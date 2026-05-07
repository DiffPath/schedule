// ────────────── FIREBASE INIT ──────────────
const firebaseConfig = {
    apiKey: "AIzaSyDuNpgf8Gtd2treHdaQt66HYcNjCrhBjlM",
    authDomain: "scheduler-f54c7.firebaseapp.com",
    databaseURL: "https://scheduler-f54c7-default-rtdb.firebaseio.com",
    projectId: "scheduler-f54c7",
    storageBucket: "scheduler-f54c7.firebasestorage.app",
    messagingSenderId: "529858873691",
    appId: "1:529858873691:web:2f4f60038da8db4a0af27e",
    measurementId: "G-WEKS3DWMCG"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ────────────── SEEDS (only used if Firebase is empty) ──────────────
const SEED_PATHOLOGISTS = [
    { id: 1, name: 'Dr. Michael Moravek', initials: 'MM', color: 'var(--p1)', vacationAllotted: 35 },
    { id: 2, name: 'Dr. Imaad Mujeeb', initials: 'IM', color: 'var(--p2)', vacationAllotted: 35 },
    { id: 3, name: 'Dr. Jamaal Rehman', initials: 'JR', color: 'var(--p3)', vacationAllotted: 35 },
    { id: 4, name: 'Dr. Maryam Raouf', initials: 'MR', color: 'var(--p4)', vacationAllotted: 35 },
];

// ────────────── CONSTANTS ──────────────
const SERVICES = [
    { id: 'cyto', name: 'McHenry Cyto / Gross', short: 'M Cyto/Gross', abbr: 'CYT', cssVar: '--svc-cyto' },
    { id: 'bigs', name: 'McHenry Bigs', short: 'M Bigs', abbr: 'BIG', cssVar: '--svc-bigs' },
    { id: 'huntley', name: 'Huntley', short: 'Huntley', abbr: 'HUN', cssVar: '--svc-huntley' },
    { id: 'wfh', name: 'Breast Bx / WFH', short: 'Breast bx/WFH', abbr: 'WFH', cssVar: '--svc-wfh' },
];

// Special combined state when only 2 pathologists are working
const COMBO_SVC = {
    id: 'cytobigs',
    name: 'McHenry Cyto / Gross / Bigs',
    short: 'M Cyto/Gross/Bigs',
    abbr: 'CGB',
    cssVar: '--svc-cyto' // reusing cyto's color theme
};

const SERVICE_BY_ID = Object.fromEntries(SERVICES.map(s => [s.id, s]));
SERVICE_BY_ID['cytobigs'] = COMBO_SVC; // Register the combo service

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_MINI = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// Earliest date for which the app shows schedule data. Anything before this
// date renders as blank (no rotation, no PTO, no on-call shown).
const EARLIEST_DATE = new Date(2025, 8, 1); // September 1, 2025
EARLIEST_DATE.setHours(0, 0, 0, 0);
const isBeforeEarliest = d => d.getTime() < EARLIEST_DATE.getTime();

// ────────────── STATE ──────────────
let pathologists = [];
let vacations = [];                  // [{ key, pathologistId, start: Date, end: Date }]
let onCallOverrides = {};            // { weekKey: pathologistId }
let onCallDayOverrides = {};         // { dayKey: pathologistId }
let serviceOverrides = {};           // { weekKey: { pathId: serviceId } }

// Procedures: an hourly schedule independent of the pathologist rotation.
// Shape: { 'YYYY-MM-DD': { pushKey: { time: 'HH:MM', type: 'procedure',
//                                     createdAt: <ms>, createdBy: <pid> } } }
// `type` is fixed to 'procedure' for now but is stored so future versions can
// support other procedure types without a data migration.
let procedures = {};

let pathologistsReady = false;
let vacationsReady = false;
let currentPathFilter = 'all';

// ────────────── HOURLY GRID CONFIG ──────────────
// Half-hour slots from HOURS_START:00 through HOURS_END:30 inclusive.
// Default: 7 AM start, last slot 4:30 PM (covers 7:00–17:00 in half-hour steps).
const HOURS_START = 7;   // 7 AM
const HOURS_END   = 16;  // last hour shown (so last slot is HOURS_END:30 = 4:30 PM)

// Available procedure types shown in the "Add procedure" modal. Easy to
// extend — just add another string. The pill on the schedule renders as
// "<location> - <name>" (e.g. "HH - CT Random Kidney bx").
const PROCEDURE_TYPES = [
    'EUS',
    'EBUS/ION',
    'IR Thyroid bx',
    'IR Thyroid w/ Afirma',
    'CT Random Kidney bx',
    'CT Bone Marrow',
    'Lumpectomy',
    'Mastectomy',
    'Excisional bx',
    'FS Brain',
    'FS Lung',
    'FS Parathyroid',   
];

const PROCEDURE_LOCATIONS = ['HH', 'MH'];

// ────────────── ADMIN / REQUESTS ──────────────
// The admin user is identified by name (more robust than relying on a
// numeric id which could change if the seed is regenerated).
const ADMIN_NAME_RE = /Michael\s+Moravek/i;
// Special non-pathologist user that can only edit the procedure schedule
const GROSS_ROOM_ID = 'gross_room';
let requests = {};            // { reqKey: { ...request fields } } from Firebase
let requestsReady = false;    // becomes true after first snapshot resolves
let _seenRequestKeys = null;  // for "new request arrived" detection
let activeRequestsTab = 'pending';  // 'pending' | 'history'

// Returns true if the given pathologist id (defaults to the signed-in user)
// has admin privileges. Falls back to false if no one is signed in.
function isAdmin(pathId) {
    const id = (pathId !== undefined && pathId !== null) ? pathId : loggedInPathId;
    if (id === null || id === undefined) return false;
    const p = pathologists.find(x => x.id === id);
    if (!p) return false;
    return ADMIN_NAME_RE.test(p.name);
}

// Returns true when the gross-room account is signed in.
// Gross room can edit the procedure schedule but not the pathologist schedule.
function isGrossRoom() {
    return loggedInPathId === GROSS_ROOM_ID;
}

// Update the path-tab toggle to reflect val ('all' or a stringified pathId)
function setPathFilter(val) {
    currentPathFilter = val;
    document.querySelectorAll('.path-tab').forEach(btn => {
        const wantsAll = btn.dataset.filter === 'all';
        btn.classList.toggle('active', wantsAll ? val === 'all' : val !== 'all');
    });
}
let view = 'week';                    // 'week' | 'month' | 'year'
const today = new Date();
today.setHours(0, 0, 0, 0);
let cursor = new Date(today);

// ────────────── DISPLAY SETTINGS ──────────────
// Persisted in localStorage so preferences survive page refreshes.
const SETTINGS_STORAGE_KEY = 'schedDisplaySettings';
let settings = (() => {
    try {
        const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
        if (raw) return Object.assign({ weekdaysOnly: false, hideSidebar: false }, JSON.parse(raw));
    } catch (_) {}
    return { weekdaysOnly: false, hideSidebar: false };
})();

function saveSettings() {
    try { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings)); } catch (_) {}
}

// Apply current settings to the DOM (sidebar visibility, etc.)
function applySettings() {
    const app = document.querySelector('.app');
    if (app) app.classList.toggle('sidebar-hidden', !!settings.hideSidebar);

    // Sync toggle switches to reflect current state
    const tw = document.getElementById('toggleWeekdays');
    const ts = document.getElementById('toggleSidebar');
    if (tw) tw.setAttribute('aria-checked', settings.weekdaysOnly ? 'true' : 'false');
    if (ts) ts.setAttribute('aria-checked', settings.hideSidebar ? 'true' : 'false');

    // Sync sidebar arrow button aria-label
    const stb = document.getElementById('sidebarToggleBtn');
    if (stb) {
        const label = settings.hideSidebar ? 'Expand sidebar' : 'Collapse sidebar';
        stb.setAttribute('aria-label', label);
        stb.setAttribute('title', label);
    }
}

// Year view mode: 'pto' shows PTO schedule, 'call' shows on-call schedule
let yearMode = 'pto';

// ────────────── AUTH STATE ──────────────
// Authenticated pathologist id (number) or null when nobody is signed in on
// this device. We persist this in localStorage so users only see the login
// screen on first use of a given browser.
const AUTH_STORAGE_KEY = 'schedCurrentPathId';
let loggedInPathId = (() => {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (raw === GROSS_ROOM_ID) return GROSS_ROOM_ID;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
})();

// ────────────── DATE HELPERS ──────────────
const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseDate = s => { const d = new Date(s + 'T00:00:00'); d.setHours(0, 0, 0, 0); return d; };
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const startOfWeek = d => { const x = new Date(d); x.setDate(x.getDate() - x.getDay()); x.setHours(0, 0, 0, 0); return x; };

// Given a pathologist color value like 'var(--p2)', returns the matching
// light-tint background CSS variable string for service row highlighting.
function pathBgColor(colorVar) {
    const m = colorVar && colorVar.match(/--p(\d+)/);
    return m ? `var(--p${m[1]}-bg)` : '';
}
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const daysBetween = (a, b) => Math.round((b - a) / 86400000);
const isWeekend = d => d.getDay() === 0 || d.getDay() === 6;
const weekKey = d => fmt(startOfWeek(d));

// Next/previous workday — skips weekends AND federal holidays. Used by
// hard-rule and soft-rule logic so "the day before" correctly resolves
// across holiday weekends:
//   - prevWorkday(Tuesday after Memorial Day) → Friday (skips Sat/Sun/Mon)
//   - nextWorkday(Friday before July 4 weekend) → Monday after July 4
// This means Bigs-on-Friday + WFH-on-Tuesday (with a holiday Monday) is
// correctly detected as a soft-rule conflict, just like Friday + Monday.
function nextWorkday(date) {
    let d = addDays(date, 1);
    while (isWeekend(d) || getFederalHoliday(d)) d = addDays(d, 1);
    return d;
}
function prevWorkday(date) {
    let d = addDays(date, -1);
    while (isWeekend(d) || getFederalHoliday(d)) d = addDays(d, -1);
    return d;
}

// ────────────── FEDERAL HOLIDAYS ──────────────
// Returns the holiday name for the given date, or null if not a federal holiday.
function getFederalHoliday(date) {
    const m = date.getMonth();  // 0-indexed
    const d = date.getDate();
    const dow = date.getDay();    // 0=Sun … 6=Sat
    const y = date.getFullYear();

    // New Year's Day — January 1
    if (m === 0 && d === 1) return "New Year's Day";

    // Memorial Day — last Monday of May
    if (m === 4 && dow === 1) {
        const nextWeek = new Date(y, 4, d + 7);
        if (nextWeek.getMonth() !== 4) return 'Memorial Day';
    }

    // Independence Day — July 4
    if (m === 6 && d === 4) return 'Independence Day';

    // Labor Day — first Monday of September
    if (m === 8 && dow === 1 && d <= 7) return 'Labor Day';

    // Thanksgiving — 4th Thursday of November
    if (m === 10 && dow === 4 && d >= 22 && d <= 28) return 'Thanksgiving';

    // Christmas Day — December 25
    if (m === 11 && d === 25) return 'Christmas Day';

    return null;
}

// ────────────── ROTATION (defaults) ──────────────
// Weekly on-call anchor: Jan 8 2024 is a normal Monday
const CALL_ANCHOR = new Date(2024, 0, 8);
CALL_ANCHOR.setHours(0, 0, 0, 0);

// Daily service rotation anchor (Mondays): Jan 1 2024 = workDay 0
const WORK_ANCHOR = new Date(2024, 0, 1);
WORK_ANCHOR.setHours(0, 0, 0, 0);

// Finds the start of the dynamic call block for any given date
function getCallCycleStart(date) {
    let d = new Date(date);
    d.setHours(0, 0, 0, 0);
    while (true) {
        let dow = d.getDay();
        let isHol = getFederalHoliday(d);
        // Starts on a normal Monday
        if (dow === 1 && !isHol) return d;
        // OR starts on a Tuesday if the preceding Monday was a holiday
        if (dow === 2) {
            let prev = addDays(d, -1);
            if (getFederalHoliday(prev)) return d;
        }
        d = addDays(d, -1); // Walk backwards until we hit a start
    }
}

// Finds the last day of a dynamic call block
function getCallCycleEnd(cycleStart) {
    let d = addDays(cycleStart, 1);
    while (true) {
        let dow = d.getDay();
        let isHol = getFederalHoliday(d);
        if (dow === 1 && !isHol) return addDays(d, -1);
        if (dow === 2 && getFederalHoliday(addDays(d, -1))) return addDays(d, -1);
        d = addDays(d, 1);
    }
}

// Counts how many call blocks have passed since the anchor to assign the right doctor
function callCycleIndex(cycleStart) {
    let current = new Date(CALL_ANCHOR);
    let idx = 0;
    let target = cycleStart.getTime();

    if (target >= current.getTime()) {
        while (current.getTime() < target) {
            current = addDays(current, 1);
            let dow = current.getDay();
            let isHol = getFederalHoliday(current);
            if (dow === 1 && !isHol) idx++;
            else if (dow === 2 && getFederalHoliday(addDays(current, -1))) idx++;
        }
    } else {
        while (current.getTime() > target) {
            let dow = current.getDay();
            let isHol = getFederalHoliday(current);
            if (dow === 1 && !isHol) idx--;
            else if (dow === 2 && getFederalHoliday(addDays(current, -1))) idx--;
            current = addDays(current, -1);
        }
    }
    return idx;
}

// Workday index — counts weekdays since WORK_ANCHOR (Mon Jan 1 2024 = 0).
function workDayIndex(date) {
    if (isWeekend(date)) return null;
    const ds = daysBetween(WORK_ANCHOR, date);
    const fullWeeks = Math.floor(ds / 7);
    const remainder = ((ds % 7) + 7) % 7;
    return fullWeeks * 5 + remainder;
}

// Workday index — counts weekdays since WORK_ANCHOR (Mon Jan 1 2024 = 0).
// Returns null for weekend dates (no service).
function workDayIndex(date) {
    if (isWeekend(date)) return null;
    const ds = daysBetween(WORK_ANCHOR, date);
    const fullWeeks = Math.floor(ds / 7);
    const remainder = ((ds % 7) + 7) % 7;   // 0=Mon, 1=Tue, … 4=Fri (anchor is Mon)
    return fullWeeks * 5 + remainder;
}

// Default on-call: cycles through pathologists using the block index
function defaultOnCallId(cycleStart) {
    if (pathologists.length === 0) return null;
    const w = callCycleIndex(cycleStart);
    const idx = ((w % pathologists.length) + pathologists.length) % pathologists.length;
    return pathologists[idx].id;
}

// Service lookup doesn't change
function defaultServiceId(pathId, date) {
    const pIdx = pathologists.findIndex(p => p.id === pathId);
    if (pIdx < 0) return SERVICES[0].id;
    const wdi = workDayIndex(date);
    if (wdi === null) return null;
    const sIdx = ((pIdx + wdi) % SERVICES.length + SERVICES.length) % SERVICES.length;
    return SERVICES[sIdx].id;
}

// ────────────── EFFECTIVE LOOKUPS (overrides win) ──────────────
function onCallIdForCycle(cycleStart) {
    const k = fmt(cycleStart);
    if (onCallOverrides[k]) return onCallOverrides[k];
    return defaultOnCallId(cycleStart);
}

function onCallIdForDay(date) {
    const dk = fmt(date);
    if (onCallDayOverrides[dk]) return onCallDayOverrides[dk];
    return onCallIdForCycle(getCallCycleStart(date));
}

function isOnPto(pathId, date) {
    const t = date.getTime();
    return vacations.find(v =>
        v.pathologistId === pathId &&
        t >= v.start.getTime() &&
        t <= v.end.getTime()
    );
}

// Compute the NATURAL service assignments for ALL pathologists on a single date —
// i.e. plain rotation + PTO cascade + manual overrides, BEFORE the hard-rule swap
// pass. Hard-rule fix-ups happen in getDayAssignments() (the public function) so
// that look-ahead/look-back logic can use this natural baseline as input.
// Returns: { [pathId]: { type: 'service'|'pto'|'off', service, onCall } }
//
// Rules:
//   - Weekends: no service (all pathologists "off"); on-call still applies (weekly).
//   - Weekdays: each pathologist rotates daily through cyto → bigs → huntley → wfh.
//   - When ANY pathologist is on PTO, WFH is unstaffed; whoever was on WFH steps in
//     to cover the PTO pathologist's slot. With multiple PTO, drop services from the
//     bottom of the priority list (wfh, then huntley, then bigs).
//   - Manual day-level service overrides are applied last (overrides win).
const _naturalCache = new Map();
function getNaturalDayAssignments(date) {
    const cacheKey = fmt(date) + '|' + pathologists.length;
    if (_naturalCache.has(cacheKey)) return _naturalCache.get(cacheKey);

    const onCallId = onCallIdForDay(date);
    const result = {};

    // Weekend or federal holiday: nobody on service, but on-call status applies
    if (isWeekend(date) || getFederalHoliday(date)) {
        pathologists.forEach(p => {
            const onPto = !!isOnPto(p.id, date);
            result[p.id] = {
                type: onPto ? 'pto' : 'off',
                service: null,
                onCall: onCallId === p.id,
            };
        });
        _naturalCache.set(cacheKey, result);
        return result;
    }

    // Weekday — start with default daily rotation
    const slots = pathologists.map((p, pIdx) => ({
        pathId: p.id,
        pIdx,
        onPto: !!isOnPto(p.id, date),
        serviceId: defaultServiceId(p.id, date),
    }));

    // PTO/WFH cascade: drop services from the bottom of the priority list.
    // 1 PTO → drop wfh; 2 PTO → drop wfh+huntley; 3 PTO → drop wfh+huntley+bigs.
    const ptoCount = slots.filter(s => s.onPto).length;
    if (ptoCount > 0) {
        slots.forEach(s => { if (s.onPto) s.serviceId = null; });
        const working = slots.filter(s => !s.onPto);

        if (working.length === 2) {
            // Rule 1: EXACTLY 2 WORKING (Huntley and the Cyto/Bigs combo)
            let huntleyDoc = working.find(s => s.serviceId === 'huntley')
                || working.find(s => s.serviceId === 'wfh')
                || working.find(s => s.serviceId === 'bigs')
                || working[1];

            working.forEach(s => {
                s.serviceId = (s === huntleyDoc) ? 'huntley' : 'cytobigs';
            });

        } else if (working.length === 1) {
            // EXACTLY 1 WORKING
            working[0].serviceId = 'cytobigs';

        } else if (working.length === 3) {
            // Rule 1: EXACTLY 3 WORKING (Cyto, Bigs, Huntley. Drop WFH)
            const droppedIds = ['wfh'];
            const displaced = working.filter(s => droppedIds.includes(s.serviceId));
            const fixed = working.filter(s => !droppedIds.includes(s.serviceId));
            const fixedIds = fixed.map(s => s.serviceId);

            const activeIds = ['cyto', 'bigs', 'huntley'];
            const vacantIds = activeIds.filter(id => !fixedIds.includes(id));

            displaced.sort((a, b) => a.pIdx - b.pIdx);
            displaced.forEach((s, i) => { s.serviceId = vacantIds[i] || null; });
        }
    }
    // Apply per-day service overrides (overrides win for that pathologist)
    const dayKey = fmt(date);
    const dayOv = serviceOverrides[dayKey] || {};
    slots.forEach(s => {
        if (!s.onPto && dayOv[s.pathId]) s.serviceId = dayOv[s.pathId];
    });

    // Build result
    slots.forEach(s => {
        if (s.onPto) {
            result[s.pathId] = { type: 'pto', service: null, onCall: onCallId === s.pathId };
        } else if (!s.serviceId) {
            result[s.pathId] = { type: 'off', service: null, onCall: onCallId === s.pathId };
        } else {
            result[s.pathId] = {
                type: 'service',
                service: SERVICE_BY_ID[s.serviceId],
                onCall: onCallId === s.pathId,
            };
        }
    });

    _naturalCache.set(cacheKey, result);
    return result;
}

// ────────────── HARD-RULE LAYER ──────────────
//
// After computing the natural rotation, we enforce two cross-day constraints:
//   Rule 1: A pathologist cannot be on McH Bigs the workday before they begin
//           PTO of more than 1 (work)day.
//   Rule 2: A pathologist cannot be on Bigs or Breast Bx/WFH the workday before
//           they are on Breast Bx/WFH service.
//
// "The day before" is the previous *workday* (so Monday's day-before is the
// previous Friday). Multi-day PTO is 2+ workdays in a row (a Fri+Mon range
// counts as multi-day even though there's a weekend in between).
//
// When a violation exists, we swap the offending pathologist's service with
// another pathologist's service for that same day, picking a partner whose
// post-swap services don't introduce new violations. If no clean swap exists
// we apply the best-effort swap and flag the day so it's visibly marked.

