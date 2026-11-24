// caseApi — the Case Assignment workbook's door into the app's data.
//
// Case lists hold case numbers (PHI), so they're split in an Excel-on-the-
// web workbook on the hospital's Office 365, never in the app. The app
// publishes what the split needs (scheduler/caseDist/publish: who's working,
// services, shares, case types — no patient data); the workbook's Office
// Scripts fetch it here and send back only totals:
//
//   GET  ?op=day[&skip=<recordKey>]   the day to split for (3 pm Central
//        rule) with its team, the case types and settings, each person's
//        running balance for the fiscal year, and — when skip names a
//        record — that record's per-person balance, left out of the totals.
//   POST ?op=record  { date, key?, minutes, expected, cases }   one list's
//        per-person totals (ledger/<date>/<key>; key replaces a record).
//
// Every request carries the shared key (X-Key header). Anything that looks
// like a case number in a request is refused.

const ACC_RE = /^[A-Z]{1,5}-?\d{2,4}-\d{1,8}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^(\d{1,4}|l:[-\w]{1,40}|d:[-\w]{1,40})$/;
const KEY_RE = /^[-\w]{1,40}$/;
const CENTRAL = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23',
});

class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// The calendar day the cases are for: today before the cutoff, else
// tomorrow (the published days skip weekends and holidays).
function ruleDate(now, cutoffHour) {
    const p = {};
    CENTRAL.formatToParts(now).forEach(x => { p[x.type] = Number(x.value); });
    const d = new Date(p.year, p.month - 1, p.day);
    if (p.hour >= cutoffHour) d.setDate(d.getDate() + 1);
    return ymd(d);
}

// Firebase hands lists back as objects keyed 0, 1, 2… (or drops them when
// empty) and drops null fields: put the published data back in shape.
const arr = v => Array.isArray(v) ? v
    : (v && typeof v === 'object' ? Object.keys(v).sort((a, b) => Number(a) - Number(b)).map(k => v[k]) : []);
const arrMap = o => {
    const out = {};
    Object.entries(o || {}).forEach(([k, v]) => { out[k] = arr(v); });
    return out;
};
function shapeTeam(team) {
    return arr(team).map(t => ({
        id: String(t.id), name: t.name || '', short: t.short || '', epic: t.epic || '',
        svcIds: arr(t.svcIds), svc: t.svc || '', share: Number(t.share) || 0, locum: !!t.locum, delnor: !!t.delnor,
    }));
}
function shapeTypes(types) {
    return arr(types).map(t => ({
        id: String(t.id), name: t.name || '', match: t.match || '',
        minutes: Number(t.minutes) || 0,
        addMinutes: t.addMinutes === undefined || t.addMinutes === null ? null : Number(t.addMinutes),
        slides: t.slides === undefined || t.slides === null ? null : Number(t.slides),
        codes: arr(t.codes), services: t.services || null, readers: t.readers || null, delnor: !!t.delnor,
    }));
}
function shapeConstants(k) {
    k = k || {};
    return Object.assign({}, k, {
        cptMinutes: arrMap(k.cptMinutes), rvu: arrMap(k.rvu), cptFloor: k.cptFloor || {}, cptSlides: k.cptSlides || {},
        slideRange: arr(k.slideRange),
    });
}

// Fiscal year (Sept 1 – Aug 31) start for a date key.
function fyStart(dk) {
    const [y, m] = dk.split('-').map(Number);
    return `${m >= 9 ? y : y - 1}-09-01`;
}

// Refuse anything shaped like a case number, in keys or values, anywhere.
function assertNoCaseNumbers(v, where = 'request') {
    if (typeof v === 'string') {
        if (ACC_RE.test(v.trim())) throw new ApiError(400, `The ${where} contains what looks like a case number; it was refused.`);
        return;
    }
    if (Array.isArray(v)) { v.forEach(x => assertNoCaseNumbers(x, where)); return; }
    if (v && typeof v === 'object') {
        Object.entries(v).forEach(([k, x]) => { assertNoCaseNumbers(k, where); assertNoCaseNumbers(x, where); });
    }
}

function numberMap(obj, what) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new ApiError(400, `${what} must be an object.`);
    const out = {};
    Object.entries(obj).forEach(([id, n]) => {
        if (!ID_RE.test(id)) throw new ApiError(400, `${what}: unknown person id "${id}".`);
        const v = Number(n);
        if (!Number.isFinite(v) || Math.abs(v) > 1e6) throw new ApiError(400, `${what}: bad number for ${id}.`);
        out[id] = v;
    });
    return out;
}

