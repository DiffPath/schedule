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

// Ensure the manager account (Kathleen) has her default password set in
// Firebase. This runs once on first load; subsequent loads are no-ops.
(function seedManagerPassword() {
    const ref = db.ref('scheduler/passwords/' + 'kathleen');
    ref.once('value').then(snap => {
        if (!snap.exists() || !snap.val()) {
            ref.set('discover');
        }
    });
})();

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

// Off-site services: shown in service dropdowns and rendered like regular
// services, but the pathologist is excluded from the McH/Huntley coverage
// rotation (same effect as PTO on the automated assignment cascade).
const OFF_SERVICES = [
    { id: 'off_service', name: 'Off Service', short: 'Off Service', abbr: 'OFF', cssVar: '--svc-off-service' },
    { id: 'off_service_director', name: 'Off Service – Director Retreat', short: 'Off Service - Dir Retreat', abbr: 'DIR', cssVar: '--svc-off-service-director' },
    { id: 'off_service_lab', name: 'Off Service – Lab Inspection', short: 'Off Service - Lab Inspect', abbr: 'LAB', cssVar: '--svc-off-service-lab' },
];

// Returns true when a service id represents an off-site assignment
// (excluded from coverage rotation but rendered as a service, not as PTO).
function isOffSiteServiceId(id) {
    return OFF_SERVICES.some(s => s.id === id);
}

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
OFF_SERVICES.forEach(s => { SERVICE_BY_ID[s.id] = s; }); // Register off-site services

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

// Lake Forest sendout flags. When set, an "LF sendout" row is rendered above
// the first pathologist on the matching day(s).
//   lfSendoutDays  → { 'YYYY-MM-DD': true }     individual day
//   lfSendoutWeeks → { 'YYYY-MM-DD': true }     keyed by call-cycle start
let lfSendoutDays = {};
let lfSendoutWeeks = {};

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
const HOURS_END = 16;  // last hour shown (so last slot is HOURS_END:30 = 4:30 PM)

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
// Conference-tracker manager: can view the full schedule and edit the
// conference tracking page, but cannot manage pathologist assignments or PTO.
const MANAGER_ID = 'kathleen';
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

// Returns true when the conference-tracker manager (Kathleen) is signed in.
// She can view the full schedule and edit the conference tracking page.
function isManager() {
    return loggedInPathId === MANAGER_ID;
}

// Update the path-tab toggle to reflect val ('all' or a stringified pathId)
function setPathFilter(val) {
    currentPathFilter = val;
    document.querySelectorAll('.path-tab').forEach(btn => {
        const wantsAll = btn.dataset.filter === 'all';
        btn.classList.toggle('active', wantsAll ? val === 'all' : val !== 'all');
    });
    // Mirror to the mobile select (single-row toolbar on phone viewports).
    // The select only has 'all' and 'me' as values; any non-'all' filter is
    // the user's own id, which the mobile UI represents as 'me'.
    const mobileSel = document.getElementById('mobilePathSelect');
    if (mobileSel) mobileSel.value = (val === 'all') ? 'all' : 'me';
}
let view;                             // 'day' | 'week' | 'month' | 'year' — assigned after settings load below
let today;
let cursor;

// Viewport helper — true when we're on a phone-sized screen. Kept in sync
// with the @media (max-width: 800px) breakpoint used throughout the CSS.
// Used by the initial-view selection (mobile gets Day by default) and by
// the resize handler so the active view stays sensible across rotations.
const MOBILE_BREAKPOINT_PX = 800;
function isMobileViewport() {
    return typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT_PX;
}

// ────────────── DISPLAY SETTINGS ──────────────
// Persisted in localStorage so preferences survive page refreshes.
const SETTINGS_STORAGE_KEY = 'schedDisplaySettings';
const VALID_DEFAULT_VIEWS = ['day', 'week', 'month', 'year'];
const VALID_DEFAULT_FILTERS = ['all', 'me'];
const DEFAULT_SETTINGS = {
    weekdaysOnly: false,
    hideSidebar: false,
    // What view to show when the app opens. 'week' preserves prior behavior.
    defaultView: 'week',
    // Which pathologists to show on launch: 'all' or 'me' (your own schedule).
    // 'me' preserves prior behavior for individual pathologists. Gross-room
    // is always forced to 'all' regardless of this setting.
    defaultPathFilter: 'me',
};
let settings = (() => {
    try {
        const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
        if (raw) return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
    } catch (_) { }
    return Object.assign({}, DEFAULT_SETTINGS);
})();
// Sanitize persisted values in case localStorage was hand-edited or stale.
if (!VALID_DEFAULT_VIEWS.includes(settings.defaultView)) settings.defaultView = 'week';
if (!VALID_DEFAULT_FILTERS.includes(settings.defaultPathFilter)) settings.defaultPathFilter = 'me';

// Now that settings is loaded, seed the active view from the user's
// default-view preference (falls back to 'week' if invalid).
//
// Mobile override: on phone-sized viewports we always start in Day view
// since that's the only mobile view that shows the procedure schedule
// (week/month/year on mobile are summary-only). Desktop users get their
// saved preference unchanged. We don't persist this override — switching
// to a phone for one session shouldn't overwrite a deliberate desktop
// default. The user can still tap Week / Month / Year on mobile within
// the session if they want.
view = settings.defaultView;
if (isMobileViewport()) view = 'day';
else if (view === 'day') view = 'week'; // 'day' saved but desktop loaded → fall back
today = new Date();
today.setHours(0, 0, 0, 0);
cursor = new Date(today);