const _dayCache = new Map();
const _violationFlags = new Map();   // dayKey → array of issue strings (display only)

// True iff `pathId` has PTO on `tomorrow` AND on the workday after that —
// i.e. the start of "more than 1 day" of PTO. Skips weekends so a Fri→Mon
// PTO range counts as multi-day.
function isMultiDayPtoStartingOn(pathId, tomorrow) {
    if (!isOnPto(pathId, tomorrow)) return false;
    const dayAfter = nextWorkday(tomorrow);
    return !!isOnPto(pathId, dayAfter);
}

// Reasons a pathologist's assignment on `date` would be a hard-rule violation.
// Uses naturalToday (today's services) and naturalTomorrow / naturalYesterday
// to look across days. Returns an array of human-readable issue strings; empty
// array = no violation.
function violationsFor(pId, todaySvcId, date, naturalTomorrow, naturalYesterday) {
    if (!todaySvcId) return [];
    const issues = [];
    const tomorrow = nextWorkday(date);

    // Treat the combo service as "bigs" for rule evaluation
    const isBigsToday = todaySvcId === 'bigs' || todaySvcId === 'cytobigs';

    // Rule 2: No bigs the day before ANY PTO
    if (isBigsToday && isOnPto(pId, tomorrow)) {
        issues.push('Rule 2: Bigs day before PTO');
    }

    // Rule 3 (Forward): No bigs the day before WFH
    const tmrwSvc = naturalTomorrow && naturalTomorrow[pId] && naturalTomorrow[pId].service
        ? naturalTomorrow[pId].service.id : null;
    if (isBigsToday && tmrwSvc === 'wfh') {
        issues.push('Rule 3: Bigs day before WFH');
    }

    // Rule 3 (Backward): No WFH the day after Bigs (prevents swaps from creating a violation)
    if (todaySvcId === 'wfh' && naturalYesterday) {
        const yestSvc = naturalYesterday[pId] && naturalYesterday[pId].service
            ? naturalYesterday[pId].service.id : null;
        if (yestSvc === 'bigs' || yestSvc === 'cytobigs') {
            issues.push('Rule 3: WFH following Bigs');
        }
    }

    // Rule 4: Avoid repeating service days
    if (naturalYesterday) {
        const yestSvc = naturalYesterday[pId] && naturalYesterday[pId].service
            ? naturalYesterday[pId].service.id : null;
        if (todaySvcId === yestSvc) {
            issues.push('Rule 4: Repeated service (' + todaySvcId + ')');
        }
    }

    return issues;
}
// Apply hard-rule swaps to today's natural assignments.
// Pathologists with a manual day-level service override on this date are
// "locked" — the rule pass won't move them. (They CAN still be flagged.)
function applyHardRules(date, naturalToday, naturalTomorrow, naturalYesterday) {
    const result = {};
    const working = [];

    // Shallow clone and grab everyone working today
    for (const pid in naturalToday) {
        result[pid] = Object.assign({}, naturalToday[pid]);
        if (result[pid].type === 'service') working.push(pid);
    }

    const dayKey = fmt(date);
    const overrides = serviceOverrides[dayKey] || {};
    const isLocked = pid => Object.prototype.hasOwnProperty.call(overrides, String(pid))
        || Object.prototype.hasOwnProperty.call(overrides, pid);

    // Filter out pathologists who have manual overrides pinned for today
    const unlockedPids = working.filter(pid => !isLocked(pid));
    const unlockedServices = unlockedPids.map(pid => result[pid].service);

    if (unlockedPids.length > 0) {
        // Helper to generate all possible combinations of the available services today
        function getPermutations(arr) {
            if (arr.length <= 1) return [arr];
            const perms = [];
            for (let i = 0; i < arr.length; i++) {
                const current = arr[i];
                const remaining = arr.slice(0, i).concat(arr.slice(i + 1));
                const remainingPerms = getPermutations(remaining);
                for (const perm of remainingPerms) {
                    perms.push([current].concat(perm));
                }
            }
            return perms;
        }

        const allPerms = getPermutations(unlockedServices);

        let bestPerm = null;
        let bestScore = Infinity;

        // Test every layout to find the one with 0 hard-rule violations 
        // and the fewest changes to the natural rotation.
        for (const perm of allPerms) {
            let currentScore = 0;
            let changes = 0;

            for (let i = 0; i < unlockedPids.length; i++) {
                const pid = unlockedPids[i];
                const svcId = perm[i].id;

                if (svcId !== result[pid].service.id) changes++;

                const issues = violationsFor(pid, svcId, date, naturalTomorrow, naturalYesterday);
                currentScore += issues.length * 100; // Heavily penalize actual rule breaks
            }

            const totalScore = currentScore + changes; // Tie-breaker: minimal disruption

            if (totalScore < bestScore) {
                bestScore = totalScore;
                bestPerm = perm;
            }
        }

        // Apply the winning permutation
        for (let i = 0; i < unlockedPids.length; i++) {
            result[unlockedPids[i]].service = bestPerm[i];
        }
    }

    // Double check and flag any unfixable violations (rare)
    const remaining = [];
    for (const pid of working) {
        const issues = violationsFor(pid, result[pid].service.id, date, naturalTomorrow, naturalYesterday);
        issues.forEach(msg => {
            const p = pathologists.find(x => String(x.id) === String(pid));
            remaining.push((p ? p.name.replace(/^Dr\. /, '') : pid) + ' — ' + msg);
        });
    }

    if (remaining.length > 0) _violationFlags.set(dayKey, remaining);
    else _violationFlags.delete(dayKey);

    return result;
}
// Public day-assignment lookup (used by all renderers and modals).
// Wraps the natural rotation with the hard-rule swap layer.
function getDayAssignments(date) {
    const cacheKey = fmt(date) + '|' + pathologists.length + '|R';
    if (_dayCache.has(cacheKey)) return _dayCache.get(cacheKey);

    // Pre-cutoff dates render as blank — no rotation, no PTO, no on-call.
    if (isBeforeEarliest(date)) {
        const blank = {};
        pathologists.forEach(p => {
            blank[p.id] = { type: 'blank', service: null, onCall: false };
        });
        _dayCache.set(cacheKey, blank);
        return blank;
    }

    const natural = getNaturalDayAssignments(date);

    // Weekend or federal holiday: no service rotation, no hard rules to apply.
    if (isWeekend(date) || getFederalHoliday(date)) {
        _dayCache.set(cacheKey, natural);
        return natural;
    }

    // For look-ahead/look-back we use the NATURAL baseline of neighbouring
    // workdays — this avoids recursive dependencies between days.
    const tmrw = nextWorkday(date);
    const yest = prevWorkday(date);
    const naturalTomorrow = getNaturalDayAssignments(tmrw);
    const naturalYesterday = getNaturalDayAssignments(yest);

    const result = applyHardRules(date, natural, naturalTomorrow, naturalYesterday);
    _dayCache.set(cacheKey, result);
    return result;
}

// Returns the array of unfixable-violation messages for the given date, or
// null if the day has no flagged issues. The hard-rule pass populates this
// map as a side effect, so we make sure the day has been computed first.
function violationsForDay(date) {
    getDayAssignments(date);   // ensure flags map is populated for this date
    const list = _violationFlags.get(fmt(date));
    return (list && list.length > 0) ? list : null;
}

function getAssignment(pathId, date) {
    return getDayAssignments(date)[pathId];
}


function clearDayCache() {
    _dayCache.clear();
    _naturalCache.clear();
    _violationFlags.clear();
}

// ────────────── ROTATION OPTIMIZER (recompute future schedule) ──────────────
//
// After a service or PTO change, walk forward from opts.fromDate (default
// 180 calendar days) and, for each workday, write the {pid: serviceId}
// arrangement that:
//   1. covers the required services for that day's working count (red flag), then
//   2. minimizes yellow-flag violations, then
//   3. follows the cyto → bigs → huntley → wfh rotation as closely as possible.
//
// Required services (mirrors coverageViolationsForDay):
//   2 working → Huntley + McH cyto/gross/bigs (combo)
//   3 working → Huntley + McH cyto/gross + McH bigs
//   4 working → Huntley + McH cyto/gross + McH bigs + Breast Bx/WFH
//   5+ working → as for 4, with extras on Breast Bx/WFH
//
// Score (lower wins, lexicographic — earlier components dominate):
//   v1   — bigs the workday before PTO              (soft 1)
//   v2   — bigs adjacent to Breast Bx/WFH           (soft 2, both directions)
//   v3   — same service as yesterday                (soft 2 cont.)
//   skip — total deviation from the cyto/bigs/huntley/wfh cycle
//
// Worked example for the wfh slot when n=4: yesterday → today=wfh score is
//   huntley→wfh: (0,0,0,0)   ← natural cycle step, best
//   cyto→wfh:    (0,0,0,2)   ← off-cycle but no soft conflict
//   wfh→wfh:     (0,0,1,3)   ← same-service violation
//   bigs→wfh:    (0,1,0,1)   ← bigs-before-wfh violation, worst
// matching the user-specified priority Huntley > cyto > wfh > bigs.
//
// pinnedByDay[dayKey] = {pid: serviceId} locks specific paths to specific
// services (the admin's just-made change). Pins are honored even when they
// break coverage — the red-flag layer surfaces those cases for review.
//
// opts:
//   fromDate     — required Date; first day of the recompute window
//   horizonDays  — calendar days to walk forward (default 180)
//   dayBeforeFix — also re-optimize the workday before fromDate (default true)
//
// Returns { processed, dayBeforeProcessed }.

const ROTATION_CYCLE = ['cyto', 'bigs', 'huntley', 'wfh'];

// cytobigs covers both cyto + bigs; for cycle purposes treat it as bigs
// (the next step from cytobigs is huntley = bigs's natural successor).
function _cycleId(svcId) { return svcId === 'cytobigs' ? 'bigs' : svcId; }

function _nextInCycle(svcId) {
    const i = ROTATION_CYCLE.indexOf(_cycleId(svcId));
    return i < 0 ? null : ROTATION_CYCLE[(i + 1) % 4];
}

// Forward distance in the cycle: 0 if same, 1 if one step further, etc.
function _cycleSkip(actualId, expectedId) {
    const a = ROTATION_CYCLE.indexOf(_cycleId(actualId));
    const e = ROTATION_CYCLE.indexOf(_cycleId(expectedId));
    if (a < 0 || e < 0) return 0;
    return (a - e + 4) % 4;
}

// Score a {pid: serviceId} candidate as [v1, v2, v3, skip].
function _scoreAssignment(candidate, prevAssign, nextAssign) {
    let v1 = 0, v2 = 0, v3 = 0, skip = 0;
    for (const pid in candidate) {
        const sid = candidate[pid];
        if (!sid) continue;
        const isBigs = (sid === 'bigs' || sid === 'cytobigs');
        const isWfh  = (sid === 'wfh');

        const next = nextAssign && (nextAssign[pid] || nextAssign[String(pid)]);
        const prev = prevAssign && (prevAssign[pid] || prevAssign[String(pid)]);
        const prevId = (prev && prev.type === 'service' && prev.service)
            ? prev.service.id : null;

        // soft 1 (forward): bigs today + PTO tomorrow
        if (isBigs && next && next.type === 'pto') v1++;

        // soft 2 (forward): bigs today + wfh tomorrow
        if (isBigs && next && next.type === 'service'
            && next.service && next.service.id === 'wfh') v2++;
        // soft 2 (backward): wfh today + bigs yesterday — captures the
        // same transition from the other side, since prev is the most
        // reliably-known neighbour during a forward-walking recompute.
        if (isWfh && (prevId === 'bigs' || prevId === 'cytobigs')) v2++;

        // soft 3: same service two days in a row (cycle-equivalent)
        if (prevId && _cycleId(prevId) === _cycleId(sid)) v3++;

        // rotation skip: from yesterday's service, expected next is +1 in cycle
        if (prevId) {
            const expected = _nextInCycle(prevId);
            if (expected) skip += _cycleSkip(sid, expected);
        }
    }
    return [v1, v2, v3, skip];
}

function _compareScores(a, b) {
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

function _allPermutations(arr) {
    if (arr.length <= 1) return [arr.slice()];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
        const rest = arr.slice(0, i).concat(arr.slice(i + 1));
        _allPermutations(rest).forEach(p => out.push([arr[i]].concat(p)));
    }
    return out;
}

// Synthesize a getDayAssignments-shape map from a {pid: serviceId} override,
// so an in-progress forward pass can read its own writes as neighbour state.
function _synthesizeAssign(date, overrideMap) {
    const result = {};
    pathologists.forEach(p => {
        if (isOnPto(p.id, date)) {
            result[p.id] = { type: 'pto', service: null, onCall: false };
            return;
        }
        const sid = overrideMap && (overrideMap[p.id] || overrideMap[String(p.id)]);
        if (sid && SERVICE_BY_ID[sid]) {
            result[p.id] = { type: 'service', service: SERVICE_BY_ID[sid], onCall: false };
        } else {
            result[p.id] = { type: 'off', service: null, onCall: false };
        }
    });
    return result;
}

// Required service multiset for N working pathologists. For N > 4 we pad
// with extra wfh slots so every working pathologist gets assigned (multiple
// paths can each work from home; duplicating a McHenry station service
// would put two paths at the same lab).
function requiredServicesFor(n) {
    if (n >= 4) {
        const out = ['cyto', 'bigs', 'huntley', 'wfh'];
        for (let i = 4; i < n; i++) out.push('wfh');
        return out;
    }
    if (n === 3) return ['cyto', 'bigs', 'huntley'];
    if (n === 2) return ['huntley', 'cytobigs'];
    return null;
}

// Compute the optimal full {pid: serviceId} map for `date`. Returns null
// when nothing changes (day already optimal under current pins).
function fixDayWithRules(date, pins, prevAssign, nextAssign) {
    const assign = getDayAssignments(date);
    const working = pathologists.filter(p =>
        assign[p.id] && assign[p.id].type === 'service'
    );
    const n = working.length;
    if (n < 2) return null;
    const required = requiredServicesFor(n);
    if (!required) return null;

    const currentSvc = {};
    working.forEach(p => {
        currentSvc[p.id] = assign[p.id].service && assign[p.id].service.id;
    });

    // Honor pins; subtract pinned services from the required pool.
    const result = {};
    const remaining = required.slice();
    const unpinned = [];
    working.forEach(p => {
        const pinId = pins && (pins[p.id] || pins[String(p.id)]);
        if (pinId) {
            result[p.id] = pinId;
            const idx = remaining.indexOf(pinId);
            if (idx >= 0) remaining.splice(idx, 1);
        } else {
            unpinned.push(p.id);
        }
    });

    if (remaining.length !== unpinned.length) {
        // Pins point to services outside `required`. Fall back to a
        // minimal-change coverage fill and let the red-flag layer surface
        // the conflict — soft-rule scoring is undefined here.
        const displaced = [];
        unpinned.forEach(pid => {
            const cur = currentSvc[pid];
            const idx = cur ? remaining.indexOf(cur) : -1;
            if (idx >= 0) {
                result[pid] = cur;
                remaining.splice(idx, 1);
            } else {
                displaced.push(pid);
            }
        });
        displaced.forEach((pid, i) => {
            if (remaining[i]) result[pid] = remaining[i];
        });
    } else {
        // Permute the remaining services across the unpinned paths and
        // pick the arrangement with the best (v1, v2, v3, skip) score.
        let bestPerm = null;
        let bestScore = null;
        const perms = _allPermutations(remaining);
        for (const perm of perms) {
            const cand = Object.assign({}, result);
            for (let i = 0; i < unpinned.length; i++) {
                cand[unpinned[i]] = perm[i];
            }
            const score = _scoreAssignment(cand, prevAssign, nextAssign);
            if (!bestScore || _compareScores(score, bestScore) < 0) {
                bestScore = score;
                bestPerm = cand;
            }
        }
        if (bestPerm) {
            for (const pid in bestPerm) result[pid] = bestPerm[pid];
        }
    }

    // No-op if every working path's service is unchanged.
    let changed = false;
    for (const p of working) {
        if (result[p.id] !== currentSvc[p.id]) { changed = true; break; }
    }
    if (!changed) return null;

    // Drop unassigned paths (only when pins overconstrain).
    const clean = {};
    let count = 0;
    for (const pid in result) {
        if (result[pid]) { clean[pid] = result[pid]; count++; }
    }
    return count > 0 ? clean : null;
}

async function recomputeFutureSchedule(pinnedByDay, opts) {
    pinnedByDay = pinnedByDay || {};
    opts = opts || {};
    const fromDate = opts.fromDate;
    if (!fromDate) return { processed: 0, dayBeforeProcessed: false };
    const horizonDays = Math.max(1, opts.horizonDays || 180);
    const dayBeforeFix = opts.dayBeforeFix !== false;

    const writes = {};
    let processed = 0;
    let dayBeforeProcessed = false;

    // neighbourAssign reads pending writes from THIS pass first, so each
    // iteration's prev/next lookups see already-optimized neighbours
    // instead of stale pre-recompute state. Critical for soft-rule
    // scoring across consecutive days.
    function neighbourAssign(d) {
        const k = 'scheduler/serviceOverrides/' + fmt(d);
        if (writes[k]) return _synthesizeAssign(d, writes[k]);
        return getDayAssignments(d);
    }

    // Forward pass: fromDate → fromDate + horizonDays - 1.
    for (let i = 0; i < horizonDays; i++) {
        const d = addDays(fromDate, i);
        if (isBeforeEarliest(d)) continue;
        if (isWeekend(d)) continue;
        if (getFederalHoliday(d)) continue;

        const dayKey = fmt(d);
        const prevA = neighbourAssign(prevWorkday(d));
        const nextA = neighbourAssign(nextWorkday(d));
        const fixed = fixDayWithRules(d, pinnedByDay[dayKey] || null, prevA, nextA);
        if (!fixed) continue;
        writes['scheduler/serviceOverrides/' + dayKey] = fixed;
        processed++;
    }

    // Day-before fix: re-optimize the workday before fromDate, using the
    // now-optimized fromDate as its nextAssign so soft rule 1
    // (bigs-before-PTO) and soft rule 2 (bigs-before-wfh) are checked
    // against the admin's actual change.
    if (dayBeforeFix) {
        const prev = prevWorkday(fromDate);
        if (!isBeforeEarliest(prev) && !isWeekend(prev) && !getFederalHoliday(prev)) {
            const prevPrev = neighbourAssign(prevWorkday(prev));
            const nextDay  = neighbourAssign(fromDate);
            const fixed = fixDayWithRules(
                prev, pinnedByDay[fmt(prev)] || null, prevPrev, nextDay);
            if (fixed) {
                writes['scheduler/serviceOverrides/' + fmt(prev)] = fixed;
                processed++;
                dayBeforeProcessed = true;
            }
        }
    }

    if (Object.keys(writes).length > 0) {
        await db.ref().update(writes);
    }
    return { processed: processed, dayBeforeProcessed: dayBeforeProcessed };
}

function ptoDaysScheduled(pathId) {
    // Collect and clamp all ranges for this pathologist.
    const ranges = [];
    vacations.filter(v => v.pathologistId === pathId).forEach(v => {
        const effStart = v.start.getTime() < EARLIEST_DATE.getTime() ? EARLIEST_DATE : v.start;
        if (v.end.getTime() < effStart.getTime()) return;
        ranges.push({ start: new Date(effStart), end: new Date(v.end) });
    });

    if (ranges.length === 0) return 0;

    // Sort by start date, then merge overlapping or duplicate ranges to avoid
    // double-counting days when the same PTO period has been entered more than once.
    ranges.sort((a, b) => a.start.getTime() - b.start.getTime());
    const merged = [{ start: ranges[0].start, end: ranges[0].end }];
    for (let i = 1; i < ranges.length; i++) {
        const last = merged[merged.length - 1];
        const cur = ranges[i];
        if (cur.start.getTime() <= addDays(last.end, 1).getTime()) {
            // Overlapping or adjacent — extend the merged range if needed.
            if (cur.end.getTime() > last.end.getTime()) last.end = cur.end;
        } else {
            merged.push({ start: cur.start, end: cur.end });
        }
    }

    // Count working days (weekdays, non-holidays) across the merged ranges.
    let count = 0;
    merged.forEach(r => {
        for (let d = new Date(r.start); d.getTime() <= r.end.getTime(); d = addDays(d, 1)) {
            if (!isWeekend(d) && !getFederalHoliday(d)) count++;
        }
    });
    return count;
}