async function getDay(db, query, now) {
    const pub = (await db.ref('scheduler/caseDist/publish').once('value')).val();
    if (!pub || !pub.days) throw new ApiError(503, 'The app hasn’t published the schedule yet: open the app signed in as the director.');
    const want = ruleDate(now, (pub.constants && pub.constants.cutoffHour) || 15);
    const date = Object.keys(pub.days).sort().find(k => k >= want);
    if (!date) throw new ApiError(409, `The app’s published days end before ${want}: open the app signed in as the director to refresh them.`);

    // Running balance this fiscal year: minutes assigned − fair share, from
    // every recorded list up to and including the day (cdBalances).
    const skip = query.skip && KEY_RE.test(String(query.skip)) ? String(query.skip) : '';
    const ledger = (await db.ref('scheduler/caseDist/ledger').orderByKey().startAt(fyStart(date)).endAt(date).once('value')).val() || {};
    const got = {}, exp = {}, skipped = {};
    let skippedFound = false;
    Object.values(ledger).forEach(batches => Object.entries(batches || {}).forEach(([bk, b]) => {
        if (bk === skip) {
            skippedFound = true;
            Object.entries(b.minutes || {}).forEach(([id, m]) => { skipped[id] = (skipped[id] || 0) + m; });
            Object.entries(b.expected || {}).forEach(([id, m]) => { skipped[id] = (skipped[id] || 0) - m; });
            return;
        }
        Object.entries(b.minutes || {}).forEach(([id, m]) => { got[id] = (got[id] || 0) + m; });
        Object.entries(b.expected || {}).forEach(([id, m]) => { exp[id] = (exp[id] || 0) + m; });
    }));
    const balances = {};
    new Set([...Object.keys(got), ...Object.keys(exp)]).forEach(id => { balances[id] = (got[id] || 0) - (exp[id] || 0); });
    return {
        date, publishedAt: pub.at || 0,
        team: shapeTeam(pub.days[date] && pub.days[date].team),
        types: shapeTypes(pub.types), people: arr(pub.people), services: arr(pub.services),
        settings: pub.settings || {}, constants: shapeConstants(pub.constants),
        balances, skipped: skippedFound ? skipped : null,
    };
}

async function postRecord(db, body) {
    const date = String(body.date || '');
    if (!DATE_RE.test(date)) throw new ApiError(400, 'date must be YYYY-MM-DD.');
    const rec = {
        minutes: numberMap(body.minutes, 'minutes'),
        expected: numberMap(body.expected, 'expected'),
        cases: numberMap(body.cases, 'cases'),
        at: Date.now(), by: 'excel',
    };
    const base = db.ref('scheduler/caseDist/ledger/' + date);
    let key = body.key && KEY_RE.test(String(body.key)) ? String(body.key) : '';
    // A key from another day starts a new record on this one.
    if (key && !(await base.child(key).once('value')).exists()) key = '';
    const ref = key ? base.child(key) : base.push();
    await ref.set(rec);
    return { key: ref.key };
}

// One request → { status, body }. `key` is the shared secret.
export async function handleCaseApi(req, { db, key, now = new Date() }) {
    try {
        const sent = String((req.headers && (req.headers['x-key'] || req.headers['X-Key'])) || '');
        if (!key || sent.length !== key.length || !timingSafeEqualStr(sent, key)) throw new ApiError(401, 'Wrong or missing key (Settings!B2 in the workbook).');
        const op = String((req.query && req.query.op) || '');
        if (req.method === 'GET' && op === 'day') return { status: 200, body: await getDay(db, req.query || {}, now) };
        if (req.method === 'POST') {
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            assertNoCaseNumbers(body);
            if (op === 'record') return { status: 200, body: await postRecord(db, body) };
        }
        throw new ApiError(404, 'Unknown request.');
    } catch (err) {
        if (err instanceof ApiError) return { status: err.status, body: { error: err.message } };
        throw err;
    }
}

function timingSafeEqualStr(a, b) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

export const _test = { ruleDate, fyStart, assertNoCaseNumbers, shapeTeam, shapeTypes, shapeConstants };