function saveSettings() {
    try { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings)); } catch (_) { }
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

    // Sync the view-tab pills to whatever `view` currently is. This keeps the
    // header in sync after we seed `view` from settings.defaultView at load.
    document.querySelectorAll('.view-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.view === view);
    });

    // Sync segmented controls in the settings drawer to reflect saved defaults
    const dvSeg = document.getElementById('defaultViewSeg');
    if (dvSeg) {
        dvSeg.querySelectorAll('.seg-btn').forEach(b => {
            const isActive = b.dataset.value === settings.defaultView;
            b.classList.toggle('active', isActive);
            b.setAttribute('aria-checked', isActive ? 'true' : 'false');
        });
    }
    const dfSeg = document.getElementById('defaultFilterSeg');
    if (dfSeg) {
        dfSeg.querySelectorAll('.seg-btn').forEach(b => {
            const isActive = b.dataset.value === settings.defaultPathFilter;
            b.classList.toggle('active', isActive);
            b.setAttribute('aria-checked', isActive ? 'true' : 'false');
        });
    }
    // Gross-room is always forced to "All" regardless of the default-filter
    // setting, so hide that row to avoid showing a control that has no effect.
    const dfRow = document.getElementById('defaultFilterRow');
    if (dfRow) dfRow.style.display = (isGrossRoom() || isManager()) ? 'none' : '';

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
    if (raw === MANAGER_ID) return MANAGER_ID;
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
// Calendar-rule holiday: returns the name when the date itself matches a
// federal holiday by its raw rule, with NO weekend-observation shifting.
// Used internally by getFederalHoliday() to decide what falls on Sat/Sun.
function getActualFederalHoliday(date) {
    const m = date.getMonth();  // 0-indexed
    const d = date.getDate();
    const dow = date.getDay();  // 0=Sun … 6=Sat
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

// Returns the holiday name for the given date, or null if not a federal
// holiday. Applies federal observation rules: when a holiday lands on a
// Saturday, the prior Friday is the *true* holiday (everyone off service);
// when it lands on a Sunday, the following Monday is the true holiday.
// The actual Sat/Sun still returns its calendar name for display, but
// it's already a non-working day by virtue of being a weekend, so the
// behavior change only kicks in on the observed weekday.
function getFederalHoliday(date) {
    const dow = date.getDay();

    // Friday: if tomorrow (Saturday) is an actual holiday, today is observed.
    if (dow === 5) {
        const sat = addDays(date, 1);
        const satHol = getActualFederalHoliday(sat);
        if (satHol) return satHol + ' (observed)';
    }

    // Monday: if yesterday (Sunday) is an actual holiday, today is observed.
    if (dow === 1) {
        const sun = addDays(date, -1);
        const sunHol = getActualFederalHoliday(sun);
        if (sunHol) return sunHol + ' (observed)';
    }

    return getActualFederalHoliday(date);
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
        while (current.getTi    { id: 'bigs', name: 'McHenry Bigs', short: 'M Bigs', abbr: 'BIG', cssVar: '--svc-bigs' },
    { id: 'huntley', name: 'Huntley', short: 'Huntley', abbr: 'HUN', cssVar: '--svc-huntley' },
    { id: 'wfh', name: 'Breast Bx / WFH', short: 'Breast bx/WFH', abbr: 'WFH', cssVar: '--svc-wfh' },
];

// Off-site services: shown in service dropdowns and rendered like regular
// services, but the pathologist is excluded from the McH/Huntley coverage
// rotation (same effect as PTO on the automated assignment cascade).
const OFF_SERVICES = [
    { id: 'off_service', name: 'Off Service', short: 'Off Service', abbr: 'OFF', cssVar: '--svc-off-service' },
    { id: 'off_service_director', name: 'Off Service – Director Retreat', short: 'Off Service - Dir Retreat', abbr: 'DIR', cssVar: '--svc-off-service-director' },
    { id: 'off_service_lab', name: 'Off Service – Lab Inspection', short: 'Off Service - Lab Inspect', abbr: 'LAB', cssVar: '--svc-off-service-lab' },
];

// Returns true when a service id represents an off-site assignment
// (excluded from coverage rotation but rendered as a service, not as PTO).
function isOffSiteServiceId(id) {
    return OFF_SERVICES.some(s => s.id === id);
}

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
OFF_SERVICES.forEach(s => { SERVICE_BY_ID[s.id] = s; }); // Register off-site services

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

// Lake Forest sendout flags. When set, an "LF sendout" row is rendered above
// the first pathologist on the matching day(s).
//   lfSendoutDays  → { 'YYYY-MM-DD': true }     individual day
//   lfSendoutWeeks → { 'YYYY-MM-DD': true }     keyed by call-cycle start
let lfSendoutDays = {};
let lfSendoutWeeks = {};

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
const HOURS_END = 16;  // last hour shown (so last slot is HOURS_END:30 = 4:30 PM)

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
// Conference-tracker manager: can view the full schedule and edit the
// conference tracking page, but cannot manage pathologist assignments or PTO.
const MANAGER_ID = 'kathleen';
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

// Returns true when the conference-tracker manager (Kathleen) is signed in.
// She can view the full schedule and edit the conference tracking page.
function isManager() {
    return loggedInPathId === MANAGER_ID;
}

// Update the path-tab toggle to reflect val ('all' or a stringified pathId)
function setPathFilter(val) {
    currentPathFilter = val;
    document.querySelectorAll('.path-tab').forEach(btn => {
        const wantsAll = btn.dataset.filter === 'all';
        btn.classList.toggle('active', wantsAll ? val === 'all' : val !== 'all');
    });
    // Mirror to the mobile select (single-row toolbar on phone viewports).
    // The select only has 'all' and 'me' as values; any non-'all' filter is
    // the user's own id, which the mobile UI represents as 'me'.
    const mobileSel = document.getElementById('mobilePathSelect');
    if (mobileSel) mobileSel.value = (val === 'all') ? 'all' : 'me';
}
let view;                             // 'day' | 'week' | 'month' | 'year' — assigned after settings load below
let today;
let cursor;

// Viewport helper — true when we're on a phone-sized screen. Kept in sync
// with the @media (max-width: 800px) breakpoint used throughout the CSS.
// Used by the initial-view selection (mobile gets Day by default) and by
// the resize handler so the active view stays sensible across rotations.
const MOBILE_BREAKPOINT_PX = 800;
function isMobileViewport() {
    return typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT_PX;
}

// ────────────── DISPLAY SETTINGS ──────────────
// Persisted in localStorage so preferences survive page refreshes.
const SETTINGS_STORAGE_KEY = 'schedDisplaySettings';
const VALID_DEFAULT_VIEWS = ['day', 'week', 'month', 'year'];
const VALID_DEFAULT_FILTERS = ['all', 'me'];
const DEFAULT_SETTINGS = {
    weekdaysOnly: false,
    hideSidebar: false,
    // What view to show when the app opens. 'week' preserves prior behavior.
    defaultView: 'week',
    // Which pathologists to show on launch: 'all' or 'me' (your own schedule).
    // 'me' preserves prior behavior for individual pathologists. Gross-room
    // is always forced to 'all' regardless of this setting.
    defaultPathFilter: 'me',
};
let settings = (() => {
    try {
        const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
        if (raw) return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
    } catch (_) { }
    return Object.assign({}, DEFAULT_SETTINGS);
})();
// Sanitize persisted values in case localStorage was hand-edited or stale.
if (!VALID_DEFAULT_VIEWS.includes(settings.defaultView)) settings.defaultView = 'week';
if (!VALID_DEFAULT_FILTERS.includes(settings.defaultPathFilter)) settings.defaultPathFilter = 'me';

// Now that settings is loaded, seed the active view from the user's
// default-view preference (falls back to 'week' if invalid).
//
// Mobile override: on phone-sized viewports we always start in Day view
// since that's the only mobile view that shows the procedure schedule
// (week/month/year on mobile are summary-only). Desktop users get their
// saved preference unchanged. We don't persist this override — switching
// to a phone for one session shouldn't overwrite a deliberate desktop
// default. The user can still tap Week / Month / Year on mobile within
// the session if they want.
view = settings.defaultView;
if (isMobileViewport()) view = 'day';
else if (view === 'day') view = 'week'; // 'day' saved but desktop loaded → fall back
today = new Date();
today.setHours(0, 0, 0, 0);
cursor = new Date(today);

function saveSettings() {
    try { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings)); } catch (_) { }
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

    // Sync the view-tab pills to whatever `view` currently is. This keeps the
    // header in sync after we seed `view` from settings.defaultView at load.
    document.querySelectorAll('.view-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.view === view);
    });

    // Sync segmented controls in the settings drawer to reflect saved defaults
    const dvSeg = document.getElementById('defaultViewSeg');
    if (dvSeg) {
        dvSeg.querySelectorAll('.seg-btn').forEach(b => {
            const isActive = b.dataset.value === settings.defaultView;
            b.classList.toggle('active', isActive);
            b.setAttribute('aria-checked', isActive ? 'true' : 'false');
        });
    }
    const dfSeg = document.getElementById('defaultFilterSeg');
    if (dfSeg) {
        dfSeg.querySelectorAll('.seg-btn').forEach(b => {
            const isActive = b.dataset.value === settings.defaultPathFilter;
            b.classList.toggle('active', isActive);
            b.setAttribute('aria-checked', isActive ? 'true' : 'false');
        });
    }
    // Gross-room is always forced to "All" regardless of the default-filter
    // setting, so hide that row to avoid showing a control that has no effect.
    const dfRow = document.getElementById('defaultFilterRow');
    if (dfRow) dfRow.style.display = (isGrossRoom() || isManager()) ? 'none' : '';

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
    if (raw === MANAGER_ID) return MANAGER_ID;
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
// Calendar-rule holiday: returns the name when the date itself matches a
// federal holiday by its raw rule, with NO weekend-observation shifting.
// Used internally by getFederalHoliday() to decide what falls on Sat/Sun.
function getActualFederalHoliday(date) {
    const m = date.getMonth();  // 0-indexed
    const d = date.getDate();
    const dow = date.getDay();  // 0=Sun … 6=Sat
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

// Returns the holiday name for the given date, or null if not a federal
// holiday. Applies federal observation rules: when a holiday lands on a
// Saturday, the prior Friday is the *true* holiday (everyone off service);
// when it lands on a Sunday, the following Monday is the true holiday.
// The actual Sat/Sun still returns its calendar name for display, but
// it's already a non-working day by virtue of being a weekend, so the
// behavior change only kicks in on the observed weekday.
function getFederalHoliday(date) {
    const dow = date.getDay();

    // Friday: if tomorrow (Saturday) is an actual holiday, today is observed.
    if (dow === 5) {
        const sat = addDays(date, 1);
        const satHol = getActualFederalHoliday(sat);
        if (satHol) return satHol + ' (observed)';
    }

    // Monday: if yesterday (Sunday) is an actual holiday, today is observed.
    if (dow === 1) {
        const sun = addDays(date, -1);
        const sunHol = getActualFederalHoliday(sun);
        if (sunHol) return sunHol + ' (observed)';
    }

    return getActualFederalHoliday(date);
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

// Returns true if a Lake Forest sendout row should be rendered for this date.
// Either a per-day flag is set, or the day's call-cycle week has the flag set.
// Pre-cutoff dates always return false.
// When the full-week flag is set it only applies to working days (weekdays that
// are not federal holidays); weekends and holidays are always excluded.
function isLfSendoutDay(date) {
    if (isBeforeEarliest(date)) return false;
    const dk = fmt(date);
    if (lfSendoutDays[dk]) return true;
    // Full-week flag: skip weekends and federal holidays.
    if (!isWeekend(date) && !getFederalHoliday(date)) {
        const wk = fmt(getCallCycleStart(date));
        if (lfSendoutWeeks[wk]) return true;
    }
    return false;
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
        lockedServiceId: null,   // set below for regular service overrides
        offSiteServiceId: null,   // set below for off-site service overrides
    }));

    // ── Pre-cascade: resolve all service overrides ──────────────────────────
    // This pass runs BEFORE the PTO cascade so:
    //   • A regular service override (cyto, huntley, wfh, …) brings a
    //     pathologist back to duty even if they have a PTO vacation entry.
    //     Their service is "locked" — the cascade will not reassign it.
    //   • An off-site override (Off Service, Director Retreat, Lab Inspection)
    //     removes the pathologist from the rotation (like PTO) and renders
    //     their assigned label instead of the generic PTO stripe.
    const dayKey = fmt(date);
    const dayOv = serviceOverrides[dayKey] || {};
    slots.forEach(s => {
        const ovId = dayOv[s.pathId];
        if (!ovId) return;

        if (isOffSiteServiceId(ovId)) {
            // Off-site override: excluded from rotation.  Always wins over any
            // vacation-PTO entry (showing the named reason is more informative).
            s.onPto = true;
            s.offSiteServiceId = ovId;
        } else {
            // Regular service override: pathologist is ON duty with this
            // service, even if a vacation entry marks them as PTO.
            s.onPto = false;        // override any vacation PTO for this day
            s.lockedServiceId = ovId;
        }
    });

    // ── PTO / WFH cascade ───────────────────────────────────────────────────
    // Only unlocked working pathologists are reassigned by the cascade.
    // Locked pathologists (explicit service override) keep their assigned
    // service and count as "working" when determining coverage rules.
    const ptoCount = slots.filter(s => s.onPto).length;
    if (ptoCount > 0) {
        slots.forEach(s => { if (s.onPto) s.serviceId = null; });
        // Only reassign slots that are working AND have no locked service.
        const unlockedWorking = slots.filter(s => !s.onPto && !s.lockedServiceId);

        if (unlockedWorking.length === 2) {
            // EXACTLY 2 unlocked working (Huntley + Cyto/Bigs combo)
            let huntleyDoc = unlockedWorking.find(s => s.serviceId === 'huntley')
                || unlockedWorking.find(s => s.serviceId === 'wfh')
                || unlockedWorking.find(s => s.serviceId === 'bigs')
                || unlockedWorking[1];

            unlockedWorking.forEach(s => {
                s.serviceId = (s === huntleyDoc) ? 'huntley' : 'cytobigs';
            });

        } else if (unlockedWorking.length === 1) {
            unlockedWorking[0].serviceId = 'cytobigs';

        } else if (unlockedWorking.length === 3) {
            // EXACTLY 3 unlocked working (Cyto, Bigs, Huntley; drop WFH)
            const droppedIds = ['wfh'];
            const displaced = unlockedWorking.filter(s => droppedIds.includes(s.serviceId));
            const fixed = unlockedWorking.filter(s => !droppedIds.includes(s.serviceId));
            const fixedIds = fixed.map(s => s.serviceId);

            const activeIds = ['cyto', 'bigs', 'huntley'];
            const vacantIds = activeIds.filter(id => !fixedIds.includes(id));

            displaced.sort((a, b) => a.pIdx - b.pIdx);
            displaced.forEach((s, i) => { s.serviceId = vacantIds[i] || null; });
        }
        // 0 unlocked working: all working paths are locked — no reassignment.
        // 4+ unlocked working: normal rotation, no change needed.
    }

    // ── Build result ────────────────────────────────────────────────────────
    slots.forEach(s => {
        if (s.offSiteServiceId) {
            // Off-site service override: show the named label with its colour.
            result[s.pathId] = {
                type: 'off_site',
                service: SERVICE_BY_ID[s.offSiteServiceId],
                onCall: onCallId === s.pathId,
            };
        } else if (s.lockedServiceId) {
            // Regular service override (incl. PTO override): show as working.
            result[s.pathId] = {
                type: 'service',
                service: SERVICE_BY_ID[s.lockedServiceId],
                onCall: onCallId === s.pathId,
            };
        } else if (s.onPto) {
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

// (recompute code moved to recompute.js)

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
        if (loggedInPathId !== null && loggedInPathId !== GROSS_ROOM_ID && loggedInPathId !== MANAGER_ID && !pathologists.find(p => p.id === loggedInPathId)) {
            // Stored id no longer matches anyone — clear it and force re-login
            localStorage.removeItem(AUTH_STORAGE_KEY);
            loggedInPathId = null;
        }
        if (loggedInPathId === null) {
            showLoginOverlay();
        } else {
            // Default the filter based on who is signed in and their saved
            // preference. Gross room is always forced to all pathologists.
            // Otherwise, honor the user's defaultPathFilter setting ('all'
            // or 'me').
            if (isGrossRoom() || isManager()) {
                setPathFilter('all');
            } else if (settings.defaultPathFilter === 'all') {
                setPathFilter('all');
            } else {
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

    // Mirror visibility on the mobile select: when "Me" isn't available there's
    // only one option, so we just hide the whole select rather than show a
    // pointless one-item dropdown.
    const mobileSel = document.getElementById('mobilePathSelect');
    const mobileWrap = document.getElementById('mobilePathSelectWrap');
    const mobileMeOpt = mobileSel ? mobileSel.querySelector('option[value="me"]') : null;

    // Gross room / manager: always show all pathologists with no option to switch
    if (isGrossRoom() || isManager()) {
        meTab.style.display = 'none';
        if (mobileMeOpt) mobileMeOpt.hidden = true;
        if (mobileWrap) mobileWrap.style.display = 'none';
        setPathFilter('all');
        return;
    }

    const me = loggedInPathId !== null
        ? pathologists.find(p => p.id === loggedInPathId)
        : null;

    if (me) {
        meTab.style.display = '';
        if (mobileMeOpt) mobileMeOpt.hidden = false;
        if (mobileWrap) mobileWrap.style.display = '';
        const validVals = new Set(['all', String(me.id)]);
        const fallback = settings.defaultPathFilter === 'all' ? 'all' : String(me.id);
        const next = validVals.has(currentPathFilter) ? currentPathFilter : fallback;
        setPathFilter(next);
    } else {
        meTab.style.display = 'none';
        if (mobileMeOpt) mobileMeOpt.hidden = true;
        if (mobileWrap) mobileWrap.style.display = 'none';
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
        `<option value="${GROSS_ROOM_ID}">Gross Room</option>` +
        `<option value="${MANAGER_ID}">Kathleen</option>`;
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
    const isManagerLogin = pidRaw === MANAGER_ID;
    const pid = isGrossRoomLogin ? GROSS_ROOM_ID : (isManagerLogin ? MANAGER_ID : parseInt(pidRaw, 10));
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
        // pathologists honor their defaultPathFilter setting ('all' or 'me').
        populatePathFilter();
        if (!isGrossRoomLogin && !isManagerLogin) {
            setPathFilter(settings.defaultPathFilter === 'all' ? 'all' : String(pid));
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

// Lake Forest sendout flags — see isLfSendoutDay() for how they're consumed.
db.ref('scheduler/lfSendoutDays').on('value', snap => {
    lfSendoutDays = snap.exists() ? snap.val() : {};
    if (pathologistsReady && vacationsReady) renderAll();
});

db.ref('scheduler/lfSendoutWeeks').on('value', snap => {
    lfSendoutWeeks = snap.exists() ? snap.val() : {};
    if (pathologistsReady && vacationsReady) renderAll();
});

// Procedures: hourly entries for the week-view grid (and the mobile day
// view, which uses the same hourly grid). Independent of the pathologist
// rotation, so we don't need to clear the day cache or wait on it to
// render the rest of the calendar — just re-render the main view when
// this changes, but only if we're on a view that actually shows the
// procedure schedule (week or day). Skipping month/year avoids a wasted
// render on views that don't display procedures.
//
// NOTE: this re-render is required for the case where the procedures
// snapshot arrives AFTER pathologists + vacations have already triggered
// the initial renderAll(); without it, the day/week view paints with an
// empty `procedures` global and stays blank until the user changes view.
db.ref('scheduler/procedures').on('value', snap => {
    procedures = snap.exists() ? snap.val() : {};
    if (pathologistsReady && vacationsReady && (view === 'week' || view === 'day')) renderMain();
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

    // If the Requests page is the active page, refresh it live too
    const _appEl = document.getElementById('app');
    if (_appEl && _appEl.getAttribute('data-page') === 'requests'
        && typeof renderRequestsPage === 'function') {
        renderRequestsPage();
    }
}, err => {
    console.error('Firebase requests error:', err);
});

// (recompute code moved to recompute.js)

// ────────────── SIDEBAR ──────────────
function renderSidebar() {
    // Show/hide admin-only controls based on signed-in user's role
    const admin = isAdmin();
    const grossRoom = isGrossRoom();
    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) exportBtn.style.display = admin ? '' : 'none';

    // ── Recompute Schedule button (admin-only) ──
    const rcBtn = document.getElementById('recomputeBtn');
    if (rcBtn) rcBtn.style.display = admin ? '' : 'none';

    // Gross room / manager cannot manage PTO or view requests at all — hide those buttons
    const addPtoBtnEl = document.getElementById('addPtoBtn');
    if (addPtoBtnEl) addPtoBtnEl.style.display = (grossRoom || isManager()) ? 'none' : '';

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
        } else if (isManager()) {
            sWho.textContent = 'Signed in · Kathleen';
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

// (recompute code moved to recompute.js)

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
    const menuBtn = document.getElementById('menuBtn');
    const menuReqItem = document.getElementById('menuRequestsItem');
    const menuReqBadge = document.getElementById('menuRequestsBadge');
    const menuReqLabel = document.getElementById('menuRequestsLabel');
    const menuPtoLabel = document.getElementById('menuPtoLabel');
    const menuExportItem = document.getElementById('menuExportItem');

    // Mobile recompute menu item (declared in HTML; click handled by the
    // shared menu-dropdown click handler below)
    const menuRcItem = document.getElementById('menuRecomputeItem');

    // Hide entirely if not signed in OR if gross room / manager (who cannot manage requests or PTO)
    if (loggedInPathId === null || isGrossRoom() || isManager()) {
        if (btn) btn.style.display = 'none';
        if (menuBtn) menuBtn.classList.remove('has-alert');
        if (menuReqItem) menuReqItem.style.display = 'none';
        if (menuExportItem) menuExportItem.style.display = 'none';
        if (menuRcItem) menuRcItem.style.display = 'none';
        // Also hide the PTO menu item for gross room / manager
        const menuPtoItem = document.querySelector('.menu-item[data-action="pto"]');
        if (menuPtoItem) menuPtoItem.style.display = (isGrossRoom() || isManager()) ? 'none' : '';
        return;
    }

    // ── Sidebar button (desktop) ──
    if (btn) {
        btn.style.display = '';
        if (lbl) lbl.textContent = isAdmin() ? 'Requests' : 'My Requests';
    }

    // ── Mobile menu items ──
    if (menuPtoLabel) menuPtoLabel.textContent = isAdmin() ? 'Manage PTO' : 'Request PTO';
    if (menuReqItem) menuReqItem.style.display = '';
    if (menuReqLabel) menuReqLabel.textContent = isAdmin() ? 'Requests' : 'My Requests';
    if (menuExportItem) menuExportItem.style.display = isAdmin() ? '' : 'none';
    if (menuRcItem) menuRcItem.style.display = isAdmin() ? '' : 'none';

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

    // Drive the sidebar nav dot indicator
    updateNavRequestsIndicator();
}

// ────────────── SIDEBAR NAV DOT INDICATOR ──────────────
// Shows a small colored dot on the "Requests" sidebar nav item:
//   amber  — pending requests (waiting for admin decision)
//   green  — one or more requests were approved since the user last
//            visited the Requests page
//   red    — one or more requests were denied since the last visit
// Clearing logic: visiting the Requests page saves a timestamp
// (reqDecisionAck_{pathId}) in localStorage. Decisions older than
// that timestamp are considered "seen" and don't trigger the dot.
function _getAckTs() {
    if (!loggedInPathId) return Date.now();
    const key = 'reqDecisionAck_' + loggedInPathId;
    try {
        const stored = localStorage.getItem(key);
        if (stored === null) {
            // First activation: baseline to now so stale history is silent.
            const now = String(Date.now());
            localStorage.setItem(key, now);
            return +now;
        }
        return +stored || 0;
    } catch (_) { return 0; }
}

function updateNavRequestsIndicator() {
    const dot = document.getElementById('navRequestsBadge');
    if (!dot) return;

    if (!loggedInPathId || isGrossRoom() || isManager()) {
        dot.style.display = 'none';
        return;
    }

    const admin = isAdmin();

    if (admin) {
        // Admins: amber dot when any pending requests exist
        const pendingCount = getVisiblePendingCount();
        if (pendingCount > 0) {
            _setNavDot(dot, 'tone-pending', false);
        } else {
            dot.style.display = 'none';
        }
        return;
    }

    // Non-admins: check for unseen decisions, then pending
    const ackTs = _getAckTs();
    const mine = Object.values(requests || {}).filter(
        r => r && r.requesterId === loggedInPathId
    );
    const hasUnseenDenied = mine.some(
        r => r.status === 'denied' && (r.decisionAt || 0) > ackTs
    );
    const hasUnseenApproved = mine.some(
        r => r.status === 'approved' && (r.decisionAt || 0) > ackTs
    );
    const hasPending = mine.some(r => r.status === 'pending');

    // Denied takes priority over approved (worst news first)
    if (hasUnseenDenied) {
        _setNavDot(dot, 'tone-denied', true);
    } else if (hasUnseenApproved) {
        _setNavDot(dot, 'tone-approved', true);
    } else if (hasPending) {
        _setNavDot(dot, 'tone-pending', false);
    } else {
        dot.style.display = 'none';
    }
}

// Helper: apply a tone class to the dot, optionally triggering the pop
// animation (used when a new decision has just arrived so the dot is
// clearly noticeable without being disruptive).
function _setNavDot(dot, toneClass, pop) {
    const wasHidden = dot.style.display === 'none' || !dot.style.display;
    const prev = [...dot.classList].find(c => c.startsWith('tone-'));
    dot.className = 'nav-badge ' + toneClass;
    dot.textContent = '';
    dot.style.display = '';
    if (pop && (wasHidden || prev !== toneClass)) {
        // Re-trigger animation: remove → force reflow → add
        dot.classList.remove('pop');
        void dot.offsetWidth;
        dot.classList.add('pop');
        dot.addEventListener('animationend', () => dot.classList.remove('pop'), { once: true });
    }
}

// Called whenever the user navigates to the Requests page.
// Stamps the current time so subsequent updateNavRequestsIndicator()
// calls know which decisions are "new" vs already acknowledged.
function markRequestsPageSeen() {
    if (!loggedInPathId || isAdmin()) return;
    const key = 'reqDecisionAck_' + loggedInPathId;
    try { localStorage.setItem(key, String(Date.now())); } catch (_) {}
    updateNavRequestsIndicator();
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

        // ── Change log ──
        // The schedule was just mutated; record one entry summarizing
        // what got applied. Source flag distinguishes these from direct
        // admin edits in the Changes log.
        try {
            const reqPid = req.requesterId;
            if (req.type === 'pto_add') {
                logChange(Object.assign({
                    kind: 'pto', type: 'pto_add',
                    source: 'request_approved', requestKey: reqKey,
                    forPathId: reqPid,
                    startDate: req.payload.start, endDate: req.payload.end,
                }, _chgSummaryPtoAdd(reqPid, req.payload.start, req.payload.end)));
            } else if (req.type === 'pto_remove') {
                logChange(Object.assign({
                    kind: 'pto', type: 'pto_remove',
                    source: 'request_approved', requestKey: reqKey,
                    forPathId: reqPid,
                    startDate: req.payload.start, endDate: req.payload.end,
                }, _chgSummaryPtoRemove(reqPid, req.payload.start, req.payload.end)));
            } else if (req.type === 'oncall_change') {
                logChange(Object.assign({
                    kind: 'oncall', type: 'oncall_set',
                    source: 'request_approved', requestKey: reqKey,
                    forPathId: req.payload.newPathId,
                    date: req.payload.date,
                    scope: req.payload.scope,
                }, _chgSummaryOnCallSet(
                    req.payload.newPathId, req.payload.date, req.payload.scope
                )));
            } else if (req.type === 'service_change') {
                const scope = req.payload.scope || 'day';
                if (req.payload.serviceId) {
                    logChange(Object.assign({
                        kind: 'service', type: 'service_set',
                        source: 'request_approved', requestKey: reqKey,
                        forPathId: reqPid,
                        date: req.payload.date,
                        serviceId: req.payload.serviceId,
                        scope: scope,
                    }, _chgSummaryServiceSet(
                        reqPid, req.payload.date, req.payload.serviceId, scope
                    )));
                } else {
                    // Approved a "clear my service" request — log as a
                    // single-line bulk-style entry so it reads naturally
                    logChange(Object.assign({
                        kind: 'service', type: 'service_set',
                        source: 'request_approved', requestKey: reqKey,
                        forPathId: reqPid,
                        date: req.payload.date,
                        serviceId: null,
                        scope: scope,
                    }, _chgSummaryServiceSet(
                        reqPid, req.payload.date, null, scope
                    )));
                }
            }
        } catch (logErr) {
            console.error('logChange (approveRequest) error:', logErr);
        }

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

// Admin can revoke a previously-approved request, reversing the applied change
// and re-alerting the requester (status flips back to 'denied').
async function revokeApproval(reqKey) {
    if (!isAdmin()) { showToast('Only the admin can revoke approvals.', { type: 'error' }); return; }
    const req = requests[reqKey];
    if (!req || req.status !== 'approved') return;

    const reason = prompt('Optional reason for revoking this approval (visible to requester):', '');
    if (reason === null) return;   // user clicked Cancel — bail out

    let rcFromDate = null;
    let rcDayBeforeFix = false;
    let rcPinnedByDay = {};
    let rcMessage = null;

    try {
        // ── Reverse the change that was applied on approval ──────────────────
        if (req.type === 'pto_add') {
            // Find the vacation entry that was pushed when this request was approved.
            // Match on pathologistId + exact start/end dates stored in the payload.
            const vac = vacations.find(v =>
                v.pathologistId === req.requesterId &&
                v.start && fmt(v.start) === req.payload.start &&
                v.end   && fmt(v.end)   === req.payload.end
            );
            if (vac) {
                rcFromDate    = vac.start;
                rcDayBeforeFix = false;
                rcMessage     = 'Approval revoked and PTO removed. Recompute the future schedule?';
                await db.ref('scheduler/vacations/' + vac.key).remove();
            } else {
                showToast('Could not find the PTO entry to remove — it may have already been deleted.', { type: 'error' });
                return;
            }

        } else if (req.type === 'pto_remove') {
            // The vacation was deleted on approval — restore it.
            if (req.payload.start && req.payload.end) {
                rcFromDate    = parseDate(req.payload.start);
                rcDayBeforeFix = true;
                rcMessage     = 'Approval revoked and PTO restored. Recompute the future schedule?';
                await db.ref('scheduler/vacations').push({
                    pathologistId: req.requesterId,
                    start: req.payload.start,
                    end:   req.payload.end,
                });
            }

        } else if (req.type === 'oncall_change') {
            // Remove the on-call override that was written on approval.
            const dKey = req.payload.date;
            if (req.payload.scope === 'week') {
                const cs = getCallCycleStart(parseDate(dKey));
                await db.ref('scheduler/onCallOverrides/' + fmt(cs)).remove();
            } else {
                await db.ref('scheduler/onCallDayOverrides/' + dKey).remove();
            }

        } else if (req.type === 'service_change') {
            // Remove the service override for the requester on the affected day(s).
            const dKey  = req.payload.date;
            const pid   = req.requesterId;
            const scope = req.payload.scope || 'day';

            const dayKeys = scope === 'week'
                ? workdaysInCallCycle(parseDate(dKey)).map(d => fmt(d))
                : [dKey];

            const writes = {};
            dayKeys.forEach(k => {
                const existing = Object.assign({}, serviceOverrides[k] || {});
                delete existing[pid];
                writes['scheduler/serviceOverrides/' + k] =
                    Object.keys(existing).length === 0 ? null : existing;
                rcPinnedByDay[k] = {};
            });
            if (Object.keys(writes).length > 0) await db.ref().update(writes);
            if (dayKeys.length > 0) {
                rcFromDate    = parseDate(dayKeys.slice().sort()[0]);
                rcDayBeforeFix = true;
                rcMessage     = 'Approval revoked and service override removed. Recompute the future schedule?';
            }
        }

        // ── Mark as denied so the requester is notified ──────────────────────
        await db.ref('scheduler/requests/' + reqKey).update({
            status:       'denied',
            decisionAt:   Date.now(),
            decisionBy:   loggedInPathId,
            decisionNote: reason.trim() || 'Approval was revoked by the admin.',
        });
        showToast('Approval revoked — request marked as denied.');

        // ── Change log ──
        // Revoking an approval reverses the previously-applied change.
        // Log the *reversal*, not the original — what actually mutated
        // the schedule just now is the inverse of what was approved.
        try {
            const reqPid = req.requesterId;
            if (req.type === 'pto_add') {
                // Original approval added PTO; revocation removed it
                logChange(Object.assign({
                    kind: 'pto', type: 'pto_remove',
                    source: 'request_revoked', requestKey: reqKey,
                    forPathId: reqPid,
                    startDate: req.payload.start, endDate: req.payload.end,
                }, _chgSummaryPtoRemove(reqPid, req.payload.start, req.payload.end)));
            } else if (req.type === 'pto_remove') {
                // Original approval removed PTO; revocation restored it
                logChange(Object.assign({
                    kind: 'pto', type: 'pto_add',
                    source: 'request_revoked', requestKey: reqKey,
                    forPathId: reqPid,
                    startDate: req.payload.start, endDate: req.payload.end,
                }, _chgSummaryPtoAdd(reqPid, req.payload.start, req.payload.end)));
            } else if (req.type === 'oncall_change') {
                // Original approval set an on-call override; revocation cleared it
                logChange(Object.assign({
                    kind: 'oncall', type: 'oncall_clear',
                    source: 'request_revoked', requestKey: reqKey,
                    date: req.payload.date,
                    scope: req.payload.scope,
                }, _chgSummaryOnCallClear(req.payload.date, req.payload.scope)));
            } else if (req.type === 'service_change') {
                // Original approval set a service override; revocation cleared it
                const scope = req.payload.scope || 'day';
                logChange(Object.assign({
                    kind: 'service', type: 'service_reset',
                    source: 'request_revoked', requestKey: reqKey,
                    forPathId: reqPid,
                    date: req.payload.date,
                    scope: scope,
                }, _chgSummaryServiceReset(req.payload.date, scope)));
            }
        } catch (logErr) {
            console.error('logChange (revokeApproval) error:', logErr);
        }

        if (rcFromDate) {
            await maybeOfferRecompute(rcPinnedByDay, {
                fromDate:    rcFromDate,
                dayBeforeFix: rcDayBeforeFix,
                message:     rcMessage,
            });
        }
    } catch (err) {
        console.error('revokeApproval error:', err);
        showToast('Failed to revoke approval: ' + (err.message || err), { type: 'error' });
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

function renderRequestsList(targetEl, tabState) {
    // Backwards-compatible defaults: when called with no args, write to the
    // modal's list using the modal's tab state. When called with explicit
    // arguments (from the Requests page), write into that surface instead.
    const listEl = targetEl || document.getElementById('requestsList');
    if (!listEl) return;
    const tab = tabState || activeRequestsTab;

    // Filter: admin sees everyone's; non-admin sees only their own
    let entries = Object.entries(requests).filter(([, r]) => !!r);
    if (!isAdmin()) {
        entries = entries.filter(([, r]) => r.requesterId === loggedInPathId);
    }

    // Tab filter
    if (tab === 'pending') {
        entries = entries.filter(([, r]) => r.status === 'pending');
    } else {
        entries = entries.filter(([, r]) => r.status !== 'pending');
    }

    // Newest first
    entries.sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

    if (entries.length === 0) {
        const isPage = listEl.classList.contains('requests-page-list');
        if (isPage) {
            // Friendlier empty state on the full page
            const headline = tab === 'pending'
                ? (isAdmin() ? 'All caught up.' : 'Nothing pending.')
                : 'No history yet.';
            const sub = tab === 'pending'
                ? (isAdmin()
                    ? 'No requests are waiting for your review.'
                    : 'You have no requests awaiting a decision.')
                : 'Approved and denied requests will appear here.';
            listEl.innerHTML = `<div class="empty"><span class="empty-headline">${headline}</span>${sub}</div>`;
        } else {
            const msg = tab === 'pending'
                ? (isAdmin() ? 'No requests waiting for review.' : 'You have no pending requests.')
                : 'No past requests yet.';
            listEl.innerHTML = `<div class="empty">${msg}</div>`;
        }
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
        } else if (req.status === 'approved' && isAdmin()) {
            actions = `
                        <div class="req-card-actions">
                            <button class="revoke" data-act="revoke" data-key="${key}">Revoke approval</button>
                        </div>`;
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
            else if (act === 'revoke') revokeApproval(key);
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

// ────────────── REQUESTS PAGE (sidebar → "Requests") ──────────────
// Full-area version of the requests UI. Shares card rendering with the
// modal via renderRequestsList(targetEl, tabState), but has its own tab
// state and its own header (title/subtitle/summary stats).
let activeRequestsPageTab = 'pending';

function renderRequestsPage() {
    const pg = document.getElementById('requestsPage');
    if (!pg) return;

    const titleEl = document.getElementById('requestsPageTitle');
    const subEl = document.getElementById('requestsPageSubtitle');
    const admin = (typeof isAdmin === 'function') ? isAdmin() : false;

    // Title + subtitle adapt to admin vs requester role
    if (titleEl) titleEl.textContent = admin ? 'Requests' : 'My Requests';
    if (subEl) {
        subEl.textContent = admin
            ? 'Review and decide on schedule change requests from the team.'
            : 'Track the status of changes you have requested.';
    }

    // Compute counts visible to this user (admin = all, else own only)
    let visible = Object.entries(requests || {}).filter(([, r]) => !!r);
    if (!admin) {
        visible = visible.filter(([, r]) => r.requesterId === loggedInPathId);
    }
    const pendingCount = visible.filter(([, r]) => r.status === 'pending').length;
    const resolvedCount = visible.filter(([, r]) => r.status !== 'pending').length;

    // Summary stats (top-right of header)
    const sumPending = document.getElementById('requestsSummaryPending');
    const sumHist = document.getElementById('requestsSummaryHistory');
    if (sumPending) {
        sumPending.textContent = String(pendingCount);
        const stat = sumPending.closest('.requests-summary-stat');
        if (stat) stat.setAttribute('data-empty', pendingCount === 0 ? 'true' : 'false');
    }
    if (sumHist) sumHist.textContent = String(resolvedCount);

    // Tab count chips
    const tabPending = document.getElementById('requestsPageTabCountPending');
    const tabHist = document.getElementById('requestsPageTabCountHistory');
    if (tabPending) tabPending.textContent = String(pendingCount);
    if (tabHist) tabHist.textContent = String(resolvedCount);

    // Sync active-tab visual state on the page tabs (independent of the
    // modal's tab state)
    document.querySelectorAll('#requestsPageTabs .req-tab').forEach(b => {
        b.classList.toggle('active', b.dataset.rtab === activeRequestsPageTab);
    });

    // Render the cards into the page list using the shared renderer
    renderRequestsList(
        document.getElementById('requestsPageList'),
        activeRequestsPageTab
    );
}

// Expose for any caller that needs to refresh the page (e.g. after sign-in)
window.__renderRequestsPage = renderRequestsPage;

// Page tabs: switch Pending / History
const _reqPageTabsEl = document.getElementById('requestsPageTabs');
if (_reqPageTabsEl) {
    _reqPageTabsEl.addEventListener('click', e => {
        const btn = e.target.closest('.req-tab');
        if (!btn) return;
        activeRequestsPageTab = btn.dataset.rtab;
        renderRequestsPage();
    });
}

// When the Requests sidebar nav item is clicked, the page-nav IIFE at the
// bottom of this file calls setPage('requests') which hides/shows the right
// surfaces. We piggy-back on the same click to (re)render the page contents.
document.querySelectorAll('.nav-item[data-page="requests"]').forEach(btn => {
    btn.addEventListener('click', () => {
        // Mark decisions seen before re-rendering so the dot clears
        // at the same moment the content appears (no flash of old dot).
        markRequestsPageSeen();
        // Defer one tick so setPage's own handler (which un-hides #requestsPage)
        // runs first; otherwise summary widths can compute against a hidden node.
        setTimeout(renderRequestsPage, 0);
    });
});

// ════════════════════════════════════════════════════════════════════════
//                          CHANGE LOG SUBSYSTEM
// ════════════════════════════════════════════════════════════════════════
// Whenever an applied schedule change happens (PTO add/remove/edit, on-call
// override, service override, recompute, or an approved request being
// applied/revoked), we push a summarized entry into `scheduler/changes`.
// The Changes page in the sidebar reads from that path and renders a
// reverse-chronological log so the team can see at a glance what shifted
// and when.
//
// Denied requests are NOT logged here — they don't change the schedule.
// Only actions that actually mutate scheduler state get a change entry.
//
// Each entry shape:
//   {
//     kind:    'pto' | 'oncall' | 'service' | 'recompute',
//     type:    'pto_add' | 'pto_remove' | 'pto_edit'
//            | 'oncall_set' | 'oncall_clear'
//            | 'service_set' | 'service_reset'
//            | 'recompute',
//     byPathId:   number,           // who triggered the change
//     byName:     string,           // pre-rendered "Dr. X" snapshot
//     at:         timestamp (ms),
//     summary:    string,           // pre-rendered headline (frozen at write time)
//     details:    string,           // optional secondary line
//     source:     'direct' | 'request_approved' | 'request_revoked' | 'recompute',
//     requestKey: string | null,    // when source !== 'direct'
//     forPathId:  number | null,    // who the change affects (if applicable)
//     // Plus type-specific structured fields (date, scope, serviceId, etc.)
//   }

let changes = {};                  // { pushKey: change-entry } from Firebase
let changesReady = false;

// Subscribe to the change log so the page stays live
db.ref('scheduler/changes').on('value', snap => {
    changes = snap.exists() ? snap.val() : {};
    changesReady = true;

    // If the Changes page is the active page, refresh it live
    const _appEl = document.getElementById('app');
    if (_appEl && _appEl.getAttribute('data-page') === 'changes'
        && typeof renderChangesPage === 'function') {
        renderChangesPage();
    }
}, err => {
    console.error('Firebase changes error:', err);
});

// ── Summary helpers ──────────────────────────────────────────────────────
// Pre-render human-readable summaries at write time so the log stays
// readable even if e.g. a pathologist's name later changes.

function _chgFmtDate(s) {
    if (!s) return '?';
    const d = (s instanceof Date) ? s : parseDate(s);
    return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function _chgFmtRange(start, end) {
    if (!start || !end) return _chgFmtDate(start || end);
    const s = (start instanceof Date) ? start : parseDate(start);
    const e = (end instanceof Date) ? end : parseDate(end);
    if (sameDay(s, e)) return _chgFmtDate(s);
    if (s.getFullYear() === e.getFullYear()) {
        if (s.getMonth() === e.getMonth()) {
            return `${MONTHS_SHORT[s.getMonth()]} ${s.getDate()}–${e.getDate()}, ${s.getFullYear()}`;
        }
        return `${MONTHS_SHORT[s.getMonth()]} ${s.getDate()} – ${MONTHS_SHORT[e.getMonth()]} ${e.getDate()}, ${s.getFullYear()}`;
    }
    return `${MONTHS_SHORT[s.getMonth()]} ${s.getDate()}, ${s.getFullYear()} – ${MONTHS_SHORT[e.getMonth()]} ${e.getDate()}, ${e.getFullYear()}`;
}

function _chgFmtCallWeek(dateKey) {
    const cs = getCallCycleStart(parseDate(dateKey));
    const ce = getCallCycleEnd(cs);
    return _chgFmtRange(cs, ce);
}

function _chgServiceName(sid) {
    if (!sid) return 'No service';
    return SERVICE_BY_ID[sid] ? SERVICE_BY_ID[sid].name : sid;
}

function _chgShortName(pid) {
    if (pid == null) return '—';
    return _pathName(pid).replace(/^Dr\. /, '');
}

// ── Summary builders for each change type ────────────────────────────────
// Each takes structured fields and returns { summary, details? }.

function _chgSummaryPtoAdd(forPid, start, end) {
    return {
        summary: `${_chgShortName(forPid)} — PTO added on ${_chgFmtRange(start, end)}`,
    };
}
function _chgSummaryPtoRemove(forPid, start, end) {
    return {
        summary: `${_chgShortName(forPid)} — PTO removed on ${_chgFmtRange(start, end)}`,
    };
}
function _chgSummaryPtoEdit(forPid, oldStart, oldEnd, newStart, newEnd) {
    return {
        summary: `${_chgShortName(forPid)} — PTO range updated`,
        details: `${_chgFmtRange(oldStart, oldEnd)}  →  ${_chgFmtRange(newStart, newEnd)}`,
    };
}
function _chgSummaryOnCallSet(forPid, dateKey, scope) {
    const where = scope === 'week'
        ? `the call block of ${_chgFmtCallWeek(dateKey)}`
        : _chgFmtDate(dateKey);
    return {
        summary: `${_chgShortName(forPid)} — placed on call for ${where}`,
    };
}
function _chgSummaryOnCallClear(dateKey, scope) {
    const where = scope === 'week'
        ? `the call block of ${_chgFmtCallWeek(dateKey)}`
        : _chgFmtDate(dateKey);
    return {
        summary: `On-call override cleared for ${where}`,
    };
}
function _chgSummaryLfSet(dateKey, scope) {
    const where = scope === 'week'
        ? `the call week of ${_chgFmtCallWeek(dateKey)}`
        : _chgFmtDate(dateKey);
    return {
        summary: `Lake Forest sendout added for ${where}`,
    };
}
function _chgSummaryLfClear(dateKey, scope) {
    const where = scope === 'week'
        ? `the call week of ${_chgFmtCallWeek(dateKey)}`
        : _chgFmtDate(dateKey);
    return {
        summary: `Lake Forest sendout removed for ${where}`,
    };
}
function _chgSummaryServiceSet(forPid, dateKey, serviceId, scope) {
    const where = scope === 'week'
        ? `the call week of ${_chgFmtCallWeek(dateKey)}`
        : _chgFmtDate(dateKey);
    return {
        summary: `${_chgShortName(forPid)} — service set to ${_chgServiceName(serviceId)} for ${where}`,
    };
}
// Bulk service edit (multiple pathologists changed in one save)
function _chgSummaryServiceBulk(dateKey, scope, lines) {
    const where = scope === 'week'
        ? `the call week of ${_chgFmtCallWeek(dateKey)}`
        : _chgFmtDate(dateKey);
    return {
        summary: `Service overrides updated for ${where}`,
        details: lines.join('\n'),
    };
}
function _chgSummaryServiceReset(dateKey, scope) {
    const where = scope === 'week'
        ? `the call week of ${_chgFmtCallWeek(dateKey)}`
        : _chgFmtDate(dateKey);
    return {
        summary: `Service overrides reset to default for ${where}`,
    };
}
// (recompute code moved to recompute.js)

// ── Core writer ──────────────────────────────────────────────────────────
// Pushes one change-log entry to Firebase. Non-fatal: if it fails (network
// hiccup, perms, etc.) we just console.error — never block or alert the
// user, since the underlying schedule change has already happened.
async function logChange(entry) {
    if (loggedInPathId === null) return;
    if (!entry || !entry.summary) return;
    try {
        const payload = Object.assign({
            byPathId: loggedInPathId,
            byName: _pathName(loggedInPathId),
            at: Date.now(),
            source: 'direct',
        }, entry);
        await db.ref('scheduler/changes').push(payload);
    } catch (err) {
        console.error('logChange error:', err, entry);
    }
}

// ── Renderer ─────────────────────────────────────────────────────────────

function renderChangesPage() {
    const pg = document.getElementById('changesPage');
    if (!pg) return;

    const listEl = document.getElementById('changesList');
    const totalEl = document.getElementById('changesSummaryTotal');
    if (!listEl) return;

    const entries = Object.entries(changes || {})
        .filter(([, c]) => !!c)
        .sort((a, b) => (b[1].at || 0) - (a[1].at || 0));

    if (totalEl) totalEl.textContent = String(entries.length);

    if (entries.length === 0) {
        listEl.innerHTML = `
            <div class="empty">
                <span class="empty-headline">Nothing yet.</span>
                Schedule changes will appear here as they happen.
            </div>`;
        return;
    }

    const KIND_LABEL = {
        pto:        'PTO',
        oncall:     'ON-CALL',
        service:    'SERVICE',
        recompute:  'RECOMPUTE',
        lf_sendout: 'LF SENDOUT',
    };
    const SOURCE_LABEL = {
        direct:           '',
        request_approved: 'via approved request',
        request_revoked:  'via revoked approval',
        recompute:        '',
    };

    listEl.innerHTML = entries.map(([key, c]) => {
        const when = c.at
            ? new Date(c.at).toLocaleString([], {
                month: 'short', day: 'numeric',
                hour: 'numeric', minute: '2-digit',
            })
            : '';
        const kind = c.kind || 'service';
        const kindLabel = KIND_LABEL[kind] || kind.toUpperCase();
        const by = c.byName ? c.byName.replace(/^Dr\. /, '') : '';
        const sourceLabel = SOURCE_LABEL[c.source || 'direct'] || '';

        const detailLine = c.details
            ? `<div class="chg-details">${escapeHtml(c.details)}</div>`
            : '';

        const metaParts = [];
        if (when) metaParts.push(escapeHtml(when));
        if (by)   metaParts.push('by ' + escapeHtml(by));
        const metaMain = metaParts.join(' · ');
        const sourceHtml = sourceLabel
            ? `<span class="chg-source">${escapeHtml(sourceLabel)}</span>`
            : '';

        return `
            <div class="chg-card kind-${escapeHtml(kind)}">
                <div class="chg-card-head">
                    <div class="chg-summary">${escapeHtml(c.summary || '')}</div>
                    <span class="chg-kind">${escapeHtml(kindLabel)}</span>
                </div>
                ${detailLine}
                <div class="chg-meta">${metaMain}${sourceHtml}</div>
            </div>`;
    }).join('');
}

// Expose so other code (e.g. login flow) can refresh the page on demand
window.__renderChangesPage = renderChangesPage;

// Re-render the page when the user clicks the Changes nav item, just like
// the requests page does (defer a tick so setPage un-hides the shell first)
document.querySelectorAll('.nav-item[data-page="changes"]').forEach(btn => {
    btn.addEventListener('click', () => {
        setTimeout(renderChangesPage, 0);
    });
});

// ════════════════════════════════════════════════════════════════════════
//                          CONFERENCE TRACKER SUBSYSTEM
// ════════════════════════════════════════════════════════════════════════
// Tracks how many of each conference each pathologist has presented at.
// Entries live in scheduler/conferenceLog. Each entry is shaped:
//   {
//     pathologistId: <number>,
//     type: 'breast' | 'lung' | 'thoracic' | 'cdh' | 'other',
//     date: 'YYYY-MM-DD',
//     subtype: 'GI' | 'Heme' | 'Thoracic' | 'Neuro',  // cdh only
//     otherTitle: <string>,                            // other only
//     note: <string>,                                  // optional
//     createdAt: <ms>,
//     createdBy: <pathId>,
//   }
//
// Editing privileges: admin OR any pathId in scheduler/conferencePresenters
// (a small allow-list the admin populates to grant non-admin users the
// ability to log conferences).
//
// The page shows:
//   1. A summary count grid (rows = pathologists, cols = conference types)
//   2. Tabs to drill into each conference type
//   3. An entries list for the active tab
// All views respect the selected academic-year period.

// Conference type metadata. Keep keys in sync with HTML/CSS hooks.
const CONF_TYPES = [
    { id: 'breast',   label: 'Breast',       singular: 'Breast Conference' },
    { id: 'lung',     label: 'Lung',         singular: 'Lung Conference' },
    { id: 'thoracic', label: 'Thoracic',     singular: 'Thoracic Conference' },
    { id: 'cdh',      label: 'Morning/CDH',  singular: 'Morning / CDH' },
    { id: 'other',    label: 'Other',        singular: 'Other Tumor Board' },
];
const CONF_TYPE_BY_ID = Object.fromEntries(CONF_TYPES.map(t => [t.id, t]));
const CDH_SUBTYPES = ['GI', 'Heme', 'Thoracic', 'Neuro'];

// ── Data store ───────────────────────────────────────────────────────────
let conferenceLog = {};               // { pushKey: entry }
let conferenceLogReady = false;
let conferencePresenters = {};        // { pathId: true } — allow-list

// ── UI state ─────────────────────────────────────────────────────────────
let activeTrackingTab = 'breast';
// Period filter: '<startYearShort>' string like '2025' (= academic year
// Sept 2025 – Aug 2026), or 'all' for no filter.
let trackingPeriod = null;            // set on first render

// ── Firebase subscriptions ───────────────────────────────────────────────
db.ref('scheduler/conferenceLog').on('value', snap => {
    conferenceLog = snap.exists() ? snap.val() : {};
    conferenceLogReady = true;
    const _appEl = document.getElementById('app');
    if (_appEl && _appEl.getAttribute('data-page') === 'tracking'
        && typeof renderTrackingPage === 'function') {
        renderTrackingPage();
    }
}, err => {
    console.error('Firebase conferenceLog error:', err);
});

db.ref('scheduler/conferencePresenters').on('value', snap => {
    conferencePresenters = snap.exists() ? snap.val() : {};
    // Update Add button visibility / row edit buttons if visible now
    const _appEl = document.getElementById('app');
    if (_appEl && _appEl.getAttribute('data-page') === 'tracking'
        && typeof renderTrackingPage === 'function') {
        renderTrackingPage();
    }
}, err => {
    console.error('Firebase conferencePresenters error:', err);
});

// ── Permission helper ────────────────────────────────────────────────────
// Admin always qualifies. Otherwise the signed-in user must be in the
// conferencePresenters allow-list (managed manually for now). Gross room
// never qualifies (it's the procedure-only account).
function canEditConferences(pathId) {
    const id = (pathId !== undefined && pathId !== null) ? pathId : loggedInPathId;
    if (id === null || id === undefined) return false;
    if (id === GROSS_ROOM_ID) return false;
    if (id === MANAGER_ID) return true;
    if (isAdmin(id)) return true;
    return !!(conferencePresenters && conferencePresenters[id]);
}

// ── Period helpers ───────────────────────────────────────────────────────
// Academic year runs Sept 1 → Aug 31. We label it by the start year.
//   getAcademicYearOfDate(new Date('2025-09-05')) → 2025
//   getAcademicYearOfDate(new Date('2026-08-31')) → 2025
//   getAcademicYearOfDate(new Date('2026-09-01')) → 2026
function getAcademicYearOfDate(date) {
    return date.getMonth() >= 8 ? date.getFullYear() : date.getFullYear() - 1;
}
function getAcademicYearOfKey(dateKey) {
    if (!dateKey || typeof dateKey !== 'string') return null;
    const m = dateKey.match(/^(\d{4})-(\d{2})-/);
    if (!m) return null;
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10); // 1-indexed
    return month >= 9 ? year : year - 1;
}
function academicYearLabel(startYear) {
    return startYear + '–' + (startYear + 1);
}

// ── Filtered-entries cache ───────────────────────────────────────────────
// Returns the array of {key, entry} pairs matching the current period
// filter, sorted by date descending (most recent first).
function getFilteredEntries() {
    const period = trackingPeriod;
    const entries = Object.entries(conferenceLog || {})
        .filter(([, e]) => !!e && e.date && e.pathologistId !== undefined && e.type);

    let filtered = entries;
    if (period !== null && period !== 'all') {
        const yr = parseInt(period, 10);
        if (Number.isFinite(yr)) {
            filtered = entries.filter(([, e]) => getAcademicYearOfKey(e.date) === yr);
        }
    }

    return filtered.sort((a, b) => {
        // newest date first; tiebreak by createdAt desc
        if (a[1].date !== b[1].date) return a[1].date < b[1].date ? 1 : -1;
        return (b[1].createdAt || 0) - (a[1].createdAt || 0);
    });
}

// ── Period selector population ───────────────────────────────────────────
function populateTrackingYearSelect() {
    const sel = document.getElementById('trackingYearSelect');
    if (!sel) return;

    // Build a set of years that have entries, plus the current academic year
    const yearsWithEntries = new Set();
    Object.values(conferenceLog || {}).forEach(e => {
        if (!e || !e.date) return;
        const yr = getAcademicYearOfKey(e.date);
        if (yr !== null) yearsWithEntries.add(yr);
    });
    const currentAy = getAcademicYearOfDate(new Date());
    yearsWithEntries.add(currentAy);

    // Sort descending so newest year is first
    const years = Array.from(yearsWithEntries).sort((a, b) => b - a);

    // Default selection: current academic year if available, else newest
    if (trackingPeriod === null) {
        trackingPeriod = years.includes(currentAy) ? String(currentAy) : String(years[0]);
    }

    const prev = trackingPeriod;
    sel.innerHTML =
        years.map(y => `<option value="${y}">${academicYearLabel(y)}</option>`).join('') +
        `<option value="all">All time</option>`;
    sel.value = prev;
    // If the saved value is no longer valid (e.g. period was removed), fallback
    if (sel.value !== prev) {
        sel.value = String(currentAy);
        trackingPeriod = sel.value;
    }
}

// ── Summary count grid ───────────────────────────────────────────────────
function renderTrackingSummary(filteredEntries) {
    const body = document.getElementById('trackingSummaryBody');
    if (!body) return;

    if (!pathologists || pathologists.length === 0) {
        body.innerHTML = '';
        return;
    }

    // Build a (pathId, type) → count map
    const counts = {};
    pathologists.forEach(p => {
        counts[p.id] = { breast: 0, lung: 0, thoracic: 0, cdh: 0, other: 0, total: 0 };
    });
    filteredEntries.forEach(([, e]) => {
        const c = counts[e.pathologistId];
        if (!c) return;
        if (CONF_TYPE_BY_ID[e.type]) {
            c[e.type] = (c[e.type] || 0) + 1;
            c.total += 1;
        }
    });

    body.innerHTML = pathologists.map(p => {
        const c = counts[p.id];
        const lastName = (p.name || '').replace(/^Dr\.\s*/, '').split(/\s+/).pop() || p.name;
        const cell = (val) =>
            `<td class="${val === 0 ? 't-sum-zero' : ''}">${val}</td>`;
        return `
            <tr>
                <td class="t-sum-name" style="--c:${p.color};">
                    <span class="t-sum-dot"></span>
                    <span>Dr. ${escapeHtml(lastName)}</span>
                    <span class="t-sum-initials">${escapeHtml(p.initials || '')}</span>
                </td>
                ${cell(c.breast)}
                ${cell(c.lung)}
                ${cell(c.thoracic)}
                ${cell(c.cdh)}
                ${cell(c.other)}
                <td class="t-sum-total">${c.total}</td>
            </tr>`;
    }).join('');
}

// ── Tab counts ───────────────────────────────────────────────────────────
function renderTrackingTabCounts(filteredEntries) {
    const counts = { breast: 0, lung: 0, thoracic: 0, cdh: 0, other: 0 };
    filteredEntries.forEach(([, e]) => {
        if (counts[e.type] !== undefined) counts[e.type] += 1;
    });
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = String(val);
    };
    set('trackingTabCountBreast', counts.breast);
    set('trackingTabCountLung', counts.lung);
    set('trackingTabCountThoracic', counts.thoracic);
    set('trackingTabCountCdh', counts.cdh);
    set('trackingTabCountOther', counts.other);
}

// ── Entries list (per active tab) ────────────────────────────────────────
function renderTrackingEntries(filteredEntries) {
    const listEl = document.getElementById('trackingEntries');
    if (!listEl) return;

    const tabEntries = filteredEntries.filter(([, e]) => e.type === activeTrackingTab);
    const editable = canEditConferences();

    if (tabEntries.length === 0) {
        const typeLabel = CONF_TYPE_BY_ID[activeTrackingTab]
            ? CONF_TYPE_BY_ID[activeTrackingTab].singular
            : 'this conference';
        listEl.innerHTML = `
            <div class="empty">
                <span class="empty-headline">No entries yet.</span>
                Logged ${escapeHtml(typeLabel.toLowerCase())} sessions will appear here.
            </div>`;
        return;
    }

    listEl.innerHTML = tabEntries.map(([key, e]) => {
        const p = pathologists.find(x => x.id === e.pathologistId);
        const dateLabel = (function() {
            try {
                const d = parseDate(e.date);
                return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
            } catch (_) {
                return e.date;
            }
        })();
        const presenterName = p ? p.name : 'Unknown pathologist';
        const presenterColor = p ? p.color : 'var(--ink-3)';

        // Meta line: subtype tag (cdh), title (other), and note
        const metaParts = [];
        if (e.type === 'cdh' && e.subtype) {
            metaParts.push(`<span class="te-tag">${escapeHtml(e.subtype)}</span>`);
        }
        if (e.type === 'other' && e.otherTitle) {
            metaParts.push(`<span class="te-title">${escapeHtml(e.otherTitle)}</span>`);
        }
        if (e.note) {
            metaParts.push(`<span class="te-note">${escapeHtml(e.note)}</span>`);
        }

        const metaHtml = metaParts.length
            ? `<div class="te-meta">${metaParts.join(' ')}</div>`
            : '';

        const editBtn = editable
            ? `<button class="te-edit-btn" data-conf-edit="${escapeHtml(key)}" type="button">Edit</button>`
            : '';

        return `
            <div class="tracking-entry" style="--c:${presenterColor};">
                <div class="te-date">${escapeHtml(dateLabel)}</div>
                <div class="te-main">
                    <div class="te-presenter">
                        <span class="te-dot"></span>
                        <span>${escapeHtml(presenterName)}</span>
                    </div>
                    ${metaHtml}
                </div>
                ${editBtn}
            </div>`;
    }).join('');
}

// ── Master renderer ──────────────────────────────────────────────────────
function renderTrackingPage() {
    const pg = document.getElementById('trackingPage');
    if (!pg) return;

    // First render: populate the year select before reading its value
    populateTrackingYearSelect();

    // Sync the period dropdown to the current state
    const yearSel = document.getElementById('trackingYearSelect');
    if (yearSel && trackingPeriod !== null && yearSel.value !== trackingPeriod) {
        yearSel.value = trackingPeriod;
    }

    // Show/hide the Add button based on permissions
    const addBtn = document.getElementById('trackingAddBtn');
    if (addBtn) {
        addBtn.style.display = canEditConferences() ? '' : 'none';
    }

    // Show/hide the one-time historical import banner (admin only)
    if (typeof syncImportBanner === 'function') syncImportBanner();

    // Sync active-tab visual state
    document.querySelectorAll('#trackingTabs .tracking-tab').forEach(b => {
        b.classList.toggle('active', b.dataset.conf === activeTrackingTab);
    });

    const filtered = getFilteredEntries();
    renderTrackingSummary(filtered);
    renderTrackingTabCounts(filtered);
    renderTrackingEntries(filtered);
}

// Expose for any caller that needs to refresh the page (e.g. after sign-in)
window.__renderTrackingPage = renderTrackingPage;

// ── Wire-up: nav-item click (re-render after setPage un-hides shell) ─────
document.querySelectorAll('.nav-item[data-page="tracking"]').forEach(btn => {
    btn.addEventListener('click', () => {
        setTimeout(renderTrackingPage, 0);
    });
});

// ── Wire-up: tab clicks ──────────────────────────────────────────────────
(function wireTrackingTabs() {
    const tabsEl = document.getElementById('trackingTabs');
    if (!tabsEl) return;
    tabsEl.addEventListener('click', e => {
        const btn = e.target.closest('.tracking-tab');
        if (!btn) return;
        activeTrackingTab = btn.dataset.conf;
        renderTrackingPage();
    });
})();

// ── Wire-up: period dropdown ─────────────────────────────────────────────
(function wireTrackingYearSelect() {
    const sel = document.getElementById('trackingYearSelect');
    if (!sel) return;
    sel.addEventListener('change', () => {
        trackingPeriod = sel.value;
        renderTrackingPage();
    });
})();

// ── Wire-up: entry edit buttons (delegated) ──────────────────────────────
(function wireTrackingEntryEdits() {
    const listEl = document.getElementById('trackingEntries');
    if (!listEl) return;
    listEl.addEventListener('click', e => {
        const btn = e.target.closest('[data-conf-edit]');
        if (!btn) return;
        if (!canEditConferences()) return;
        openConferenceModal(btn.getAttribute('data-conf-edit'));
    });
})();

// ── Conference autofill helpers ──────────────────────────────────────────

// Returns a Set of 'YYYY-MM-DD' strings already logged for the given type.
function _confLoggedDates(type) {
    const dates = new Set();
    Object.values(conferenceLog || {}).forEach(e => {
        if (e.type === type && e.date) dates.add(e.date);
    });
    return dates;
}

// Returns the Date of the Nth occurrence (1-based) of `weekday` (0=Sun…6=Sat)
// in the given year/month (0-indexed month).
function _nthWeekdayOfMonth(year, month, weekday, n) {
    let count = 0;
    const d = new Date(year, month, 1);
    while (d.getMonth() === month) {
        if (d.getDay() === weekday) {
            count++;
            if (count === n) return new Date(d);
        }
        d.setDate(d.getDate() + 1);
    }
    return null;
}

// Returns the predicted next conference Date for the given type, skipping
// dates that already have a logged entry.
//   breast   → next Friday (non-holiday) with no existing log entry
//   thoracic → next 3rd Wednesday of the month (non-holiday) with no entry
//   lung     → next 2nd Wednesday of the month (non-holiday) with no entry
//   other    → next working day with no existing log entry for that type
function predictedConferenceDate(type) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const logged = _confLoggedDates(type);

    if (type === 'breast') {
        let d = addDays(today, 1);
        for (let i = 0; i < 730; i++) {
            if (d.getDay() === 5 && !getFederalHoliday(d) && !logged.has(fmt(d))) return d;
            d = addDays(d, 1);
        }
        return addDays(today, 1);
    }

    if (type === 'thoracic' || type === 'lung') {
        const nth = (type === 'thoracic') ? 3 : 2;
        for (let mo = 0; mo < 24; mo++) {
            const ref = new Date(today.getFullYear(), today.getMonth() + mo, 1);
            const target = _nthWeekdayOfMonth(ref.getFullYear(), ref.getMonth(), 3 /* Wed */, nth);
            if (target && target > today && !getFederalHoliday(target) && !logged.has(fmt(target))) {
                return target;
            }
        }
        return addDays(today, 1);
    }

    // Default (other, cdh): next working day not already logged for this type
    let d = addDays(today, 1);
    for (let i = 0; i < 730; i++) {
        if (!isWeekend(d) && !getFederalHoliday(d) && !logged.has(fmt(d))) return d;
        d = addDays(d, 1);
    }
    return addDays(today, 1);
}

// Returns the pathologist id of whoever is on McH Bigs (or cytobigs) on the
// given date, or null if no one is assigned to that service that day.
function getBigsPathForDate(date) {
    if (isWeekend(date) || getFederalHoliday(date)) return null;
    const assignments = getDayAssignments(date);
    for (const [pathId, a] of Object.entries(assignments)) {
        if (a.type === 'service' && a.service &&
            (a.service.id === 'bigs' || a.service.id === 'cytobigs')) {
            return parseInt(pathId, 10);
        }
    }
    return null;
}

// ── Conference modal: open / close / save / delete ───────────────────────
// Track which entry is being edited (null when adding a new one)
let _editingConferenceKey = null;

function openConferenceModal(editKey) {
    if (!canEditConferences()) return;

    const back = document.getElementById('confModalBack');
    if (!back) return;

    const titleEl = document.getElementById('confModalTitle');
    const subEl = document.getElementById('confModalSub');
    const typeSel = document.getElementById('confType');
    const subtypeSel = document.getElementById('confSubtype');
    const otherTitleInput = document.getElementById('confOtherTitle');
    const dateInput = document.getElementById('confDate');
    const pathSel = document.getElementById('confPathologist');
    const noteInput = document.getElementById('confNote');
    const deleteBtn = document.getElementById('confDelete');
    const saveBtn = document.getElementById('confSave');
    const errEl = document.getElementById('confFormError');

    // Reset error
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

    // Populate the pathologist select fresh each open (pathologist list
    // can change as users are added/removed in Firebase)
    pathSel.innerHTML = pathologists
        .map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
        .join('');

    if (editKey && conferenceLog[editKey]) {
        _editingConferenceKey = editKey;
        const e = conferenceLog[editKey];
        titleEl.textContent = 'Edit conference entry';
        if (subEl) subEl.textContent = 'Update or remove this entry.';
        saveBtn.textContent = 'Save changes';
        deleteBtn.style.display = '';

        typeSel.value = e.type || 'breast';
        subtypeSel.value = CDH_SUBTYPES.includes(e.subtype) ? e.subtype : 'GI';
        otherTitleInput.value = e.otherTitle || '';
        dateInput.value = e.date || '';
        if (pathologists.some(p => p.id === e.pathologistId)) {
            pathSel.value = String(e.pathologistId);
        }
        noteInput.value = e.note || '';
    } else {
        _editingConferenceKey = null;
        titleEl.textContent = 'Add conference entry';
        if (subEl) subEl.textContent = 'Log when a pathologist presented at a conference.';
        saveBtn.textContent = 'Add entry';
        deleteBtn.style.display = 'none';

        // Autofill: type = currently active tab; predicted date and
        // pathologist based on conference-specific scheduling rules.
        const _confType = activeTrackingTab || 'breast';
        typeSel.value = _confType;
        subtypeSel.value = 'GI';
        otherTitleInput.value = '';
        noteInput.value = '';

        // Predict the next applicable date for this conference type and the
        // pathologist who will be on McH Bigs service that day.
        const _predDate = predictedConferenceDate(_confType);
        dateInput.value = fmt(_predDate);
        const _bigsId = getBigsPathForDate(_predDate);
        if (_bigsId !== null && pathologists.some(p => p.id === _bigsId)) {
            pathSel.value = String(_bigsId);
        } else if (pathologists.length) {
            pathSel.value = String(pathologists[0].id);
        }
    }

    syncConferenceTypeFields();
    back.classList.add('open');
    // Focus first relevant field
    setTimeout(() => { try { typeSel.focus(); } catch (_) {} }, 30);
}

function closeConferenceModal() {
    const back = document.getElementById('confModalBack');
    if (back) back.classList.remove('open');
    _editingConferenceKey = null;
}

// Show/hide the subtype and other-title fields based on the selected type
function syncConferenceTypeFields() {
    const typeSel = document.getElementById('confType');
    const subtypeWrap = document.getElementById('confSubtypeWrap');
    const otherTitleWrap = document.getElementById('confOtherTitleWrap');
    if (!typeSel || !subtypeWrap || !otherTitleWrap) return;
    const t = typeSel.value;
    subtypeWrap.style.display = (t === 'cdh') ? '' : 'none';
    otherTitleWrap.style.display = (t === 'other') ? '' : 'none';
}

async function saveConferenceEntry() {
    if (!canEditConferences()) return;

    const typeSel = document.getElementById('confType');
    const subtypeSel = document.getElementById('confSubtype');
    const otherTitleInput = document.getElementById('confOtherTitle');
    const dateInput = document.getElementById('confDate');
    const pathSel = document.getElementById('confPathologist');
    const noteInput = document.getElementById('confNote');
    const errEl = document.getElementById('confFormError');

    const showError = (msg) => {
        if (!errEl) return;
        errEl.textContent = msg;
        errEl.style.display = '';
    };
    if (errEl) errEl.style.display = 'none';

    const type = typeSel.value;
    const date = dateInput.value;
    const pathId = parseInt(pathSel.value, 10);
    const note = (noteInput.value || '').trim();

    if (!type || !CONF_TYPE_BY_ID[type]) {
        showError('Please select a conference type.');
        return;
    }
    if (!date) {
        showError('Please pick a date.');
        return;
    }
    if (!Number.isFinite(pathId) || !pathologists.some(p => p.id === pathId)) {
        showError('Please select a presenter.');
        return;
    }

    const payload = {
        pathologistId: pathId,
        type,
        date,
    };
    if (type === 'cdh') {
        const st = subtypeSel.value;
        if (!CDH_SUBTYPES.includes(st)) {
            showError('Please pick a CDH subtype.');
            return;
        }
        payload.subtype = st;
    }
    if (type === 'other') {
        const t = (otherTitleInput.value || '').trim();
        if (!t) {
            showError('Please enter a title for the other tumor board.');
            return;
        }
        payload.otherTitle = t.slice(0, 80);
    }
    if (note) payload.note = note.slice(0, 160);

    try {
        if (_editingConferenceKey) {
            // Preserve original createdAt/createdBy; update the editable fields
            const existing = conferenceLog[_editingConferenceKey] || {};
            const merged = Object.assign({}, existing, payload, {
                updatedAt: Date.now(),
                updatedBy: loggedInPathId,
            });
            // If switching away from cdh/other, clear stale fields
            if (type !== 'cdh') merged.subtype = null;
            if (type !== 'other') merged.otherTitle = null;
            await db.ref('scheduler/conferenceLog/' + _editingConferenceKey).set(merged);
            // Log to changes feed
            const p = pathologists.find(x => x.id === pathId);
            const summary = _confChangeSummary('Updated', type, date, p, payload);
            try {
                await logChange({ kind: 'conference', summary, source: 'direct' });
            } catch (_) {}
        } else {
            const full = Object.assign({}, payload, {
                createdAt: Date.now(),
                createdBy: loggedInPathId,
            });
            await db.ref('scheduler/conferenceLog').push(full);
            const p = pathologists.find(x => x.id === pathId);
            const summary = _confChangeSummary('Logged', type, date, p, payload);
            try {
                await logChange({ kind: 'conference', summary, source: 'direct' });
            } catch (_) {}
        }
        closeConferenceModal();
    } catch (err) {
        console.error('Save conference entry error:', err);
        showError('Could not save. Please try again.');
    }
}

async function deleteConferenceEntry() {
    if (!canEditConferences()) return;
    const key = _editingConferenceKey;
    if (!key) return;
    if (!conferenceLog[key]) { closeConferenceModal(); return; }

    if (!confirm('Delete this conference entry? This cannot be undone.')) return;

    try {
        const existing = conferenceLog[key];
        await db.ref('scheduler/conferenceLog/' + key).remove();
        if (existing) {
            const p = pathologists.find(x => x.id === existing.pathologistId);
            const summary = _confChangeSummary('Removed', existing.type, existing.date, p, existing);
            try {
                await logChange({ kind: 'conference', summary, source: 'direct' });
            } catch (_) {}
        }
        closeConferenceModal();
    } catch (err) {
        console.error('Delete conference entry error:', err);
        const errEl = document.getElementById('confFormError');
        if (errEl) { errEl.textContent = 'Could not delete. Please try again.'; errEl.style.display = ''; }
    }
}

// Build a one-line summary string for the changes feed.
function _confChangeSummary(verb, type, dateKey, pathObj, payload) {
    const typeLabel = (CONF_TYPE_BY_ID[type] && CONF_TYPE_BY_ID[type].singular) || type;
    let datePretty = dateKey;
    try { datePretty = parseDate(dateKey).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }); } catch (_) {}
    const who = pathObj ? pathObj.name : 'a pathologist';
    let extra = '';
    if (type === 'cdh' && payload.subtype) extra = ` (${payload.subtype})`;
    if (type === 'other' && payload.otherTitle) extra = ` — ${payload.otherTitle}`;
    return `${verb} ${typeLabel}${extra} on ${datePretty} for ${who}`;
}

// ── Wire-up: modal buttons, type changes, backdrop close ─────────────────
(function wireConferenceModal() {
    const back = document.getElementById('confModalBack');
    const addBtn = document.getElementById('trackingAddBtn');
    const typeSel = document.getElementById('confType');
    const cancelBtn = document.getElementById('confCancel');
    const saveBtn = document.getElementById('confSave');
    const deleteBtn = document.getElementById('confDelete');
    if (!back) return;

    if (addBtn) addBtn.addEventListener('click', () => openConferenceModal(null));
    if (cancelBtn) cancelBtn.addEventListener('click', closeConferenceModal);
    if (saveBtn) saveBtn.addEventListener('click', saveConferenceEntry);
    if (deleteBtn) deleteBtn.addEventListener('click', deleteConferenceEntry);
    if (typeSel) typeSel.addEventListener('change', () => {
        syncConferenceTypeFields();
        // For new entries only, re-autofill date and pathologist to match the
        // newly selected conference type.
        if (_editingConferenceKey) return;
        const dateInput = document.getElementById('confDate');
        const pathSel = document.getElementById('confPathologist');
        if (!dateInput || !pathSel) return;
        const type = typeSel.value;
        const predDate = predictedConferenceDate(type);
        dateInput.value = fmt(predDate);
        const bigsId = getBigsPathForDate(predDate);
        if (bigsId !== null && pathologists.some(p => p.id === bigsId)) {
            pathSel.value = String(bigsId);
        }
    });

    // Click outside the modal card closes
    back.addEventListener('click', e => {
        if (e.target.id === 'confModalBack') closeConferenceModal();
    });

    // Esc closes when the modal is open
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && back.classList.contains('open')) {
            closeConferenceModal();
        }
    });
})();

// ── Historical data import (one-time) ────────────────────────────────────
// The 2025–2026 academic-year spreadsheet is reproduced here as a seed
// dataset. Only entries with date ≤ today's parse cutoff (May 11, 2026)
// are included — future scheduled presentations are intentionally
// excluded as the user requested. Cancelled spreadsheet rows are skipped.
//
// Once imported, scheduler/conferenceLogImported is set to a record of
// the import; that flag hides the banner permanently. Keys are
// deterministic ("hist_<type>_<date>[_<subtypeOrTitle>]") so re-clicking
// produces an idempotent overwrite, not duplicates.

const HISTORICAL_CONFERENCE_DATA = [
    // ── Breast Conference (31 entries) ───────────────────────────────
    { type: 'breast', date: '2025-09-05', presenter: 'MR' },
    { type: 'breast', date: '2025-09-12', presenter: 'IM' },
    { type: 'breast', date: '2025-09-19', presenter: 'JR' },
    { type: 'breast', date: '2025-10-03', presenter: 'MR' },
    { type: 'breast', date: '2025-10-10', presenter: 'MM' },
    { type: 'breast', date: '2025-10-17', presenter: 'IM' },
    { type: 'breast', date: '2025-10-31', presenter: 'MM' },
    { type: 'breast', date: '2025-11-07', presenter: 'IM' },
    { type: 'breast', date: '2025-11-14', presenter: 'MM' },
    { type: 'breast', date: '2025-11-21', presenter: 'MM' },
    { type: 'breast', date: '2025-12-05', presenter: 'IM' },
    { type: 'breast', date: '2025-12-12', presenter: 'MM' },
    { type: 'breast', date: '2025-12-19', presenter: 'MR' },
    { type: 'breast', date: '2026-01-09', presenter: 'MR' },
    { type: 'breast', date: '2026-01-16', presenter: 'IM' },
    { type: 'breast', date: '2026-01-23', presenter: 'JR' },
    { type: 'breast', date: '2026-01-30', presenter: 'MM' },
    { type: 'breast', date: '2026-02-06', presenter: 'IM' },
    { type: 'breast', date: '2026-02-13', presenter: 'MR' },
    { type: 'breast', date: '2026-02-20', presenter: 'JR' },
    { type: 'breast', date: '2026-02-27', presenter: 'JR' },
    { type: 'breast', date: '2026-03-06', presenter: 'MM' },
    { type: 'breast', date: '2026-03-13', presenter: 'MM' },
    { type: 'breast', date: '2026-03-20', presenter: 'MM' },
    { type: 'breast', date: '2026-03-27', presenter: 'JR' },
    { type: 'breast', date: '2026-04-03', presenter: 'IM' },
    { type: 'breast', date: '2026-04-10', presenter: 'JR' },
    { type: 'breast', date: '2026-04-17', presenter: 'MR' },
    { type: 'breast', date: '2026-04-24', presenter: 'MM' },
    { type: 'breast', date: '2026-05-01', presenter: 'JR' },
    { type: 'breast', date: '2026-05-08', presenter: 'MM' },

    // ── Lung Conference (8 entries) ──────────────────────────────────
    { type: 'lung', date: '2025-09-10', presenter: 'MM' },
    { type: 'lung', date: '2025-10-08', presenter: 'MR' },
    { type: 'lung', date: '2025-11-12', presenter: 'MM' },
    { type: 'lung', date: '2025-12-10', presenter: 'MR' },
    { type: 'lung', date: '2026-01-14', presenter: 'MM' },
    { type: 'lung', date: '2026-02-11', presenter: 'MM' },
    { type: 'lung', date: '2026-03-11', presenter: 'JR' },
    { type: 'lung', date: '2026-04-08', presenter: 'JR' },

    // ── Thoracic Conference (7 entries) ──────────────────────────────
    { type: 'thoracic', date: '2025-09-17', presenter: 'MM' },
    { type: 'thoracic', date: '2025-10-15', presenter: 'JR' },
    { type: 'thoracic', date: '2025-11-19', presenter: 'MM' },
    { type: 'thoracic', date: '2026-01-21', presenter: 'MM' },
    { type: 'thoracic', date: '2026-02-18', presenter: 'IM' },
    { type: 'thoracic', date: '2026-03-18', presenter: 'MM' },
    { type: 'thoracic', date: '2026-04-15', presenter: 'IM' },

    // ── Morning / CDH (27 entries) ───────────────────────────────────
    { type: 'cdh', date: '2025-09-02', subtype: 'GI',       presenter: 'MR' },
    { type: 'cdh', date: '2025-09-05', subtype: 'Heme',     presenter: 'MM' },
    { type: 'cdh', date: '2025-09-10', subtype: 'Thoracic', presenter: 'JR' },
    { type: 'cdh', date: '2025-09-16', subtype: 'GI',       presenter: 'JR' },
    { type: 'cdh', date: '2025-09-23', subtype: 'GI',       presenter: 'MM' },
    { type: 'cdh', date: '2025-10-03', subtype: 'Heme',     presenter: 'MR' },
    { type: 'cdh', date: '2025-10-14', subtype: 'GI',       presenter: 'IM' },
    { type: 'cdh', date: '2025-11-04', subtype: 'GI',       presenter: 'JR' },
    { type: 'cdh', date: '2025-11-21', subtype: 'Heme',     presenter: 'MM' },
    { type: 'cdh', date: '2025-12-02', subtype: 'GI',       presenter: 'MM' },
    { type: 'cdh', date: '2025-12-09', subtype: 'GI',       presenter: 'MM' },
    { type: 'cdh', date: '2025-12-16', subtype: 'GI',       presenter: 'MR' },
    { type: 'cdh', date: '2026-01-20', subtype: 'GI',       presenter: 'JR' },
    { type: 'cdh', date: '2026-01-27', subtype: 'GI',       presenter: 'IM' },
    { type: 'cdh', date: '2026-01-29', subtype: 'Thoracic', presenter: 'JR' },
    { type: 'cdh', date: '2026-02-06', subtype: 'Heme',     presenter: 'MR' },
    { type: 'cdh', date: '2026-02-10', subtype: 'GI',       presenter: 'JR' },
    { type: 'cdh', date: '2026-02-17', subtype: 'GI',       presenter: 'MM' },
    { type: 'cdh', date: '2026-02-24', subtype: 'GI',       presenter: 'MM' },
    { type: 'cdh', date: '2026-03-03', subtype: 'GI',       presenter: 'IM' },
    { type: 'cdh', date: '2026-03-06', subtype: 'Heme',     presenter: 'MM' },
    { type: 'cdh', date: '2026-03-17', subtype: 'GI',       presenter: 'MR' },
    { type: 'cdh', date: '2026-03-24', subtype: 'GI',       presenter: 'MR' },
    { type: 'cdh', date: '2026-04-14', subtype: 'GI',       presenter: 'MM' },
    { type: 'cdh', date: '2026-04-21', subtype: 'GI',       presenter: 'IM' },
    { type: 'cdh', date: '2026-04-30', subtype: 'Thoracic', presenter: 'MR' },
    { type: 'cdh', date: '2026-05-05', subtype: 'GI',       presenter: 'IM' },

    // ── Other Tumor Boards (1 entry) ─────────────────────────────────
    { type: 'other', date: '2025-09-12', otherTitle: 'NMH Gyn Onc', presenter: 'IM' },
];

// Flag indicating the historical import has been run (or explicitly
// dismissed via Firebase console). When truthy, the banner stays hidden.
let conferenceLogImported = null;
db.ref('scheduler/conferenceLogImported').on('value', snap => {
    conferenceLogImported = snap.exists() ? snap.val() : null;
    const _appEl = document.getElementById('app');
    if (_appEl && _appEl.getAttribute('data-page') === 'tracking'
        && typeof renderTrackingPage === 'function') {
        renderTrackingPage();
    }
}, err => {
    console.error('Firebase conferenceLogImported error:', err);
});

// Build {initials: pathId} from the live pathologists list. Used to
// resolve the seed's 'MR', 'IM', etc. → real ids.
function _getInitialsToPathIdMap() {
    const m = {};
    pathologists.forEach(p => { if (p.initials) m[p.initials] = p.id; });
    return m;
}

// Sanitize an "otherTitle" string into a Firebase-key-safe slug.
// Firebase keys disallow: . $ # [ ] /  and whitespace.
function _slugifyKeyPart(s) {
    return String(s || '')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        || 'untitled';
}

// Build the deterministic key for a historical seed entry. Re-running
// the import overwrites in place — no duplicates.
function _historicalKey(e) {
    let key = 'hist_' + e.type + '_' + e.date;
    if (e.type === 'cdh' && e.subtype) key += '_' + _slugifyKeyPart(e.subtype);
    if (e.type === 'other' && e.otherTitle) key += '_' + _slugifyKeyPart(e.otherTitle);
    return key;
}

// Update the import-banner visibility / disabled state. Called from
// renderTrackingPage and from the click handler during the in-flight
// save so the button shows "Importing…".
function syncImportBanner() {
    const banner = document.getElementById('trackingImportBanner');
    const btn = document.getElementById('trackingImportBtn');
    const sub = document.getElementById('trackingImportSub');
    if (!banner) return;

    // Hide unless: admin (only admin runs the one-time import), the
    // flag isn't set yet, and the seed data exists.
    const shouldShow = isAdmin()
        && !conferenceLogImported
        && HISTORICAL_CONFERENCE_DATA.length > 0;
    banner.style.display = shouldShow ? '' : 'none';

    if (sub) {
        sub.textContent =
            'Import ' + HISTORICAL_CONFERENCE_DATA.length +
            ' past entries (Sept 2025 – today) from your 2025–2026 spreadsheet. ' +
            'Future scheduled presentations are not included.';
    }
    if (btn) btn.disabled = false;
}

// Run the import. Validates that every initials referenced in the seed
// data resolves to a current pathologist, builds one multi-path update,
// and writes everything atomically.
async function importHistoricalConferenceData() {
    if (!isAdmin()) return;
    if (conferenceLogImported) return;

    const map = _getInitialsToPathIdMap();
    const missing = new Set();
    HISTORICAL_CONFERENCE_DATA.forEach(e => {
        if (!map[e.presenter]) missing.add(e.presenter);
    });
    if (missing.size > 0) {
        alert(
            'Cannot import: these initials in the seed data have no matching pathologist: '
            + [...missing].join(', ')
            + '. Check the pathologist list in Firebase.'
        );
        return;
    }

    const count = HISTORICAL_CONFERENCE_DATA.length;
    if (!confirm(
        'Import ' + count + ' past conference entries from the 2025–2026 spreadsheet?\n\n'
        + 'This is a one-time action. Future-scheduled presentations are not included. '
        + 'Existing entries with the same date/type are overwritten with the seed values.'
    )) return;

    const btn = document.getElementById('trackingImportBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }

    const now = Date.now();
    const updates = {};

    HISTORICAL_CONFERENCE_DATA.forEach(e => {
        const key = _historicalKey(e);
        const entry = {
            pathologistId: map[e.presenter],
            type: e.type,
            date: e.date,
            createdAt: now,
            createdBy: loggedInPathId,
            source: 'historical_import',
        };
        if (e.subtype) entry.subtype = e.subtype;
        if (e.otherTitle) entry.otherTitle = e.otherTitle;
        updates['scheduler/conferenceLog/' + key] = entry;
    });

    updates['scheduler/conferenceLogImported'] = {
        at: now,
        by: loggedInPathId,
        count,
        action: 'imported',
    };

    try {
        await db.ref().update(updates);
        // Audit trail entry in the Changes feed
        try {
            await logChange({
                kind: 'conference',
                summary: 'Imported ' + count + ' historical conference entries (2025–2026 academic year)',
                source: 'direct',
            });
        } catch (_) { /* non-fatal */ }
        // Listener will auto-re-render; explicit call is a safety net in
        // case the listener races the visible state.
        if (typeof renderTrackingPage === 'function') renderTrackingPage();
    } catch (err) {
        console.error('Historical import error:', err);
        alert('Import failed. Please try again or check the console.');
        if (btn) { btn.disabled = false; btn.textContent = 'Import'; }
    }
}

// Wire the import button. Banner visibility itself is handled by
// renderTrackingPage / syncImportBanner.
(function wireHistoricalImportBtn() {
    const btn = document.getElementById('trackingImportBtn');
    if (!btn) return;
    btn.addEventListener('click', importHistoricalConferenceData);
})();

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
    const hasCyto = svcs.includes('cyto') || svcs.includes('cytobigs');
    const hasBigs = svcs.includes('bigs') || svcs.includes('cytobigs');
    const hasWfh = svcs.includes('wfh');
    const hasMcHAny = hasCyto || hasBigs;

    const issues = [];
    if (n === 2) {
        if (!hasHuntley) issues.push('Huntley not staffed');
        if (!hasMcHAny) issues.push('No McHenry service staffed');
    } else if (n === 3) {
        if (!hasHuntley) issues.push('Huntley not staffed');
        if (!hasCyto) issues.push('McHenry Cyto/Gross not staffed');
        if (!hasBigs) issues.push('McHenry Bigs not staffed');
    } else {
        if (!hasHuntley) issues.push('Huntley not staffed');
        if (!hasCyto) issues.push('McHenry Cyto/Gross not staffed');
        if (!hasBigs) issues.push('McHenry Bigs not staffed');
        if (!hasWfh) issues.push('Breast Bx/WFH not staffed');
    }
    return issues.length > 0 ? issues : null;
}

// ────────────── SOFT RULE CHECK (yellow flag) ──────────────
// Soft rules: any pathologist on McHenry Bigs (or cytobigs) the workday
// before they start PTO, or the workday before they are on Breast Bx/WFH.
// Returns an array of descriptive strings, or null if no violations.
function softRuleViolationsForDay(date) {
    if (isWeekend(date) || getFederalHoliday(date) || isBeforeEarliest(date)) return null;

    const assign = getDayAssignments(date);
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
    const softIssues = softRuleViolationsForDay(date);
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
    if (view === 'day') {
        return sameDay(cursor, today);
    } else if (view === 'week') {
        const s = startOfWeek(cursor);
        const e = addDays(s, 6);
        return today >= s && today <= addDays(e, 1);
    } else if (view === 'month') {
        return cursor.getFullYear() === today.getFullYear() &&
            cursor.getMonth() === today.getMonth();
    } else { // year
        return cursor.getFullYear() === today.getFullYear();
    }
}

function renderPeriodLabel() {
    const el = document.getElementById('currentPeriod');
    if (view === 'day') {
        // Single-day label: weekday + month + day, with year separated so it
        // can be styled (and dropped to a second line on narrow screens).
        // e.g. "Tue, May 12 2026"
        el.innerHTML = `${DOW[cursor.getDay()]}, ${MONTHS_SHORT[cursor.getMonth()]} ${cursor.getDate()} <span class="year">${cursor.getFullYear()}</span>`;
    } else if (view === 'week') {
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

// ────────────── DAY VIEW ──────────────
// Mobile-first single-day view. Reuses the same .week-day card structure
// as the week view (header / pathologist rows / hour grid) so all existing
// CSS, click handlers, drag-and-drop, and procedure pill logic Just Works
// — the only difference is we render one day at full width instead of a
// grid of seven narrow columns. This is the only mobile view that shows
// the procedure schedule (week/month/year on mobile are summary-only).
function renderDay() {
    const main = document.getElementById('main');
    // Normalize cursor to midnight so date math/comparisons are stable.
    const d = new Date(cursor);
    d.setHours(0, 0, 0, 0);

    const td = sameDay(d, today);
    const we = isWeekend(d);
    const holiday = getFederalHoliday(d);
    const dayAssign = getDayAssignments(d);

    const activePathologists = currentPathFilter === 'all'
        ? pathologists
        : pathologists.filter(p => p.id === parseInt(currentPathFilter));

    let rows = '';

    // Lake Forest sendout banner sits above the first pathologist row
    // (same as in week view).
    if (isLfSendoutDay(d)) {
        rows += `<div class="wd-row lf-sendout" title="Lake Forest sendout">
        <span class="lf-label">Lake Forest sendout</span>
      </div>`;
    }

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
        } else if (a.type === 'off_site') {
            const cbg = pathBgColor(p.color);
            rows += `<div class="wd-row off-site" style="--c:${p.color}; --sc:var(${a.service.cssVar})${cbg ? `; --c-bg:${cbg}` : ''}">
          <span class="pid">${p.initials}</span>
          <span class="svc"><span class="swatch"></span>${a.service.short}</span>
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

    // The .day-view wrapper is just a layout container — the actual card
    // uses the same .week-day class as week view so all styling/handlers
    // line up. The .day-view-card modifier lets CSS opt into the wider,
    // mobile-optimized treatment (bigger header, full-width hour grid).
    const html = `<div class="day-view">
      <div class="week-day day-view-card ${td ? 'today' : ''} ${we ? 'weekend' : ''} ${holiday ? 'holiday' : ''}" data-date="${fmt(d)}">
        <div class="wd-head day-view-head">
          <div class="day-view-head-main">
            <span class="dow">${DOW[d.getDay()]}</span>
            <span class="num">${d.getDate()}${flagHtml(d)}</span>
            <span class="day-view-month">${MONTHS_SHORT[d.getMonth()]}</span>
          </div>
          ${holidayBadge}
        </div>
        <div class="wd-rows">${rows}</div>
        ${hoursHtml}
      </div>
    </div>`;
    main.innerHTML = html;
    attachDayClickHandlers();
    attachHourGridHandlers();
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

        // Lake Forest sendout banner sits above the first pathologist row.
        if (isLfSendoutDay(d)) {
            rows += `<div class="wd-row lf-sendout" title="Lake Forest sendout">
            <span class="lf-label">Lake Forest sendout</span>
          </div>`;
        }

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
            } else if (a.type === 'off_site') {
                const cbg = pathBgColor(p.color);
                rows += `<div class="wd-row off-site" style="--c:${p.color}; --sc:var(${a.service.cssVar})${cbg ? `; --c-bg:${cbg}` : ''}">
            <span class="pid">${p.initials}</span>
            <span class="svc"><span class="swatch"></span>${a.service.short}</span>
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

    // Group procedures into the half-hour slot they fall into. A procedure
    // whose start time is exactly on a :00 or :30 boundary goes in that slot;
    // off-boundary times (e.g. 8:15, 8:45) bucket into the half-hour slot
    // they belong to (8:15 → 8:00 slot, 8:45 → 8:30 slot). This keeps the
    // grid layout fixed while allowing arbitrary procedure start times.
    const bySlot = {};
    procs.forEach(p => {
        const slotKey = slotKeyForTime(p.time);
        if (!slotKey) return; // outside the visible window
        if (!bySlot[slotKey]) bySlot[slotKey] = [];
        bySlot[slotKey].push(p);
    });

    let rowsHtml = '';
    for (let h = HOURS_START; h <= HOURS_END; h++) {
        for (let m of [0, 30]) {
            const timeKey = pad2(h) + ':' + pad2(m);   // "08:30"
            const isHourMark = (m === 0);
            const cls = isHourMark ? 'hour-mark' : 'half';
            const label = isHourMark ? formatHour12(h) : '';
            const items = (bySlot[timeKey] || []).map(p => {
                // Always prefix the pill label with the exact start time so
                // it's visible at a glance regardless of whether the time
                // lands on a :00, :30, or any other minute
                // (e.g. "7:00 HH - EUS", "8:15 HH - CT Kidney bx").
                const baseLbl = procLabel(p);
                const lbl = `${formatTime12Short(p.time)} ${baseLbl}`;
                const cat = getProcedureCategory(p.location, p.procedureName);
                // Hover tooltip: procedure label + time range. Each procedure
                // is 30 min by default (durationMin can override).
                const tooltip = `${baseLbl} — ${formatTimeRange(p.time, p.durationMin)}`;
                return `<span class="proc-item proc-cat-${cat}" data-day="${dayKey}" data-key="${p.key}" tabindex="0" draggable="true" title="${escapeHtml(tooltip)}">${escapeHtml(lbl)}</span>`;
            }).join('');
            rowsHtml += `<div class="hour-row ${cls}" data-day="${dayKey}" data-time="${timeKey}" title="Double-click an empty slot to add a procedure">
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
        // Default duration: 30 minutes unless the record explicitly overrides.
        durationMin: (typeof p.durationMin === 'number' && p.durationMin > 0) ? p.durationMin : 30,
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
    if (/\bEUS\b/i.test(name)) return 'eus';
    if (/lumpectomy|mastectomy|excisional\s*bx/i.test(name)) return 'surgical';
    if (/^FS\b/i.test(name)) return 'fs';
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

// Compact 12h time like "8:15" (no AM/PM) for pill prefixes where space is
// tight and the surrounding slot already implies the period.
function formatTime12Short(timeKey) {
    const [hStr, mStr] = timeKey.split(':');
    const h = parseInt(hStr, 10);
    const m = parseInt(mStr, 10);
    const hh = ((h + 11) % 12) + 1;
    return hh + ':' + pad2(m);
}

// True when the given "HH:MM" lands exactly on a half-hour boundary.
function isOnHalfHourBoundary(timeKey) {
    if (!timeKey) return false;
    const m = parseInt(timeKey.split(':')[1], 10);
    return m === 0 || m === 30;
}

// Returns the half-hour slot key ("HH:MM") that the given time falls into,
// or null if the time is outside the visible HOURS_START..HOURS_END window.
// e.g. "08:15" → "08:00", "08:45" → "08:30", "06:30" → null (before window).
function slotKeyForTime(timeKey) {
    if (!timeKey || !/^\d{2}:\d{2}$/.test(timeKey)) return null;
    const [hStr, mStr] = timeKey.split(':');
    const h = parseInt(hStr, 10);
    const m = parseInt(mStr, 10);
    if (h < HOURS_START || h > HOURS_END) return null;
    const slotM = m < 30 ? 0 : 30;
    return pad2(h) + ':' + pad2(slotM);
}

// Validate a free-form "HH:MM" string (24h) and check it falls in-range.
function isValidTimeKey(timeKey) {
    if (!timeKey || !/^\d{2}:\d{2}$/.test(timeKey)) return false;
    const [hStr, mStr] = timeKey.split(':');
    const h = parseInt(hStr, 10);
    const m = parseInt(mStr, 10);
    if (Number.isNaN(h) || Number.isNaN(m)) return false;
    if (h < 0 || h > 23 || m < 0 || m > 59) return false;
    // Allow the full HOURS_START..HOURS_END window, including any minute up
    // to :59 of the final hour (so e.g. 16:45 is OK within the 16:30 slot).
    if (h < HOURS_START || h > HOURS_END) return false;
    return true;
}

// "8:00 AM – 8:30 AM" for a procedure starting at timeKey with durationMin
// minutes (defaults to 30). End time is computed in minutes-since-midnight
// and clamped to a single day; durations that would cross midnight are
// truncated to "11:59 PM" for display purposes.
function formatTimeRange(timeKey, durationMin) {
    const dur = (typeof durationMin === 'number' && durationMin > 0) ? durationMin : 30;
    const [hStr, mStr] = timeKey.split(':');
    const startTotal = parseInt(hStr, 10) * 60 + parseInt(mStr, 10);
    let endTotal = Math.min(startTotal + dur, 24 * 60 - 1);
    const endH = Math.floor(endTotal / 60);
    const endM = endTotal % 60;
    const endKey = pad2(endH) + ':' + pad2(endM);
    return formatTime12(timeKey) + ' – ' + formatTime12(endKey);
}

const pad2 = n => String(n).padStart(2, '0');

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Tracks the currently-selected procedure pill so the Delete key knows
// what to remove. Cleared whenever the user clicks outside any pill.
let _selectedProc = null;  // { dayKey, procKey } or null

function selectProcedure(dayKey, procKey) {
    if (!dayKey || !procKey) return;
    // Clear any prior selection in the DOM, then set the new one.
    document.querySelectorAll('.proc-item.selected').forEach(el => el.classList.remove('selected'));
    _selectedProc = { dayKey, procKey };
    const el = document.querySelector(
        '.proc-item[data-day="' + dayKey + '"][data-key="' + procKey + '"]'
    );
    if (el) el.classList.add('selected');
}

function clearProcedureSelection() {
    document.querySelectorAll('.proc-item.selected').forEach(el => el.classList.remove('selected'));
    _selectedProc = null;
}

// Attach handlers for the week-view hourly grid.
//   - Stop click/dblclick from bubbling to the .week-day (which would open
//     the day-detail modal — not what the user wants when scheduling).
//   - Double-click on an empty slot → add-procedure modal.
//   - Single-click on a pill → select it (Delete key removes it).
//   - Double-click on a pill → edit-procedure modal.
function attachHourGridHandlers() {
    document.querySelectorAll('.wd-hours').forEach(grid => {
        // Block the parent .week-day's click → day modal. Also clear any
        // procedure selection when the user clicks an empty area of the
        // grid (clicks on pills are handled separately and stopPropagation
        // there prevents this from firing for them).
        grid.addEventListener('click', e => {
            e.stopPropagation();
            if (!e.target.closest('.proc-item')) {
                clearProcedureSelection();
            }
        });
        grid.addEventListener('dblclick', e => e.stopPropagation());
    });

    document.querySelectorAll('.hour-row').forEach(row => {
        row.addEventListener('dblclick', e => {
            // If the dblclick landed on an existing pill, the pill's own
            // handler opens the edit modal — don't open the add modal.
            if (e.target.closest('.proc-item')) return;
            const dayKey = row.dataset.day;
            const timeKey = row.dataset.time;
            if (!dayKey || !timeKey) return;
            openProcedureModal(dayKey, timeKey);
        });
    });

    document.querySelectorAll('.proc-item').forEach(item => {
        // Single click → select the pill. Delete key removes the selection.
        item.addEventListener('click', e => {
            e.stopPropagation();
            selectProcedure(item.dataset.day, item.dataset.key);
        });
        // Double click → edit the procedure. Reuses the add-procedure modal
        // in edit mode (location + procedure type prefilled).
        item.addEventListener('dblclick', e => {
            e.stopPropagation();
            const dayKey = item.dataset.day;
            const procKey = item.dataset.key;
            if (!dayKey || !procKey) return;
            const proc = (procedures[dayKey] || {})[procKey];
            if (!proc) return;
            openProcedureModal(dayKey, proc.time, procKey);
        });

        // ── Drag-and-drop: move procedure to a different time slot ──
        item.addEventListener('dragstart', e => {
            e.stopPropagation();
            // Store the source info in dataTransfer so the drop handler knows
            // which procedure is being moved, even across grid columns.
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain',
                JSON.stringify({ dayKey: item.dataset.day, procKey: item.dataset.key }));
            // Small timeout so the "ghost" image captures the normal pill style
            // before the .dragging class dims it.
            setTimeout(() => item.classList.add('dragging'), 0);
        });
        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            // Remove all drop-zone highlights left behind.
            document.querySelectorAll('.hour-row.drag-over').forEach(r => r.classList.remove('drag-over'));
        });
    });

    // ── Drop zones: every hour-row in every visible grid ──
    document.querySelectorAll('.hour-row').forEach(row => {
        row.addEventListener('dragover', e => {
            e.preventDefault(); // required to allow drop
            e.dataTransfer.dropEffect = 'move';
            // Highlight this row and clear any previously-highlighted sibling.
            document.querySelectorAll('.hour-row.drag-over').forEach(r => {
                if (r !== row) r.classList.remove('drag-over');
            });
            row.classList.add('drag-over');
        });
        row.addEventListener('dragleave', e => {
            // Only remove the highlight when leaving the row entirely, not
            // when moving between its children (label ↔ slot).
            if (!row.contains(e.relatedTarget)) {
                row.classList.remove('drag-over');
            }
        });
        row.addEventListener('drop', async e => {
            e.preventDefault();
            e.stopPropagation();
            row.classList.remove('drag-over');

            let payload;
            try {
                payload = JSON.parse(e.dataTransfer.getData('text/plain'));
            } catch (_) { return; }

            const { dayKey: srcDay, procKey } = payload;
            const dstDay  = row.dataset.day;   // day of the target row
            const newTime = row.dataset.time;  // "HH:MM" of the target slot
            if (!srcDay || !procKey || !dstDay || !newTime) return;

            const proc = (procedures[srcDay] || {})[procKey];
            if (!proc) return;

            // Nothing to do if dropped onto the exact same day+slot.
            const currentSlot = slotKeyForTime(proc.time);
            if (srcDay === dstDay && currentSlot === newTime) return;

            try {
                if (srcDay === dstDay) {
                    // Same day — just update the time field.
                    await db.ref('scheduler/procedures/' + srcDay + '/' + procKey + '/time').set(newTime);
                } else {
                    // Different day — write the full record to the new path,
                    // then delete from the old path atomically via multi-path update.
                    const updatedProc = Object.assign({}, proc, { time: newTime });
                    // Remove internal-only fields that aren't stored in Firebase.
                    delete updatedProc.key;
                    delete updatedProc.durationMin; // only set if explicitly stored; re-derived on read

                    const updates = {};
                    updates['scheduler/procedures/' + dstDay + '/' + procKey] = updatedProc;
                    updates['scheduler/procedures/' + srcDay + '/' + procKey] = null; // delete
                    await db.ref().update(updates);
                }
            } catch (err) {
                showToast('Could not move procedure: ' + (err.message || err), { type: 'error' });
            }
        });
    });

    // Re-apply selection state after a re-render (Firebase snapshots blow
    // away the DOM and any class set on it). If the previously-selected
    // procedure no longer exists, drop the stale reference.
    if (_selectedProc) {
        const sel = document.querySelector(
            '.proc-item[data-day="' + _selectedProc.dayKey + '"][data-key="' + _selectedProc.procKey + '"]'
        );
        if (sel) sel.classList.add('selected');
        else _selectedProc = null;
    }
}

// Click anywhere outside a procedure pill → deselect. Skips clicks inside
// modals so users can interact with dialogs without losing their selection
// (though selection is also cleared after delete/edit succeeds).
document.addEventListener('click', e => {
    if (e.target.closest('.proc-item')) return;
    if (e.target.closest('.modal-back')) return;
    clearProcedureSelection();
});

// Delete / Backspace removes the currently-selected procedure.
// Skips text-entry contexts and any open modal so we don't delete while
// the user is typing or navigating a dialog.
document.addEventListener('keydown', async e => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (!_selectedProc) return;
    const ae = document.activeElement;
    if (ae && (
        ae.tagName === 'INPUT' ||
        ae.tagName === 'TEXTAREA' ||
        ae.tagName === 'SELECT' ||
        ae.isContentEditable
    )) return;
    if (document.querySelector('.modal-back.open')) return;

    const { dayKey, procKey } = _selectedProc;
    e.preventDefault();
    _selectedProc = null;
    try {
        await db.ref('scheduler/procedures/' + dayKey + '/' + procKey).remove();
    } catch (err) {
        showToast('Could not remove procedure: ' + (err.message || err), { type: 'error' });
    }
});

// Procedure modal — pick a location (HH/MH) and a procedure type, then
// confirm. The "Add Procedure" button is disabled until both are chosen.
// Pass `editingKey` to open in edit mode: pre-fills location + name from
// the existing record, swaps the title/button labels, and on save updates
// in place rather than pushing a new entry.
let _pendingProc = null;  // { dayKey, timeKey, location, procedureName, editingKey }

function openProcedureModal(dayKey, timeKey, editingKey) {
    _pendingProc = {
        dayKey,
        timeKey,
        location: null,
        procedureName: null,
        editingKey: editingKey || null,
    };

    // If editing, snapshot the existing fields so we can prefill the UI.
    let existing = null;
    if (editingKey) {
        existing = (procedures[dayKey] || {})[editingKey] || null;
        if (existing) {
            _pendingProc.location = existing.location || null;
            _pendingProc.procedureName = existing.procedureName || null;
        }
    }

    const date = parseDate(dayKey);
    // The subheader shows the date only; the time itself lives in its own
    // editable input below so the user can override the half-hour default.
    const sub = `${DOW[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
    document.getElementById('procModalSub').textContent = sub;

    // Swap heading + primary button text for edit vs add.
    const titleEl = document.getElementById('procModalTitle');
    if (titleEl) titleEl.textContent = editingKey ? 'Edit Procedure' : 'Add Procedure';
    const confirmBtn = document.getElementById('procConfirm');
    if (confirmBtn) confirmBtn.textContent = editingKey ? 'Save Changes' : 'Add Procedure';

    // Prefill the time input. For new procedures this is the half-hour slot
    // the user double-clicked; for edits, the procedure's existing time.
    // Either way the user can override it before saving.
    const timeInput = document.getElementById('procTimeInput');
    if (timeInput) {
        timeInput.value = timeKey || '';
        timeInput.min = pad2(HOURS_START) + ':00';
        timeInput.max = pad2(HOURS_END) + ':59';
    }

    // Reset / preset the location radios
    document.querySelectorAll('input[name="procLoc"]').forEach(r => {
        r.checked = !!(existing && r.value === existing.location);
    });

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

    // Pre-select the matching preset button or populate the freetext input
    // when editing an existing procedure.
    if (existing && existing.procedureName) {
        const isPreset = PROCEDURE_TYPES.includes(existing.procedureName);
        if (isPreset) {
            const presetBtn = document.querySelector(
                '#procTypeGrid .proc-type-btn[data-name="' + CSS.escape(existing.procedureName) + '"]'
            );
            if (presetBtn) presetBtn.classList.add('selected');
        } else {
            const input = document.getElementById('procFreetextInput');
            const wrap = document.getElementById('procFreetextWrap');
            if (input) input.value = existing.procedureName;
            if (wrap) wrap.classList.add('active');
        }
    }

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

    updateModalProcColors();
    updateProcConfirmEnabled();
    document.getElementById('procModalBack').classList.add('open');
}

function closeProcedureModal() {
    document.getElementById('procModalBack').classList.remove('open');
    _pendingProc = null;
}

// Gate the primary button on having both selections made AND a valid time.
function updateProcConfirmEnabled() {
    const btn = document.getElementById('procConfirm');
    const timeInput = document.getElementById('procTimeInput');
    const timeVal = (timeInput && timeInput.value) ? timeInput.value : '';
    const ready = !!(
        _pendingProc &&
        _pendingProc.location &&
        _pendingProc.procedureName &&
        isValidTimeKey(timeVal)
    );
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
    // Read the latest time value from the input — the user may have edited
    // it after the modal opened. Fall back to the slot's time on parse fail.
    const timeInput = document.getElementById('procTimeInput');
    const timeKey = (timeInput && timeInput.value) ? timeInput.value : _pendingProc.timeKey;
    if (!isValidTimeKey(timeKey)) {
        showToast(
            `Time must be between ${formatTime12(pad2(HOURS_START) + ':00')} and ${formatTime12(pad2(HOURS_END) + ':59')}.`,
            { type: 'error' }
        );
        return;
    }
    const { dayKey, location, procedureName, editingKey } = _pendingProc;
    try {
        if (editingKey) {
            // Edit mode — update only the mutable fields. Leave type,
            // createdAt, createdBy untouched. Stamp updatedAt for traceability.
            // Time IS now mutable since the user can adjust it in the modal.
            await db.ref('scheduler/procedures/' + dayKey + '/' + editingKey).update({
                time: timeKey,
                location,
                procedureName,
                updatedAt: Date.now(),
            });
        } else {
            // Add mode — push a brand-new entry.
            const payload = {
                time: timeKey,
                type: 'procedure',
                location,
                procedureName,
                createdAt: Date.now(),
            };
            if (loggedInPathId !== null) payload.createdBy = loggedInPathId;
            await db.ref('scheduler/procedures/' + dayKey).push(payload);
        }
        closeProcedureModal();
    } catch (err) {
        showToast('Could not save procedure: ' + (err.message || err), { type: 'error' });
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
      <h3 id="procModalTitle">Add Procedure</h3>
      <p class="sub" id="procModalSub"></p>
    </div>
  </div>

  <div class="proc-section-label">Time</div>
  <div class="proc-time-row">
    <input type="time" id="procTimeInput" class="proc-time-input" step="60">
    <span class="proc-time-hint">You can override the default slot.</span>
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

// Re-enable the confirm button when the user edits the time input. Delegated
// from the modal back so it survives the modal-content rebuild above.
document.getElementById('procModalBack').addEventListener('input', e => {
    if (e.target && e.target.id === 'procTimeInput') {
        updateProcConfirmEnabled();
    }
});

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
    const wrap = document.getElementById('procFreetextWrap');
    if (input) input.value = '';
    if (wrap) wrap.classList.remove('active');
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

        // Lake Forest sendout banner sits above the first pathologist row.
        // Only shown for in-month days so out-of-month padding cells stay clean.
        if (inMonth && isLfSendoutDay(date)) {
            rows += `<div class="wd-row lf-sendout" title="Lake Forest sendout">
            <span class="lf-label">Lake Forest sendout</span>
          </div>`;
        }

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
            } else if (a.type === 'off_site') {
                const cbg = pathBgColor(p.color);
                rows += `<div class="wd-row off-site" style="--c:${p.color}; --sc:var(${a.service.cssVar})${cbg ? `; --c-bg:${cbg}` : ''}" title="${p.name} — ${a.service.name}${a.onCall ? ' · On call' : ''}">
            <span class="pid">${p.initials}</span>
            <span class="svc"><span class="swatch"></span>${a.service.short}</span>
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

    // Lake Forest sendout banner — sits above the first pathologist row.
    const lfActive = isLfSendoutDay(date);
    let lfRowHtml = '';
    if (lfActive) {
        lfRowHtml = `<div class="day-detail-row lf-row" title="Lake Forest sendout">
          <div class="ddot"></div>
          <div class="dname">Lake Forest sendout</div>
          <div class="dservice">Lake Forest sendout</div>
        </div>`;
    }

    rows.innerHTML = lfRowHtml + pathologists.map(p => {
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
        if (a.type === 'off_site') {
            const cbg = pathBgColor(p.color);
            return `<div class="day-detail-row${adminCls}"${adminAttrs} style="--c:${p.color}; --sc:var(${a.service.cssVar})${cbg ? `; --c-bg:${cbg}` : ''}">
          <div class="ddot"></div>
          <div class="dname">${p.name}</div>
          <div class="dservice"><span class="swatch"></span>${a.service.name}</div>
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

    // Lake Forest sendout button — admin-only.  Label flips based on whether
    // the row is already showing for this date so a single button manages both
    // adding and removing.
    const lfBtn = document.getElementById('dayAddLfSendout');
    if (lfBtn) {
        if (admin) {
            lfBtn.style.display = '';
            lfBtn.textContent = lfActive ? 'Remove Lake Forest' : 'Add Lake Forest';
        } else {
            lfBtn.style.display = 'none';
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
                        // ── Change log ──
                        if (oldVac) {
                            logChange(Object.assign({
                                kind: 'pto',
                                type: 'pto_edit',
                                forPathId: oldVac.pathologistId,
                                oldStartDate: fmt(oldVac.start),
                                oldEndDate: fmt(oldVac.end),
                                startDate: newStart,
                                endDate: newEnd,
                            }, _chgSummaryPtoEdit(
                                oldVac.pathologistId,
                                fmt(oldVac.start), fmt(oldVac.end),
                                newStart, newEnd
                            )));
                        }
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
                        // ── Change log ──
                        if (vac) {
                            logChange(Object.assign({
                                kind: 'pto',
                                type: 'pto_remove',
                                forPathId: vac.pathologistId,
                                startDate: fmt(vac.start),
                                endDate: fmt(vac.end),
                            }, _chgSummaryPtoRemove(vac.pathologistId, fmt(vac.start), fmt(vac.end))));
                        }
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

            } else if (atype === 'service' || atype === 'off_site') {
                const dayAssign = getDayAssignments(date);
                const currentSvc = dayAssign[pid]?.service;
                const allOptions = [...SERVICES, COMBO_SVC, ...OFF_SERVICES];
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

                    // Skip if the value didn't actually change. Without this
                    // check, clicking Save without editing would still create
                    // an override + pin, freezing the path against future
                    // natural-rotation adjustments for no reason.
                    const initialVal = currentSvc ? currentSvc.id : '';
                    if (newVal === initialVal) {
                        closePanel();
                        openDayDetail(date);
                        return;
                    }

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
                    const allOptions = [...SERVICES, COMBO_SVC, ...OFF_SERVICES];
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
document.getElementById('dayAddLfSendout').addEventListener('click', () => {
    document.getElementById('dayModalBack').classList.remove('open');
    openLfModal(activeDayDate);
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
                // ── Change log ──
                if (vac) {
                    logChange(Object.assign({
                        kind: 'pto',
                        type: 'pto_remove',
                        forPathId: vac.pathologistId,
                        startDate: fmt(vac.start),
                        endDate: fmt(vac.end),
                    }, _chgSummaryPtoRemove(vac.pathologistId, fmt(vac.start), fmt(vac.end))));
                }
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
        // ── Change log ──
        logChange(Object.assign({
            kind: 'pto',
            type: 'pto_add',
            forPathId: pid,
            startDate: fmt(s),
            endDate: fmt(e),
        }, _chgSummaryPtoAdd(pid, fmt(s), fmt(e))));

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
        // ── Change log ──
        logChange(Object.assign({
            kind: 'oncall',
            type: 'oncall_set',
            forPathId: pid,
            date: activeOcDayKey,
            scope: scope,
        }, _chgSummaryOnCallSet(pid, activeOcDayKey, scope)));

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
    // ── Change log ──
    logChange(Object.assign({
        kind: 'oncall',
        type: 'oncall_clear',
        date: activeOcDayKey,
        scope: scope,
    }, _chgSummaryOnCallClear(activeOcDayKey, scope)));

    document.getElementById('ocModalBack').classList.remove('open');
});

// ────────────── LAKE FOREST SENDOUT MODAL ──────────────
// Admin-only.  Lets an admin flag a single day or a full call cycle as a
// "Lake Forest sendout" day.  Storage:
//   scheduler/lfSendoutDays/<YYYY-MM-DD>     → true
//   scheduler/lfSendoutWeeks/<call-cycle-start YYYY-MM-DD> → true
// When either flag is set the calendar renders an "LF sendout" row above the
// first pathologist row for that day.
let activeLfDate = null;
let activeLfDayKey = null;
let activeLfWeekKey = null;

function _lfDayFlag(date) {
    return !!lfSendoutDays[fmt(date)];
}
function _lfWeekFlag(date) {
    return !!lfSendoutWeeks[fmt(getCallCycleStart(date))];
}

function _refreshLfModalUi() {
    const scope = document.querySelector('input[name="lfScope"]:checked').value;
    const cs = getCallCycleStart(activeLfDate);
    const ce = getCallCycleEnd(cs);
    const subEl = document.getElementById('lfModalSub');
    if (scope === 'day') {
        subEl.textContent =
            `${DOW[activeLfDate.getDay()]}, ${MONTHS_SHORT[activeLfDate.getMonth()]} ${activeLfDate.getDate()}, ${activeLfDate.getFullYear()}`;
    } else {
        subEl.textContent =
            `Full call block: ${MONTHS_SHORT[cs.getMonth()]} ${cs.getDate()} – ${MONTHS_SHORT[ce.getMonth()]} ${ce.getDate()}, ${ce.getFullYear()}`;
    }

    // Status text + Save/Remove visibility reflect the current state for
    // whichever scope the admin has selected.
    const statusEl = document.getElementById('lfStatus');
    const saveBtn = document.getElementById('lfSave');
    const removeBtn = document.getElementById('lfRemove');
    const dayOn = _lfDayFlag(activeLfDate);
    const weekOn = _lfWeekFlag(activeLfDate);

    if (scope === 'day') {
        if (dayOn) {
            statusEl.textContent = 'This day is currently flagged as a Lake Forest sendout day.';
            statusEl.style.background = 'var(--accent-soft)';
            statusEl.style.color = 'var(--ink-2)';
            saveBtn.style.display = 'none';
            removeBtn.style.display = '';
            removeBtn.textContent = 'Remove from this day';
        } else if (weekOn) {
            statusEl.textContent = 'The full call week is already flagged. Switch to "Full week" scope to remove it.';
            statusEl.style.background = 'var(--accent-soft)';
            statusEl.style.color = 'var(--ink-2)';
            saveBtn.style.display = 'none';
            removeBtn.style.display = 'none';
        } else {
            statusEl.textContent = 'Not currently flagged. Add Lake Forest sendout for this day only.';
            statusEl.style.background = 'var(--bg-2)';
            statusEl.style.color = 'var(--ink-2)';
            saveBtn.style.display = '';
            saveBtn.textContent = 'Add for this day';
            removeBtn.style.display = 'none';
        }
    } else {
        // Week scope
        if (weekOn) {
            statusEl.textContent = 'The full call week is currently flagged as a Lake Forest sendout week.';
            statusEl.style.background = 'var(--accent-soft)';
            statusEl.style.color = 'var(--ink-2)';
            saveBtn.style.display = 'none';
            removeBtn.style.display = '';
            removeBtn.textContent = 'Remove from full week';
        } else {
            const dayPart = dayOn ? ' (this day-only flag will be cleared in favor of the week flag)' : '';
            statusEl.textContent = `Not currently flagged for the full week. Add Lake Forest sendout to every day in the call cycle${dayPart}.`;
            statusEl.style.background = 'var(--bg-2)';
            statusEl.style.color = 'var(--ink-2)';
            saveBtn.style.display = '';
            saveBtn.textContent = 'Add for full week';
            removeBtn.style.display = 'none';
        }
    }
}

function openLfModal(date) {
    if (!isAdmin()) return; // Belt-and-suspenders — button is also hidden.
    activeLfDate = date;
    activeLfDayKey = fmt(date);
    activeLfWeekKey = fmt(getCallCycleStart(date));

    // Default scope: day-only.
    document.getElementById('lfScopeDay').checked = true;

    // Title stays neutral; the status box explains what each button will do.
    document.getElementById('lfModalTitle').textContent = 'Lake Forest sendout';

    _refreshLfModalUi();
    document.getElementById('lfModalBack').classList.add('open');
}

document.querySelectorAll('input[name="lfScope"]').forEach(radio => {
    radio.addEventListener('change', _refreshLfModalUi);
});

document.getElementById('lfCancel').addEventListener('click', () => {
    document.getElementById('lfModalBack').classList.remove('open');
});
document.getElementById('lfModalBack').addEventListener('click', e => {
    if (e.target.id === 'lfModalBack') e.target.classList.remove('open');
});

// Helper: clear all per-day LF flags within the active call cycle. Called
// after a week-scope add so day flags can't silently shadow it.
async function _clearLfDayFlagsForCycle() {
    const cs = getCallCycleStart(activeLfDate);
    const ce = getCallCycleEnd(cs);
    const writes = {};
    for (let d = new Date(cs); d.getTime() <= ce.getTime(); d = addDays(d, 1)) {
        const dk = fmt(d);
        if (lfSendoutDays[dk] !== undefined) {
            writes['scheduler/lfSendoutDays/' + dk] = null;
        }
    }
    if (Object.keys(writes).length > 0) {
        await db.ref().update(writes);
    }
}

document.getElementById('lfSave').addEventListener('click', async () => {
    if (!isAdmin()) return;
    const scope = document.querySelector('input[name="lfScope"]:checked').value;
    if (scope === 'day') {
        await db.ref('scheduler/lfSendoutDays/' + activeLfDayKey).set(true);
    } else {
        await db.ref('scheduler/lfSendoutWeeks/' + activeLfWeekKey).set(true);
        await _clearLfDayFlagsForCycle();
    }
    try {
        logChange(Object.assign({
            kind: 'lf_sendout',
            type: 'lf_set',
            date: activeLfDayKey,
            scope: scope,
        }, _chgSummaryLfSet(activeLfDayKey, scope)));
    } catch (e) {
        console.error('logChange (lf_set) error:', e);
    }
    document.getElementById('lfModalBack').classList.remove('open');
});

document.getElementById('lfRemove').addEventListener('click', async () => {
    if (!isAdmin()) return;
    const scope = document.querySelector('input[name="lfScope"]:checked').value;
    if (scope === 'day') {
        await db.ref('scheduler/lfSendoutDays/' + activeLfDayKey).remove();
    } else {
        await db.ref('scheduler/lfSendoutWeeks/' + activeLfWeekKey).remove();
        // Also clear any day-level flags inside the cycle so the cycle fully
        // reverts to "no LF sendout" without leftover crumbs.
        await _clearLfDayFlagsForCycle();
    }
    try {
        logChange(Object.assign({
            kind: 'lf_sendout',
            type: 'lf_clear',
            date: activeLfDayKey,
            scope: scope,
        }, _chgSummaryLfClear(activeLfDayKey, scope)));
    } catch (e) {
        console.error('logChange (lf_clear) error:', e);
    }
    document.getElementById('lfModalBack').classList.remove('open');
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
    const d = activeSvcDate;
    if (!d) return;
    const subEl = document.getElementById('svcModalSub');
    subEl.textContent =
        `${DOW[d.getDay()]}, ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}. Assigning a service to a PTO or Off Service pathologist overrides their absence for that day.`;
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
        // PTO and off_site rows are now editable: a regular service override
        // brings a PTO pathologist back on duty; selecting "— No service —"
        // clears any override and restores their PTO/off-site status.
        const currentId = (a.type === 'service' || a.type === 'off_site')
            ? (a.service ? a.service.id : '')
            : '';
        const allOptions = [...SERVICES, COMBO_SVC, ...OFF_SERVICES];
        const opts = allOptions.map(s =>
            `<option value="${s.id}" ${s.id === currentId ? 'selected' : ''}>${s.name}</option>`
        ).join('');
        const noneOpt = `<option value="" ${currentId === '' ? 'selected' : ''}>— No service —</option>`;
        // data-initial captures the displayed value at modal-open time so the
        // save handler can tell which selects the admin actually changed.
        // Only changed selects become recompute pins — otherwise every
        // pre-filled dropdown would pin its path and overconstrain the
        // optimizer (e.g., two paths pinned to Huntley, one because the admin
        // chose it, one because the dropdown was already showing Huntley).
        return `<label style="margin-top:10px;">${p.name}${a.type === 'pto' ? ' <span style="font-size:11px;color:var(--ink-3);">(PTO)</span>' : a.type === 'off_site' ? ' <span style="font-size:11px;color:var(--ink-3);">(Off Site)</span>' : ''}</label>
        <select data-pid="${p.id}" data-initial="${currentId}">${noneOpt}${opts}</select>`;
    }).join('');
    document.getElementById('svcModalBack').classList.add('open');
}

document.getElementById('svcCancel').addEventListener('click', () => {
    document.getElementById('svcModalBack').classList.remove('open');
});
document.getElementById('svcModalBack').addEventListener('click', e => {
    if (e.target.id === 'svcModalBack') e.target.classList.remove('open');
});
document.getElementById('svcSave').addEventListener('click', async () => {
    const selects = document.querySelectorAll('#svcAssignments select[data-pid]');
    const scope = 'day';

    if (isAdmin()) {
        // Build {pid: serviceId} map of all the slots the admin ACTUALLY
        // changed. Each select has data-initial set to its value at modal-
        // open time; we ignore selects that match their initial value, since
        // those are unchanged dropdowns the admin never touched.
        //
        // Without this filter, every pre-filled dropdown would be sent as
        // a pin to the recompute, overconstraining the optimizer. Example:
        // admin changes B to Huntley, but C was already showing Huntley
        // naturally — submitting would pin BOTH B and C to Huntley, leaving
        // the day with two Huntleys and no Bigs.
        const update = {};
        const cleared = new Set();
        selects.forEach(s => {
            const initial = s.dataset.initial || '';
            const current = s.value || '';
            if (current === initial) return;   // unchanged — leave overrides alone
            if (current) {
                update[s.dataset.pid] = current;
            } else {
                // Was something, now "— No service —" — explicit clear
                cleared.add(String(s.dataset.pid));
            }
        });

        // Track what we just saved so the recompute prompt can use the new
        // values as locks regardless of whether the Firebase listener has
        // fired yet.
        let recomputeFromDate = null;
        const recomputePins = {};

        if (scope === 'day') {
            // Merge: start from existing overrides, apply changes, remove cleared.
            const merged = Object.assign({}, serviceOverrides[activeSvcDayKey] || {});
            Object.assign(merged, update);
            cleared.forEach(pid => { delete merged[pid]; });

            if (Object.keys(merged).length === 0) {
                await db.ref('scheduler/serviceOverrides/' + activeSvcDayKey).remove();
            } else {
                await db.ref('scheduler/serviceOverrides/' + activeSvcDayKey).set(merged);
            }
            // Pin only the just-changed paths for the recompute
            recomputePins[activeSvcDayKey] = Object.assign({}, update);
            recomputeFromDate = activeSvcDate;
        } else {
            // Full call week: merge into every workday in the cycle.
            const days = workdaysInCallCycle(activeSvcDate);
            const writes = {};
            days.forEach(d => {
                const dKey = fmt(d);
                const existing = Object.assign({}, serviceOverrides[dKey] || {});
                // Apply new values and remove explicit clears
                Object.assign(existing, update);
                cleared.forEach(pid => { delete existing[pid]; });
                if (Object.keys(existing).length === 0) {
                    writes['scheduler/serviceOverrides/' + dKey] = null;
                } else {
                    writes['scheduler/serviceOverrides/' + dKey] = existing;
                }
                recomputePins[dKey] = Object.assign({}, update);
            });
            if (Object.keys(writes).length > 0) {
                await db.ref().update(writes);
            }
            if (days.length > 0) recomputeFromDate = days[0];
        }

        // ── Change log ──
        // Build human-readable lines summarizing what changed: each
        // affected pathologist gets one line "Dr. X → Cyto/Gross" or
        // "Dr. X → cleared". Skip if nothing actually changed.
        const lines = [];
        Object.entries(update).forEach(([pid, sid]) => {
            lines.push(`${_chgShortName(parseInt(pid, 10))} → ${_chgServiceName(sid)}`);
        });
        cleared.forEach(pid => {
            lines.push(`${_chgShortName(parseInt(pid, 10))} → cleared`);
        });
        if (lines.length > 0) {
            logChange(Object.assign({
                kind: 'service',
                type: 'service_set',
                date: activeSvcDayKey,
                scope: scope,
                assignments: update,
                cleared: Array.from(cleared),
            }, _chgSummaryServiceBulk(activeSvcDayKey, scope, lines)));
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
    const scope = 'day';
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
    // ── Change log ──
    logChange(Object.assign({
        kind: 'service',
        type: 'service_reset',
        date: activeSvcDayKey,
        scope: scope,
    }, _chgSummaryServiceReset(activeSvcDayKey, scope)));

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
function renderMain() {
    renderPeriodLabel();
    if (view === 'day') renderDay();
    else if (view === 'week') renderWeek();
    else if (view === 'month') renderMonth();
    else if (view === 'year') renderYear();
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
    // Mirror to the mobile view select so the two surfaces stay in sync
    // (e.g. if a desktop tab is clicked programmatically or the user
    // crosses the breakpoint after picking a view).
    const mobileViewSel = document.getElementById('mobileViewSelect');
    if (mobileViewSel) mobileViewSel.value = view;
    renderMain();
});

document.getElementById('prevBtn').addEventListener('click', () => {
    if (view === 'day') cursor = addDays(cursor, -1);
    else if (view === 'week') cursor = addDays(cursor, -7);
    else if (view === 'month') cursor = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1);
    else cursor = new Date(cursor.getFullYear() - 1, cursor.getMonth(), 1);
    renderMain();
});
document.getElementById('nextBtn').addEventListener('click', () => {
    if (view === 'day') cursor = addDays(cursor, 1);
    else if (view === 'week') cursor = addDays(cursor, 7);
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

// ── Mobile dropdown handlers ─────────────────────────────────────────
// On phones the .path-tabs / .view-tabs button groups are hidden and
// replaced by these compact <select>s in the toolbar. We delegate to the
// existing tab buttons via .click() so the canonical logic (active class,
// state updates, mirror sync) runs from a single code path.
const mobileViewSel = document.getElementById('mobileViewSelect');
if (mobileViewSel) {
    mobileViewSel.addEventListener('change', e => {
        const want = e.target.value;
        const tab = document.querySelector(`.view-tab[data-view="${want}"]`);
        if (tab) tab.click();
    });
    // Initial sync — pick up whatever 'view' the page booted with.
    mobileViewSel.value = view;
}

const mobilePathSel = document.getElementById('mobilePathSelect');
if (mobilePathSel) {
    mobilePathSel.addEventListener('change', e => {
        const want = e.target.value; // 'all' | 'me'
        const filter = want === 'me' && loggedInPathId !== null
            ? String(loggedInPathId)
            : 'all';
        setPathFilter(filter);
        renderMain();
    });
}

// ── Swipe navigation (mobile only) ───────────────────────────────────
// Listens on #main (which persists across re-renders). Tracks horizontal
// gestures live — the previous/next periods are pre-rendered as snapshots
// flush to either side of #main, and all three translate together with the
// finger so the user sees the adjacent period swiping in as they drag.
// On a qualifying swipe the band continues to its committed position; on
// an aborted drag everything snaps back.
//
// Architecture: #main and its two neighbor snapshots all live as siblings
// in the same .content-area (which already clips with overflow:hidden).
// The toolbar sits above #main and is unaffected.
(function setupSwipeNavigation() {
    const mainEl = document.getElementById('main');
    if (!mainEl) return;

    let startX = 0, startY = 0, startTime = 0;
    let tracking = false, dragging = false;
    let isAnimating = false;

    // Neighbor snapshots built on first confirmed horizontal move and
    // torn down at the end of every gesture (commit or abort).
    let prevSnap = null, nextSnap = null;
    let snapWidth = 0;

    const MIN_DISTANCE_PX = 60;   // horizontal travel required to count as a swipe
    const MAX_VERTICAL_PX  = 60;  // vertical drift allowed (keeps scroll gestures intact)
    const MAX_DURATION_MS  = 600; // flicks only — long slow drags are probably scrolling
    const ANIM_MS          = 280; // slide-in / slide-out duration

    // Compute the cursor value for the period `delta` steps from the
    // current one (+1 = next, -1 = prev). Mirrors the prev/next button
    // handlers so swipes and buttons stay perfectly aligned.
    function cursorFor(delta) {
        if (view === 'day')        return addDays(cursor, delta);
        else if (view === 'week')  return addDays(cursor, 7 * delta);
        else if (view === 'month') return new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1);
        else                       return new Date(cursor.getFullYear() + delta, cursor.getMonth(), 1);
    }

    // Render-and-clone helper: temporarily swaps `cursor` to render a
    // neighbor period into #main, clones the result, then leaves cursor
    // mutated (caller restores via a final render). Side effects on
    // elements outside #main (e.g. the period label updated by
    // renderPeriodLabel) flicker through neighbor values within this
    // sync block, but the browser doesn't paint until JS yields, so
    // they're invisible — only the caller's final restore render shows.
    function snapshotPeriod(periodCursor) {
        cursor = periodCursor;
        renderMain();
        const clone = mainEl.cloneNode(true);
        clone.setAttribute('aria-hidden', 'true');
        return clone;
    }

    // Build prev + next snapshots flush to either side of #main. Called
    // once per gesture, the moment the drag is confirmed horizontal.
    // Costs 3 renderMain() calls (prev, next, restore) — fine because
    // it only runs after the 8px horizontal dead zone is crossed, so
    // pure taps and vertical scrolls don't pay for it.
    function buildNeighbors() {
        const w      = mainEl.offsetWidth || window.innerWidth;
        const parent = mainEl.offsetParent || mainEl.parentElement;
        const top    = mainEl.offsetTop;
        const left   = mainEl.offsetLeft;
        const height = mainEl.offsetHeight;
        snapWidth = w;

        const savedCursor = cursor;
        prevSnap = snapshotPeriod(cursorFor(-1));
        nextSnap = snapshotPeriod(cursorFor(+1));
        cursor = savedCursor;
        renderMain(); // restore #main to the current period

        function styleSnap(snap, tx) {
            snap.style.cssText = [
                'position:absolute',
                'top:'    + top    + 'px',
                'left:'   + left   + 'px',
                'width:'  + w      + 'px',
                'height:' + height + 'px',
                'transform:translateX(' + tx + 'px)',
                'transition:none',
                'z-index:5',
                'pointer-events:none',
                'overflow:hidden',
            ].join(';');
        }
        styleSnap(prevSnap, -w);
        styleSnap(nextSnap,  w);
        parent.appendChild(prevSnap);
        parent.appendChild(nextSnap);
    }

    function clearNeighbors() {
        if (prevSnap) { prevSnap.remove(); prevSnap = null; }
        if (nextSnap) { nextSnap.remove(); nextSnap = null; }
    }

    // Translate #main and both neighbors together so the band moves as
    // one rigid unit — main at dx, prev at -w+dx, next at +w+dx.
    function moveAll(dx) {
        mainEl.style.transform = 'translateX(' + dx + 'px)';
        if (prevSnap) prevSnap.style.transform = 'translateX(' + (-snapWidth + dx) + 'px)';
        if (nextSnap) nextSnap.style.transform = 'translateX(' + ( snapWidth + dx) + 'px)';
    }

    function setTransitionAll(t) {
        mainEl.style.transition = t;
        if (prevSnap) prevSnap.style.transition = t;
        if (nextSnap) nextSnap.style.transition = t;
    }

    // Run `cb` once the current transform transition on #main ends, with
    // a setTimeout fallback in case transitionend doesn't fire (e.g. the
    // start and end values turned out identical, or the tab was hidden).
    function whenTransformDone(durationMs, cb) {
        let done = false;
        function finish() {
            if (done) return;
            done = true;
            mainEl.removeEventListener('transitionend', onTransition);
            cb();
        }
        function onTransition(e) {
            if (e.propertyName !== 'transform') return;
            finish();
        }
        mainEl.addEventListener('transitionend', onTransition);
        setTimeout(finish, durationMs + 60);
    }

    // Commit: the relevant neighbor slides into the center, #main slides
    // off in the swipe direction, the other neighbor slides further off.
    // When the animation ends, we update `cursor`, re-render #main with
    // the new period, snap its transform back to 0, and remove both
    // snapshots. Because snapshots have z-index:5 and #main doesn't,
    // the now-centered neighbor masks #main during the swap — no flash.
    function commitAnimation(goNext, finalDx) {
        isAnimating = true;
        const w = snapWidth;
        const targetDx = goNext ? -w : w;
        const timing = 'transform ' + ANIM_MS + 'ms ease-out';

        // First make sure the pre-transition transform is the live drag
        // position so the browser interpolates from there, not from 0.
        moveAll(finalDx);

        // Double-rAF: let the browser commit the starting transform,
        // then turn on the transition and set the ending transform.
        requestAnimationFrame(function() {
            requestAnimationFrame(function() {
                setTransitionAll(timing);
                moveAll(targetDx);

                whenTransformDone(ANIM_MS, function() {
                    cursor = cursorFor(goNext ? 1 : -1);
                    renderMain();
                    // Reset #main without animating back through 0.
                    mainEl.style.transition = 'none';
                    mainEl.style.transform  = '';
                    // Force the no-transition state to commit before the
                    // next style change so the next gesture starts clean.
                    void mainEl.offsetHeight;
                    mainEl.style.transition = '';
                    clearNeighbors();
                    isAnimating = false;
                });
            });
        });
    }

    // Abort: slide everything back to baseline (#main → 0, neighbors → ±w),
    // then remove the snapshots.
    function snapBack(finalDx) {
        isAnimating = true;
        const timing = 'transform 200ms ease';

        // Ensure we transition from the live drag position.
        moveAll(finalDx);

        requestAnimationFrame(function() {
            requestAnimationFrame(function() {
                setTransitionAll(timing);
                moveAll(0);

                whenTransformDone(200, function() {
                    mainEl.style.transition = '';
                    mainEl.style.transform  = '';
                    clearNeighbors();
                    isAnimating = false;
                });
            });
        });
    }

    // ── Touch listeners ──────────────────────────────────────────────────

    mainEl.addEventListener('touchstart', (e) => {
        if (!isMobileViewport()) return;
        if (isAnimating) return;
        if (e.touches.length !== 1) { tracking = false; return; }
        const t = e.touches[0];
        startX    = t.clientX;
        startY    = t.clientY;
        startTime = Date.now();
        tracking  = true;
        dragging  = false;
        // Kill any residual transition so the live-drag is instant.
        mainEl.style.transition = 'none';
        mainEl.style.transform  = '';
    }, { passive: true });

    // passive:false so we can preventDefault() once the gesture is confirmed
    // horizontal — this keeps native vertical scroll working for vertical-only
    // gestures while letting us own the horizontal ones.
    mainEl.addEventListener('touchmove', (e) => {
        if (!tracking) return;
        const t  = e.touches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;

        if (!dragging) {
            // Wait until the finger has moved enough to determine intent.
            if (Math.abs(dx) <= 8 && Math.abs(dy) <= 8) return;
            if (Math.abs(dy) >= Math.abs(dx)) {
                // Predominantly vertical — let native scroll handle it.
                tracking = false;
                return;
            }
            dragging = true;
            // Build the neighbor previews now that we know it's a swipe.
            // Synchronous and costs ~3 renderMain calls — one possible
            // hitched frame at the very start of the drag, then smooth.
            buildNeighbors();
        }

        // Confirmed horizontal drag: move the whole band with the finger
        // and suppress native scroll.
        e.preventDefault();
        moveAll(dx);
    }, { passive: false });

    mainEl.addEventListener('touchend', (e) => {
        if (!tracking) return;
        tracking = false;
        if (!dragging) return;
        dragging = false;

        const elapsed = Date.now() - startTime;
        const t  = e.changedTouches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;

        if (
            elapsed > MAX_DURATION_MS ||
            Math.abs(dx) < MIN_DISTANCE_PX ||
            Math.abs(dy) > MAX_VERTICAL_PX
        ) {
            snapBack(dx);
            return;
        }

        // Valid swipe — commit. swipe left → next; swipe right → prev.
        commitAnimation(dx < 0, dx);
    }, { passive: true });

    mainEl.addEventListener('touchcancel', (e) => {
        if (dragging) {
            // Use last-known dx if available, else 0.
            const t = (e.changedTouches && e.changedTouches[0]) || null;
            const dx = t ? (t.clientX - startX) : 0;
            snapBack(dx);
        }
        tracking = false;
        dragging = false;
    }, { passive: true });
})();

// Viewport-aware view fallback: the Day tab is mobile-only (hidden on
// desktop via CSS), so if the window crosses the mobile breakpoint while
// Day view is active we swap to Week so the user isn't stranded on a tab
// they can no longer see. We don't auto-switch the other direction
// (desktop → mobile keeps the current view, e.g. week) — that respects
// user intent if they deliberately picked Week mid-session. The initial
// "mobile gets Day" override only fires on first load.
let _wasMobileViewport = isMobileViewport();
window.addEventListener('resize', () => {
    const nowMobile = isMobileViewport();
    if (_wasMobileViewport === nowMobile) return; // no breakpoint crossing
    _wasMobileViewport = nowMobile;
    if (!nowMobile && view === 'day') {
        // Resized up to desktop while in Day view — fall back to Week so
        // the user has a visible active tab.
        view = 'week';
        document.querySelectorAll('.view-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.view === view);
        });
        const mobileViewSel = document.getElementById('mobileViewSelect');
        if (mobileViewSel) mobileViewSel.value = view;
        renderMain();
    }
});

// ────────────── MOBILE HAMBURGER MENU ──────────────
// On phones, Manage PTO / Requests / Export to Outlook live in a dropdown
// behind a hamburger icon to free up vertical real estate. The menu items
// just delegate to the existing sidebar button click handlers so behavior
// stays in lock-step between the two surfaces.
(function wireHamburgerMenu() {
    const menuBtn = document.getElementById('menuBtn');
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
        } else if (action === 'recompute') {
            document.getElementById('recomputeBtn').click();
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
    else if (e.key === 'd' || e.key === 'D') document.querySelector('.view-tab[data-view="day"]').click();
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
        case 'off_service': return 'Off Service';
        case 'off_service_director': return 'Off Service – Director Retreat';
        case 'off_service_lab': return 'Off Service – Lab Inspection';
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
            if (!a || (a.type !== 'service' && a.type !== 'off_site') || !a.service) continue;
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

// (recompute code moved to recompute.js)

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
    const btn = document.getElementById('settingsBtn');
    const drawer = document.getElementById('settingsDrawer');
    const twBtn = document.getElementById('toggleWeekdays');
    const tsBtn = document.getElementById('toggleSidebar');

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

    // Default-view segmented control. Note: this only sets the launch
    // default — it does NOT change the current `view`. The user can still
    // switch views in this session via the header view-tabs.
    const defaultViewSeg = document.getElementById('defaultViewSeg');
    if (defaultViewSeg) {
        defaultViewSeg.addEventListener('click', e => {
            const b = e.target.closest('.seg-btn');
            if (!b) return;
            const v = b.dataset.value;
            if (!VALID_DEFAULT_VIEWS.includes(v)) return;
            if (settings.defaultView === v) return;
            settings.defaultView = v;
            saveSettings();
            applySettings();
        });
    }

    // Default-pathologists segmented control. Same caveat: this is just the
    // launch default; the active filter is unchanged by toggling it here.
    const defaultFilterSeg = document.getElementById('defaultFilterSeg');
    if (defaultFilterSeg) {
        defaultFilterSeg.addEventListener('click', e => {
            const b = e.target.closest('.seg-btn');
            if (!b) return;
            const v = b.dataset.value;
            if (!VALID_DEFAULT_FILTERS.includes(v)) return;
            if (settings.defaultPathFilter === v) return;
            settings.defaultPathFilter = v;
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
            showLoginOverlay();   // ← populates the dropdown AND shows the overlay
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
/* ════════════════════════════════════════════════════════════════════════
   ╔══════════════════════════════════════════════════════════════════════╗
   ║                                                                      ║
   ║              REWORKED LAYOUT — page navigation + sidebar             ║
   ║                                                                      ║
   ╚══════════════════════════════════════════════════════════════════════╝

   Adds the new full-height sidebar's page-navigation system. The sidebar
   has three "pages":
       schedule  — the calendar (default; uses existing renderMain logic)
       requests  — placeholder for future content
       tracking  — placeholder for future content
   plus Settings (full main-area page) and Sign out.

   The kebab menu in the toolbar still exposes Manage PTO / Requests modal /
   Export / Recompute, mirroring the previous mobile-only hamburger menu,
   so all existing functionality stays reachable.
   ════════════════════════════════════════════════════════════════════════ */

(function initPageNavigation() {
    const VALID_PAGES = ['schedule', 'requests', 'changes', 'tracking', 'settings'];
    let currentPage = 'schedule';

    const app = document.getElementById('app');
    const navItems = document.querySelectorAll('.page-nav .nav-item, .aside-bottom .nav-item');

    /**
     * Switch which "page" is shown in the content area.
     * - schedule: shows toolbar + main (existing calendar render)
     * - requests/changes/tracking: shows placeholder page-shell
     * - settings: shows full settings page
     */
    function setPage(page) {
        if (!VALID_PAGES.includes(page)) page = 'schedule';
        currentPage = page;

        // Update app data-attribute (CSS hides toolbar/main on non-schedule pages)
        if (app) app.setAttribute('data-page', page);

        // Update active state on sidebar nav items
        document.querySelectorAll('.nav-item[data-page]').forEach(el => {
            el.classList.toggle('active', el.dataset.page === page);
        });

        // Toggle visibility of the page surfaces
        const mainEl = document.getElementById('main');
        const reqPg = document.getElementById('requestsPage');
        const chgPg = document.getElementById('changesPage');
        const trkPg = document.getElementById('trackingPage');
        const settingsPg = document.getElementById('settingsPage');

        if (mainEl) mainEl.hidden = (page !== 'schedule');
        if (reqPg) reqPg.hidden = (page !== 'requests');
        if (chgPg) chgPg.hidden = (page !== 'changes');
        if (trkPg) trkPg.hidden = (page !== 'tracking');
        if (settingsPg) settingsPg.hidden = (page !== 'settings');

        // When switching to schedule, re-render the calendar to make sure the
        // current period/view/data are accurate.
        if (page === 'schedule' && typeof renderMain === 'function') {
            try { renderMain(); } catch (_) { /* ignore */ }
        }

        // When switching to changes, re-render the log (it may have grown
        // while the user was on another page)
        if (page === 'changes' && typeof renderChangesPage === 'function') {
            try { renderChangesPage(); } catch (_) { /* ignore */ }
        }

        // When switching to settings, re-apply settings so toggles reflect
        // current state (in case anything changed since last open).
        if (page === 'settings' && typeof applySettings === 'function') {
            try { applySettings(); } catch (_) { /* ignore */ }
        }

        // Auto-close mobile sidebar on navigation
        closeMobileSidebar();
    }

    // Expose so other code (e.g. login flow) can reset to schedule on sign-in
    window.__setPage = setPage;

    // Wire up nav-item clicks
    navItems.forEach(btn => {
        const targetPage = btn.dataset.page;
        if (!targetPage) return;
        btn.addEventListener('click', () => setPage(targetPage));
    });

    // Initial page = schedule
    if (app) app.setAttribute('data-page', 'schedule');

    // ── Mobile sidebar (slide-out drawer) ─────────────────────────────
    const asideToggleBtn = document.getElementById('asideToggleBtn');
    const sidebarBackdrop = document.getElementById('sidebarBackdrop');

    function openMobileSidebar() {
        if (app) app.classList.add('sidebar-open');
    }
    function closeMobileSidebar() {
        if (app) app.classList.remove('sidebar-open');
    }

    if (asideToggleBtn) {
        asideToggleBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (app && app.classList.contains('sidebar-open')) {
                closeMobileSidebar();
            } else {
                openMobileSidebar();
            }
        });
    }

    if (sidebarBackdrop) {
        sidebarBackdrop.addEventListener('click', closeMobileSidebar);
    }

    // Esc closes mobile sidebar
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && app && app.classList.contains('sidebar-open')) {
            closeMobileSidebar();
        }
    });

    // ── Sidebar sign-out button ───────────────────────────────────────
    const sidebarSignOutBtn = document.getElementById('sidebarSignOutBtn');
    if (sidebarSignOutBtn) {
        sidebarSignOutBtn.addEventListener('click', () => {
            closeMobileSidebar();
            try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch (_) {}
            loggedInPathId = null;
            // Reset to schedule page so re-login lands there
            setPage('schedule');
            if (typeof showLoginOverlay === 'function') showLoginOverlay();
        });
    }

    // ── Mirror the kebab's red-alert-dot onto the mobile hamburger ────
    // The aside hamburger should glow when there are pending requests, so
    // the user knows to open the sidebar/menu even before it's open.
    const asideAlertDot = document.getElementById('asideAlertDot');
    if (asideAlertDot && asideToggleBtn) {
        const menuBtn = document.getElementById('menuBtn');
        if (menuBtn) {
            // Watch for the .has-alert class on menuBtn and mirror it onto
            // the aside toggle button.
            const sync = () => {
                asideToggleBtn.classList.toggle(
                    'has-alert',
                    menuBtn.classList.contains('has-alert')
                );
            };
            const observer = new MutationObserver(sync);
            observer.observe(menuBtn, { attributes: true, attributeFilter: ['class'] });
            sync();
        }
    }
})();

/* ────────────────────────────────────────────────────────────────────
   Make 'T' keyboard shortcut still jump to today when the today button
   is hidden. (The hidden #todayBtn is preserved in HTML for click-through
   purposes, so the existing handler already works — this is a safety net.)
   ──────────────────────────────────────────────────────────────────── */