// ────────────── LOADING ──────────────
function setLoadingStatus(msg) {
    const el = document.getElementById('loadingStatus');
    if (el) el.textContent = msg;
}
function hideLoading() {
    const el = document.getElementById('loadingOverlay');
    if (!el) return;
    el.classList.add('hidden');
    setTimeout(() => el.remove(), 500);
}
function checkReady() {
    if (pathologistsReady && vacationsReady) {
        hideLoading();
        renderAll();
        // Once data is loaded, decide whether to show the login screen.
        // If a returning user is already signed in on this device, we just
        // verify their stored id still corresponds to a real pathologist.
        if (loggedInPathId !== null && loggedInPathId !== GROSS_ROOM_ID && !pathologists.find(p => p.id === loggedInPathId)) {
            // Stored id no longer matches anyone — clear it and force re-login
            localStorage.removeItem(AUTH_STORAGE_KEY);
            loggedInPathId = null;
        }
        if (loggedInPathId === null) {
            showLoginOverlay();
        } else {
            // Default the filter based on who is signed in.
            // Gross room always sees all pathologists; individual pathologists
            // default to their own view.
            if (isGrossRoom()) {
                setPathFilter('all');
            } else if (currentPathFilter === 'all') {
                setPathFilter(String(loggedInPathId));
            }
            renderAll();
        }
    }
}

// Show/hide the "Me" tab and set the active filter appropriately.
// - When signed in:  show "Me", default to the user's own id (or preserve a
//                    previously valid choice).
// - When signed out: hide "Me", force "All".
function populatePathFilter() {
    const meTab = document.getElementById('pathTabMe');
    if (!meTab) return;

    // Gross room: always show all pathologists with no option to switch
    if (isGrossRoom()) {
        meTab.style.display = 'none';
        setPathFilter('all');
        return;
    }

    const me = loggedInPathId !== null
        ? pathologists.find(p => p.id === loggedInPathId)
        : null;

    if (me) {
        meTab.style.display = '';
        const validVals = new Set(['all', String(me.id)]);
        const next = validVals.has(currentPathFilter) ? currentPathFilter : String(me.id);
        setPathFilter(next);
    } else {
        meTab.style.display = 'none';
        setPathFilter('all');
    }
}

function showLoginOverlay() {
    const overlay = document.getElementById('loginOverlay');
    const sel = document.getElementById('loginPath');
    const pwInput = document.getElementById('loginPassword');
    const errEl = document.getElementById('loginError');

    sel.innerHTML = '<option value="">— Select your name —</option>' +
        pathologists.map(p => `<option value="${p.id}">${p.name}</option>`).join('') +
        '<option value="" disabled>──────────────</option>' +
        `<option value="${GROSS_ROOM_ID}">Gross Room</option>`;
    pwInput.value = '';
    errEl.textContent = '';
    overlay.style.display = 'flex';
    // Focus the name dropdown so the user can start tabbing right away
    setTimeout(() => sel.focus(), 50);
}

function hideLoginOverlay() {
    const overlay = document.getElementById('loginOverlay');
    if (overlay) overlay.style.display = 'none';
}

async function attemptLogin() {
    const sel = document.getElementById('loginPath');
    const pwInput = document.getElementById('loginPassword');
    const errEl = document.getElementById('loginError');
    const btn = document.getElementById('loginSubmit');

    const pidRaw = sel.value;
    const pwAttempt = pwInput.value.trim();
    errEl.textContent = '';

    if (!pidRaw) { errEl.textContent = 'Please select your name.'; return; }
    if (!pwAttempt) { errEl.textContent = 'Please enter your password.'; return; }

    const isGrossRoomLogin = pidRaw === GROSS_ROOM_ID;
    const pid = isGrossRoomLogin ? GROSS_ROOM_ID : parseInt(pidRaw, 10);
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
        const snap = await db.ref('scheduler/passwords/' + pid).once('value');
        const expected = snap.val();
        if (!expected) {
            errEl.textContent = 'No password on file for this user. Contact admin.';
            return;
        }
        if (pwAttempt.toLowerCase() !== expected.toLowerCase()) {
            errEl.textContent = 'Incorrect password.';
            pwInput.select();
            return;
        }
        // Success — persist and proceed
        loggedInPathId = pid;
        localStorage.setItem(AUTH_STORAGE_KEY, String(pid));
        hideLoginOverlay();
        // Refresh the filter tabs. Gross room always shows all; individual
        // pathologists default to their own view.
        populatePathFilter();
        if (!isGrossRoomLogin) {
            setPathFilter(String(pid));
        }
        renderAll();
    } catch (err) {
        errEl.textContent = 'Login failed: ' + (err.message || 'unknown error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Sign in';
    }
}


// Wire up login form events (the elements always exist in the DOM)
document.getElementById('loginSubmit').addEventListener('click', attemptLogin);
document.getElementById('loginPassword').addEventListener('keydown', e => {
    if (e.key === 'Enter') attemptLogin();
});
document.getElementById('loginPath').addEventListener('keydown', e => {
    if (e.key === 'Enter') attemptLogin();
});

// ────────────── FIREBASE LISTENERS ──────────────
db.ref('scheduler/pathologists').on('value', async snap => {
    if (!snap.exists()) {
        setLoadingStatus('Seeding pathologists…');
        const batch = {};
        SEED_PATHOLOGISTS.forEach(p => { batch[p.id] = p; });
        await db.ref('scheduler/pathologists').set(batch);
        return;
    }
    const raw = snap.val();
    pathologists = Object.values(raw).sort((a, b) => a.id - b.id);
    clearDayCache();

    // Populate the header filter (centralized — respects login state)
    populatePathFilter();

    if (!pathologistsReady) {
        pathologistsReady = true;
        setLoadingStatus('Loading PTO…');
    }
    checkReady();
    if (vacationsReady) renderAll();
}, err => {
    setLoadingStatus('Firebase error: ' + err.message);
    console.error('Firebase pathologists error:', err);
});

db.ref('scheduler/vacations').on('value', snap => {
    if (!snap.exists()) {
        vacations = [];
    } else {
        const raw = snap.val();
        vacations = Object.entries(raw).map(([key, v]) => ({
            key,
            pathologistId: v.pathologistId,
            start: parseDate(v.start),
            end: parseDate(v.end),
        }));
    }
    clearDayCache();
    if (!vacationsReady) vacationsReady = true;
    checkReady();
    if (pathologistsReady) renderAll();
}, err => {
    console.error('Firebase vacations error:', err);
});

db.ref('scheduler/onCallOverrides').on('value', snap => {
    onCallOverrides = snap.exists() ? snap.val() : {};
    clearDayCache();
    if (pathologistsReady && vacationsReady) renderAll();
});

db.ref('scheduler/onCallDayOverrides').on('value', snap => {
    onCallDayOverrides = snap.exists() ? snap.val() : {};
    clearDayCache();
    if (pathologistsReady && vacationsReady) renderAll();
});

db.ref('scheduler/serviceOverrides').on('value', snap => {
    serviceOverrides = snap.exists() ? snap.val() : {};
    clearDayCache();
    if (pathologistsReady && vacationsReady) renderAll();
});

// Procedures: hourly entries for the week-view grid. Independent of the
// pathologist rotation, so we don't need to clear the day cache or wait
// on it to render the rest of the calendar — just re-render the main view
// when this changes (and only if we're currently on the week view).
db.ref('scheduler/procedures').on('value', snap => {
    procedures = snap.exists() ? snap.val() : {};
    if (pathologistsReady && vacationsReady && view === 'week') renderMain();
}, err => {
    console.error('Firebase procedures error:', err);
});

// Request queue: every change a non-admin wants to make goes here first
// and is then approved/denied by the admin.  Each request looks like:
//   { requesterId, type, status, createdAt, payload, note,
//     decisionAt?, decisionBy?, decisionNote? }
db.ref('scheduler/requests').on('value', snap => {
    const next = snap.exists() ? snap.val() : {};

    // After the first load, detect newly-added pending requests so we can
    // show a small alert to the admin (one toast per refresh, not spammy).
    if (_seenRequestKeys && isAdmin()) {
        const newPending = Object.entries(next).filter(([k, r]) =>
            !_seenRequestKeys.has(k) && r && r.status === 'pending'
        );
        if (newPending.length > 0) {
            showToast(`${newPending.length} new request${newPending.length === 1 ? '' : 's'} pending review.`);
        }
    }
    _seenRequestKeys = new Set(Object.keys(next));

    requests = next;
    requestsReady = true;
    updateRequestsBadge();

    // If the requests modal is open, refresh its body live
    if (document.getElementById('requestsModalBack').classList.contains('open')) {
        renderRequestsList();
    }
}, err => {
    console.error('Firebase requests error:', err);
});

// ────────────── SIDEBAR ──────────────
function renderSidebar() {
    // Show/hide admin-only controls based on signed-in user's role
    const admin = isAdmin();
    const grossRoom = isGrossRoom();
    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) exportBtn.style.display = admin ? '' : 'none';

    // Gross room cannot manage PTO or view requests at all — hide those buttons
    const addPtoBtnEl = document.getElementById('addPtoBtn');
    if (addPtoBtnEl) addPtoBtnEl.style.display = grossRoom ? 'none' : '';

    // The "Manage PTO" label changes to "Request PTO" for non-admins (not gross room)
    const ptoBtnLabel = document.getElementById('addPtoBtnLabel');
    if (ptoBtnLabel) ptoBtnLabel.textContent = admin ? 'Manage PTO' : 'Request PTO';

    // Show/hide & update the Requests button + badge
    updateRequestsBadge();

    const cs = getCallCycleStart(today);
    const ce = getCallCycleEnd(cs);
    const ocId = onCallIdForDay(today);
    const oc = pathologists.find(p => p.id === ocId);
    const ocEl = document.getElementById('ocCallout');
    if (oc) {
        ocEl.innerHTML = `
        <div class="label">On call this week</div>
        <div class="name">${oc.name.replace(/^Dr\. /, '')}</div>
        <div class="week">${MONTHS_SHORT[cs.getMonth()]} ${cs.getDate()} – ${MONTHS_SHORT[ce.getMonth()]} ${ce.getDate()}</div>
      `;
    }

    // Pathologist list (compact)
    const list = document.getElementById('pathList');
    list.innerHTML = pathologists.map(p => {
        const used = ptoDaysScheduled(p.id);
        const allot = p.vacationAllotted;
        return `<div class="path-card" style="--c:${p.color}">
        <div class="dot"></div>
        <div class="info">
          <div class="name">${p.name.replace(/^Dr\. /, '')}</div>
          <div class="meta">${p.initials} · ${used}/${allot} PTO</div>
        </div>
      </div>`;
    }).join('');

    // Signed-in indicator + sign-out (only visible after login)
    const sInfo = document.getElementById('signinInfo');
    const sWho = document.getElementById('signinWho');
    if (sInfo && sWho) {
        if (isGrossRoom()) {
            sWho.textContent = 'Signed in · Gross Room';
            sInfo.style.display = 'flex';
        } else if (loggedInPathId !== null) {
            const me = pathologists.find(p => p.id === loggedInPathId);
            if (me) {
                sWho.textContent = 'Signed in · ' + me.name.replace(/^Dr\. /, '');
                sInfo.style.display = 'flex';
            } else {
                sInfo.style.display = 'none';
            }
        } else {
            sInfo.style.display = 'none';
        }
    }
}

// ────────────── TOAST (non-blocking notifications) ──────────────
// Lightweight one-line message that floats in from the top-right and
// auto-dismisses. Used for "new request" alerts and confirmations.
function showToast(msg, opts) {
    opts = opts || {};
    const wrap = (() => {
        let w = document.getElementById('toastWrap');
        if (!w) {
            w = document.createElement('div');
            w.id = 'toastWrap';
            Object.assign(w.style, {
                position: 'fixed',
                top: '18px',
                right: '18px',
                zIndex: 99999,
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                pointerEvents: 'none',
            });
            document.body.appendChild(w);
        }
        return w;
    })();

    const el = document.createElement('div');
    const isErr = opts.type === 'error';
    Object.assign(el.style, {
        background: isErr ? '#b94e2a' : 'rgba(20,20,20,0.92)',
        color: '#fff',
        padding: '10px 14px',
        borderRadius: '6px',
        fontSize: '13px',
        fontWeight: '500',
        boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
        pointerEvents: 'auto',
        cursor: 'pointer',
        maxWidth: '320px',
        opacity: '0',
        transform: 'translateY(-6px)',
        transition: 'opacity 0.2s ease, transform 0.2s ease',
    });
    el.textContent = msg;
    el.addEventListener('click', () => el.remove());
    wrap.appendChild(el);
    requestAnimationFrame(() => {
        el.style.opacity = '1';
        el.style.transform = 'translateY(0)';
    });
    setTimeout(() => {
        if (!el.parentNode) return;
        el.style.opacity = '0';
        el.style.transform = 'translateY(-6px)';
        setTimeout(() => el.remove(), 250);
    }, opts.duration || 4500);
}

// ────────────── RECOMPUTE PROMPT ──────────────
// After an admin makes a service or PTO change, this dialog asks whether
// to (a) just keep the change, or (b) recompute the future service schedule
// for everyone using the rotation rules.
//
// Resolves to { recompute: false } or { recompute: true, horizonDays: N }.
function showRecomputeDialog(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
        const back = document.createElement('div');
        Object.assign(back.style, {
            position: 'fixed', inset: '0',
            background: 'rgba(0,0,0,0.42)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 100000,
        });

        const modal = document.createElement('div');
        Object.assign(modal.style, {
            background: 'var(--paper, #fff)',
            color: 'var(--ink, #222)',
            padding: '22px 24px',
            borderRadius: '8px',
            maxWidth: '480px',
            width: '92%',
            boxShadow: '0 14px 42px rgba(0,0,0,0.22)',
            fontFamily: 'inherit',
        });

        const message = opts.message
            || 'You can update the future service schedule for all pathologists by following the rotation rules, or just keep the change you made.';

        modal.innerHTML =
            '<h3 style="margin:0 0 8px;font-family:var(--serif, Georgia, serif);font-size:20px;color:var(--ink,#222);">'
            + 'Recompute future schedule?'
            + '</h3>'
            + '<p style="margin:0 0 16px;color:var(--ink-2, #555);font-size:13.5px;line-height:1.5;">'
            + escapeHtml(message)
            + '</p>'
            + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:18px;font-size:13px;color:var(--ink-2,#555);">'
            +   '<label for="rcHorizon">Horizon:</label>'
            +   '<select id="rcHorizon" style="padding:5px 8px;font-size:13px;border-radius:4px;border:1px solid var(--rule-soft,#ccc);">'
            +     '<option value="30">Next 30 days</option>'
            +     '<option value="90">Next 90 days</option>'
            +     '<option value="180" selected>Next 180 days</option>'
            +     '<option value="365">Next 365 days</option>'
            +   '</select>'
            + '</div>'
            + '<div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;">'
            +   '<button id="rcCancel" style="padding:8px 14px;font-size:13px;border:1px solid var(--rule-soft,#ccc);background:transparent;color:var(--ink,#222);border-radius:4px;cursor:pointer;">'
            +     'Just apply this change'
            +   '</button>'
            +   '<button id="rcOk" style="padding:8px 16px;font-size:13px;background:var(--accent,#37e);color:#fff;border:0;border-radius:4px;cursor:pointer;font-weight:500;">'
            +     'Recompute'
            +   '</button>'
            + '</div>';

        back.appendChild(modal);
        document.body.appendChild(back);

        function done(result) {
            back.remove();
            resolve(result);
        }

        modal.querySelector('#rcCancel').addEventListener('click', () => done({ recompute: false }));
        modal.querySelector('#rcOk').addEventListener('click', () => {
            const sel = modal.querySelector('#rcHorizon');
            const h = parseInt(sel.value, 10) || 180;
            done({ recompute: true, horizonDays: h });
        });
        back.addEventListener('click', e => {
            if (e.target === back) done({ recompute: false });
        });

        // Esc closes (treats as "just apply")
        function onKey(e) {
            if (e.key === 'Escape') {
                document.removeEventListener('keydown', onKey);
                done({ recompute: false });
            }
        }
        document.addEventListener('keydown', onKey);
    });
}

// Wrapper used from save handlers: only offers recompute to admins, only
// when fromDate is today or later, then runs recomputeFutureSchedule().
async function maybeOfferRecompute(pinnedByDay, opts) {
    opts = opts || {};
    if (!isAdmin()) return;
    if (!opts.fromDate) return;
    // Don't rewrite history
    if (opts.fromDate.getTime() < today.getTime()) return;

    let choice;
    try {
        choice = await showRecomputeDialog({ message: opts.message });
    } catch (err) {
        console.error('recompute dialog error', err);
        return;
    }
    if (!choice || !choice.recompute) return;

    try {
        const res = await recomputeFutureSchedule(
            pinnedByDay || {},
            Object.assign({}, opts, { horizonDays: choice.horizonDays })
        );
        const dayPart = res.dayBeforeProcessed ? ' (incl. day before)' : '';
        showToast('Future schedule recomputed: '
            + res.processed + ' day' + (res.processed === 1 ? '' : 's')
            + ' updated' + dayPart + '.');
    } catch (err) {
        console.error('recomputeFutureSchedule error', err);
        showToast('Recompute failed: ' + (err && err.message ? err.message : err), { type: 'error' });
    }
}

// ────────────── REQUEST QUEUE HELPERS ──────────────
// Push a new pending request into Firebase.  payload is type-specific.
async function submitRequest(type, payload, note) {
    if (loggedInPathId === null) {
        alert('You must be signed in to submit a request.');
        return false;
    }
    try {
        await db.ref('scheduler/requests').push({
            requesterId: loggedInPathId,
            type: type,
            status: 'pending',
            createdAt: Date.now(),
            payload: payload || {},
            note: (note || '').trim() || null,
        });
        showToast('Request submitted — admin will review.');
        return true;
    } catch (err) {
        console.error('submitRequest error:', err);
        showToast('Failed to submit request: ' + (err.message || err), { type: 'error' });
        return false;
    }
}

// Counts of pending requests visible to the current user.  Admin sees all
// pending across the team; non-admin sees only their own pending count.
function getVisiblePendingCount() {
    const arr = Object.entries(requests).filter(([, r]) => r && r.status === 'pending');
    if (isAdmin()) return arr.length;
    return arr.filter(([, r]) => r.requesterId === loggedInPathId).length;
}

// Show / hide the sidebar Requests button and its red badge.
// Also drives the mobile hamburger menu's red alert dot and its
// in-menu Requests badge so phone users get notified the same way.
function updateRequestsBadge() {
    const btn = document.getElementById('requestsBtn');
    const badge = document.getElementById('requestsBadge');
    const lbl = document.getElementById('requestsBtnLabel');

    // Mobile menu equivalents
    const menuBtn        = document.getElementById('menuBtn');
    const menuReqItem    = document.getElementById('menuRequestsItem');
    const menuReqBadge   = document.getElementById('menuRequestsBadge');
    const menuReqLabel   = document.getElementById('menuRequestsLabel');
    const menuPtoLabel   = document.getElementById('menuPtoLabel');
    const menuExportItem = document.getElementById('menuExportItem');

    // Hide entirely if not signed in OR if gross room (who cannot manage requests or PTO)
    if (loggedInPathId === null || isGrossRoom()) {
        if (btn) btn.style.display = 'none';
        if (menuBtn) menuBtn.classList.remove('has-alert');
        if (menuReqItem) menuReqItem.style.display = 'none';
        if (menuExportItem) menuExportItem.style.display = 'none';
        // Also hide the PTO menu item for gross room
        const menuPtoItem = document.querySelector('.menu-item[data-action="pto"]');
        if (menuPtoItem) menuPtoItem.style.display = isGrossRoom() ? 'none' : '';
        return;
    }

    // ── Sidebar button (desktop) ──
    if (btn) {
        btn.style.display = '';
        if (lbl) lbl.textContent = isAdmin() ? 'Requests' : 'My Requests';
    }

    // ── Mobile menu items ──
    if (menuPtoLabel) menuPtoLabel.textContent = isAdmin() ? 'Manage PTO' : 'Request PTO';
    if (menuReqItem)  menuReqItem.style.display = '';
    if (menuReqLabel) menuReqLabel.textContent  = isAdmin() ? 'Requests' : 'My Requests';
    if (menuExportItem) menuExportItem.style.display = isAdmin() ? '' : 'none';

    // ── Pending count → badges + alert dot ──
    const pending = getVisiblePendingCount();
    if (pending > 0) {
        if (badge) {
            badge.style.display = '';
            badge.textContent = String(pending);
        }
        if (menuReqBadge) {
            menuReqBadge.style.display = '';
            menuReqBadge.textContent = String(pending);
        }
        if (menuBtn) menuBtn.classList.add('has-alert');
    } else {
        if (badge) badge.style.display = 'none';
        if (menuReqBadge) menuReqBadge.style.display = 'none';
        if (menuBtn) menuBtn.classList.remove('has-alert');
    }
}

