// ════════════════════════════════════════════════════════════════════════
// Split cases — Office Script for the "Case Assignment" workbook
// (Excel on the web, on the hospital's Office 365).
// ════════════════════════════════════════════════════════════════════════
//
// Case lists hold case numbers, which are PHI, so they're split here and
// never reach the scheduling app. The app publishes what the split needs —
// who's working, their services and shares, the case types — and this
// script fetches it through the app's caseApi function. It sends back only
// each person's minutes and case counts for the day (the running ahead /
// behind totals). No case numbers leave the workbook.
//
// Sheets: Cases (paste Epic's case log at A1), Assignments (the result),
// Settings (B1 = caseApi address, B2 = key), List (hidden: the last list).
//
//  1. Paste the case log at Cases!A1 (the automation does this) and click
//     "Split cases". The list moves to the hidden List sheet and Cases is
//     cleared for the next one.
//  2. To move a case, pick another pathologist in its row and click "Split
//     cases" again: cases changed by hand stay put, the rest re-split.
//     Pasting the same list again replaces its record instead of counting it
//     twice.
//
// The rules are the app's (case-distribution.js), ported line for line:
// cdBuildCases, cdDistribute, cdDealDelnor, cdTotals. Change both together.

interface TeamMember {
    id: string; name: string; short: string; epic: string;
    svcIds: string[]; svc: string; share: number; locum: boolean; delnor: boolean;
}
interface CaseType {
    id: string; name: string; match: string; group: string;
    minutes: number; addMinutes: number | null; slides: number | null; codes: string[];
    services: { [sid: string]: number | boolean } | null;
    readers: { [pid: string]: boolean } | null;
    delnor: boolean;
}
interface Constants {
    cptMinutes: { [code: string]: number[] }; cptFloor: { [code: string]: number };
    cptSlides: { [code: string]: number }; defaultSlides: number;
    rvu: { [code: string]: number[] };
    stainRe: string; addonRe: string; chargeRe: string; accRe: string;
    slideRange: number[]; carry: number; delnorFraction: number; dealTries: number;
}
interface Settings { defaultMinutes: number; slideEffect: number; fnaCellBlockMinutes: number; }
interface DayData {
    date: string; publishedAt: number;
    team: TeamMember[]; types: CaseType[]; services: { id: string; short: string }[];
    settings: Settings; constants: Constants;
    balances: { [id: string]: number };
    // The record named by ?skip=, left out of balances: each person's
    // minutes − fair share in it. Added back when this is a different list.
    skipped: { [id: string]: number } | null;
}
interface Part { name: string; code: string | null; units: number; type: CaseType | null; minutes: number; via: string; }
interface SplitCase {
    key: string; id: string; cat: string; parts: Part[]; slides: number | null; seq: number;
    minutes: number; label: string; detail: string;
    readers: Set<string> | null; services: Set<string>[] | null; delnorOK: boolean;
    assigned: string | null; pinned: string | undefined; note: string; shared: string;
}
interface Cols { id: number; proto: number; charge: number; cat: number; slides: number; }
interface Totals { minutes: { [id: string]: number }; expected: { [id: string]: number }; cases: { [id: string]: number }; }

// ── The rules (pure: no Excel) ──────────────────────────────────────────
class Splitter {
    day: DayData;
    types: CaseType[];
    stainRe: RegExp; addonRe: RegExp; chargeRe: RegExp; accRe: RegExp;
    svcShort: { [id: string]: string };
    matchCache: Map<string, CaseType | null>;
    cases: SplitCase[];

    constructor(day: DayData) {
        this.day = day;
        this.types = day.types;
        const k = day.constants;
        this.stainRe = new RegExp(k.stainRe);
        this.addonRe = new RegExp(k.addonRe);
        this.chargeRe = new RegExp(k.chargeRe, 'i');
        this.accRe = new RegExp(k.accRe, 'i');
        this.svcShort = {};
        day.services.forEach(s => { this.svcShort[s.id] = s.short; });
        this.matchCache = new Map<string, CaseType | null>();
        this.cases = [];
    }