// ────────────── REQUEST → DESCRIPTION FORMATTERS ──────────────
function _reqDateRange(start, end) {
    const s = parseDate(start);
    const e = parseDate(end);
    if (sameDay(s, e)) {
        return `${MONTHS_SHORT[s.getMonth()]} ${s.getDate()}, ${s.getFullYear()}`;
    }
    return `${MONTHS_SHORT[s.getMonth()]} ${s.getDate()} – ${MONTHS_SHORT[e.getMonth()]} ${e.getDate()}, ${e.getFullYear()}`;
}

function _pathName(id) {
    const p = pathologists.find(x => x.id === id);
    return p ? p.name : `(unknown #${id})`;
}

// Returns { title, body } for a given request.  Used both in the request
// card and (loosely) in approve/deny toast confirmations.
function describeRequest(req) {
    const who = _pathName(req.requesterId).replace(/^Dr\. /, '');
    switch (req.type) {
        case 'pto_add': {
            const range = _reqDateRange(req.payload.start, req.payload.end);
            return {
                title: `${who} → Add PTO`,
                body: `Requesting PTO for <strong>${range}</strong>.`,
            };
        }
        case 'pto_remove': {
            const v = vacations.find(x => x.key === req.payload.vacationKey);
            const range = v
                ? (sameDay(v.start, v.end)
                    ? `${MONTHS_SHORT[v.start.getMonth()]} ${v.start.getDate()}, ${v.start.getFullYear()}`
                    : `${MONTHS_SHORT[v.start.getMonth()]} ${v.start.getDate()} – ${MONTHS_SHORT[v.end.getMonth()]} ${v.end.getDate()}, ${v.end.getFullYear()}`)
                : '(PTO no longer exists)';
            return {
                title: `${who} → Remove PTO`,
                body: `Requesting to cancel PTO on <strong>${range}</strong>.`,
            };
        }
        case 'oncall_change': {
            const d = parseDate(req.payload.date);
            const newP = _pathName(req.payload.newPathId).replace(/^Dr\. /, '');
            const scopeLabel = req.payload.scope === 'week' ? 'full call block' : 'this day only';
            const dateLabel = `${DOW[d.getDay()]}, ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
            return {
                title: `${who} → On-call change`,
                body: `Requesting <strong>${newP}</strong> take call (${scopeLabel}) on <strong>${dateLabel}</strong>.`,
            };
        }
        case 'service_change': {
            const d = parseDate(req.payload.date);
            const dateLabel = `${DOW[d.getDay()]}, ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
            const svc = req.payload.serviceId
                ? (SERVICE_BY_ID[req.payload.serviceId]
                    ? SERVICE_BY_ID[req.payload.serviceId].name
                    : req.payload.serviceId)
                : 'No service';
            const scope = req.payload.scope || 'day';
            if (scope === 'week') {
                const cs = getCallCycleStart(d);
                const ce = getCallCycleEnd(cs);
                const weekLabel = `${MONTHS_SHORT[cs.getMonth()]} ${cs.getDate()} – ${MONTHS_SHORT[ce.getMonth()]} ${ce.getDate()}, ${ce.getFullYear()}`;
                return {
                    title: `${who} → Service change (full call week)`,
                    body: `Requesting service for the <strong>full call week</strong> of <strong>${weekLabel}</strong> changed to <strong>${svc}</strong>.`,
                };
            }
            return {
                title: `${who} → Service change`,
                body: `Requesting service for <strong>${dateLabel}</strong> changed to <strong>${svc}</strong>.`,
            };
        }
        default:
            return { title: `${who} → ${req.type}`, body: 'Unknown request type.' };
    }
}

// ────────────── ADMIN ACTIONS: APPROVE / DENY ──────────────
async function approveRequest(reqKey) {
    if (!isAdmin()) { showToast('Only the admin can approve.', { type: 'error' }); return; }
    const req = requests[reqKey];
    if (!req || req.status !== 'pending') return;

    // Track recompute parameters across the type-specific apply blocks
    let rcFromDate = null;
    let rcDayBeforeFix = false;
    let rcPinnedByDay = {};
    let rcMessage = null;

    try {
        // Apply the underlying change first; if that fails we don't mark approved
        if (req.type === 'pto_add') {
            await db.ref('scheduler/vacations').push({
                pathologistId: req.requesterId,
                start: req.payload.start,
                end: req.payload.end,
            });
            rcFromDate = parseDate(req.payload.start);
            rcDayBeforeFix = true;
            rcMessage = 'PTO request approved. Recompute the future schedule for everyone using the rotation rules?';
        } else if (req.type === 'pto_remove') {
            if (req.payload.vacationKey) {
                // Capture the start date BEFORE the listener removes the entry
                const vac = vacations.find(v => v.key === req.payload.vacationKey);
                if (vac) rcFromDate = vac.start;
                else if (req.payload.start) rcFromDate = parseDate(req.payload.start);
                await db.ref('scheduler/vacations/' + req.payload.vacationKey).remove();
                rcDayBeforeFix = false;
                rcMessage = 'PTO removal approved. Recompute the future schedule for everyone using the rotation rules?';
            }
        } else if (req.type === 'oncall_change') {
            const dKey = req.payload.date;
            if (req.payload.scope === 'week') {
                const cs = getCallCycleStart(parseDate(dKey));
                await db.ref('scheduler/onCallOverrides/' + fmt(cs)).set(req.payload.newPathId);
            } else {
                await db.ref('scheduler/onCallDayOverrides/' + dKey).set(req.payload.newPathId);
            }
            // On-call changes don't affect service rotation — no recompute offer.
        } else if (req.type === 'service_change') {
            const dKey = req.payload.date;
            const pid = req.requesterId;
            const scope = req.payload.scope || 'day';   // back-compat: old reqs default to 'day'

            // Build the list of day-keys we need to touch.  For 'day' it's
            // just the requested date; for 'week' it's every workday in
            // the call cycle that contains that date.
            let dayKeys;
            if (scope === 'week') {
                dayKeys = workdaysInCallCycle(parseDate(dKey)).map(d => fmt(d));
            } else {
                dayKeys = [dKey];
            }

            const writes = {};
            dayKeys.forEach(k => {
                if (req.payload.serviceId) {
                    // Merge into existing day overrides
                    const existing = serviceOverrides[k] || {};
                    writes['scheduler/serviceOverrides/' + k] =
                        Object.assign({}, existing, { [pid]: req.payload.serviceId });
                    // Pin ONLY the just-approved path; pre-existing overrides
                    // shouldn't lock the recompute against fixing flags.
                    rcPinnedByDay[k] = { [pid]: req.payload.serviceId };
                } else {
                    // Clear just this user's slot for the day
                    const existing = Object.assign({}, serviceOverrides[k] || {});
                    delete existing[pid];
                    writes['scheduler/serviceOverrides/' + k] =
                        Object.keys(existing).length === 0 ? null : existing;
                    // Override removed — nothing for the admin's edit locks.
                    rcPinnedByDay[k] = {};
                }
            });
            if (Object.keys(writes).length > 0) {
                await db.ref().update(writes);
            }
            // Start the recompute at the earliest affected workday.
            if (dayKeys.length > 0) {
                const sortedKeys = dayKeys.slice().sort();
                rcFromDate = parseDate(sortedKeys[0]);
                rcDayBeforeFix = true;
                rcMessage = 'Service request approved. Recompute the future schedule for everyone using the rotation rules?';
            }
        }

        // Mark approved
        await db.ref('scheduler/requests/' + reqKey).update({
            status: 'approved',
            decisionAt: Date.now(),
            decisionBy: loggedInPathId,
        });
        showToast('Request approved.');

        // After successful approval, offer to recompute if relevant
        if (rcFromDate) {
            await maybeOfferRecompute(rcPinnedByDay, {
                fromDate: rcFromDate,
                dayBeforeFix: rcDayBeforeFix,
                message: rcMessage,
            });
        }
    } catch (err) {
        console.error('approveRequest error:', err);
        showToast('Approval failed: ' + (err.message || err), { type: 'error' });
    }
}

async function denyRequest(reqKey) {
    if (!isAdmin()) { showToast('Only the admin can deny.', { type: 'error' }); return; }
    const reason = prompt('Optional reason for denial (visible to requester):', '');
    // prompt() returning null = user clicked Cancel — bail out
    if (reason === null) return;

    try {
        await db.ref('scheduler/requests/' + reqKey).update({
            status: 'denied',
            decisionAt: Date.now(),
            decisionBy: loggedInPathId,
            decisionNote: reason.trim() || null,
        });
        showToast('Request denied.');
    } catch (err) {
        console.error('denyRequest error:', err);
        showToast('Denial failed: ' + (err.message || err), { type: 'error' });
    }
}

// Requester (or admin) can withdraw a pending request entirely
async function cancelRequest(reqKey) {
    const req = requests[reqKey];
    if (!req) return;
    if (!isAdmin() && req.requesterId !== loggedInPathId) return;
    if (!confirm('Cancel this request? This cannot be undone.')) return;
    try {
        await db.ref('scheduler/requests/' + reqKey).remove();
        showToast('Request cancelled.');
    } catch (err) {
        showToast('Cancel failed: ' + (err.message || err), { type: 'error' });
    }
}

// ────────────── REQUESTS MODAL ──────────────
function openRequestsModal() {
    // Default landing tab: Pending
    activeRequestsTab = 'pending';
    document.querySelectorAll('#reqTabs .req-tab').forEach(b => {
        b.classList.toggle('active', b.dataset.rtab === 'pending');
    });
    const titleEl = document.getElementById('requestsModalTitle');
    const subEl = document.getElementById('requestsModalSub');
    if (isAdmin()) {
        titleEl.textContent = 'Schedule Change Requests';
        subEl.textContent = 'Approve or deny pending requests from the team.';
    } else {
        titleEl.textContent = 'My Requests';
        subEl.textContent = 'Track the status of changes you have requested.';
    }
    renderRequestsList();
    document.getElementById('requestsModalBack').classList.add('open');
}

function renderRequestsList() {
    const listEl = document.getElementById('requestsList');
    if (!listEl) return;

    // Filter: admin sees everyone's; non-admin sees only their own
    let entries = Object.entries(requests).filter(([, r]) => !!r);
    if (!isAdmin()) {
        entries = entries.filter(([, r]) => r.requesterId === loggedInPathId);
    }

    // Tab filter
    if (activeRequestsTab === 'pending') {
        entries = entries.filter(([, r]) => r.status === 'pending');
    } else {
        entries = entries.filter(([, r]) => r.status !== 'pending');
    }

    // Newest first
    entries.sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

    if (entries.length === 0) {
        const msg = activeRequestsTab === 'pending'
            ? (isAdmin() ? 'No requests waiting for review.' : 'You have no pending requests.')
            : 'No past requests yet.';
        listEl.innerHTML = `<div class="empty">${msg}</div>`;
        return;
    }

    listEl.innerHTML = entries.map(([key, req]) => {
        const desc = describeRequest(req);
        const when = req.createdAt
            ? new Date(req.createdAt).toLocaleString([], {
                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            })
            : '';
        const decisionLine = (req.status !== 'pending')
            ? `<div class="req-meta">${req.status === 'approved' ? '✓ Approved' : '✗ Denied'}${req.decisionAt ? ' · ' + new Date(req.decisionAt).toLocaleString([], {
                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            }) : ''
            }${req.decisionBy ? ' · by ' + _pathName(req.decisionBy).replace(/^Dr\. /, '') : ''}${req.decisionNote ? '<div class="req-note">“' + escapeHtml(req.decisionNote) + '”</div>' : ''
            }</div>`
            : '';
        const noteLine = req.note
            ? `<div class="req-note">“${escapeHtml(req.note)}”</div>`
            : '';

        // Build action buttons depending on viewer + status
        let actions = '';
        if (req.status === 'pending') {
            if (isAdmin()) {
                actions = `
                            <div class="req-card-actions">
                                <button class="deny" data-act="deny" data-key="${key}">Deny</button>
                                <button class="approve" data-act="approve" data-key="${key}">Approve</button>
                            </div>`;
            } else if (req.requesterId === loggedInPathId) {
                actions = `
                            <div class="req-card-actions">
                                <button data-act="cancel" data-key="${key}">Cancel request</button>
                            </div>`;
            }
        }

        const typeShort = ({
            'pto_add': 'PTO ADD',
            'pto_remove': 'PTO REMOVE',
            'oncall_change': 'ON-CALL',
            'service_change': 'SERVICE',
        })[req.type] || req.type;

        return `
                    <div class="req-card status-${req.status}">
                        <div class="req-card-head">
                            <div>
                                <span class="req-who">${escapeHtml(desc.title)}</span>
                                <span class="req-type">${typeShort}</span>
                            </div>
                            <span class="req-status-pill ${req.status}">${req.status}</span>
                        </div>
                        <div class="req-detail">${desc.body}</div>
                        ${noteLine}
                        ${decisionLine}
                        <div class="req-meta">${when}</div>
                        ${actions}
                    </div>`;
    }).join('');

    // Wire up action buttons
    listEl.querySelectorAll('button[data-act]').forEach(btn => {
        btn.addEventListener('click', () => {
            const act = btn.dataset.act;
            const key = btn.dataset.key;
            if (act === 'approve') approveRequest(key);
            else if (act === 'deny') denyRequest(key);
            else if (act === 'cancel') cancelRequest(key);
        });
    });
}

// Tiny HTML escape used in request descriptions / notes
function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Wire up the requests modal
document.getElementById('requestsBtn').addEventListener('click', openRequestsModal);
document.getElementById('requestsClose').addEventListener('click', () => {
    document.getElementById('requestsModalBack').classList.remove('open');
});
document.getElementById('requestsModalBack').addEventListener('click', e => {
    if (e.target.id === 'requestsModalBack') e.target.classList.remove('open');
});
document.getElementById('reqTabs').addEventListener('click', e => {
    const btn = e.target.closest('.req-tab');
    if (!btn) return;
    activeRequestsTab = btn.dataset.rtab;
    document.querySelectorAll('#reqTabs .req-tab').forEach(b => {
        b.classList.toggle('active', b === btn);
    });
    renderRequestsList();
});

// ────────────── COVERAGE RULE CHECK (red flag) ──────────────
// Hard rule: given the final day assignments, verifies that the required
// services are covered based on how many pathologists are working.
//   2 working → Huntley + any McHenry service (cyto, bigs, or cytobigs)
//   3 working → Huntley + McHenry Cyto/Gross + McHenry Bigs
//   4+ working → Huntley + McHenry Cyto/Gross + McHenry Bigs + Breast Bx/WFH
// Returns an array of missing-service strings, or null if all required
// services are covered.
function coverageViolationsForDay(date) {
    if (isWeekend(date) || getFederalHoliday(date) || isBeforeEarliest(date)) return null;

    const assign = getDayAssignments(date);
    const working = pathologists.filter(p => assign[p.id] && assign[p.id].type === 'service');
    const n = working.length;
    if (n < 2) return null;

    const svcs = working
        .map(p => assign[p.id].service && assign[p.id].service.id)
        .filter(Boolean);

    const hasHuntley = svcs.includes('huntley');
    const hasCyto    = svcs.includes('cyto') || svcs.includes('cytobigs');
    const hasBigs    = svcs.includes('bigs') || svcs.includes('cytobigs');
    const hasWfh     = svcs.includes('wfh');
    const hasMcHAny  = hasCyto || hasBigs;

    const issues = [];
    if (n === 2) {
        if (!hasHuntley) issues.push('Huntley not staffed');
        if (!hasMcHAny)  issues.push('No McHenry service staffed');
    } else if (n === 3) {
        if (!hasHuntley) issues.push('Huntley not staffed');
        if (!hasCyto)    issues.push('McHenry Cyto/Gross not staffed');
        if (!hasBigs)    issues.push('McHenry Bigs not staffed');
    } else {
        if (!hasHuntley) issues.push('Huntley not staffed');
        if (!hasCyto)    issues.push('McHenry Cyto/Gross not staffed');
        if (!hasBigs)    issues.push('McHenry Bigs not staffed');
        if (!hasWfh)     issues.push('Breast Bx/WFH not staffed');
    }
    return issues.length > 0 ? issues : null;
}

// ────────────── SOFT RULE CHECK (yellow flag) ──────────────
// Soft rules: any pathologist on McHenry Bigs (or cytobigs) the workday
// before they start PTO, or the workday before they are on Breast Bx/WFH.
// Returns an array of descriptive strings, or null if no violations.
function softRuleViolationsForDay(date) {
    if (isWeekend(date) || getFederalHoliday(date) || isBeforeEarliest(date)) return null;

    const assign  = getDayAssignments(date);
    const tomorrow = nextWorkday(date);
    const tmrwAssign = getDayAssignments(tomorrow);

    const issues = [];
    pathologists.forEach(p => {
        const a = assign[p.id];
        if (!a || a.type !== 'service' || !a.service) return;
        const isBigs = a.service.id === 'bigs' || a.service.id === 'cytobigs';
        if (!isBigs) return;

        const shortName = p.name.replace(/^Dr\. /, '');

        // Soft rule 1: bigs the workday before PTO
        if (isOnPto(p.id, tomorrow)) {
            issues.push(shortName + ': on Bigs the day before PTO');
        }

        // Soft rule 2: bigs the workday before Breast Bx/WFH
        const ta = tmrwAssign && tmrwAssign[p.id];
        if (ta && ta.type === 'service' && ta.service && ta.service.id === 'wfh') {
            issues.push(shortName + ': on Bigs the day before Breast Bx/WFH');
        }
    });

    return issues.length > 0 ? issues : null;
}

// ────────────── FLAG HTML ──────────────
// Returns zero, one, or two "!" pill spans for the day header:
//   Red  pill → hard coverage rule not met (required service missing)
//   Yellow pill → soft rule conflict (bigs the day before PTO or Breast Bx/WFH)
function flagHtml(date) {
    if (isWeekend(date)) return '';

    const coverageIssues = coverageViolationsForDay(date);
    const softIssues     = softRuleViolationsForDay(date);
    let html = '';

    if (coverageIssues) {
        const working = pathologists.filter(p => {
            const a = getDayAssignments(date)[p.id];
            return a && a.type === 'service';
        }).length;
        const tip = `Coverage rule not met (${working} pathologist${working === 1 ? '' : 's'} working):\n\u2022 ` + coverageIssues.join('\n\u2022 ');
        html += `<span class="rule-flag rule-flag-red" title="${tip.replace(/"/g, '&quot;')}">!</span>`;
    }

    if (softIssues) {
        const tip = 'Soft rule conflict:\n\u2022 ' + softIssues.join('\n\u2022 ');
        html += `<span class="rule-flag rule-flag-yellow" title="${tip.replace(/"/g, '&quot;')}">!</span>`;
    }

    return html;
}

// ────────────── PERIOD LABEL ──────────────
// Returns true when the cursor's current period (week/month/year)
// already contains today — used to toggle the "off-today" affordance.
function periodContainsToday() {
    if (view === 'week') {
        const s = startOfWeek(cursor);
        const e = addDays(s, 6);
        return today >= s && today <= addDays(e, 1);
    } else if (view === 'month') {
        return cursor.getFullYear() === today.getFullYear() &&
               cursor.getMonth() === today.getMonth();
    } else { // year, agenda
        return cursor.getFullYear() === today.getFullYear();
    }
}

function renderPeriodLabel() {
    const el = document.getElementById('currentPeriod');
    if (view === 'week') {
        const s = startOfWeek(cursor);
        const e = addDays(s, 6);
        const sameMonth = s.getMonth() === e.getMonth();
        if (sameMonth) {
            el.innerHTML = `${MONTHS[s.getMonth()]} ${s.getDate()}–${e.getDate()} <span class="year">${s.getFullYear()}</span>`;
        } else {
            el.innerHTML = `${MONTHS_SHORT[s.getMonth()]} ${s.getDate()} – ${MONTHS_SHORT[e.getMonth()]} ${e.getDate()} <span class="year">${e.getFullYear()}</span>`;
        }
    } else if (view === 'month') {
        el.innerHTML = `${MONTHS[cursor.getMonth()]} <span class="year">${cursor.getFullYear()}</span>`;
    } else {
        el.innerHTML = `<span class="year">${cursor.getFullYear()}</span>`;
    }
    // Show the small "•" affordance + tap-to-today cursor when not viewing today
    el.classList.toggle('off-today', !periodContainsToday());
}

// ────────────── WEEK VIEW ──────────────
function renderWeek() {
    const main = document.getElementById('main');
    const start = startOfWeek(cursor);
    // When weekdaysOnly: show Mon(1)–Fri(5) only; otherwise Sun(0)–Sat(6)
    const dayIndices = settings.weekdaysOnly ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6];
    const cols = dayIndices.length;
    let html = `<div class="week-view" style="grid-template-columns: repeat(${cols}, 1fr);">`;
    for (let idx = 0; idx < dayIndices.length; idx++) {
        const i = dayIndices[idx];
        const d = addDays(start, i);
        const td = sameDay(d, today);
        const we = isWeekend(d);
        const holiday = getFederalHoliday(d);
        const dayAssign = getDayAssignments(d);
        let rows = '';
        const activePathologists = currentPathFilter === 'all'
            ? pathologists
            : pathologists.filter(p => p.id === parseInt(currentPathFilter));

        activePathologists.forEach(p => {
            const a = dayAssign[p.id];
            if (a.type === 'blank') return; // pre-cutoff date — render no rows
            const oc = a.onCall ? `<span class="oc-mark" title="On call this week">On Call</span>` : '';
            if (a.type === 'pto') {
                rows += `<div class="wd-row pto" style="--c:${p.color}">
            <span class="pid">${p.initials}</span>
            <span class="svc">PTO</span>
            ${oc}
          </div>`;
            } else if (a.type === 'off') {
                rows += `<div class="wd-row off" style="--c:${p.color}">
            <span class="pid">${p.initials}</span>
            <span class="svc">${(we || holiday) ? 'Off' : 'Unstaffed'}</span>
            ${oc}
          </div>`;
            } else {
                const cbg = pathBgColor(p.color);
                rows += `<div class="wd-row" style="--c:${p.color}; --sc:var(${a.service.cssVar})${cbg ? `; --c-bg:${cbg}` : ''}">
            <span class="pid">${p.initials}</span>
            <span class="svc"><span class="swatch"></span>${a.service.short}</span>
            ${oc}
          </div>`;
            }
        });
        const holidayBadge = holiday ? `<span class="holiday-badge" title="${holiday}">${holiday}</span>` : '';
        const hoursHtml = renderHourGrid(d);
        html += `<div class="week-day ${td ? 'today' : ''} ${we ? 'weekend' : ''} ${holiday ? 'holiday' : ''}" data-date="${fmt(d)}">
        <div class="wd-head">
          <span class="dow">${DOW[d.getDay()]}</span>
          ${holidayBadge}
          <span class="num">${d.getDate()}${flagHtml(d)}</span>
        </div>
        <div class="wd-rows">${rows}</div>
        ${hoursHtml}
      </div>`;
    }
    html += `</div>`;
    main.innerHTML = html;
    attachDayClickHandlers();
    attachHourGridHandlers();
}

// ────────────── HOURLY GRID (week view) ──────────────
// Build the half-hour rows for a single day card. Each row is dbl-click
// enabled to add a procedure; existing procedures render as removable pills.
function renderHourGrid(date) {
    const dayKey = fmt(date);
    const procs = getProceduresForDay(dayKey);

    // Group procedures by their slot key "HH:MM" so we can drop them into
    // the matching row. Two+ at the same time render side-by-side.
    const bySlot = {};
    procs.forEach(p => {
        if (!bySlot[p.time]) bySlot[p.time] = [];
        bySlot[p.time].push(p);
    });

    let rowsHtml = '';
    for (let h = HOURS_START; h <= HOURS_END; h++) {
        for (let m of [0, 30]) {
            const timeKey = pad2(h) + ':' + pad2(m);   // "08:30"
            const isHourMark = (m === 0);
            const cls = isHourMark ? 'hour-mark' : 'half';
            const label = isHourMark ? formatHour12(h) : '';
            const items = (bySlot[timeKey] || []).map(p => {
                const lbl = procLabel(p);
                const cat = getProcedureCategory(p.location, p.procedureName);
                return `<span class="proc-item proc-cat-${cat}" data-day="${dayKey}" data-key="${p.key}" title="${escapeHtml(lbl)} — click to remove">${escapeHtml(lbl)}<span class="proc-x">×</span></span>`;
            }).join('');
            rowsHtml += `<div class="hour-row ${cls}" data-day="${dayKey}" data-time="${timeKey}" title="Double-click to add a procedure">
              <div class="hour-label">${label}</div>
              <div class="hour-slot">${items}</div>
            </div>`;
        }
    }
    return `<div class="wd-hours">
      <div class="wd-hours-head"></div>
      ${rowsHtml}
    </div>`;
}

// Returns a flat array of { key, time, type, ... } for the given day key.
function getProceduresForDay(dayKey) {
    const dayData = procedures[dayKey];
    if (!dayData) return [];
    return Object.entries(dayData).map(([key, p]) => ({
        key,
        time: p.time,
        type: p.type || 'procedure',
        location: p.location,
        procedureName: p.procedureName,
        createdAt: p.createdAt,
        createdBy: p.createdBy,
    })).sort((a, b) => a.time.localeCompare(b.time));
}

// Display label for a procedure pill, e.g. "HH - CT Random Kidney bx".
// Falls back to "Procedure" for any older entries that pre-date the
// location/procedureName fields.
function procLabel(p) {
    if (p && p.location && p.procedureName) {
        return `${p.location} - ${p.procedureName}`;
    }
    return 'Procedure';
}

// Returns a CSS category class name for a procedure based on its type and location.
// Priority order (checked top to bottom):
//   1. EBUS (must be checked before EUS since EBUS contains "EUS")
//   2. EUS
//   3. Surgical: Lumpectomy, Mastectomy, Excisional bx
//   4. Free-text starting with "FS"
//   5. Location-based: HH → purple, MH → blue
function getProcedureCategory(location, procedureName) {
    if (!procedureName) return 'default';
    const name = procedureName.trim();
    if (/\bEBUS\b/i.test(name)) return 'ebus';
    if (/\bEUS\b/i.test(name))  return 'eus';
    if (/lumpectomy|mastectomy|excisional\s*bx/i.test(name)) return 'surgical';
    if (/^FS\b/i.test(name))    return 'fs';
    if (location === 'HH') return 'hh';
    if (location === 'MH') return 'mh';
    return 'default';
}

// Convert 24h hour to "7 AM" / "12 PM" / "1 PM" style.
function formatHour12(h) {
    const period = h < 12 ? 'AM' : 'PM';
    const hh = ((h + 11) % 12) + 1; // 0->12, 13->1, etc.
    return hh + ' ' + period;
}

// Convert "HH:MM" 24h to a friendly 12h string like "8:30 AM".
function formatTime12(timeKey) {
    const [hStr, mStr] = timeKey.split(':');
    const h = parseInt(hStr, 10);
    const m = parseInt(mStr, 10);
    const period = h < 12 ? 'AM' : 'PM';
    const hh = ((h + 11) % 12) + 1;
    return hh + ':' + pad2(m) + ' ' + period;
}

const pad2 = n => String(n).padStart(2, '0');

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Attach handlers for the week-view hourly grid.
//   - Stop click/dblclick from bubbling to the .week-day (which would open
//     the day-detail modal — not what the user wants when scheduling).
//   - Double-click on an empty slot → procedure modal.
//   - Click on an existing pill → confirm removal.
function attachHourGridHandlers() {
    document.querySelectorAll('.wd-hours').forEach(grid => {
        // Block the parent .week-day's click → day modal
        grid.addEventListener('click', e => e.stopPropagation());
        grid.addEventListener('dblclick', e => e.stopPropagation());
    });

    document.querySelectorAll('.hour-row').forEach(row => {
        row.addEventListener('dblclick', e => {
            // If the dblclick landed on an existing pill, the pill's own
            // handler takes care of removal — don't open the add modal.
            if (e.target.closest('.proc-item')) return;
            const dayKey = row.dataset.day;
            const timeKey = row.dataset.time;
            if (!dayKey || !timeKey) return;
            openProcedureModal(dayKey, timeKey);
        });
    });

    document.querySelectorAll('.proc-item').forEach(item => {
        item.addEventListener('click', async e => {
            e.stopPropagation();
            const dayKey = item.dataset.day;
            const procKey = item.dataset.key;
            if (!dayKey || !procKey) return;
            const proc = (procedures[dayKey] || {})[procKey];
            const label = proc ? procLabel(proc) : 'this procedure';
            if (!confirm(`Remove "${label}" from the schedule?`)) return;
            try {
                await db.ref('scheduler/procedures/' + dayKey + '/' + procKey).remove();
            } catch (err) {
                showToast('Could not remove procedure: ' + (err.message || err), { type: 'error' });
            }
        });
    });
}

// Procedure modal — pick a location (HH/MH) and a procedure type, then
// confirm. The "Add Procedure" button is disabled until both are chosen.
let _pendingProc = null;  // { dayKey, timeKey, location, procedureName }

function openProcedureModal(dayKey, timeKey) {
    _pendingProc = { dayKey, timeKey, location: null, procedureName: null };
    const date = parseDate(dayKey);
    const sub = `${DOW[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()} at ${formatTime12(timeKey)}`;
    document.getElementById('procModalSub').textContent = sub;

    // Reset location radios
    document.querySelectorAll('input[name="procLoc"]').forEach(r => { r.checked = false; });

    // Build the procedure-type button grid fresh each open (cheap, and
    // keeps the markup in sync if PROCEDURE_TYPES ever changes at runtime)
    const grid = document.getElementById('procTypeGrid');
    grid.innerHTML = PROCEDURE_TYPES.map(name => {
        // Derive the fixed category (no location needed for EUS/EBUS/surgical)
        const cat = getProcedureCategory(null, name);
        return `<button type="button" class="proc-type-btn proc-cat-${cat}" data-name="${escapeHtml(name)}">${escapeHtml(name)}</button>`;
    }).join('') +
    `<div class="proc-freetext-wrap" id="procFreetextWrap">` +
      `<input type="text" id="procFreetextInput" class="proc-freetext-input" placeholder="Or type a custom procedure…" maxlength="80">` +
    `</div>`;

    // Re-bind freetext input each open (element is recreated by innerHTML above).
    // Typing auto-selects the free-text entry and deselects any preset button.
    document.getElementById('procFreetextInput').addEventListener('input', e => {
        if (!_pendingProc) return;
        const val = e.target.value.trim();
        // Deselect all preset buttons
        document.querySelectorAll('#procTypeGrid .proc-type-btn').forEach(b => b.classList.remove('selected'));
        // Activate / deactivate the freetext radio indicator
        const wrap = document.getElementById('procFreetextWrap');
        if (wrap) wrap.classList.toggle('active', val.length > 0);
        _pendingProc.procedureName = val || null;
        updateModalProcColors();
        updateProcConfirmEnabled();
    });

    updateProcConfirmEnabled();
    document.getElementById('procModalBack').classList.add('open');
}

function closeProcedureModal() {
    document.getElementById('procModalBack').classList.remove('open');
    _pendingProc = null;
}

// Gate the primary button on having both selections made.
function updateProcConfirmEnabled() {
    const btn = document.getElementById('procConfirm');
    const ready = !!(_pendingProc && _pendingProc.location && _pendingProc.procedureName);
    btn.disabled = !ready;
}

// Refresh the colour category classes on all proc-type-btn elements and the
// free-text wrap to reflect the currently selected location. Called whenever
// the location or the procedure name changes so the buttons always preview
// the colour the pill will have in the schedule.
function updateModalProcColors() {
    const loc = _pendingProc ? _pendingProc.location : null;
    const freeName = _pendingProc ? _pendingProc.procedureName : null;

    // Update preset buttons: fixed categories (EUS/EBUS/surgical) don't change,
    // but location-dependent ones update when a location is chosen.
    document.querySelectorAll('#procTypeGrid .proc-type-btn').forEach(btn => {
        const name = btn.dataset.name;
        const cat = getProcedureCategory(loc, name);
        // Replace any existing proc-cat-* class
        btn.className = btn.className.replace(/\bproc-cat-\S+/g, '').trim();
        btn.classList.add('proc-cat-' + cat);
    });

    // Update the free-text wrap colour to preview what the pill will be
    const wrap = document.getElementById('procFreetextWrap');
    if (wrap && wrap.classList.contains('active') && freeName) {
        const cat = getProcedureCategory(loc, freeName);
        wrap.className = wrap.className.replace(/\bproc-cat-\S+/g, '').trim();
        wrap.classList.add('proc-cat-' + cat);
    } else if (wrap) {
        wrap.className = wrap.className.replace(/\bproc-cat-\S+/g, '').trim();
    }
}

async function saveProcedure() {
    if (!_pendingProc || !_pendingProc.location || !_pendingProc.procedureName) return;
    const { dayKey, timeKey, location, procedureName } = _pendingProc;
    const payload = {
        time: timeKey,
        type: 'procedure',
        location,
        procedureName,
        createdAt: Date.now(),
    };
    if (loggedInPathId !== null) payload.createdBy = loggedInPathId;
    try {
        await db.ref('scheduler/procedures/' + dayKey).push(payload);
        closeProcedureModal();
    } catch (err) {
        showToast('Could not add procedure: ' + (err.message || err), { type: 'error' });
    }
}

// Wire up the modal once. Inputs delegate from the modal back so the
// dynamically-rendered procedure-type buttons work without re-binding.

// ── Restructure procedure modal HTML for enhanced styling ──
// Rebuilds the modal's inner content with the richer markup the new
// CSS expects (modal-inner wrapper, proc-header, section labels, and
// loc-abbr/loc-name spans inside each location option).
(function initProcedureModalStructure() {
    const back = document.getElementById('procModalBack');
    if (!back) return;
    const modal = back.querySelector('.modal');
    if (!modal) return;
    modal.innerHTML = `
<div class="modal-inner">
  <div class="proc-header">
    <div class="proc-header-text">
      <h3>Add Procedure</h3>
      <p class="sub" id="procModalSub"></p>
    </div>
  </div>

  <div class="proc-section-label">Location</div>
  <div id="procLocToggle" class="proc-loc-toggle">
    <label class="proc-loc-opt">
      <input type="radio" name="procLoc" value="HH">
      <span class="loc-abbr">HH</span>
      <span class="loc-name">Huntley Hospital</span>
    </label>
    <label class="proc-loc-opt">
      <input type="radio" name="procLoc" value="MH">
      <span class="loc-abbr">MH</span>
      <span class="loc-name">McHenry Hospital</span>
    </label>
  </div>

  <div class="proc-section-label">Procedure Type</div>
  <div id="procTypeGrid" class="proc-type-grid"></div>

  <div class="modal-actions">
    <button id="procCancel">Cancel</button>
    <button id="procConfirm" class="primary" disabled>Add Procedure</button>
  </div>
</div>`;
})();

document.getElementById('procCancel').addEventListener('click', closeProcedureModal);
document.getElementById('procConfirm').addEventListener('click', saveProcedure);
document.getElementById('procModalBack').addEventListener('click', e => {
    if (e.target.id === 'procModalBack') closeProcedureModal();
});

// Location radios: capture HH or MH selection
document.getElementById('procLocToggle').addEventListener('change', e => {
    if (e.target.name !== 'procLoc' || !_pendingProc) return;
    _pendingProc.location = e.target.value;
    updateModalProcColors();
    updateProcConfirmEnabled();
});

// Procedure-type buttons: single-select (one selected at a time).
// Clicking a preset button also clears the free-text input.
document.getElementById('procTypeGrid').addEventListener('click', e => {
    const btn = e.target.closest('.proc-type-btn');
    if (!btn || !_pendingProc) return;
    document.querySelectorAll('#procTypeGrid .proc-type-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    // Clear freetext state
    const input = document.getElementById('procFreetextInput');
    const wrap  = document.getElementById('procFreetextWrap');
    if (input) input.value = '';
    if (wrap)  wrap.classList.remove('active');
    _pendingProc.procedureName = btn.dataset.name;
    updateModalProcColors();
    updateProcConfirmEnabled();
});

// ────────────── MONTH VIEW ──────────────
function renderMonth() {
    const main = document.getElementById('main');
    const y = cursor.getFullYear();
    const m = cursor.getMonth();
    const first = new Date(y, m, 1);
    const last = new Date(y, m + 1, 0);
    const gridStart = startOfWeek(first);

    // When weekdaysOnly: 5-column grid (Mon–Fri), else 7-column (Sun–Sat)
    const wdOnly = settings.weekdaysOnly;
    const colCount = wdOnly ? 5 : 7;
    // Offset: 0=Sun,1=Mon…6=Sat. When weekdays-only, the grid starts on Mon(1).
    const gridOffset = wdOnly ? 1 : 0;
    // First cell's date offset: for weekdays-only the anchor shifts to Monday
    const gridAnchor = wdOnly ? addDays(gridStart, 1) : gridStart;
    // Number of cells needed
    const firstDow = wdOnly
        ? ((first.getDay() + 6) % 7)   // 0=Mon…4=Fri for weekdays-only
        : first.getDay();               // 0=Sun…6=Sat
    const totalCells = Math.ceil((last.getDate() + firstDow) / colCount) * colCount;

    let html = `<div class="month-view" style="grid-template-columns: repeat(${colCount}, 1fr);">`;
    // Day-of-week headers
    const dowLabels = wdOnly ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] : DOW;
    dowLabels.forEach(d => { html += `<div class="dow-h">${d}</div>`; });

    for (let i = 0; i < totalCells; i++) {
        const date = addDays(gridAnchor, i);
        // Skip weekends when in weekdays-only mode (shouldn't happen given gridAnchor, but guard it)
        if (wdOnly && isWeekend(date)) continue;
        const inMonth = date.getMonth() === m;
        const td = sameDay(date, today);
        const we = isWeekend(date);
        const holiday = inMonth ? getFederalHoliday(date) : null;
        const dayAssign = getDayAssignments(date);

        let rows = '';
        const activePathologists = currentPathFilter === 'all'
            ? pathologists
            : pathologists.filter(p => p.id === parseInt(currentPathFilter));

        activePathologists.forEach(p => {
            const a = dayAssign[p.id];
            if (a.type === 'blank') return; // pre-cutoff date — render no rows
            const oc = a.onCall ? `<span class="oc-mark" title="On call this week">On Call</span>` : '';
            if (a.type === 'pto') {
                rows += `<div class="wd-row pto" style="--c:${p.color}" title="${p.name} — PTO${a.onCall ? ' · On call' : ''}">
            <span class="pid">${p.initials}</span>
            <span class="svc">PTO</span>
            ${oc}
          </div>`;
            } else if (a.type === 'off') {
                rows += `<div class="wd-row off" style="--c:${p.color}" title="${p.name} — ${(we || holiday) ? 'Off' : 'Unstaffed'}${a.onCall ? ' · On call' : ''}">
            <span class="pid">${p.initials}</span>
            <span class="svc">${(we || holiday) ? 'Off' : 'Unstaffed'}</span>
            ${oc}
          </div>`;
            } else {
                const cbg = pathBgColor(p.color);
                rows += `<div class="wd-row" style="--c:${p.color}; --sc:var(${a.service.cssVar})${cbg ? `; --c-bg:${cbg}` : ''}" title="${p.name} — ${a.service.name}${a.onCall ? ' · On call' : ''}">
            <span class="pid">${p.initials}</span>
            <span class="svc"><span class="swatch"></span>${a.service.short}</span>
            ${oc}
          </div>`;
            }
        });

        const holidayBadge = holiday ? `<span class="month-holiday-badge" title="${holiday}">${holiday}</span>` : '';
        html += `<div class="day ${inMonth ? '' : 'outside'} ${we ? 'weekend' : ''} ${holiday ? 'holiday' : ''} ${td ? 'today' : ''}" data-date="${fmt(date)}">
        <div class="day-num-row">
          <span class="num">${date.getDate()}${inMonth ? flagHtml(date) : ''}</span>
          ${holidayBadge}
        </div>
        <div class="wd-rows">${rows}</div>
      </div>`;
    }
    html += `</div>`;
    main.innerHTML = html;
    attachDayClickHandlers();
}

// ────────────── YEAR VIEW ──────────────

// Build a CSS background string from a list of pathologist colour vars.
// 1 → solid colour; 2 → diagonal split; 3 → 3-stripe; 4 → 4-stripe.
function gradientFor(colors) {
    if (colors.length === 0) return 'transparent';
    if (colors.length === 1) return colors[0];
    if (colors.length === 2) {
        return `linear-gradient(135deg, ${colors[0]} 50%, ${colors[1]} 50%)`;
    }
    if (colors.length === 3) {
        return `linear-gradient(135deg, ${colors[0]} 33.33%, ${colors[1]} 33.33%, ${colors[1]} 66.66%, ${colors[2]} 66.66%)`;
    }
    // 4+: distribute evenly
    const stops = [];
    const step = 100 / colors.length;
    colors.forEach((c, i) => {
        const s = (i * step).toFixed(2) + '%';
        const e = ((i + 1) * step).toFixed(2) + '%';
        stops.push(`${c} ${s} ${e}`);
    });
    return `linear-gradient(135deg, ${stops.join(', ')})`;
}
function cellContent(date) {
    // Pre-cutoff dates render as blank in year view too.
    if (isBeforeEarliest(date)) return null;

    // Check if a specific pathologist is selected in the dropdown
    const filterId = currentPathFilter === 'all' ? null : parseInt(currentPathFilter);

    if (yearMode === 'pto') {
        const folks = pathologists.filter(p => {
            // If filtering, ignore everyone except the selected pathologist
            if (filterId !== null && p.id !== filterId) return false;
            return isOnPto(p.id, date);
        });

        if (folks.length === 0) return null;

        const colors = folks.map(p => p.color);
        const initials = folks.map(p => p.initials);
        const names = folks.map(p => p.name.replace(/^Dr\. /, ''));
        const title = `${names.join(', ')} — PTO`;

        let label;
        if (folks.length === 1) label = initials[0];
        else if (folks.length <= 2) label = initials.join('/');
        else label = String(folks.length);   // 3+ → just count

        return {
            folks,
            background: gradientFor(colors),
            label,
            title,
            multi: folks.length > 1,
            count: folks.length > 2,
        };
    }

    // Call mode — use the same lookup as week/month views (respects day-level overrides)
    const ocId = onCallIdForDay(date);
    const oc = pathologists.find(p => p.id === ocId);

    // If nobody is on call, OR if we are filtering and the on-call doc isn't the selected one
    if (!oc || (filterId !== null && oc.id !== filterId)) return null;

    return {
        folks: [oc],
        background: oc.color,
        label: oc.initials,
        title: `${oc.name.replace(/^Dr\. /, '')} — On call`,
        multi: false,
        count: false,
    };
}