    norm(s: string): string { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
    escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    phrases(t: CaseType): string[] {
        return String(t.match || t.name || '').split(/[;\n]/).map(s => s.trim().toLowerCase()).filter(s => s.length > 0);
    }
    // The type whose phrase matches the text as whole words; the longest wins.
    matchType(text: string): CaseType | null {
        const t = String(text || '').toLowerCase();
        if (!t) return null;
        const hit = this.matchCache.get(t);
        if (hit !== undefined) return hit;
        let best: CaseType | null = null, bestLen = 0;
        this.types.forEach(type => {
            this.phrases(type).forEach(ph => {
                if (ph.length <= bestLen) return;
                const re = new RegExp('(^|[^a-z0-9])' + this.escapeRe(ph) + '($|[^a-z0-9])');
                if (re.test(t)) { best = type; bestLen = ph.length; }
            });
        });
        this.matchCache.set(t, best);
        return best;
    }
    serviceTiers(obj: { [sid: string]: number | boolean } | null): Set<string>[] | null {
        if (!obj) return null;
        const t1 = new Set<string>(), t2 = new Set<string>();
        Object.keys(obj).forEach(sid => {
            const v = obj[sid];
            if (v === 2) t2.add(sid);
            else if (v) t1.add(sid);
        });
        if (!t1.size && t2.size) return [t2, new Set<string>()];
        return t1.size ? [t1, t2] : null;
    }
    setOf(obj: { [k: string]: boolean } | null): Set<string> | null {
        const keys = obj ? Object.keys(obj).filter(k => obj[k]) : [];
        return keys.length ? new Set<string>(keys.map(String)) : null;
    }
    svcNames(set: Set<string>): string {
        return Array.from(set).map(s => this.svcShort[s] || s).join(' / ');
    }

    // ── Parsing (cdParseTable's cleaning, cdDropTitleRows, cdGuessCols) ──
    cleanRows(raw: string[][]): string[][] {
        const clean = raw.map(r => r.map(c => String(c === undefined || c === null ? '' : c).replace(/\r\n?/g, '\n').split('\n')
            .map(l => l.replace(/\s+/g, ' ').trim()).filter(l => l.length > 0).join('\n')))
            .filter(r => r.some(c => c.length > 0));
        const width = clean.reduce((w, r) => Math.max(w, r.length), 0);
        clean.forEach(r => { while (r.length < width) r.push(''); });
        return clean;
    }
    dropTitleRows(rows: string[][]): string[][] {
        const isHead = (r: string[]) => r.some(c => /^(case|accession)\b/i.test(c));
        const hasAcc = (r: string[]) => !!r && r.some(c => this.accRe.test(c.split('\n')[0]));
        for (let i = 0; i < Math.min(rows.length - 1, 10); i++) {
            if (isHead(rows[i]) && hasAcc(rows[i + 1])) return i ? rows.slice(i) : rows;
            if (hasAcc(rows[i])) break;
        }
        return rows;
    }
    looksLikeHeader(rows: string[][]): boolean {
        if (rows.length < 2) return false;
        return !rows[0].some(c => /\d/.test(c)) && rows[1].some(c => /\d/.test(c));
    }
    guessCols(rows: string[][], hasHeader: boolean): Cols {
        const width = rows.length ? rows[0].length : 0;
        const headers: string[] = [];
        for (let i = 0; i < width; i++) headers.push(hasHeader ? rows[0][i] || ('Column ' + i) : 'Column ' + i);
        const data = (hasHeader ? rows.slice(1) : rows).slice(0, 200);
        const used = new Set<number>();
        const pick = (re: RegExp, test: ((c: string) => boolean) | null): number => {
            let i = hasHeader ? headers.findIndex((h, j) => !used.has(j) && re.test(h)) : -1;
            if (i < 0 && test) {
                i = headers.findIndex((_, j) => !used.has(j) && data.length > 0
                    && data.filter(r => test(r[j])).length / data.length >= 0.6);
            }
            if (i >= 0) used.add(i);
            return i;
        };
        const id = pick(/accession|case\s*(#|no\b|num|number|id\b)|^case$/i, c => this.accRe.test(c));
        const charge = pick(/charge|cpt|billing/i, c => c.split('\n').some(l => this.chargeRe.test(l)));
        const proto = pick(/protocol|specimen|part|procedure|description/i, null);
        const cat = pick(/case\s*type|category/i, null);
        const slides = pick(/slide/i, null);
        return { id, proto, charge, cat, slides };
    }

    // ── Minutes ──
    partMinutes(pt: Part): number {
        const k = this.day.constants;
        const units = Math.max(1, pt.units || 1);
        let first: number, add: number;
        if (pt.type) {
            first = Number(pt.type.minutes) || 0;
            const a = pt.type.addMinutes === null ? NaN : Number(pt.type.addMinutes);
            add = Number.isFinite(a) ? a : first;
            pt.via = 'type';
        } else if (pt.code && k.cptMinutes[pt.code]) {
            first = k.cptMinutes[pt.code][0];
            add = k.cptMinutes[pt.code][1];
            pt.via = 'cpt';
        } else {
            first = add = this.day.settings.defaultMinutes;
            pt.via = 'default';
        }
        if (pt.code && k.cptFloor[pt.code]) first = Math.max(first, k.cptFloor[pt.code]);
        return first + (units - 1) * add;
    }
    partSlides(pt: Part): number | null {
        const k = this.day.constants;
        const units = Math.max(1, pt.units || 1);
        if (pt.code && this.stainRe.test(pt.code)) return 0;
        if (pt.type) {
            const s = pt.type.slides;
            if (s === undefined || s === null || !Number.isFinite(Number(s))) return null;
            return Number(s) * units;
        }
        const s = pt.code && k.cptSlides[pt.code] !== undefined ? k.cptSlides[pt.code] : k.defaultSlides;
        return s * units;
    }
    slideFactor(slides: number | null, typical: number | null): number {
        const effect = this.day.settings.slideEffect;
        const k = this.day.constants;
        if (slides === null || typical === null || !(slides > 0) || !(typical > 0) || !effect) return 1;
        const f = Math.pow(slides / typical, effect);
        return Math.min(k.slideRange[1], Math.max(k.slideRange[0], f));
    }
    slideCount(cell: string): number | null {
        const v = String(cell || '').split('\n')[0].replace(/,/g, '').trim();
        return /^\d+$/.test(v) ? parseInt(v, 10) : null;
    }
    rowParts(r: string[], cols: Cols): Part[] {
        const parts: Part[] = [];
        const lines = (col: number): string[] => (col >= 0 && r[col]) ? r[col].split('\n').map(l => l.trim()).filter(l => l.length > 0) : [];
        lines(cols.charge).forEach(l => {
            const m = l.match(this.chargeRe);
            if (m) parts.push({ name: m[1].trim() || l, code: m[2], units: parseInt(m[3], 10) || 1, type: null, minutes: 0, via: '' });
            else parts.push({ name: l, code: null, units: 1, type: null, minutes: 0, via: '' });
        });
        const charged = new Set<string>(parts.map(pt => this.norm(pt.name)));
        lines(cols.proto).forEach(l => {
            if (!charged.has(this.norm(l))) { parts.push({ name: l, code: null, units: 1, type: null, minutes: 0, via: '' }); charged.add(this.norm(l)); }
        });
        return parts;
    }

    // ── Rows → cases (cdBuildCases) ──
    build(rawRows: string[][]): void {
        const rows = this.dropTitleRows(this.cleanRows(rawRows));
        this.cases = [];
        if (!rows.length) return;
        const hasHeader = this.looksLikeHeader(rows);
        const cols = this.guessCols(rows, hasHeader);
        if (cols.proto < 0 && cols.charge < 0) throw new Error('No specimen or charge column found in the pasted list.');
        const fnaType = this.matchType('fna'), cellBlockType = this.matchType('cell block');
        const fnaCbMin = fnaType && cellBlockType && fnaType !== cellBlockType ? this.day.settings.fnaCellBlockMinutes : 0;

        interface Group { key: string; id: string; cat: string; parts: Part[]; slides: number | null; }
        const groups = new Map<string, Group>();
        (hasHeader ? rows.slice(1) : rows).forEach((r, i) => {
            const id = cols.id >= 0 ? r[cols.id].split('\n')[0] : '';
            const key = id ? 'id:' + id.toUpperCase() : 'row:' + i;
            if (!groups.has(key)) groups.set(key, { key, id: id || '', cat: '', parts: [], slides: null });
            const g = groups.get(key) as Group;
            if (cols.cat >= 0 && r[cols.cat] && !g.cat) g.cat = r[cols.cat].replace(/\n/g, ' ');
            const s = cols.slides >= 0 ? this.slideCount(r[cols.slides]) : null;
            if (s !== null) g.slides = Math.max(g.slides || 0, s);
            this.rowParts(r, cols).forEach(pt => g.parts.push(pt));
        });

        groups.forEach(g => {
            if (!g.parts.length) return;
            // One holder, so the loop's changes aren't lost to type narrowing.
            const acc: { minutes: number; routed: Part | null; readers: Set<string> | null; typical: number | null; stains: number } =
                { minutes: 0, routed: null, readers: null, typical: 0, stains: 0 };
            const narrow = (rs: Set<string> | null) => {
                if (!rs) return;
                const cur = acc.readers;
                acc.readers = cur ? new Set<string>(Array.from(cur).filter(x => rs.has(x))) : rs;
            };
            g.parts.forEach(pt => {
                pt.type = pt.code && (this.stainRe.test(pt.code) || this.addonRe.test(pt.code)) ? null : this.matchType(pt.name);
                pt.minutes = this.partMinutes(pt);
                acc.minutes += pt.minutes;
                const ps = this.partSlides(pt);
                acc.typical = (acc.typical === null || ps === null) ? null : acc.typical + ps;
                if (pt.code && this.stainRe.test(pt.code)) acc.stains += Math.max(1, pt.units || 1);
                const r = acc.routed;
                if (pt.type && this.serviceTiers(pt.type.services) && (!r || pt.minutes > r.minutes)) acc.routed = pt;
                if (pt.type) narrow(this.setOf(pt.type.readers));
            });
            const catType = g.cat ? this.matchType(g.cat) : null;
            if (catType) narrow(this.setOf(catType.readers));
            let minutes = acc.minutes;
            const readers = acc.readers, typical = acc.typical, stains = acc.stains;
            const hasType = (t: CaseType) => g.parts.some(pt => !!pt.type && pt.type.id === t.id);
            const fnaCellBlock = fnaCbMin > 0 && fnaType && cellBlockType && hasType(fnaType) && hasType(cellBlockType) ? fnaCbMin : 0;
            minutes += fnaCellBlock;

            const weight = (pt: Part) => pt.type ? Number(pt.type.minutes) || 0 : pt.minutes;
            const labels: string[] = [];
            g.parts.slice().sort((a, b) => weight(b) - weight(a) || b.minutes - a.minutes).forEach(pt => {
                if (pt.minutes === 0) return;
                const l = pt.type ? pt.type.name : pt.name;
                if (labels.indexOf(l) < 0) labels.push(l);
            });
            const heSlides = g.slides === null ? null : Math.max(1, g.slides - stains);
            const factor = typical === null ? 1 : this.slideFactor(heSlides, typical);
            const r0 = acc.routed;
            const services = (r0 && r0.type && this.serviceTiers(r0.type.services))
                || (catType && this.serviceTiers(catType.services)) || null;
            const timed = g.parts.filter(pt => pt.minutes > 0 && !(pt.code && (this.stainRe.test(pt.code) || this.addonRe.test(pt.code))));
            this.cases.push({
                key: g.key, id: g.id, cat: g.cat, parts: g.parts, slides: g.slides, seq: 0,
                minutes: Math.round(minutes * factor * 10) / 10,
                label: labels.join(' + ') || g.parts[0].name,
                detail: g.parts.map(pt => pt.name + (pt.units > 1 ? ' ×' + pt.units : '')).join(' · '),
                readers, services,
                delnorOK: timed.length > 0 && timed.every(pt => !!pt.type && pt.type.delnor),
                assigned: null, pinned: undefined, note: '', shared: '',
            });
        });
        this.cases.forEach((c, i) => { c.seq = i + 1; });
    }

    // A short fingerprint of the list's case numbers (order aside). Stays in
    // the workbook: it seeds the Delnor deal and spots the same list again.
    listSig(): string {
        const ids = this.cases.map(c => String(c.id || c.key).toUpperCase()).sort().join('|');
        let h = 2166136261;
        for (let i = 0; i < ids.length; i++) { h ^= ids.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
        return h.toString(36) + '-' + this.cases.length;
    }

    caseRvu(c: SplitCase): number {
        const rvu = this.day.constants.rvu;
        return c.parts.reduce((s, pt) => {
            if (pt.code && this.stainRe.test(pt.code)) return s;
            const code = pt.code || (pt.type && pt.type.codes.length ? pt.type.codes[0] : null);
            const r = code ? rvu[code] : null;
            return s + (r ? r[0] * Math.max(1, pt.units || 1) : 0);
        }, 0);
    }

    // ── The distribution (cdDistribute) ──
    distribute(pins: { [key: string]: string }): void {
        const k = this.day.constants;
        const working = this.day.team;
        const bal = this.day.balances || {};
        const load: { [id: string]: number } = {};
        working.forEach(w => { load[w.id] = w.delnor || w.locum ? 0 : k.carry * (bal[w.id] || 0); });
        const ours = working.filter(w => !w.delnor), delnor = working.filter(w => w.delnor);

        const readersOf = (c: SplitCase): TeamMember[] => {
            const el = ours.filter(w => !c.readers || c.readers.has(w.id));
            if (el.length) return el;
            if (c.delnorOK && delnor.length) return delnor;
            c.note = c.readers ? 'No reader for this case type is working' : 'No one is working';
            return el;
        };
        interface OnSvc { el: TeamMember[]; svc: Set<string>; }
        const onService = (c: SplitCase, el: TeamMember[]): OnSvc | null => {
            if (!c.services || !el.length || el[0].delnor) return null;
            const first = c.services[0], backup = c.services[1];
            const on = (set: Set<string>) => el.filter(w => w.svcIds.some(id => set.has(id)));
            const firstEl = on(first);
            if (firstEl.length) return { el: firstEl, svc: first };
            const backupEl = backup.size ? on(backup) : [];
            if (backupEl.length) return { el: backupEl, svc: backup };
            c.note = 'No one on ' + this.svcNames(backup.size ? new Set<string>(Array.from(first).concat(Array.from(backup))) : first) + ' — shared with all';
            return null;
        };
        const score = (w: TeamMember, c: SplitCase) => (load[w.id] + c.minutes) / w.share;
        const lowest = (el: TeamMember[], c: SplitCase) => el.reduce((best, w) => (score(w, c) < score(best, c) - 1e-9 ? w : best));
        const give = (c: SplitCase, w: TeamMember) => { c.assigned = w.id; load[w.id] += c.minutes; };

        this.cases.forEach(c => { c.note = ''; c.shared = ''; c.assigned = null; c.pinned = pins[c.key]; });
        this.cases.filter(c => c.pinned !== undefined).forEach(c => {
            c.assigned = c.pinned as string;
            if (load[c.assigned] !== undefined) load[c.assigned] += c.minutes;
        });

        if (delnor.length) {
            const target = this.cases.reduce((t, c) => t + c.minutes, 0) * k.delnorFraction;
            let have = delnor.reduce((t, w) => t + load[w.id], 0);
            const picked: SplitCase[] = [];
            this.cases.filter(c => c.pinned === undefined && c.delnorOK)
                .sort((a, b) => b.minutes - a.minutes || a.seq - b.seq)
                .forEach(c => {
                    if (have >= target || have + c.minutes / 2 > target) return;
                    picked.push(c);
                    have += c.minutes;
                });
            this.dealDelnor(picked, delnor).forEach(pair => give(pair.c, pair.w));
        }

        interface Todo { c: SplitCase; el: TeamMember[]; svc: OnSvc | null; }
        const todo: Todo[] = this.cases.filter(c => c.pinned === undefined && c.assigned === null)
            .map(c => { const el = readersOf(c); return { c, el, svc: onService(c, el) }; });

        const shareSum = ours.reduce((s, w) => s + w.share, 0);
        const ourMinutes = todo.filter(t => t.el.length > 0 && !t.el[0].delnor).reduce((s, t) => s + t.c.minutes, 0);
        const evenDay = shareSum ? (ours.reduce((s, w) => s + load[w.id], 0) + ourMinutes) / shareSum : 0;

        todo.filter(t => !!t.svc).sort((a, b) => b.c.minutes - a.c.minutes || a.c.seq - b.c.seq).forEach(t => {
            const svc = t.svc as OnSvc;
            const w = lowest(svc.el, t.c);
            if ((load[w.id] + t.c.minutes / 2) / w.share <= evenDay) give(t.c, w);
            else t.c.shared = w.short + ' (' + this.svcNames(svc.svc) + ') already had a full day — shared';
        });

        todo.filter(t => t.c.assigned === null && t.el.length > 0)
            .sort((a, b) => (a.el.length - b.el.length) || (b.c.minutes - a.c.minutes))
            .forEach(t => give(t.c, lowest(t.el, t.c)));
    }

    // ── Delnor's cases among Delnor's pathologists (cdDealDelnor) ──
    random(seedText: string): () => number {
        let a = 2166136261;
        for (let i = 0; i < seedText.length; i++) { a ^= seedText.charCodeAt(i); a = Math.imul(a, 16777619) >>> 0; }
        return () => {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    shuffle<T>(list: T[], rand: () => number): T[] {
        for (let i = list.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            const tmp = list[i]; list[i] = list[j]; list[j] = tmp;
        }
        return list;
    }
    dealDelnor(cases: SplitCase[], people: TeamMember[]): { c: SplitCase; w: TeamMember }[] {
        if (!cases.length) return [];
        if (people.length === 1) return cases.map(c => ({ c, w: people[0] }));
        const rvu = new Map<SplitCase, number>();
        cases.forEach(c => rvu.set(c, this.caseRvu(c)));
        const weight = (c: SplitCase) => (rvu.get(c) as number) + 0.01;
        const base = people.map(w => this.cases.filter(c => c.pinned !== undefined && String(c.pinned) === w.id).reduce((s, c) => s + this.caseRvu(c), 0));
        const rand = this.random(this.listSig() + '|' + this.day.date + '|' + people.map(w => w.id).join(','));
        const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
        let best: { score: number[]; mine: SplitCase[][] } | null = null;
        for (let t = 0; t < this.day.constants.dealTries; t++) {
            const order = this.shuffle(cases.slice(), rand).sort((a, b) => weight(b) - weight(a));
            const prefer = this.shuffle(people.map((_, i) => i), rand);
            const tot = base.slice();
            const mine: SplitCase[][] = people.map(() => []);
            order.forEach(c => {
                const i = prefer.reduce((a, b) => (tot[b] < tot[a] - 1e-9 ? b : a));
                mine[i].push(c);
                tot[i] += weight(c);
            });
            for (let step = 0; step < 200; step++) {
                const hi = tot.indexOf(Math.max(...tot)), lo = tot.indexOf(Math.min(...tot));
                const gap = tot[hi] - tot[lo];
                const found: { move: { a: SplitCase; b: SplitCase | null; d: number } | null; left: number } = { move: null, left: gap - 1e-6 };
                mine[hi].forEach(a => {
                    const d = weight(a);
                    if (Math.abs(gap - 2 * d) < found.left) { found.left = Math.abs(gap - 2 * d); found.move = { a, b: null, d }; }
                    mine[lo].forEach(b => {
                        const dd = weight(a) - weight(b);
                        if (dd > 0 && Math.abs(gap - 2 * dd) < found.left) { found.left = Math.abs(gap - 2 * dd); found.move = { a, b, d: dd }; }
                    });
                });
                const mv = found.move;
                if (!mv) break;
                mine[hi].splice(mine[hi].indexOf(mv.a), 1); mine[lo].push(mv.a);
                if (mv.b) { mine[lo].splice(mine[lo].indexOf(mv.b), 1); mine[hi].push(mv.b); }
                tot[hi] -= mv.d; tot[lo] += mv.d;
            }
            const rv = people.map((_, i) => base[i] + mine[i].reduce((s, c) => s + (rvu.get(c) as number), 0));
            const sc = [spread(rv), spread(mine.map(m => m.length))];
            if (!best || sc[0] < best.score[0] - 1e-6 || (Math.abs(sc[0] - best.score[0]) <= 1e-6 && sc[1] < best.score[1])) {
                best = { score: sc, mine: mine.map(m => m.slice()) };
            }
        }
        const out: { c: SplitCase; w: TeamMember }[] = [];
        (best as { score: number[]; mine: SplitCase[][] }).mine.forEach((m, i) => m.forEach(c => out.push({ c, w: people[i] })));
        return out;
    }

    // Per-person totals for the record (cdTotals / cdRecordedBatch).
    totals(): Totals {
        const total = this.cases.reduce((s, c) => s + c.minutes, 0);
        const shareSum = this.day.team.reduce((s, w) => s + w.share, 0) || 1;
        const raw: { [id: string]: { minutes: number; cases: number; expected: number } } = {};
        this.day.team.forEach(w => { raw[w.id] = { minutes: 0, cases: 0, expected: total * w.share / shareSum }; });
        this.cases.forEach(c => {
            if (c.assigned === null) return;
            if (!raw[c.assigned]) raw[c.assigned] = { minutes: 0, cases: 0, expected: 0 };
            raw[c.assigned].minutes += c.minutes;
            raw[c.assigned].cases++;
        });
        const out: Totals = { minutes: {}, expected: {}, cases: {} };
        Object.keys(raw).forEach(id => {
            out.minutes[id] = Math.round(raw[id].minutes);
            out.expected[id] = Math.round(raw[id].expected * 10) / 10;
            out.cases[id] = raw[id].cases;
        });
        return out;
    }
}

// ── Excel ────────────────────────────────────────────────────────────────
const RUN_MARK = '#RUN';
const OUT_HEAD = ['Seq', 'Case', 'Pathologist', 'Typed in Epic', 'Minutes', 'Specimens', 'Note', 'Split as'];

function sheet(workbook: ExcelScript.Workbook, name: string): ExcelScript.Worksheet {
    const ws = workbook.getWorksheet(name);
    if (!ws) throw new Error('The workbook has no "' + name + '" sheet.');
    return ws;
}
function texts(ws: ExcelScript.Worksheet): string[][] {
    const r = ws.getUsedRange(true);
    return r ? r.getTexts() : [];
}
function api(workbook: ExcelScript.Workbook): { url: string; key: string } {
    const v = sheet(workbook, 'Settings').getRange('B1:B2').getTexts();
    const url = String(v[0][0] || '').trim(), key = String(v[1][0] || '').trim();
    if (!url || !key) throw new Error('Settings!B1 (caseApi address) and B2 (key) must be filled in.');
    return { url, key };
}

async function main(workbook: ExcelScript.Workbook) {
    const cases = sheet(workbook, 'Cases'), list = sheet(workbook, 'List');
    const out = sheet(workbook, 'Assignments'), settings = sheet(workbook, 'Settings');
    const { url, key } = api(workbook);

    // A new list on Cases (the automation marks its paste with "#RUN <stamp>"),
    // else the last list again with any hand-made changes kept.
    let raw = texts(cases);
    let run = '';
    if (raw.length && String(raw[0][0] || '').indexOf(RUN_MARK) === 0) { run = String(raw[0][0]).trim(); raw = raw.slice(1); }
    const fresh = raw.some(r => r.some(c => String(c).trim().length > 0));
    if (fresh) {
        list.getRange().clear(ExcelScript.ClearApplyTo.contents);
        const w = raw.reduce((m, r) => Math.max(m, r.length), 0);
        const padded = raw.map(r => { const x = r.slice(); while (x.length < w) x.push(''); return x; });
        list.getRange('A1').getResizedRange(padded.length - 1, w - 1).setValues(padded);
    } else {
        raw = texts(list);
        if (!raw.length) throw new Error('Paste the case log at Cases!A1 first.');
    }
    const lastSig = settings.getRange('B5').getText(), lastKey = settings.getRange('B6').getText();

    // Hand-made changes: rows whose Pathologist differs from what the split gave.
    const pinsByName: { [key: string]: string } = {};
    if (!fresh) {
        const prev = texts(out);
        prev.forEach(r => {
            if (!/^\d+$/.test(String(r[0] || '')) || !r[1]) return;
            if (String(r[2] || '').trim() && String(r[2]).trim() !== String(r[7] || '').trim()) pinsByName['id:' + String(r[1]).toUpperCase()] = String(r[2]).trim();
        });
    }

    // What the split needs, from the app (no PHI goes there). The last
    // record is left out of the balances; it's added back below unless this
    // is the same list again (which replaces it).
    const res = await fetch(url + '?op=day' + (lastKey ? '&skip=' + encodeURIComponent(lastKey) : ''), { headers: { 'X-Key': key } });
    if (!res.ok) throw new Error('caseApi: ' + res.status + ' ' + (await res.text()));
    const day: DayData = await res.json();
    if (!day.team.length) throw new Error('No one is working on ' + day.date + ' in the schedule.');

    const sp = new Splitter(day);
    sp.build(raw);
    const sig = sp.listSig();
    const sameList = sig === lastSig && !!lastKey;
    const back = day.skipped;
    if (!sameList && back) Object.keys(back).forEach(id => { day.balances[id] = (day.balances[id] || 0) + back[id]; });
    const byName: { [name: string]: string } = {};
    day.team.forEach(w => { byName[w.short] = w.id; byName[w.name] = w.id; });
    const pins: { [key: string]: string } = {};
    Object.keys(pinsByName).forEach(k => {
        const id = byName[pinsByName[k]];
        if (!id) throw new Error('"' + pinsByName[k] + '" isn\'t working on ' + day.date + ': pick someone from the list.');
        pins[k] = id;
    });
    sp.distribute(pins);

    // The result: one row per case, in Epic's order.
    const team: { [id: string]: TeamMember } = {};
    day.team.forEach(w => { team[w.id] = w; });
    const rows: (string | number)[][] = [OUT_HEAD.slice()];
    sp.cases.forEach(c => {
        const w = c.assigned !== null ? team[c.assigned] : null;
        rows.push([c.seq, c.id, w ? w.short : '', w ? w.epic : '', Math.round(c.minutes), c.label,
            [c.note, c.shared, c.pinned !== undefined ? 'set by hand' : ''].filter(x => x.length > 0).join(' · '), w ? w.short : '']);
    });
    out.getRange().clear(ExcelScript.ClearApplyTo.all);
    out.getRange('A3').getResizedRange(rows.length - 1, OUT_HEAD.length - 1).setValues(rows);
    const pick = out.getRange('C4').getResizedRange(Math.max(0, rows.length - 2), 0);
    pick.getDataValidation().clear();
    pick.getDataValidation().setRule({ list: { inCellDropDown: true, source: day.team.map(w => w.short).join(',') } });
    out.getRange('H3').getResizedRange(rows.length - 1, 0).getFormat().setColumnHidden(true);
    out.getRange('A3:H3').getFormat().getFont().setBold(true);

    // The automation's copy: run stamp, then Seq · Case · EpicUser · Pathologist · Minutes.
    const unassigned = sp.cases.filter(c => c.assigned === null).length;
    const ahk: (string | number)[][] = [[run || RUN_MARK, '', '', '', ''], ['Seq', 'Case', 'EpicUser', 'Pathologist', 'Minutes']];
    sp.cases.forEach(c => { const w = c.assigned !== null ? team[c.assigned] : null; ahk.push([c.seq, c.id, w ? w.epic : '', w ? w.short : '', Math.round(c.minutes)]); });
    const ahkRange = out.getRange('J3').getResizedRange(ahk.length - 1, 4);
    ahkRange.setValues(ahk);
    const old = workbook.getNamedItem('AhkOut');
    if (old) old.delete();
    workbook.addNamedItem('AhkOut', ahkRange);

    // Who got what.
    const t = sp.totals();
    const sum: (string | number)[][] = [['Pathologist', 'Service', 'Cases', 'Minutes', 'Fair share']];
    Object.keys(t.minutes).forEach(id => {
        const w = team[id];
        sum.push([w ? w.short : id, w ? w.svc : '', t.cases[id], t.minutes[id], Math.round(t.expected[id])]);
    });
    out.getRange('P3').getResizedRange(sum.length - 1, 4).setValues(sum);
    out.getRange('P3:T3').getFormat().getFont().setBold(true);

    // The record (totals only). The same list again replaces its record.
    let recordKey = '';
    if (!unassigned) {
        const rec = await fetch(url + '?op=record', {
            method: 'POST', headers: { 'X-Key': key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ date: day.date, key: sameList ? lastKey : '', minutes: t.minutes, expected: t.expected, cases: t.cases }),
        });
        if (!rec.ok) throw new Error('caseApi record: ' + rec.status + ' ' + (await rec.text()));
        const got: { key: string } = await rec.json();
        recordKey = got.key;
    }
    settings.getRange('B5:B6').setValues([[sig], [recordKey || (sameList ? lastKey : '')]]);
    if (fresh) cases.getRange().clear(ExcelScript.ClearApplyTo.contents);

    const status = sp.cases.length + ' cases split for ' + day.date
        + (unassigned ? ' — ' + unassigned + ' not assigned (see Note); nothing recorded' : '; recorded')
        + ' · ' + new Date().toLocaleTimeString();
    out.getRange('A1').setValue(status);
    out.getRange('A1').getFormat().getFont().setBold(true);
    out.getRange('A:H').getFormat().autofitColumns();
    out.activate();
    console.log(status);
}