function renderYear() {
    const main = document.getElementById('main');
    const y = cursor.getFullYear();

    // Mode tabs + pathologist key
    const modeTabsHtml = `
      <div class="mode-tabs" role="tablist">
        <button class="${yearMode === 'pto' ? 'active' : ''}" data-mode="pto">PTO</button>
        <button class="${yearMode === 'call' ? 'active' : ''}" data-mode="call">Call</button>
      </div>`;

    const keyHtml = `
      <div class="key">
        <span class="key-label">Pathologists</span>
        ${pathologists.map(p =>
        `<span class="key-pill"><span class="swatch" style="--c:${p.color}">${p.initials}</span>${p.name.replace(/^Dr\. /, '')}</span>`
    ).join('')}
      </div>`;
    let html = `<div class="year-view">
      <div class="year-legend">
        ${modeTabsHtml}
        ${keyHtml}
      </div>`;

    for (let m = 0; m < 12; m++) {
        const first = new Date(y, m, 1);
        const last = new Date(y, m + 1, 0);
        const gridStart = startOfWeek(first);
        const totalCells = Math.ceil((last.getDate() + first.getDay()) / 7) * 7;

        let cells = DOW_MINI.map(d => `<div class="mh">${d}</div>`).join('');
        for (let i = 0; i < totalCells; i++) {
            const date = addDays(gridStart, i);
            const inMonth = date.getMonth() === m;
            const td = sameDay(date, today);

            const content = inMonth ? cellContent(date) : null;
            const classes = ['md'];
            if (!inMonth) classes.push('outside');
            if (td) classes.push('today');
            const holiday = inMonth ? getFederalHoliday(date) : null;
            if (holiday) classes.push('holiday');
            if (content) {
                classes.push('has-data');
                if (content.multi) classes.push('multi');
                if (content.count) classes.push('count');
            }

            const titleAttr = (content || holiday)
                ? ` title="${holiday ? holiday + (content ? ' · ' : '') : ''}${content ? content.title : ''}"`
                : '';
            const squareStyle = content ? ` style="background:${content.background}"` : '';
            const labelHtml = content ? `<span class="md-label">${content.label}</span>` : '';
            const inner = `<span class="md-num">${date.getDate()}</span><span class="md-square"${squareStyle}>${labelHtml}</span>`;

            cells += `<div class="${classes.join(' ')}" data-date="${fmt(date)}"${titleAttr}>${inner}</div>`;
        }

        html += `<div class="year-month">
        <h4>${MONTHS[m]} <span class="yr">${MONTHS_SHORT[m]}</span></h4>
        <div class="mini-grid">${cells}</div>
      </div>`;
    }

    html += `</div>`;
    main.innerHTML = html;

    // Mode toggle handlers
    main.querySelectorAll('.mode-tabs button').forEach(btn => {
        btn.addEventListener('click', () => {
            yearMode = btn.dataset.mode;
            renderYear();
        });
    });

    // Click any day in the year view → open day detail modal (edit PTO / on-call)
    main.querySelectorAll('.md').forEach(el => {
        if (el.classList.contains('outside')) return;
        el.addEventListener('click', () => {
            const ds = el.dataset.date;
            if (!ds) return;
            openDayDetail(parseDate(ds));
        });
    });
}

// ────────────── DAY DETAIL MODAL ──────────────
let activeDayDate = null;

function attachDayClickHandlers() {
    document.querySelectorAll('[data-date]').forEach(el => {
        el.addEventListener('click', () => {
            const ds = el.dataset.date;
            if (!ds) return;
            openDayDetail(parseDate(ds));
        });
    });
}

function openDayDetail(date) {
    activeDayDate = date;
    const title = document.getElementById('dayModalTitle');
    const sub = document.getElementById('dayModalSub');
    const rows = document.getElementById('dayDetailRows');

    title.textContent = `${DOW[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
    const cs = getCallCycleStart(date);
    const ce = getCallCycleEnd(cs);
    const isWk = isWeekend(date);
    const holiday = getFederalHoliday(date);
    let subText = isWk
        ? `Weekend — no service rotation. On-call still applies.`
        : `Call block: ${MONTHS_SHORT[cs.getMonth()]} ${cs.getDate()} – ${MONTHS_SHORT[ce.getMonth()]} ${ce.getDate()}`;
    if (holiday) subText += `  •  ⭐ Federal Holiday: ${holiday}`;
    sub.textContent = subText;
    const issues = (isWk || holiday) ? null : violationsForDay(date);
    if (issues) {
        subText += '  •  ⚠ Hard-rule conflict: ' + issues.join('; ');
    }
    sub.textContent = subText;

    const dayAssign = getDayAssignments(date);
    const admin = isAdmin();
    rows.innerHTML = pathologists.map(p => {
        const a = dayAssign[p.id];
        if (a.type === 'blank') return ''; // pre-cutoff date — no row
        const ocPill = a.onCall ? `<span class="doc-pill">On Call</span>` : '';
        const adminAttrs = admin ? ` data-pid="${p.id}" data-atype="${a.type}"` : '';
        const adminCls = admin ? ' admin-clickable' : '';
        if (a.type === 'pto') {
            return `<div class="day-detail-row pto-row${adminCls}"${adminAttrs} style="--c:${p.color}">
          <div class="ddot"></div>
          <div class="dname">${p.name}</div>
          <div class="dservice">PTO</div>
          ${ocPill}
        </div>`;
        }
        if (a.type === 'off') {
            return `<div class="day-detail-row off-row${adminCls}"${adminAttrs} style="--c:${p.color}">
          <div class="ddot"></div>
          <div class="dname">${p.name}</div>
          <div class="dservice">${(isWk || holiday) ? 'Off' : 'Unstaffed'}</div>
          ${ocPill}
        </div>`;
        }
        const cbg = pathBgColor(p.color);
        return `<div class="day-detail-row${adminCls}"${adminAttrs} style="--c:${p.color}; --sc:var(${a.service.cssVar})${cbg ? `; --c-bg:${cbg}` : ''}">
        <div class="ddot"></div>
        <div class="dname">${p.name}</div>
        <div class="dservice"><span class="swatch"></span>${a.service.name}</div>
        ${ocPill}
      </div>`;
    }).join('');

    if (admin) attachPathRowHandlers(date);

    // Hide "change service rotation" button on weekends and federal holidays
    const svcBtn = document.getElementById('dayChangeService');
    if (svcBtn) svcBtn.style.display = (isWk || holiday) ? 'none' : '';

    // Adjust day-modal action button labels based on viewer role.
    // Gross room cannot make any pathologist-schedule changes at all.
    const grossRoom = isGrossRoom();
    const ptoBtn = document.getElementById('dayAddPto');
    const ocBtn = document.getElementById('dayChangeOnCall');
    if (ptoBtn) {
        ptoBtn.style.display = grossRoom ? 'none' : '';
        if (!grossRoom) ptoBtn.textContent = admin ? 'Add PTO for this day' : '+ Request PTO for this day';
    }
    if (ocBtn) {
        ocBtn.style.display = grossRoom ? 'none' : '';
        if (!grossRoom) ocBtn.textContent = admin ? "Change who's on call" : "Request on-call change";
    }
    if (svcBtn && !(isWk || holiday)) {
        if (grossRoom) {
            svcBtn.style.display = 'none';
        } else {
            svcBtn.style.display = '';
            svcBtn.textContent = admin ? 'Override services this day' : 'Request service change';
        }
    }

    document.getElementById('dayModalBack').classList.add('open');
}

// ────────────── PATH QUICK-ACTION PANEL ──────────────
function attachPathRowHandlers(date) {
    const rows = document.getElementById('dayDetailRows');
    let openRow = null;
    let openPanel = null;

    function closePanel() {
        if (openPanel) { openPanel.remove(); openPanel = null; }
        if (openRow) { openRow.classList.remove('panel-open'); openRow = null; }
    }

    rows.querySelectorAll('.admin-clickable').forEach(row => {
        row.addEventListener('click', e => {
            // Don't trigger when clicking inside an already-open panel
            if (e.target.closest('.path-quick-panel')) return;

            const isSameRow = row === openRow;
            closePanel();
            if (isSameRow) return; // toggle off

            const pid = parseInt(row.dataset.pid, 10);
            const atype = row.dataset.atype;
            const path = pathologists.find(p => p.id === pid);
            if (!path) return;

            const panel = document.createElement('div');
            panel.className = 'path-quick-panel';

            const isWk = isWeekend(date);
            const holiday = getFederalHoliday(date);

            if (atype === 'pto') {
                // Find the vacation entry(s) covering this date for this pathologist
                const t = date.getTime();
                const matchingVacs = vacations.filter(v =>
                    v.pathologistId === pid &&
                    t >= v.start.getTime() && t <= v.end.getTime()
                );

                let ptoInfo = '';
                matchingVacs.forEach((v, i) => {
                    ptoInfo += `
                        <div class="pqp-label" style="margin-top:${i > 0 ? '10px' : '0'};">Edit date range</div>
                        <div class="pqp-row">
                            <input type="date" class="pqp-date-input" id="pqpStart_${v.key}" value="${fmt(v.start)}" />
                            <span style="font-size:12px;color:var(--ink-3);flex-shrink:0;">to</span>
                            <input type="date" class="pqp-date-input" id="pqpEnd_${v.key}" value="${fmt(v.end)}" />
                            <button class="pqp-btn primary" data-vackey="${v.key}" id="pqpSave_${v.key}">Save</button>
                        </div>
                        <div class="pqp-row">
                            <button class="pqp-btn danger" data-vackey="${v.key}" id="pqpRemove_${v.key}">Remove entry</button>
                        </div>`;
                });

                panel.innerHTML = `<div class="pqp-label">PTO — ${path.name}</div>${ptoInfo}`;

                // Save (update date range)
                panel.querySelectorAll('button[id^="pqpSave_"]').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        const key = btn.dataset.vackey;
                        const newStart = panel.querySelector(`#pqpStart_${key}`).value;
                        const newEnd = panel.querySelector(`#pqpEnd_${key}`).value;
                        if (!newStart || !newEnd) { showToast('Please set both dates.', { type: 'error' }); return; }
                        if (newEnd < newStart) { showToast('End date must be on or after start date.', { type: 'error' }); return; }
                        // Track the earlier of old/new starts so the recompute
                        // covers any newly-added vs. newly-removed PTO days.
                        const oldVac = vacations.find(v => v.key === key);
                        const oldStartTs = oldVac ? oldVac.start.getTime() : Infinity;
                        const newStartDate = parseDate(newStart);
                        const fromDate = newStartDate.getTime() < oldStartTs
                            ? newStartDate
                            : (oldVac ? oldVac.start : newStartDate);
                        await db.ref('scheduler/vacations/' + key).update({ start: newStart, end: newEnd });
                        showToast('PTO updated.');
                        closePanel();
                        openDayDetail(date);
                        await maybeOfferRecompute({}, {
                            fromDate: fromDate,
                            dayBeforeFix: true,
                            message: 'PTO date range updated. Recompute the future schedule for everyone using the rotation rules?',
                        });
                    });
                });

                // Remove
                panel.querySelectorAll('button[id^="pqpRemove_"]').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        if (!confirm('Remove this PTO entry?')) return;
                        const vacKey = btn.dataset.vackey;
                        const vac = vacations.find(v => v.key === vacKey);
                        const fromDate = vac ? vac.start : null;
                        await db.ref('scheduler/vacations/' + vacKey).remove();
                        closePanel();
                        openDayDetail(date);
                        if (fromDate) {
                            await maybeOfferRecompute({}, {
                                fromDate: fromDate,
                                dayBeforeFix: false,
                                message: 'PTO removed. Recompute the future schedule for everyone using the rotation rules?',
                            });
                        }
                    });
                });

            } else if (atype === 'service') {
                const dayAssign = getDayAssignments(date);
                const currentSvc = dayAssign[pid]?.service;
                const allOptions = [...SERVICES, COMBO_SVC];
                const opts = allOptions.map(s =>
                    `<option value="${s.id}" ${currentSvc && s.id === currentSvc.id ? 'selected' : ''}>${s.name}</option>`
                ).join('');
                const noneOpt = `<option value="">— No service —</option>`;

                // Check if there's an existing day-level override for this path on this date
                const dayKey = fmt(date);
                const hasOverride = serviceOverrides[dayKey] && serviceOverrides[dayKey][pid];

                panel.innerHTML = `
                    <div class="pqp-label">Service — ${path.name}</div>
                    <div class="pqp-row">
                        <select id="pqpSvcSel_${pid}">${noneOpt}${opts}</select>
                        <button class="pqp-btn primary" id="pqpSvcSave_${pid}">Save</button>
                    </div>
                    ${hasOverride ? `<button class="pqp-reset" id="pqpSvcReset_${pid}">Reset to default rotation</button>` : ''}
                `;

                panel.querySelector(`#pqpSvcSave_${pid}`).addEventListener('click', async () => {
                    const sel = panel.querySelector(`#pqpSvcSel_${pid}`);
                    const newVal = sel.value;
                    const dayKey = fmt(date);
                    const existing = serviceOverrides[dayKey] ? { ...serviceOverrides[dayKey] } : {};
                    const recomputePins = {};
                    if (newVal) {
                        existing[pid] = newVal;
                        await db.ref('scheduler/serviceOverrides/' + dayKey).set(existing);
                        // Pin ONLY the just-changed path; everyone else
                        // stays free for the recompute to rearrange.
                        recomputePins[dayKey] = { [pid]: newVal };
                    } else {
                        delete existing[pid];
                        if (Object.keys(existing).length === 0) {
                            await db.ref('scheduler/serviceOverrides/' + dayKey).remove();
                        } else {
                            await db.ref('scheduler/serviceOverrides/' + dayKey).set(existing);
                        }
                        // Override removed — nothing for the admin's edit
                        // locks; recompute is free to reflow the day.
                        recomputePins[dayKey] = {};
                    }
                    closePanel();
                    openDayDetail(date);
                    await maybeOfferRecompute(recomputePins, {
                        fromDate: date,
                        dayBeforeFix: true,
                        message: 'Service updated. Recompute the future schedule for everyone using the rotation rules?',
                    });
                });

                const resetBtn = panel.querySelector(`#pqpSvcReset_${pid}`);
                if (resetBtn) {
                    resetBtn.addEventListener('click', async () => {
                        const dayKey = fmt(date);
                        const existing = serviceOverrides[dayKey] ? { ...serviceOverrides[dayKey] } : {};
                        delete existing[pid];
                        if (Object.keys(existing).length === 0) {
                            await db.ref('scheduler/serviceOverrides/' + dayKey).remove();
                        } else {
                            await db.ref('scheduler/serviceOverrides/' + dayKey).set(existing);
                        }
                        const recomputePins = {};
                        // Reset removed pid's override — recompute is free
                        // to reflow the day; nothing to lock.
                        recomputePins[dayKey] = {};
                        closePanel();
                        openDayDetail(date);
                        await maybeOfferRecompute(recomputePins, {
                            fromDate: date,
                            dayBeforeFix: true,
                            message: 'Service reset to default. Recompute the future schedule for everyone using the rotation rules?',
                        });
                    });
                }

            } else { // 'off' — weekend, holiday, or unstaffed
                const canAddPto = true;
                const canAssignService = !(isWk || holiday);
                const parts = [];

                if (canAddPto) {
                    parts.push(`<div class="pqp-label">Actions — ${path.name}</div>
                        <div class="pqp-row">
                            <button class="pqp-btn" id="pqpAddPto_${pid}">Add PTO for this day</button>
                        </div>`);
                }

                if (canAssignService) {
                    const allOptions = [...SERVICES, COMBO_SVC];
                    const opts = allOptions.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
                    parts.push(`<div class="pqp-row">
                        <select id="pqpOffSvcSel_${pid}"><option value="">— Assign service —</option>${opts}</select>
                        <button class="pqp-btn primary" id="pqpOffSvcSave_${pid}">Save</button>
                    </div>`);
                }

                panel.innerHTML = parts.join('');

                const addPtoBtn = panel.querySelector(`#pqpAddPto_${pid}`);
                if (addPtoBtn) {
                    addPtoBtn.addEventListener('click', () => {
                        closePanel();
                        document.getElementById('dayModalBack').classList.remove('open');
                        // Open PTO modal pre-filled to this pathologist and date
                        const sel = document.getElementById('ptoPath');
                        openPtoModal(date);
                        // Pre-select this pathologist after the modal opens
                        setTimeout(() => { sel.value = pid; }, 0);
                    });
                }

                const offSvcSave = panel.querySelector(`#pqpOffSvcSave_${pid}`);
                if (offSvcSave) {
                    offSvcSave.addEventListener('click', async () => {
                        const sel = panel.querySelector(`#pqpOffSvcSel_${pid}`);
                        const newVal = sel.value;
                        if (!newVal) return;
                        const dayKey = fmt(date);
                        const existing = serviceOverrides[dayKey] ? { ...serviceOverrides[dayKey] } : {};
                        existing[pid] = newVal;
                        await db.ref('scheduler/serviceOverrides/' + dayKey).set(existing);
                        const recomputePins = {};
                        // Pin ONLY the just-assigned path; everyone else
                        // stays free for the recompute to rearrange.
                        recomputePins[dayKey] = { [pid]: newVal };
                        closePanel();
                        openDayDetail(date);
                        await maybeOfferRecompute(recomputePins, {
                            fromDate: date,
                            dayBeforeFix: true,
                            message: 'Service assigned. Recompute the future schedule for everyone using the rotation rules?',
                        });
                    });
                }
            }

            row.classList.add('panel-open');
            row.after(panel);
            openRow = row;
            openPanel = panel;
        });
    });
}

document.getElementById('dayClose').addEventListener('click', () => {
    document.getElementById('dayModalBack').classList.remove('open');
});
document.getElementById('dayModalBack').addEventListener('click', e => {
    if (e.target.id === 'dayModalBack') e.target.classList.remove('open');
});

document.getElementById('dayAddPto').addEventListener('click', () => {
    document.getElementById('dayModalBack').classList.remove('open');
    openPtoModal(activeDayDate);
});
document.getElementById('dayChangeOnCall').addEventListener('click', () => {
    document.getElementById('dayModalBack').classList.remove('open');
    openOnCallModal(activeDayDate);
});
document.getElementById('dayChangeService').addEventListener('click', () => {
    document.getElementById('dayModalBack').classList.remove('open');
    openServiceModal(activeDayDate);
});

// ────────────── PTO MODAL ──────────────
function openPtoModal(prefillDate) {
    const sel = document.getElementById('ptoPath');
    const admin = isAdmin();

    // Non-admin: lock the pathologist field to themselves (single disabled option)
    if (admin) {
        sel.innerHTML = pathologists.map(p =>
            `<option value="${p.id}">${p.name}</option>`
        ).join('');
        sel.disabled = false;
    } else {
        const me = pathologists.find(p => p.id === loggedInPathId);
        sel.innerHTML = me
            ? `<option value="${me.id}">${me.name}</option>`
            : '<option value="">(not signed in)</option>';
        sel.disabled = true;
    }

    const d = prefillDate || today;
    document.getElementById('ptoStart').value = fmt(d);
    document.getElementById('ptoEnd').value = fmt(d);

    // Note field + button label + list label change for non-admin
    document.getElementById('ptoNoteWrap').style.display = admin ? 'none' : '';
    const noteEl = document.getElementById('ptoNote');
    if (noteEl) noteEl.value = '';

    document.querySelector('#ptoModalBack .modal h3').textContent =
        admin ? 'Manage PTO' : 'Request PTO';
    document.querySelector('#ptoModalBack .modal .sub').textContent =
        admin
            ? 'Add a new PTO range or remove an existing one.'
            : 'Submit a PTO request — the admin will approve or deny it.';
    document.getElementById('ptoSave').textContent = admin ? 'Add PTO' : 'Submit Request';
    document.getElementById('ptoListLabel').textContent =
        admin ? 'Existing PTO' : 'My PTO';

    renderPtoList();
    document.getElementById('ptoModalBack').classList.add('open');
}

function renderPtoList() {
    const list = document.getElementById('ptoList');
    const admin = isAdmin();

    // Non-admin sees only their own PTO; admin sees everyone's
    let upcoming = vacations.filter(v => v.end >= today);
    if (!admin) {
        upcoming = upcoming.filter(v => v.pathologistId === loggedInPathId);
    }
    upcoming = upcoming.sort((a, b) => a.start - b.start).slice(0, 30);

    if (upcoming.length === 0) {
        list.innerHTML = `<div class="empty">No upcoming PTO scheduled.</div>`;
        return;
    }

    // Identify which vacations already have a pending removal request
    // (so we can disable the button to avoid double-submits).
    const pendingRemoves = new Set(
        Object.values(requests || {})
            .filter(r => r && r.status === 'pending' && r.type === 'pto_remove' && r.payload)
            .map(r => r.payload.vacationKey)
    );

    list.innerHTML = upcoming.map(v => {
        const p = pathologists.find(x => x.id === v.pathologistId);
        if (!p) return '';
        const same = sameDay(v.start, v.end);
        const range = same
            ? `${MONTHS_SHORT[v.start.getMonth()]} ${v.start.getDate()}, ${v.start.getFullYear()}`
            : `${MONTHS_SHORT[v.start.getMonth()]} ${v.start.getDate()} – ${MONTHS_SHORT[v.end.getMonth()]} ${v.end.getDate()}, ${v.end.getFullYear()}`;
        const label = admin
            ? 'Remove'
            : (pendingRemoves.has(v.key) ? 'Removal pending' : 'Request removal');
        const disabledAttr = (!admin && pendingRemoves.has(v.key)) ? 'disabled' : '';
        return `<div class="pto-list-item" style="--c:${p.color}">
        <div class="pdot"></div>
        <div class="prange">
          <div class="pname">${p.name.replace(/^Dr\. /, '')}</div>
          <div class="pdates">${range}</div>
        </div>
        <button data-key="${v.key}" ${disabledAttr}>${label}</button>
      </div>`;
    }).join('');

    list.querySelectorAll('button[data-key]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const key = btn.dataset.key;
            if (admin) {
                if (!confirm('Remove this PTO entry?')) return;
                const vac = vacations.find(x => x.key === key);
                const fromDate = vac ? vac.start : null;
                await db.ref('scheduler/vacations/' + key).remove();
                if (fromDate) {
                    await maybeOfferRecompute({}, {
                        fromDate: fromDate,
                        dayBeforeFix: false,
                        message: 'PTO removed. Recompute the future schedule for everyone using the rotation rules?',
                    });
                }
            } else {
                // Find the relevant vacation for the prompt detail
                const v = vacations.find(x => x.key === key);
                if (!v) return;
                if (!confirm('Submit a request to cancel this PTO? The admin will need to approve.')) return;
                const ok = await submitRequest('pto_remove', {
                    vacationKey: key,
                    start: fmt(v.start),
                    end: fmt(v.end),
                });
                if (ok) renderPtoList();
            }
        });
    });
}

document.getElementById('addPtoBtn').addEventListener('click', () => openPtoModal(null));
document.getElementById('ptoCancel').addEventListener('click', () => {
    document.getElementById('ptoModalBack').classList.remove('open');
});
document.getElementById('ptoModalBack').addEventListener('click', e => {
    if (e.target.id === 'ptoModalBack') e.target.classList.remove('open');
});
document.getElementById('ptoSave').addEventListener('click', async () => {
    const admin = isAdmin();
    const pid = admin
        ? parseInt(document.getElementById('ptoPath').value, 10)
        : loggedInPathId;
    const sStr = document.getElementById('ptoStart').value;
    const eStr = document.getElementById('ptoEnd').value;
    if (!pid) { alert('Please choose a pathologist.'); return; }
    if (!sStr || !eStr) { alert('Please choose start and end dates.'); return; }
    const s = new Date(sStr + 'T00:00:00');
    const e = new Date(eStr + 'T00:00:00');
    if (isNaN(s) || isNaN(e) || e < s) { alert('Please enter a valid date range.'); return; }

    if (admin) {
        await db.ref('scheduler/vacations').push({
            pathologistId: pid,
            start: fmt(s),
            end: fmt(e),
        });
        renderPtoList();
        document.getElementById('ptoModalBack').classList.remove('open');
        await maybeOfferRecompute({}, {
            fromDate: s,
            dayBeforeFix: true,
            message: 'PTO added. Recompute the future schedule for everyone using the rotation rules?',
        });
    } else {
        const note = (document.getElementById('ptoNote').value || '').trim();
        const ok = await submitRequest('pto_add', {
            start: fmt(s),
            end: fmt(e),
        }, note);
        if (ok) {
            document.getElementById('ptoNote').value = '';
            document.getElementById('ptoModalBack').classList.remove('open');
        }
    }
});

// ────────────── ON-CALL OVERRIDE MODAL ──────────────
let activeOcWeekKey = null;
let activeOcDayKey = null;
let activeOcDate = null;

function updateOcSubLabel() {
    const scope = document.querySelector('input[name="ocScope"]:checked').value;
    if (scope === 'day') {
        const d = activeOcDate;
        document.getElementById('ocModalSub').textContent =
            `${DOW[d.getDay()]}, ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
    } else {
        const cs = getCallCycleStart(activeOcDate);
        const ce = getCallCycleEnd(cs);
        document.getElementById('ocModalSub').textContent =
            `Full call block: ${MONTHS_SHORT[cs.getMonth()]} ${cs.getDate()} – ${MONTHS_SHORT[ce.getMonth()]} ${ce.getDate()}, ${ce.getFullYear()}`;
    }
}

function openOnCallModal(date) {
    const cs = getCallCycleStart(date);
    activeOcWeekKey = fmt(cs);
    activeOcDayKey = fmt(date);
    activeOcDate = date;

    const admin = isAdmin();
    // Tweak modal labels + reveal/hide note + reset/save buttons
    document.querySelector('#ocModalBack .modal h3').textContent =
        admin ? "Change who's on call" : "Request on-call change";
    document.getElementById('ocNoteWrap').style.display = admin ? 'none' : '';
    const ocNote = document.getElementById('ocNote');
    if (ocNote) ocNote.value = '';
    // Hide the "reset to default" button for non-admins (they can't directly reset)
    document.getElementById('ocReset').style.display = admin ? '' : 'none';
    document.getElementById('ocSave').textContent = admin ? 'Save' : 'Submit Request';

    // Default to "day only"
    document.getElementById('ocScopeDay').checked = true;
    updateOcSubLabel();

    const sel = document.getElementById('ocPath');
    const currentId = onCallIdForDay(date);
    sel.innerHTML = pathologists.map(p =>
        `<option value="${p.id}" ${p.id === currentId ? 'selected' : ''}>${p.name}</option>`
    ).join('');
    document.getElementById('ocModalBack').classList.add('open');
}
document.querySelectorAll('input[name="ocScope"]').forEach(radio => {
    radio.addEventListener('change', updateOcSubLabel);
});

document.getElementById('ocCancel').addEventListener('click', () => {
    document.getElementById('ocModalBack').classList.remove('open');
});
document.getElementById('ocModalBack').addEventListener('click', e => {
    if (e.target.id === 'ocModalBack') e.target.classList.remove('open');
});
// Helper: remove all day-level on-call overrides within the call cycle
// that contains activeOcDate.  Called whenever a week-scope change is
// saved or reset so day overrides can no longer shadow the week setting.
async function _clearDayOverridesForCycle() {
    const cs = getCallCycleStart(activeOcDate);
    const ce = getCallCycleEnd(cs);
    const writes = {};
    for (let d = new Date(cs); d.getTime() <= ce.getTime(); d = addDays(d, 1)) {
        const dk = fmt(d);
        if (onCallDayOverrides[dk] !== undefined) {
            writes['scheduler/onCallDayOverrides/' + dk] = null;
        }
    }
    if (Object.keys(writes).length > 0) {
        await db.ref().update(writes);
    }
}

document.getElementById('ocSave').addEventListener('click', async () => {
    const pid = parseInt(document.getElementById('ocPath').value, 10);
    const scope = document.querySelector('input[name="ocScope"]:checked').value;
    if (isAdmin()) {
        if (scope === 'day') {
            await db.ref('scheduler/onCallDayOverrides/' + activeOcDayKey).set(pid);
        } else {
            // Save the week-level override, then clear any day-level overrides
            // within this cycle so they can't silently shadow the week setting.
            await db.ref('scheduler/onCallOverrides/' + activeOcWeekKey).set(pid);
            await _clearDayOverridesForCycle();
        }
        document.getElementById('ocModalBack').classList.remove('open');
    } else {
        const note = (document.getElementById('ocNote').value || '').trim();
        const ok = await submitRequest('oncall_change', {
            date: activeOcDayKey,
            scope: scope,
            newPathId: pid,
        }, note);
        if (ok) document.getElementById('ocModalBack').classList.remove('open');
    }
});
document.getElementById('ocReset').addEventListener('click', async () => {
    const scope = document.querySelector('input[name="ocScope"]:checked').value;
    if (scope === 'day') {
        await db.ref('scheduler/onCallDayOverrides/' + activeOcDayKey).remove();
    } else {
        // Remove the week override and also clear any lingering day overrides
        // so the cycle fully reverts to the default rotation.
        await db.ref('scheduler/onCallOverrides/' + activeOcWeekKey).remove();
        await _clearDayOverridesForCycle();
    }
    document.getElementById('ocModalBack').classList.remove('open');
});

// ────────────── SERVICE OVERRIDE MODAL (per day or full call week) ──────────────
let activeSvcDayKey = null;
let activeSvcDate = null;

// List every workday (skipping weekends + federal holidays) inside the call
// cycle that contains `date`.  Used when applying a "full call week" service
// override / request.
function workdaysInCallCycle(date) {
    const cs = getCallCycleStart(date);
    const ce = getCallCycleEnd(cs);
    const out = [];
    for (let d = new Date(cs); d.getTime() <= ce.getTime(); d = addDays(d, 1)) {
        if (isWeekend(d)) continue;
        if (getFederalHoliday(d)) continue;
        out.push(new Date(d));
    }
    return out;
}

function updateSvcSubLabel() {
    const scope = document.querySelector('input[name="svcScope"]:checked').value;
    const d = activeSvcDate;
    if (!d) return;
    const subEl = document.getElementById('svcModalSub');
    if (scope === 'day') {
        subEl.textContent =
            `${DOW[d.getDay()]}, ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}. PTO pathologists are skipped — manage PTO separately.`;
    } else {
        const cs = getCallCycleStart(d);
        const ce = getCallCycleEnd(cs);
        subEl.textContent =
            `Full call week: ${MONTHS_SHORT[cs.getMonth()]} ${cs.getDate()} – ${MONTHS_SHORT[ce.getMonth()]} ${ce.getDate()}, ${ce.getFullYear()}. Applies to every workday; PTO days are skipped.`;
    }
}

function openServiceModal(date) {
    if (isWeekend(date)) return;   // no service rotation on weekends
    if (getFederalHoliday(date)) return;  // no service rotation on federal holidays
    activeSvcDayKey = fmt(date);
    activeSvcDate = date;

    const admin = isAdmin();
    document.querySelector('#svcModalBack .modal h3').textContent =
        admin ? 'Override services' : 'Request service change';
    document.getElementById('svcNoteWrap').style.display = admin ? 'none' : '';
    const svcNote = document.getElementById('svcNote');
    if (svcNote) svcNote.value = '';
    document.getElementById('svcReset').style.display = admin ? '' : 'none';
    document.getElementById('svcSave').textContent = admin ? 'Save' : 'Submit Request';

    // Default to "this day only" (preserves existing behaviour)
    document.getElementById('svcScopeDay').checked = true;
    updateSvcSubLabel();

    const dayAssign = getDayAssignments(date);
    const container = document.getElementById('svcAssignments');

    // Non-admin: only render their own row (they can only request changes
    // to their own service slot)
    const visiblePaths = admin
        ? pathologists
        : pathologists.filter(p => p.id === loggedInPathId);

    container.innerHTML = visiblePaths.map(p => {
        const a = dayAssign[p.id];
        if (a.type === 'blank') {
            return `<label style="margin-top:10px;">${p.name}</label>
          <select disabled><option>Date is before scheduling start</option></select>`;
        }
        if (a.type === 'pto') {
            return `<label style="margin-top:10px;">${p.name}</label>
          <select disabled><option>On PTO</option></select>`;
        }
        const currentId = a.type === 'service' ? a.service.id : '';
        const allOptions = [...SERVICES, COMBO_SVC];
        const opts = allOptions.map(s =>
            `<option value="${s.id}" ${s.id === currentId ? 'selected' : ''}>${s.name}</option>`
        ).join('');
        const noneOpt = `<option value="" ${currentId === '' ? 'selected' : ''}>— No service —</option>`;
        return `<label style="margin-top:10px;">${p.name}</label>
        <select data-pid="${p.id}">${noneOpt}${opts}</select>`;
    }).join('');
    document.getElementById('svcModalBack').classList.add('open');
}

// Refresh the sub-label whenever scope changes
document.querySelectorAll('input[name="svcScope"]').forEach(radio => {
    radio.addEventListener('change', updateSvcSubLabel);
});

document.getElementById('svcCancel').addEventListener('click', () => {
    document.getElementById('svcModalBack').classList.remove('open');
});
document.getElementById('svcModalBack').addEventListener('click', e => {
    if (e.target.id === 'svcModalBack') e.target.classList.remove('open');
});
document.getElementById('svcSave').addEventListener('click', async () => {
    const selects = document.querySelectorAll('#svcAssignments select[data-pid]');
    const scope = document.querySelector('input[name="svcScope"]:checked').value;

    if (isAdmin()) {
        // Build {pid: serviceId} map of all the slots the admin filled in
        const update = {};
        selects.forEach(s => {
            if (s.value) update[s.dataset.pid] = s.value;
        });

        // Track what we just saved so the recompute prompt can use the new
        // values as locks regardless of whether the Firebase listener has
        // fired yet.
        let recomputeFromDate = null;
        const recomputePins = {};

        if (scope === 'day') {
            if (Object.keys(update).length === 0) {
                await db.ref('scheduler/serviceOverrides/' + activeSvcDayKey).remove();
                recomputePins[activeSvcDayKey] = {};
            } else {
                await db.ref('scheduler/serviceOverrides/' + activeSvcDayKey).set(update);
                recomputePins[activeSvcDayKey] = Object.assign({}, update);
            }
            recomputeFromDate = activeSvcDate;
        } else {
            // Full call week: merge the same {pid: serviceId} into every
            // workday in the cycle (PTO days will simply be ignored at
            // render time by getNaturalDayAssignments).
            const days = workdaysInCallCycle(activeSvcDate);
            const writes = {};
            days.forEach(d => {
                const dKey = fmt(d);
                const existing = serviceOverrides[dKey] || {};
                if (Object.keys(update).length === 0) {
                    // Nothing selected for any slot — no-op for that day
                    return;
                }
                writes['scheduler/serviceOverrides/' + dKey] =
                    Object.assign({}, existing, update);
                // Pin ONLY the admin-just-set paths from `update` —
                // pre-existing overrides shouldn't lock the recompute.
                recomputePins[dKey] = Object.assign({}, update);
            });
            if (Object.keys(writes).length > 0) {
                await db.ref().update(writes);
            }
            if (days.length > 0) recomputeFromDate = days[0];
        }
        document.getElementById('svcModalBack').classList.remove('open');

        if (recomputeFromDate) {
            await maybeOfferRecompute(recomputePins, {
                fromDate: recomputeFromDate,
                dayBeforeFix: true,
                message: 'Service change saved. Recompute the future schedule for everyone using the rotation rules?',
            });
        }
    } else {
        // Non-admin: there's only one select (their own).  Submit a request.
        const ownSelect = document.querySelector(`#svcAssignments select[data-pid="${loggedInPathId}"]`);
        if (!ownSelect) {
            alert('Could not find your service slot.');
            return;
        }
        const note = (document.getElementById('svcNote').value || '').trim();
        const ok = await submitRequest('service_change', {
            date: activeSvcDayKey,
            serviceId: ownSelect.value || null,
            scope: scope,    // 'day' | 'week'
        }, note);
        if (ok) document.getElementById('svcModalBack').classList.remove('open');
    }
});
document.getElementById('svcReset').addEventListener('click', async () => {
    const scope = document.querySelector('input[name="svcScope"]:checked').value;
    let recomputeFromDate = null;
    const recomputePins = {};

    if (scope === 'day') {
        await db.ref('scheduler/serviceOverrides/' + activeSvcDayKey).remove();
        recomputePins[activeSvcDayKey] = {};
        recomputeFromDate = activeSvcDate;
    } else {
        // Wipe overrides for every workday in the call cycle
        const days = workdaysInCallCycle(activeSvcDate);
        const writes = {};
        days.forEach(d => {
            const dKey = fmt(d);
            writes['scheduler/serviceOverrides/' + dKey] = null;
            recomputePins[dKey] = {};
        });
        if (Object.keys(writes).length > 0) await db.ref().update(writes);
        if (days.length > 0) recomputeFromDate = days[0];
    }
    document.getElementById('svcModalBack').classList.remove('open');

    if (recomputeFromDate) {
        await maybeOfferRecompute(recomputePins, {
            fromDate: recomputeFromDate,
            dayBeforeFix: true,
            message: 'Service overrides cleared. Recompute the future schedule for everyone using the rotation rules?',
        });
    }
});

// ────────────── DISPATCH ──────────────
function renderAgenda() {
    const main = document.getElementById('main');

    // Determine which pathologists to show
    const activePaths = currentPathFilter === 'all'
        ? pathologists
        : pathologists.filter(p => p.id === parseInt(currentPathFilter));

    if (activePaths.length === 0) return;

    // Single-pathologist mode: existing compact list view
    if (activePaths.length === 1) {
        const p = activePaths[0];
        const pid = p.id;

        let html = `<div style="max-width: 600px; margin: 0 auto;">
      <h3 style="font-family: var(--serif); font-size: 26px; margin-bottom: 16px; color: var(--ink);">Compact Schedule: ${p.name.replace(/^Dr\. /, '')}</h3>
      <div style="background: var(--paper); border: 1px solid var(--rule-soft); border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.02);">`;

        let found = 0;
        for (let i = 0; i < 60; i++) {
            const d = addDays(today, i);
            const a = getDayAssignments(d)[pid];
            if (!a || a.type === 'off' || a.type === 'blank') continue;

            found++;
            const isPto = a.type === 'pto';
            const svcStr = isPto ? 'PTO' : `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(${a.service.cssVar});margin-right:8px;"></span>${a.service.name}`;
            const ocBadge = a.onCall ? `<span style="background: var(--accent); color: white; padding: 2px 6px; border-radius: 3px; font-family: var(--mono); font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; margin-left: 10px;">On Call</span>` : '';
            const rowBg = isPto
                ? 'repeating-linear-gradient(45deg, var(--pto-stripe) 0, var(--pto-stripe) 4px, var(--pto-bg) 4px, var(--pto-bg) 8px)'
                : (pathBgColor(p.color) || 'var(--bg)');
            const color = isPto ? 'var(--pto-ink)' : 'var(--ink)';
            const weight = isPto ? '600' : '400';

            html += `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; border-bottom: 1px solid var(--rule-soft); background: ${rowBg}; color: ${color};">
          <div style="font-weight: 500; font-size: 14px;">${DOW[d.getDay()]}, ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}</div>
          <div style="font-size: 13.5px; display: flex; align-items: center; font-weight: ${weight};">
            ${svcStr} ${ocBadge}
          </div>
        </div>`;
        }

        if (found === 0) {
            html += `<div style="padding: 20px; text-align: center; color: var(--ink-3); font-style: italic;">No upcoming scheduled shifts in the next 60 days.</div>`;
        }

        html += `</div></div>`;
        main.innerHTML = html;
        return;
    }

    // All-pathologists mode: day-by-day agenda showing everyone
    let html = `<div style="max-width: 700px; margin: 0 auto;">
      <h3 style="font-family: var(--serif); font-size: 26px; margin-bottom: 16px; color: var(--ink);">Compact Schedule: All Pathologists</h3>
      <div style="background: var(--paper); border: 1px solid var(--rule-soft); border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.02);">`;

    let foundAny = false;
    for (let i = 0; i < 60; i++) {
        const d = addDays(today, i);
        if (isWeekend(d)) continue;
        const holiday = getFederalHoliday(d);
        const dayAssign = getDayAssignments(d);

        // Check if any pathologist has something noteworthy today
        const hasContent = activePaths.some(p => {
            const a = dayAssign[p.id];
            return a && a.type !== 'off' && a.type !== 'blank';
        });
        if (!hasContent && !holiday) continue;

        foundAny = true;
        const isToday = sameDay(d, today);
        const holidayBadge = holiday
            ? `<span style="font-size:11px; background: var(--holiday-bg,#fff8e1); color: var(--holiday-ink,#7a5800); border-radius: 3px; padding: 1px 6px; margin-left: 8px;">${holiday}</span>`
            : '';

        html += `
        <div style="border-bottom: 1px solid var(--rule-soft);">
          <div style="padding: 10px 18px 6px; background: ${isToday ? 'var(--today-bg, rgba(0,0,0,0.03))' : 'transparent'}; display: flex; align-items: center; gap: 4px;">
            <span style="font-weight: 600; font-size: 13.5px; color: ${isToday ? 'var(--accent)' : 'var(--ink-2)'};">${DOW[d.getDay()]}, ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}</span>
            ${holidayBadge}
          </div>`;

        activePaths.forEach(p => {
            const a = dayAssign[p.id];
            if (!a || a.type === 'off' || a.type === 'blank') return;

            const isPto = a.type === 'pto';
            const svcStr = isPto
                ? 'PTO'
                : `<span style="display:inline-block;width:7px;height:7px;border-radius:2px;background:var(${a.service.cssVar});margin-right:6px;flex-shrink:0;"></span>${a.service.short}`;
            const ocBadge = a.onCall
                ? `<span style="background: var(--accent); color: white; padding: 1px 5px; border-radius: 3px; font-family: var(--mono); font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; margin-left: 8px;">On Call</span>`
                : '';
            const rowBg = isPto
                ? 'repeating-linear-gradient(45deg, var(--pto-stripe) 0, var(--pto-stripe) 4px, var(--pto-bg) 4px, var(--pto-bg) 8px)'
                : (pathBgColor(p.color) || 'transparent');

            html += `
          <div style="display: flex; align-items: center; padding: 7px 18px 7px 28px; background: ${rowBg}; gap: 10px;">
            <span style="display:inline-block; width:7px; height:7px; border-radius:50%; background:${p.color}; flex-shrink:0;"></span>
            <span style="font-size:12px; font-weight:600; color: var(--ink-2); min-width: 26px;">${p.initials}</span>
            <span style="font-size: 13px; display: flex; align-items: center; color: ${isPto ? 'var(--pto-ink)' : 'var(--ink)'}; font-weight: ${isPto ? '600' : '400'};">
              ${svcStr} ${ocBadge}
            </span>
          </div>`;
        });

        html += `</div>`;
    }

    if (!foundAny) {
        html += `<div style="padding: 20px; text-align: center; color: var(--ink-3); font-style: italic;">No upcoming scheduled shifts in the next 60 days.</div>`;
    }

    html += `</div></div>`;
    main.innerHTML = html;
}

function renderMain() {
    renderPeriodLabel();
    if (view === 'week') renderWeek();
    else if (view === 'month') renderMonth();
    else if (view === 'year') renderYear();
    else if (view === 'agenda') renderAgenda(); // Add this line
}

function renderAll() {
    if (!pathologistsReady || !vacationsReady || pathologists.length === 0) return;
    applySettings();   // ensure sidebar/weekdays setting is reflected
    renderSidebar();
    renderMain();
}

// ────────────── NAV EVENTS ──────────────
document.getElementById('viewTabs').addEventListener('click', e => {
    const btn = e.target.closest('.view-tab');
    if (!btn) return;
    document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    view = btn.dataset.view;
    renderMain();
});

document.getElementById('prevBtn').addEventListener('click', () => {
    if (view === 'week') cursor = addDays(cursor, -7);
    else if (view === 'month') cursor = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1);
    else cursor = new Date(cursor.getFullYear() - 1, cursor.getMonth(), 1);
    renderMain();
});
document.getElementById('nextBtn').addEventListener('click', () => {
    if (view === 'week') cursor = addDays(cursor, 7);
    else if (view === 'month') cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    else cursor = new Date(cursor.getFullYear() + 1, cursor.getMonth(), 1);
    renderMain();
});
document.getElementById('todayBtn').addEventListener('click', () => {
    cursor = new Date(today);
    renderMain();
});

document.getElementById('pathTabs').addEventListener('click', e => {
    const btn = e.target.closest('.path-tab');
    if (!btn) return;
    const filter = btn.dataset.filter === 'me' ? String(loggedInPathId) : 'all';
    setPathFilter(filter);
    renderMain();
});

// ────────────── MOBILE HAMBURGER MENU ──────────────
// On phones, Manage PTO / Requests / Export to Outlook live in a dropdown
// behind a hamburger icon to free up vertical real estate. The menu items
// just delegate to the existing sidebar button click handlers so behavior
// stays in lock-step between the two surfaces.
(function wireHamburgerMenu() {
    const menuBtn  = document.getElementById('menuBtn');
    const dropdown = document.getElementById('menuDropdown');
    if (!menuBtn || !dropdown) return;

    function openMenu() {
        dropdown.classList.add('open');
        menuBtn.setAttribute('aria-expanded', 'true');
        dropdown.setAttribute('aria-hidden', 'false');
    }
    function closeMenu() {
        dropdown.classList.remove('open');
        menuBtn.setAttribute('aria-expanded', 'false');
        dropdown.setAttribute('aria-hidden', 'true');
    }
    function toggleMenu() {
        dropdown.classList.contains('open') ? closeMenu() : openMenu();
    }

    menuBtn.addEventListener('click', e => {
        e.stopPropagation();
        toggleMenu();
    });

    // Click outside to close
    document.addEventListener('click', e => {
        if (!dropdown.classList.contains('open')) return;
        if (dropdown.contains(e.target) || menuBtn.contains(e.target)) return;
        closeMenu();
    });

    // Esc to close
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && dropdown.classList.contains('open')) closeMenu();
    });

    // Item routing — each item triggers the matching existing sidebar button
    // so we don't duplicate any modal-opening logic.
    dropdown.addEventListener('click', e => {
        const item = e.target.closest('.menu-item');
        if (!item) return;
        const action = item.dataset.action;
        closeMenu();
        if (action === 'pto') {
            document.getElementById('addPtoBtn').click();
        } else if (action === 'requests') {
            document.getElementById('requestsBtn').click();
        } else if (action === 'export') {
            document.getElementById('exportBtn').click();
        }
    });
})();

// Tap-to-today on the period label.  On desktop this only fires when
// you're not already viewing today (the label gets the "off-today" class
// via renderPeriodLabel); on mobile it always fires since we removed the
// dedicated Today button to save space.
document.getElementById('currentPeriod').addEventListener('click', () => {
    cursor = new Date(today);
    renderMain();
});

// Keyboard shortcuts
document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (document.querySelector('.modal-back.open')) return;
    if (e.key === 'ArrowLeft') document.getElementById('prevBtn').click();
    else if (e.key === 'ArrowRight') document.getElementById('nextBtn').click();
    else if (e.key === 't' || e.key === 'T') document.getElementById('todayBtn').click();
    else if (e.key === '1') document.querySelector('.view-tab[data-view="week"]').click();
    else if (e.key === '2') document.querySelector('.view-tab[data-view="month"]').click();
    else if (e.key === '3') document.querySelector('.view-tab[data-view="year"]').click();
});

// ────────────── EXPORT TO OUTLOOK (.ics) ──────────────
// Builds an iCalendar file from the schedule and triggers a browser download.
// Outlook (desktop, web, and mobile), Google Calendar, and Apple Calendar all
// import .ics files natively.

// Pad helper for ICS UTC timestamps (DTSTAMP must be UTC)
function _icsPad(n) { return String(n).padStart(2, '0'); }
function _icsDateOnly(d) {
    // YYYYMMDD — used for all-day events (DTSTART;VALUE=DATE)
    return `${d.getFullYear()}${_icsPad(d.getMonth() + 1)}${_icsPad(d.getDate())}`;
}
function _icsDateTimeUtc(d) {
    // YYYYMMDDTHHMMSSZ — used for DTSTAMP
    return `${d.getUTCFullYear()}${_icsPad(d.getUTCMonth() + 1)}${_icsPad(d.getUTCDate())}T${_icsPad(d.getUTCHours())}${_icsPad(d.getUTCMinutes())}${_icsPad(d.getUTCSeconds())}Z`;
}
// Escape special chars per RFC 5545: backslash, comma, semicolon, newline.
function _icsEscape(s) {
    return String(s)
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/,/g, '\\,')
        .replace(/;/g, '\\;');
}
// Fold lines longer than 75 octets per RFC 5545 (line + CRLF + space continuation).
function _icsFold(line) {
    if (line.length <= 75) return line;
    const out = [];
    let i = 0;
    while (i < line.length) {
        out.push((i === 0 ? '' : ' ') + line.substr(i, 75));
        i += 75;
    }
    return out.join('\r\n');
}

// Extract surname for Outlook-style summaries: "Dr. Michael Moravek" → "Moravek"
function _icsLastName(fullName) {
    const cleaned = String(fullName || '').replace(/^Dr\.\s*/i, '').trim();
    const parts = cleaned.split(/\s+/);
    return parts[parts.length - 1] || cleaned;
}

// Map service id → the short tag the user uses in Outlook
function _icsServiceShort(serviceId) {
    switch (serviceId) {
        case 'cyto': return 'M cyto/gross';
        case 'bigs': return 'M bigs';
        case 'huntley': return 'H';
        case 'wfh': return 'breast bx/work from home';
        case 'cytobigs': return 'M cyto/gross/bigs';
        default: return serviceId || '';
    }
}

// Contiguous PTO blocks for one pathologist, with weekend flanks attached
// when the PTO touches a Monday (extend back to Sat) or a Friday (extend
// forward to Sun). Result is sorted, merged, and clipped to [startDate, endDate].
function _collectPtoBlocks(pathId, startDate, endDate) {
    const raw = vacations
        .filter(v => v.pathologistId === pathId)
        .map(v => ({ start: new Date(v.start), end: new Date(v.end) }));

    // Apply weekend flanks against the original (un-clipped) PTO range
    raw.forEach(b => {
        if (b.start.getDay() === 1) b.start = addDays(b.start, -2); // Mon → Sat
        if (b.end.getDay() === 5) b.end = addDays(b.end, 2);   // Fri → Sun
    });

    raw.sort((a, b) => a.start - b.start);

    // Merge any blocks that now overlap or sit adjacent
    const merged = [];
    raw.forEach(b => {
        const last = merged[merged.length - 1];
        if (last && b.start.getTime() <= addDays(last.end, 1).getTime()) {
            if (b.end > last.end) last.end = new Date(b.end);
        } else {
            merged.push({ start: new Date(b.start), end: new Date(b.end) });
        }
    });

    // Clip to the export window
    return merged
        .map(b => ({
            start: b.start < startDate ? new Date(startDate) : b.start,
            end: b.end > endDate ? new Date(endDate) : b.end,
        }))
        .filter(b => b.start.getTime() <= b.end.getTime());
}

// Contiguous on-call blocks for one pathologist within [startDate, endDate].
// Walks day-by-day so per-day overrides naturally split blocks. Holiday-shifted
// cycles (e.g. Memorial Day) come through automatically because onCallIdForDay
// already accounts for the cycle boundary logic.
function _collectCallBlocks(pathId, startDate, endDate) {
    const blocks = [];
    let curStart = null;
    for (let d = new Date(startDate); d.getTime() <= endDate.getTime(); d = addDays(d, 1)) {
        const callId = onCallIdForDay(d);
        if (callId === pathId) {
            if (!curStart) curStart = new Date(d);
        } else if (curStart) {
            blocks.push({ start: curStart, end: addDays(d, -1) });
            curStart = null;
        }
    }
    if (curStart) blocks.push({ start: curStart, end: new Date(endDate) });
    return blocks;
}

// Build a list of VEVENT blocks for one pathologist + date range + options.
// Matches the user's Outlook formatting: "Dr. {Last} {tag}", consolidated PTO
// and Call blocks, and Outlook master-category colors.
function buildIcsEvents(pathId, startDate, endDate, opts) {
    const events = [];
    const stamp = _icsDateTimeUtc(new Date());
    const path = pathologists.find(p => p.id === pathId);
    if (!path) return events;
    const lastName = _icsLastName(path.name);

    // Helper to emit one all-day VEVENT (DTEND is exclusive per RFC 5545)
    const pushEvent = (uidSuffix, start, endInclusive, summary, category) => {
        const uid = `schedule-${pathId}-${fmt(start)}-${uidSuffix}@pathology-schedule`;
        events.push([
            'BEGIN:VEVENT',
            _icsFold(`UID:${uid}`),
            `DTSTAMP:${stamp}`,
            `DTSTART;VALUE=DATE:${_icsDateOnly(start)}`,
            `DTEND;VALUE=DATE:${_icsDateOnly(addDays(endInclusive, 1))}`,
            _icsFold(`SUMMARY:${_icsEscape(summary)}`),
            _icsFold(`CATEGORIES:${_icsEscape(category)}`),
            'TRANSP:TRANSPARENT',
            'END:VEVENT',
        ].join('\r\n'));
    };

    // 1. Per-day SERVICE events (Blue category) — workdays only, no on-call decoration
    if (opts.includeService) {
        for (let d = new Date(startDate); d.getTime() <= endDate.getTime(); d = addDays(d, 1)) {
            const a = getDayAssignments(d)[pathId];
            if (!a || a.type !== 'service' || !a.service) continue;
            const summary = `Dr. ${lastName} ${_icsServiceShort(a.service.id)}`;
            pushEvent('svc', d, d, summary, 'Blue category');
        }
    }

    // 2. Consolidated PTO events with weekend flanks (Green category)
    if (opts.includePto) {
        _collectPtoBlocks(pathId, startDate, endDate).forEach(b => {
            pushEvent('pto', b.start, b.end, `Dr. ${lastName} Off`, 'Green category');
        });
    }

    // 3. Full-cycle on-call events (Red category)
    if (opts.includeOnCall) {
        _collectCallBlocks(pathId, startDate, endDate).forEach(b => {
            pushEvent('call', b.start, b.end, `Dr. ${lastName} Call`, 'Red category');
        });
    }

    return events;
}

function buildIcsFile(pathId, startDate, endDate, opts) {
    const path = pathologists.find(p => p.id === pathId);
    const calName = path ? path.name : 'Pathologist';
    const events = buildIcsEvents(pathId, startDate, endDate, opts);

    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Pathology Group//Schedule Export//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        _icsFold(`X-WR-CALNAME:${_icsEscape(calName)}`),
        _icsFold(`X-WR-CALDESC:${_icsEscape('Pathology group schedule export')}`),
        ...events,
        'END:VCALENDAR',
    ];
    return lines.join('\r\n') + '\r\n';
}
// ── Export all pathologists into a single combined ICS ──
function buildIcsFileAll(startDate, endDate, opts) {
    const allEvents = [];
    pathologists.forEach(p => {
        allEvents.push(...buildIcsEvents(p.id, startDate, endDate, opts));
    });

    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Pathology Group//Schedule Export//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        _icsFold(`X-WR-CALNAME:${_icsEscape('All Pathologists')}`),
        _icsFold(`X-WR-CALDESC:${_icsEscape('Full pathology group schedule export')}`),
        ...allEvents,
        'END:VCALENDAR',
    ];
    return lines.join('\r\n') + '\r\n';
}

function downloadIcs(filename, content) {
    const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
}

// ── Wire up the export modal ──
document.getElementById('exportBtn').addEventListener('click', () => {
    if (!isAdmin()) {
        showToast('Only the admin can export the schedule.', { type: 'error' });
        return;
    }
    // Populate pathologist dropdown
    const sel = document.getElementById('exportPath');
    sel.innerHTML =
        `<option value="all">— All Pathologists —</option>` +
        pathologists.map(p =>
            `<option value="${p.id}">${p.name}</option>`
        ).join('');

    // If a specific pathologist is filtered, preselect them
    if (currentPathFilter !== 'all') sel.value = currentPathFilter;

    // Default date range: today → 90 days out
    const start = new Date(today);
    const end = addDays(today, 90);
    document.getElementById('exportStart').value = fmt(start);
    document.getElementById('exportEnd').value = fmt(end);

    document.getElementById('exportModalBack').classList.add('open');
});

document.getElementById('exportCancel').addEventListener('click', () => {
    document.getElementById('exportModalBack').classList.remove('open');
});
document.getElementById('exportModalBack').addEventListener('click', e => {
    if (e.target.id === 'exportModalBack') e.target.classList.remove('open');
});

document.getElementById('exportDownload').addEventListener('click', () => {
    const pathIdRaw = document.getElementById('exportPath').value;
    const isAll = pathIdRaw === 'all';
    const pathId = isAll ? null : parseInt(pathIdRaw, 10);
    const startStr = document.getElementById('exportStart').value;
    const endStr = document.getElementById('exportEnd').value;

    if ((!isAll && !pathId) || !startStr || !endStr) {
        alert('Please choose a pathologist and a valid date range.');
        return;
    }
    const start = parseDate(startStr);
    const end = parseDate(endStr);
    if (end.getTime() < start.getTime()) {
        alert('End date must be on or after the start date.');
        return;
    }

    const opts = {
        includeService: document.getElementById('exportIncludeService').checked,
        includePto: document.getElementById('exportIncludePto').checked,
        includeOnCall: document.getElementById('exportIncludeOnCall').checked,
    };
    if (!opts.includeService && !opts.includePto && !opts.includeOnCall) {
        alert('Please select at least one event type to include.');
        return;
    }

    if (isAll) {
        const ics = buildIcsFileAll(start, end, opts);
        const filename = `schedule_all_pathologists_${startStr}_to_${endStr}.ics`;
        downloadIcs(filename, ics);
    } else {
        const path = pathologists.find(p => p.id === pathId);
        const ics = buildIcsFile(pathId, start, end, opts);
        const safeName = (path ? path.name : 'pathologist')
            .replace(/^Dr\.\s*/i, '')
            .replace(/[^a-z0-9]+/gi, '_')
            .replace(/^_+|_+$/g, '');
        const filename = `schedule_${safeName}_${startStr}_to_${endStr}.ics`;
        downloadIcs(filename, ics);
    }

    document.getElementById('exportModalBack').classList.remove('open');
});
// ────────────── SETTINGS UI ──────────────
(function initSettings() {
    const btn    = document.getElementById('settingsBtn');
    const drawer = document.getElementById('settingsDrawer');
    const twBtn  = document.getElementById('toggleWeekdays');
    const tsBtn  = document.getElementById('toggleSidebar');

    if (!btn || !drawer) return;

    // Apply settings on first load (syncs toggles + sidebar visibility)
    applySettings();

    // Open / close the drawer
    function openDrawer() {
        drawer.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
        drawer.setAttribute('aria-hidden', 'false');
    }
    function closeDrawer() {
        drawer.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
        drawer.setAttribute('aria-hidden', 'true');
    }

    btn.addEventListener('click', e => {
        e.stopPropagation();
        drawer.classList.contains('open') ? closeDrawer() : openDrawer();
    });

    // Close drawer when clicking anywhere outside it
    document.addEventListener('click', e => {
        if (!drawer.contains(e.target) && e.target !== btn) closeDrawer();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeDrawer();
    });

    // Weekdays-only toggle
    if (twBtn) {
        twBtn.addEventListener('click', e => {
            e.preventDefault();
            settings.weekdaysOnly = !settings.weekdaysOnly;
            saveSettings();
            applySettings();
            renderMain();
        });
    }

    // Hide sidebar toggle
    if (tsBtn) {
        tsBtn.addEventListener('click', e => {
            e.preventDefault();
            settings.hideSidebar = !settings.hideSidebar;
            saveSettings();
            applySettings();
        });
    }

    // Sign out button
    const signOutBtn = document.getElementById('settingsSignOutBtn');
    if (signOutBtn) {
        signOutBtn.addEventListener('click', () => {
            closeDrawer();
            localStorage.removeItem(AUTH_STORAGE_KEY);
            loggedInPathId = null;
            // Show login overlay
            const overlay = document.getElementById('loginOverlay');
            if (overlay) overlay.style.display = 'flex';
        });
    }

    // Sidebar arrow toggle button (on the aside itself)
    const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
    if (sidebarToggleBtn) {
        sidebarToggleBtn.addEventListener('click', e => {
            e.preventDefault();
            settings.hideSidebar = !settings.hideSidebar;
            saveSettings();
            applySettings();
            // Update aria-label to reflect new state
            sidebarToggleBtn.setAttribute('aria-label',
                settings.hideSidebar ? 'Expand sidebar' : 'Collapse sidebar');
            sidebarToggleBtn.setAttribute('title',
                settings.hideSidebar ? 'Expand sidebar' : 'Collapse sidebar');
        });
    }
})();
