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
const auth = firebase.auth();
const analytics = firebase.analytics();

// ────────────── AUTH MAPPING ──────────────
// Firebase Auth accounts use fake emails <local>@scheduler.local, created by
// hand in the console: pathologists → 'p<id>', plus grossroom / kathleen / histology / lakeforest.
const AUTH_EMAIL_DOMAIN = '@scheduler.local';

// Histology is the read-only guest: a fixed credential signs in behind the
// scenes to satisfy '.read: auth != null'. Not a secret — it ships in client
// code — acceptable because histology cannot write.
const HISTOLOGY_PW = 'histology-guest';
// Lake Forest is the same kind of passwordless read-only guest as histology.
const LAKE_FOREST_PW = 'lakeforest-guest';

// Map an app account id (number for pathologists, or one of the string ids)
// to its Firebase Auth email.
function authEmailForId(id) {
    if (id === GROSS_ROOM_ID) return 'grossroom' + AUTH_EMAIL_DOMAIN;
    if (id === MANAGER_ID)    return 'kathleen' + AUTH_EMAIL_DOMAIN;
    if (id === HISTOLOGY_ID)  return 'histology' + AUTH_EMAIL_DOMAIN;
    if (id === LAKE_FOREST_ID) return 'lakeforest' + AUTH_EMAIL_DOMAIN;
    return 'p' + id + AUTH_EMAIL_DOMAIN; // pathologist
}

// Inverse: map a signed-in Auth email back to the app account id used
// throughout the rest of the app (loggedInPathId). Returns null if unknown.
function idForAuthEmail(email) {
    if (!email) return null;
    const local = email.slice(0, email.indexOf('@')).toLowerCase();
    if (local === 'grossroom') return GROSS_ROOM_ID;
    if (local === 'kathleen')  return MANAGER_ID;
    if (local === 'histology') return HISTOLOGY_ID;
    if (local === 'lakeforest') return LAKE_FOREST_ID;
    const m = local.match(/^p(\d+)$/);
    if (m) return parseInt(m[1], 10);
    return null;
}

// ────────────── DEFERRED DATA LISTENERS ──────────────
// Every read requires auth, so listeners registered via regListener() at load
// are only attached by startDataListeners() after sign-in.
const _pendingListeners = [];
let _listenersStarted = false;

// Drop-in replacement for `db.ref(path).on('value', cb, errCb)` that defers
// attachment until startDataListeners() is called.
function regListener(path, cb, errCb) {
    _pendingListeners.push({ path, cb, errCb });
}

function startDataListeners() {
    if (_listenersStarted) return;
    _listenersStarted = true;
    _pendingListeners.forEach(({ path, cb, errCb }) => {
        db.ref(path).on('value', cb, errCb);
    });
}

// Detach all data listeners and reset readiness flags. Called on sign-out so
// a subsequent sign-in (possibly as a different user) starts clean.
function stopDataListeners() {
    if (!_listenersStarted) return;
    _pendingListeners.forEach(({ path }) => {
        try { db.ref(path).off('value'); } catch (_) {}
    });
    _listenersStarted = false;
    pathologistsReady = false;
    vacationsReady = false;
}

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

// ── Freetext / non-standard services ─────────────────────────────────────
// Custom typed-in services are encoded as 'ft:' + text so they flow through
// overrides/locks/recompute unchanged. Like off-site: excluded from the
// coverage rotation, and always LOCKED when added.
const FREETEXT_SERVICE_PREFIX = 'ft:';

function isFreetextServiceId(id) {
    return typeof id === 'string' && id.indexOf(FREETEXT_SERVICE_PREFIX) === 0
        && id.length > FREETEXT_SERVICE_PREFIX.length;
}

// Build a freetext id from admin input: trim, collapse whitespace, cap the
// length. Returns null when nothing usable remains.
function makeFreetextServiceId(text) {
    const clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 40);
    return clean ? FREETEXT_SERVICE_PREFIX + clean : null;
}

// Synthesize a service object for a freetext id, shaped exactly like the
// built-in SERVICES entries so every renderer/consumer works unchanged.
function freetextServiceFor(id) {
    const name = String(id).slice(FREETEXT_SERVICE_PREFIX.length);
    const letters = name.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    return {
        id: id,
        name: name,
        short: name,
        abbr: (letters.slice(0, 3) || 'CST'),
        cssVar: '--svc-freetext',
    };
}

// True for NON-ROTATION assignments (off-site or freetext): excluded from
// the coverage rotation like PTO, but rendered as a service.
function isOffSiteServiceId(id) {
    return OFF_SERVICES.some(s => s.id === id) || isFreetextServiceId(id);
}

// Standard = the four rotation services (+ 2-path combo); anything else is
// non-standard and always locked when assigned.
function isNonStandardServiceId(id) {
    if (!id) return false;
    return isOffSiteServiceId(id);
}

// Special combined state when only 2 pathologists are working
const COMBO_SVC = {
    id: 'cytobigs',
    name: 'McHenry Cyto / Gross / Bigs',
    short: 'M Cyto/Gross/Bigs',
    abbr: 'CGB',
    cssVar: '--svc-cyto' // reusing cyto's color theme
};

const _SERVICE_BY_ID_BASE = Object.fromEntries(SERVICES.map(s => [s.id, s]));
_SERVICE_BY_ID_BASE['cytobigs'] = COMBO_SVC; // Register the combo service
OFF_SERVICES.forEach(s => { _SERVICE_BY_ID_BASE[s.id] = s; }); // Register off-site services

// Proxy so freetext ids resolve everywhere a built-in id would, without
// touching call sites.
const SERVICE_BY_ID = new Proxy(_SERVICE_BY_ID_BASE, {
    get(target, key) {
        if (key in target) return target[key];
        if (typeof key === 'string' && isFreetextServiceId(key)) {
            return freetextServiceFor(key);
        }
        return undefined;
    },
    has(target, key) {
        return (key in target)
            || (typeof key === 'string' && isFreetextServiceId(key));
    },
});

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

// Approved-and-locked service assignments; recompute treats these as hard
// pins. Cleared on admin edit/clear, conflicting PTO approval, or revocation.
//   serviceLocks → { dayKey: { pathId: serviceId } }
let serviceLocks = {};

// Per-fiscal-year PTO allotments (working days); years without an entry fall
// back to the legacy `vacationAllotted` default. Read via ptoAllotmentFor().
//   ptoAllotments → { startYear: { pathId: workingDays } }
let ptoAllotments = {};

// Lake Forest sendout flags. When set, an "LF sendout" row is rendered above
// the first pathologist on the matching day(s).
//   lfSendoutDays  → { 'YYYY-MM-DD': true }     individual day
//   lfSendoutWeeks → { 'YYYY-MM-DD': true }     keyed by call-cycle start
let lfSendoutDays = {};
let lfSendoutWeeks = {};

// Gross-room PTO flags: display-only "Natalie PTO" banner on the procedure
// grid; no effect on rotation/coverage/allotments.
//   nataliePtoDays → { 'YYYY-MM-DD': true }
let nataliePtoDays = {};

// Procedures: hourly schedule independent of the rotation. Shape:
// { 'YYYY-MM-DD': { pushKey: { time:'HH:MM', type:'procedure', createdAt,
// createdBy } } } — `type` stored for future variants.
let procedures = {};

let pathologistsReady = false;
let vacationsReady = false;
let currentPathFilter = 'all';

// ────────────── HOURLY GRID CONFIG ──────────────
// Half-hour slots from HOURS_START:00 through HOURS_END:30 inclusive.
// Default: 7 AM start, last slot 4:30 PM (covers 7:00–17:00 in half-hour steps).
const HOURS_START = 7;   // 7 AM
const HOURS_END = 16;  // last hour shown (so last slot is HOURS_END:30 = 4:30 PM)

// Procedure types for the "Add procedure" modal; pills render as
// "<location> - <name>".
const PROCEDURE_TYPES = [
    'EUS',
    'EBUS',
    'IR Thyroid bx',
    'IR Thyroid w/ Afirma',
    'IR Parotid bx',
    'CT Random Kidney bx',
    'CT Bone Marrow',
    'Lymph Node bx',
    'CT lung bx',
    'Lumpectomy',
    'Mastectomy',
    'FS Brain',
    'FS Lung',
    'FS Parathyroid',   
];

// Expandable parents: chevron reveals variant sub-options; the chosen
// variant string is stored verbatim as procedureName (inherits the base colour).
const PROCEDURE_VARIANTS = {
    'EUS': ['EUS/ERCP'],
    'EBUS': ['EBUS/ION'],
    'IR Thyroid bx': ['IR Thyroid bx x2', 'IR Thyroid bx x3'],
    'IR Thyroid w/ Afirma': ['IR Thyroid w/ Afirma x2', 'IR Thyroid w/ Afirma x3'],
    'Lumpectomy': ['Excisional bx'],
    'Mastectomy': ['Bilateral Mastectomy'],
};

const PROCEDURE_LOCATIONS = ['HH', 'MH'];

// ────────────── ADMIN / REQUESTS ──────────────
// Admin identified by name (robust across id reseeds).
const ADMIN_NAME_RE = /Michael\s+Moravek/i;
// Special non-pathologist user that can only edit the procedure schedule
const GROSS_ROOM_ID = 'gross_room';
// Conference-tracker manager: can view the full schedule and edit the
// conference tracking page, but cannot manage pathologist assignments or PTO.
const MANAGER_ID = 'kathleen';
// Read-only histology guest: full view, zero edit privileges, no password.
const HISTOLOGY_ID = 'histology';
// Read-only Lake Forest guest: sees only LF sendout days, no password.
const LAKE_FOREST_ID = 'lakeforest';
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

// True when histology is signed in — every editing affordance must be
// hidden or short-circuited.
function isHistology() {
    return loggedInPathId === HISTOLOGY_ID;
}

function isLakeForest() {
    return loggedInPathId === LAKE_FOREST_ID;
}

// Read-only guest accounts: full UI lockdown (histology sees everything,
// Lake Forest additionally sees only LF sendout days via body.lf-guest CSS).
function isReadOnlyGuest() {
    return isHistology() || isLakeForest();
}

// Update the path-tab toggle to reflect val ('all' or a stringified pathId)
function setPathFilter(val) {
    currentPathFilter = val;
    document.querySelectorAll('.path-tab').forEach(btn => {
        const wantsAll = btn.dataset.filter === 'all';
        btn.classList.toggle('active', wantsAll ? val === 'all' : val !== 'all');
    });
    // Mirror to the mobile select ('all'/'me'; any non-'all' filter shows as 'me').
    const mobileSel = document.getElementById('mobilePathSelect');
    if (mobileSel) mobileSel.value = (val === 'all') ? 'all' : 'me';
}
let view;                             // 'day' | 'week' | 'month' | 'year' — assigned after settings load below
let today;
let cursor;

// Phone-sized viewport? Kept in sync with the CSS 800px breakpoint; drives
// initial Day view + the resize fallback.
const MOBILE_BREAKPOINT_PX = 800;
function isMobileViewport() {
    return typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT_PX;
}

// ────────────── DISPLAY SETTINGS ──────────────
// Persisted in localStorage so preferences survive page refreshes.
const SETTINGS_STORAGE_KEY = 'schedDisplaySettings';
const VALID_DEFAULT_VIEWS = ['day', 'week', 'month', 'year'];
// Lake Forest guest picks from the desktop views only (their sole setting).
const VALID_LF_DEFAULT_VIEWS = ['week', 'month', 'year'];
const VALID_DEFAULT_FILTERS = ['all', 'me'];
const VALID_DEFAULT_PAGES = ['schedule', 'requests', 'changes', 'tracking'];
const DEFAULT_SETTINGS = {
    weekdaysOnly: false,
    hideSidebar: false,
    // What view to show when the app opens. 'week' preserves prior behavior.
    defaultView: 'week',
    // Launch filter: 'all' or 'me'. Gross-room is always forced to 'all'.
    defaultPathFilter: 'me',
    // Which page to land on when the app opens. 'schedule' preserves prior behavior.
    defaultPage: 'schedule',
    // Launch view for the Lake Forest guest account — its only setting.
    // 'year' shows the sendout days at a glance.
    lfDefaultView: 'year',
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
if (!VALID_DEFAULT_PAGES.includes(settings.defaultPage)) settings.defaultPage = 'schedule';
if (!VALID_LF_DEFAULT_VIEWS.includes(settings.lfDefaultView)) settings.lfDefaultView = 'year';

// Seed active view from the saved default (fallback 'week'). Mobile always
// starts in Day view (only mobile view with the procedure schedule) — not
// persisted, so a phone session never overwrites a desktop default.
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
    const dpSeg = document.getElementById('defaultPageSeg');
    if (dpSeg) {
        dpSeg.querySelectorAll('.seg-btn').forEach(b => {
            const isActive = b.dataset.value === settings.defaultPage;
            b.classList.toggle('active', isActive);
            b.setAttribute('aria-checked', isActive ? 'true' : 'false');
        });
    }
    const dvSeg = document.getElementById('defaultViewSeg');
    if (dvSeg) {
        // Lake Forest stores its launch view separately (lfDefaultView).
        const dvActive = isLakeForest() ? settings.lfDefaultView : settings.defaultView;
        dvSeg.querySelectorAll('.seg-btn').forEach(b => {
            const isActive = b.dataset.value === dvActive;
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
    // Gross-room / manager / histology are forced to "All" — hide the
    // pointless row.
    const dfRow = document.getElementById('defaultFilterRow');
    if (dfRow) dfRow.style.display = (isGrossRoom() || isManager() || isReadOnlyGuest()) ? 'none' : '';

    // Lake Forest guest: the only setting on offer is the launch view —
    // hide the Display section and the Default page row.
    const dispSec = document.getElementById('displaySection');
    if (dispSec) dispSec.style.display = isLakeForest() ? 'none' : '';
    const dpRow = document.getElementById('defaultPageRow');
    if (dpRow) dpRow.style.display = isLakeForest() ? 'none' : '';

    // Sync sidebar arrow button aria-label
    const stb = document.getElementById('sidebarToggleBtn');
    if (stb) {
        const label = settings.hideSidebar ? 'Expand sidebar' : 'Collapse sidebar';
        stb.setAttribute('aria-label', label);
        stb.setAttribute('title', label);
    }

    // Render the admin-only PTO allotment editor (hides itself for non-admins).
    if (typeof renderPtoAllotmentSettings === 'function') {
        try { renderPtoAllotmentSettings(); } catch (_) { /* ignore */ }
    }
}

// ── PTO allotments (Settings page, admin-only) ──────────────────────────
// Fiscal-year stepper + one number input per pathologist. Forward stepping is
// unbounded; below the earliest year sits "Default — all years", which edits
// the legacy `vacationAllotted` fallback. Year values write to
// scheduler/ptoAllotments/<startYear>/<pathId>; edits save on change/blur.
const PTO_ALLOT_DEFAULT_MODE = 'default';
let ptoAllotSettingsYear = null;      // 'default' | 'YYYY' string; null until first render
let _ptoAllotYearBeforeDefault = null; // year to return to when leaving default mode

// The earliest fiscal year the stepper can reach — the fiscal year of the
// app's earliest schedule date. Nothing exists before it to allot for.
function ptoAllotYearFloor() {
    return getAcademicYearOfDate(EARLIEST_DATE);
}

// Pure stepping logic (unit-testable): Default ↔ floor ↔ floor+1 ↔ …
// (no upper bound).
function stepPtoAllotYear(state, delta) {
    const floor = ptoAllotYearFloor();
    if (state === PTO_ALLOT_DEFAULT_MODE) {
        // Nothing before Default; stepping forward enters the first year.
        return delta > 0 ? String(floor) : PTO_ALLOT_DEFAULT_MODE;
    }
    let y = parseInt(state, 10);
    if (!Number.isFinite(y)) y = getAcademicYearOfDate(new Date());
    y += delta;
    if (y < floor) return PTO_ALLOT_DEFAULT_MODE;
    return String(y);
}

function renderPtoAllotmentSettings() {
    const section = document.getElementById('ptoAllotmentSection');
    const list = document.getElementById('ptoAllotList');
    if (!section || !list) return;

    // Admin-only. For everyone else the section stays hidden.
    if (!isAdmin()) {
        section.style.display = 'none';
        return;
    }
    // Pathologists may not have loaded yet on first paint — bail until they do.
    if (!pathologists || pathologists.length === 0) {
        section.style.display = 'none';
        return;
    }
    section.style.display = '';

    // Skip re-render while an input here has focus (don't yank mid-type); the
    // next commit refreshes. Stepper buttons are static DOM — no guard needed.
    const active = document.activeElement;
    if (active && list.contains(active)
        && active.classList && active.classList.contains('pto-allot-input')) {
        return;
    }

    // First render defaults the stepper to the current fiscal year, the
    // one the admin most likely wants to adjust.
    const currentAy = getAcademicYearOfDate(new Date());
    if (ptoAllotSettingsYear === null) {
        ptoAllotSettingsYear = String(currentAy);
    }

    const isDefaultMode = ptoAllotSettingsYear === PTO_ALLOT_DEFAULT_MODE;
    const yr = isDefaultMode ? null : parseInt(ptoAllotSettingsYear, 10);

    // ── Fiscal-year stepper (static elements; update state only) ──
    const prevBtn = document.getElementById('ptoAllotYearPrev');
    const nextBtn = document.getElementById('ptoAllotYearNext');
    const centerBtn = document.getElementById('ptoAllotYearCurrent');
    const metaEl = document.getElementById('ptoAllotYearMeta');
    const toggleBtn = document.getElementById('ptoAllotDefaultToggle');

    if (prevBtn) {
        // Disabling a focused button drops keyboard focus (breaking further
        // arrow-key stepping) — hand focus to the period label first.
        const prevHadFocus = document.activeElement === prevBtn;
        prevBtn.disabled = isDefaultMode;   // nothing before Default
        if (isDefaultMode && prevHadFocus && centerBtn) centerBtn.focus();
    }
    if (nextBtn) nextBtn.disabled = false;           // no upper bound
    if (centerBtn) {
        if (isDefaultMode) {
            centerBtn.innerHTML = 'Default — all years';
            centerBtn.title = 'Click to jump to the current fiscal year';
            centerBtn.classList.remove('is-current-year');
        } else {
            const isNow = yr === currentAy;
            centerBtn.innerHTML = escapeHtml(academicYearLabel(yr))
                + (isNow ? ' <span class="pto-allot-year-now">current</span>' : '');
            centerBtn.title = 'Sep ' + yr + ' – Aug ' + (yr + 1)
                + (isNow ? '' : ' · Click to jump to the current fiscal year');
            centerBtn.classList.toggle('is-current-year', isNow);
        }
    }
    if (toggleBtn) {
        toggleBtn.textContent = isDefaultMode ? 'Back to fiscal years' : 'Edit default (all years)';
    }
    if (metaEl) {
        if (isDefaultMode) {
            // Orientation: how many fiscal years carry any override?
            const yearsCustomized = Object.keys(ptoAllotments || {}).filter(k => {
                const y = parseInt(k, 10);
                return Number.isFinite(y)
                    && pathologists.some(p => explicitPtoAllotment(p.id, y) !== null);
            }).length;
            metaEl.textContent = yearsCustomized > 0
                ? yearsCustomized + ' year' + (yearsCustomized === 1 ? '' : 's') + ' customized'
                : '';
        } else {
            const customCount = pathologists.filter(p => explicitPtoAllotment(p.id, yr) !== null).length;
            metaEl.textContent = customCount > 0
                ? customCount + ' custom value' + (customCount === 1 ? '' : 's')
                : '';
        }
    }

    list.innerHTML = pathologists.map(p => {
        const defaultAllot = Number.isFinite(p.vacationAllotted) ? p.vacationAllotted : 0;
        const explicit = isDefaultMode ? null : explicitPtoAllotment(p.id, yr);
        const shown = isDefaultMode ? defaultAllot : (explicit !== null ? explicit : defaultAllot);
        const lastName = (p.name || '').replace(/^Dr\.\s*/, '').split(/\s+/).pop() || p.name;

        // Year mode only: tag inherited rows; offer a reset on overridden rows.
        let stateHtml = '';
        if (!isDefaultMode) {
            stateHtml = explicit !== null
                ? `<button type="button" class="pto-allot-reset" data-path-id="${p.id}"
                       title="Remove this year's value — Dr. ${escapeHtml(lastName)} goes back to the default (${defaultAllot})">Use default</button>`
                : `<span class="pto-allot-default-badge" title="No value set for ${academicYearLabel(yr)} — using the all-years default">default</span>`;
        }

        return `
            <div class="pto-allot-row" data-path-id="${p.id}">
                <div class="pto-allot-who">
                    <span class="pto-allot-dot" style="--c:${p.color};" aria-hidden="true"></span>
                    <span class="pto-allot-name">Dr. ${escapeHtml(lastName)}</span>
                    <span class="pto-allot-initials">${escapeHtml(p.initials || '')}</span>
                    ${stateHtml}
                </div>
                <div class="pto-allot-controls">
                    <input
                        type="number"
                        class="pto-allot-input"
                        data-path-id="${p.id}"
                        min="0"
                        max="365"
                        step="1"
                        inputmode="numeric"
                        value="${shown}"
                        aria-label="PTO days allotted for Dr. ${escapeHtml(lastName)}${isDefaultMode ? ' (default, all years)' : ' for ' + academicYearLabel(yr)}" />
                    <span class="pto-allot-unit">days</span>
                </div>
            </div>`;
    }).join('');
}

// Delegated input handlers, attached once to the always-present container.
(function wirePtoAllotmentInputs() {
    const list = document.getElementById('ptoAllotList');
    if (!list) return;

    // The effective value currently shown for a pathologist under the
    // selected mode — used for skip-if-unchanged and Escape-revert.
    function effectiveShownValue(p) {
        const defaultAllot = Number.isFinite(p.vacationAllotted) ? p.vacationAllotted : 0;
        if (ptoAllotSettingsYear === PTO_ALLOT_DEFAULT_MODE) return defaultAllot;
        const yr = parseInt(ptoAllotSettingsYear, 10);
        const explicit = explicitPtoAllotment(p.id, yr);
        return explicit !== null ? explicit : defaultAllot;
    }

    function markSaving(input) {
        input.classList.remove('is-saved');
        input.classList.add('is-saving');
    }
    function markSaved(input) {
        input.classList.remove('is-saving');
        input.classList.add('is-saved');
        setTimeout(() => { input.classList.remove('is-saved'); }, 1200);
    }
    function markFailed(input, err) {
        input.classList.remove('is-saving');
        console.error('Failed to save PTO allotment:', err);
        if (typeof showToast === 'function') {
            showToast('Could not save PTO allotment — please try again.', { type: 'error' });
        }
    }

    // Validate + clamp, then write to the default field or the selected year's
    // node per mode. Returns the sanitized value saved, or null.
    function commitAllotment(input) {
        const pathId = parseInt(input.dataset.pathId, 10);
        if (!Number.isFinite(pathId)) return null;
        const p = pathologists.find(x => x.id === pathId);
        if (!p) return null;

        // Parse + clamp. Empty string and non-numeric reset to the current
        // effective value (don't silently save 0).
        let v = parseInt(input.value, 10);
        if (!Number.isFinite(v)) {
            input.value = String(effectiveShownValue(p));
            return null;
        }
        if (v < 0) v = 0;
        if (v > 365) v = 365;
        input.value = String(v);

        // Only admins can save (defence in depth — UI is already gated).
        if (!isAdmin()) return null;

        if (ptoAllotSettingsYear === PTO_ALLOT_DEFAULT_MODE) {
            // ── Default (all years): edit the legacy field, as before ──
            if (v === p.vacationAllotted) return v;   // no round-trip needed
            markSaving(input);
            db.ref('scheduler/pathologists/' + pathId + '/vacationAllotted').set(v)
                .then(() => {
                    markSaved(input);
                    // Update the local cache immediately so allotment
                    // displays reflect the change before Firebase echoes.
                    p.vacationAllotted = v;
                })
                .catch(err => markFailed(input, err));
            return v;
        }

        // ── Specific fiscal year: edit scheduler/ptoAllotments/<yr>/<pid> ──
        const yr = parseInt(ptoAllotSettingsYear, 10);
        if (!Number.isFinite(yr)) return null;
        const explicit = explicitPtoAllotment(pathId, yr);
        const defaultAllot = Number.isFinite(p.vacationAllotted) ? p.vacationAllotted : 0;
        // Skip no-op writes (same explicit value, or typed == inherited default).
        if (explicit !== null ? v === explicit : v === defaultAllot) return v;

        markSaving(input);
        db.ref('scheduler/ptoAllotments/' + yr + '/' + pathId).set(v)
            .then(() => {
                markSaved(input);
                if (!ptoAllotments[yr] && !ptoAllotments[String(yr)]) ptoAllotments[yr] = {};
                (ptoAllotments[yr] || ptoAllotments[String(yr)])[pathId] = v;
                // Row state changed (default badge → reset link) — repaint
                // once the input loses focus so we don't fight the cursor.
                setTimeout(() => {
                    if (document.activeElement !== input) renderPtoAllotmentSettings();
                }, 0);
            })
            .catch(err => markFailed(input, err));
        return v;
    }

    list.addEventListener('change', e => {
        const input = e.target.closest('.pto-allot-input');
        if (!input) return;
        commitAllotment(input);
    });

    // "Use default" — remove the selected year's override for this row.
    list.addEventListener('click', e => {
        const btn = e.target.closest('.pto-allot-reset');
        if (!btn) return;
        if (!isAdmin()) return;
        if (ptoAllotSettingsYear === PTO_ALLOT_DEFAULT_MODE) return;
        const pathId = parseInt(btn.dataset.pathId, 10);
        const yr = parseInt(ptoAllotSettingsYear, 10);
        if (!Number.isFinite(pathId) || !Number.isFinite(yr)) return;
        db.ref('scheduler/ptoAllotments/' + yr + '/' + pathId).remove()
            .then(() => {
                const yearMap = ptoAllotments[yr] || ptoAllotments[String(yr)];
                if (yearMap) {
                    delete yearMap[pathId];
                    delete yearMap[String(pathId)];
                }
                renderPtoAllotmentSettings();
            })
            .catch(err => {
                console.error('Failed to reset PTO allotment:', err);
                if (typeof showToast === 'function') {
                    showToast('Could not reset to default — please try again.', { type: 'error' });
                }
            });
    });

    // Enter commits + blurs (so the value visibly settles). Escape reverts.
    list.addEventListener('keydown', e => {
        const input = e.target.closest('.pto-allot-input');
        if (!input) return;
        if (e.key === 'Enter') {
            e.preventDefault();
            input.blur();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            const pathId = parseInt(input.dataset.pathId, 10);
            const p = pathologists.find(x => x.id === pathId);
            if (p) input.value = String(effectiveShownValue(p));
            input.blur();
        }
    });

    // Select-all on focus so admins can quickly overtype the value.
    list.addEventListener('focusin', e => {
        const input = e.target.closest('.pto-allot-input');
        if (!input) return;
        input.select();
    });

    // ── Fiscal-year stepper wiring ──
    // ‹/› step ±1 (unbounded forward); label click jumps to the current year;
    // arrow keys work inside the group.
    const yearPrevBtn = document.getElementById('ptoAllotYearPrev');
    const yearNextBtn = document.getElementById('ptoAllotYearNext');
    const yearCenterBtn = document.getElementById('ptoAllotYearCurrent');
    const defaultToggleBtn = document.getElementById('ptoAllotDefaultToggle');
    const stepperEl = document.querySelector('.pto-allot-year-stepper');

    function setPtoAllotYear(next) {
        const prev = ptoAllotSettingsYear;
        if (next === prev) return;
        // Remember the year we left when entering default mode so "Back to fiscal
        // years" returns there.
        if (next === PTO_ALLOT_DEFAULT_MODE && prev !== PTO_ALLOT_DEFAULT_MODE) {
            _ptoAllotYearBeforeDefault = prev;
        }
        ptoAllotSettingsYear = next;
        renderPtoAllotmentSettings();
    }

    if (yearPrevBtn) {
        yearPrevBtn.addEventListener('click', () => {
            setPtoAllotYear(stepPtoAllotYear(ptoAllotSettingsYear, -1));
        });
    }
    if (yearNextBtn) {
        yearNextBtn.addEventListener('click', () => {
            setPtoAllotYear(stepPtoAllotYear(ptoAllotSettingsYear, +1));
        });
    }
    if (yearCenterBtn) {
        yearCenterBtn.addEventListener('click', () => {
            setPtoAllotYear(String(getAcademicYearOfDate(new Date())));
        });
    }
    if (defaultToggleBtn) {
        defaultToggleBtn.addEventListener('click', () => {
            if (ptoAllotSettingsYear === PTO_ALLOT_DEFAULT_MODE) {
                setPtoAllotYear(_ptoAllotYearBeforeDefault
                    || String(getAcademicYearOfDate(new Date())));
            } else {
                setPtoAllotYear(PTO_ALLOT_DEFAULT_MODE);
            }
        });
    }
    if (stepperEl) {
        stepperEl.addEventListener('keydown', e => {
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                setPtoAllotYear(stepPtoAllotYear(ptoAllotSettingsYear, -1));
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                setPtoAllotYear(stepPtoAllotYear(ptoAllotSettingsYear, +1));
            }
        });
    }
})();

// Year view mode: 'pto' shows PTO schedule, 'call' shows on-call schedule
let yearMode = 'pto';

// ────────────── AUTH STATE ──────────────
// Signed-in account id, resolved by onAuthStateChanged (Firebase persists the
// session itself). null = signed out.
const AUTH_STORAGE_KEY = 'schedCurrentPathId'; // retained: legacy cleanup only
let loggedInPathId = null;

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

// Next/previous workday — skips weekends AND federal holidays, so "the day
// before" resolves across holiday weekends (Bigs-on-Friday + WFH-on-Tuesday
// with a holiday Monday is still a soft-rule conflict).
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

// Holiday name for the date, or null. Federal observation: Sat holiday →
// the prior Friday is the true holiday; Sun → the following Monday. The
// actual Sat/Sun still returns its name for display (already non-working).
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

// True if an "LF sendout" row renders for this date: per-day flag, or the
// call-cycle week flag (working days only). Pre-cutoff dates → false.
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

// True if a "Natalie PTO" banner renders on this date. Day/week/range adds
// all resolve to per-day flags (see saveNataliePto), so one lookup suffices.
function isNataliePtoDay(date) {
    if (isBeforeEarliest(date)) return false;
    return !!nataliePtoDays[fmt(date)];
}

function isOnPto(pathId, date) {
    const t = date.getTime();
    return vacations.find(v =>
        v.pathologistId === pathId &&
        t >= v.start.getTime() &&
        t <= v.end.getTime()
    );
}

// NATURAL assignments for all pathologists on a date — rotation + PTO
// cascade + manual overrides, BEFORE the hard-rule swap pass (which
// getDayAssignments adds). Returns { [pathId]: { type:'service'|'pto'|'off',
// service, onCall } }. Weekends: everyone "off", weekly on-call still applies.
// Weekdays: rotate cyto → bigs → huntley → wfh; PTO pulls WFH in as cover,
// dropping services bottom-up (wfh, huntley, bigs) as more people are out.
// Manual day-level overrides win last.
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
    // Runs BEFORE the PTO cascade: a regular override brings a PTO pathologist
    // back on duty (locked from reassignment); an off-site override removes them
    // from the rotation but renders its own label instead of the PTO stripe.
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
// Cross-day constraints applied after the natural rotation:
//   Rule 1: no McH Bigs the workday before starting multi-day PTO
//           (2+ workdays; Fri+Mon counts).
//   Rule 2: no Bigs or Breast Bx/WFH the workday before a Breast Bx/WFH day.
// "Day before" = previous workday. Violations are fixed by swapping services
// with a partner whose post-swap services stay clean; if no clean swap
// exists, best-effort swap + flag the day.

const _dayCache = new Map();
const _violationFlags = new Map();   // dayKey → array of issue strings (display only)

// Human-readable hard-rule violations for `date` (empty array = none);
// looks across days via naturalToday / naturalTomorrow / naturalYesterday.
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
// Apply hard-rule swaps to today's natural assignments. Day-level override
// → "locked": the rule pass won't move them (they can still be flagged).
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

// Unfixable-violation messages for the date, or null. Populated as a side
// effect of the hard-rule pass, so compute the day first.
function violationsForDay(date) {
    getDayAssignments(date);   // ensure flags map is populated for this date
    const list = _violationFlags.get(fmt(date));
    return (list && list.length > 0) ? list : null;
}

function clearDayCache() {
    _dayCache.clear();
    _naturalCache.clear();
    _violationFlags.clear();
}

// (recompute code moved to recompute.js)

function ptoDaysScheduled(pathId, opts) {
    // Optional {start,end} range; start clamps at EARLIEST_DATE, end unbounded.
    const rangeStart = (opts && opts.start instanceof Date) ? opts.start : EARLIEST_DATE;
    const rangeEnd = (opts && opts.end instanceof Date) ? opts.end : null;

    // Collect and clamp all ranges for this pathologist.
    const ranges = [];
    vacations.filter(v => v.pathologistId === pathId).forEach(v => {
        const effStart = v.start.getTime() < rangeStart.getTime() ? rangeStart : v.start;
        const effEnd = (rangeEnd && v.end.getTime() > rangeEnd.getTime()) ? rangeEnd : v.end;
        if (effEnd.getTime() < effStart.getTime()) return;
        ranges.push({ start: new Date(effStart), end: new Date(effEnd) });
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

// ── Per-fiscal-year PTO allotments ───────────────────────────────────────
// Explicit per-year value, or null when the default applies.
function explicitPtoAllotment(pathId, fiscalStartYear) {
    const yearMap = (ptoAllotments || {})[fiscalStartYear];
    if (!yearMap) return null;
    const v = (yearMap[pathId] !== undefined) ? yearMap[pathId] : yearMap[String(pathId)];
    return Number.isFinite(v) ? v : null;
}

// Effective allotment: year-specific value, else legacy `vacationAllotted`,
// else 0.
function ptoAllotmentFor(pathId, fiscalStartYear) {
    const explicit = explicitPtoAllotment(pathId, fiscalStartYear);
    if (explicit !== null) return explicit;
    const p = pathologists.find(x => String(x.id) === String(pathId));
    return (p && Number.isFinite(p.vacationAllotted)) ? p.vacationAllotted : 0;
}

// { start, end } for the fiscal year Sept 1 <startYear> – Aug 31 next year.
function getFiscalYearRange(startYear) {
    const start = new Date(startYear, 8, 1);   // Sept 1 (month is 0-indexed)
    start.setHours(0, 0, 0, 0);
    const end = new Date(startYear + 1, 7, 31); // Aug 31
    end.setHours(23, 59, 59, 999);
    return { start, end };
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
        // Listeners only start after sign-in, so loggedInPathId is already
        // resolved. Guard: an account mapping to a missing pathologist forces re-login.
        if (loggedInPathId !== null && loggedInPathId !== GROSS_ROOM_ID && loggedInPathId !== MANAGER_ID && loggedInPathId !== HISTOLOGY_ID && loggedInPathId !== LAKE_FOREST_ID && !pathologists.find(p => p.id === loggedInPathId)) {
            auth.signOut();
            return;
        }
        // Default filter by role: gross room / manager / histology forced to all;
        // otherwise honor the user's defaultPathFilter ('all' or 'me').
        if (isGrossRoom() || isManager() || isReadOnlyGuest()) {
            setPathFilter('all');
        } else if (settings.defaultPathFilter === 'all') {
            setPathFilter('all');
        } else {
            setPathFilter(String(loggedInPathId));
        }
        renderAll();
    }
}

// Signed in: show "Me", default to own id (or keep a valid prior choice).
// Signed out: hide "Me", force "All".
function populatePathFilter() {
    const meTab = document.getElementById('pathTabMe');
    if (!meTab) return;

    // Without "Me" the mobile select has one option — hide it entirely.
    const mobileSel = document.getElementById('mobilePathSelect');
    const mobileWrap = document.getElementById('mobilePathSelectWrap');
    const mobileMeOpt = mobileSel ? mobileSel.querySelector('option[value="me"]') : null;

    // Gross room / manager / histology: always show all pathologists with no option to switch
    if (isGrossRoom() || isManager() || isReadOnlyGuest()) {
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

    // The login screen renders before sign-in but live `pathologists` needs
    // auth, so use SEED_PATHOLOGISTS for the name list; prefer live data when
    // already loaded (re-login without reload).
    const nameList = (pathologists && pathologists.length)
        ? pathologists
        : SEED_PATHOLOGISTS;

    sel.innerHTML = '<option value="">— Select your name —</option>' +
        nameList.map(p => `<option value="${p.id}">${p.name}</option>`).join('') +
        '<option value="" disabled>──────────────</option>' +
        `<option value="${GROSS_ROOM_ID}">Gross Room</option>` +
        `<option value="${MANAGER_ID}">Kathleen</option>` +
        `<option value="${HISTOLOGY_ID}">Histology</option>` +
        `<option value="${LAKE_FOREST_ID}">Lake Forest</option>`;
    pwInput.value = '';
    errEl.textContent = '';
    overlay.style.display = 'flex';
    // Histology is a passwordless guest account: hide the password field
    // entirely when it's selected, and restore it for any other choice.
    updateLoginPasswordVisibility();
    // Focus the name dropdown so the user can start tabbing right away
    setTimeout(() => sel.focus(), 50);
}

// Show or hide the login password input based on the currently-selected
// account. Histology has no password; every other account requires one.
function updateLoginPasswordVisibility() {
    const sel = document.getElementById('loginPath');
    const pwInput = document.getElementById('loginPassword');
    if (!sel || !pwInput) return;
    const pwLabel = pwInput.previousElementSibling; // the <label>Password</label>
    const isHisto = sel.value === HISTOLOGY_ID || sel.value === LAKE_FOREST_ID;
    pwInput.style.display = isHisto ? 'none' : '';
    if (pwLabel && pwLabel.tagName === 'LABEL') {
        pwLabel.style.display = isHisto ? 'none' : '';
    }
    if (isHisto) pwInput.value = '';
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

    const isGrossRoomLogin = pidRaw === GROSS_ROOM_ID;
    const isManagerLogin = pidRaw === MANAGER_ID;
    const isHistologyLogin = pidRaw === HISTOLOGY_ID;
    const isLakeForestLogin = pidRaw === LAKE_FOREST_ID;

    // Histology is a passwordless guest account. Every other account
    // requires a password.
    if (!isHistologyLogin && !isLakeForestLogin && !pwAttempt) {
        errEl.textContent = 'Please enter your password.';
        return;
    }

    const pid = isGrossRoomLogin ? GROSS_ROOM_ID
        : isManagerLogin ? MANAGER_ID
        : isHistologyLogin ? HISTOLOGY_ID
        : isLakeForestLogin ? LAKE_FOREST_ID
        : parseInt(pidRaw, 10);

    // Histology signs in behind the scenes with a fixed credential the app
    // holds; every other account uses the password the user typed.
    const email = authEmailForId(pid);
    const password = isHistologyLogin ? HISTOLOGY_PW
        : isLakeForestLogin ? LAKE_FOREST_PW
        : pwAttempt;

    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
        // Firebase Auth is the source of truth; onAuthStateChanged does all
        // post-login setup (loggedInPathId, listeners, overlay, render).
        await auth.signInWithEmailAndPassword(email, password);
        // Do NOT hideLoginOverlay()/renderAll() here — the auth state handler owns
        // that for fresh logins and session resumes alike.
    } catch (err) {
        // Map the common Firebase Auth error codes to friendly messages.
        const code = err && err.code ? err.code : '';
        if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
            errEl.textContent = 'Incorrect password.';
            pwInput.select();
        } else if (code === 'auth/user-not-found') {
            errEl.textContent = 'No account on file for this user. Contact admin.';
        } else if (code === 'auth/too-many-requests') {
            errEl.textContent = 'Too many attempts. Please wait a moment and try again.';
        } else {
            errEl.textContent = 'Login failed: ' + (err.message || 'unknown error');
        }
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
// Hide the password field when Histology (passwordless guest) is selected.
document.getElementById('loginPath').addEventListener('change', updateLoginPasswordVisibility);

// ────────────── AUTH STATE → APP STATE ──────────────
// Fires on initial load, attemptLogin() success, and sign-out. Sign-in:
// resolve loggedInPathId + start listeners (→ checkReady → render).
// Sign-out: tear listeners down, show the login overlay.
auth.onAuthStateChanged(user => {
    document.body.classList.toggle('lf-guest', user ? idForAuthEmail(user.email) === LAKE_FOREST_ID : false);
    if (user) {
        const id = idForAuthEmail(user.email);
        if (id === null) {
            // Signed in with an account that doesn't map to any known app
            // user — refuse it and sign back out.
            auth.signOut();
            return;
        }
        loggedInPathId = id;
        // Lake Forest guest lands on their saved launch view (LF settings
        // offer week/month/year; the default is the yearlong schedule).
        if (id === LAKE_FOREST_ID) {
            view = VALID_LF_DEFAULT_VIEWS.includes(settings.lfDefaultView)
                ? settings.lfDefaultView : 'year';
            document.querySelectorAll('.view-tab').forEach(t => {
                t.classList.toggle('active', t.dataset.view === view);
            });
            // Re-gate the active page: LF has no Tracking page, so a stale
            // defaultPage from a prior non-LF session falls back to schedule.
            const appEl = document.getElementById('app');
            const curPage = appEl ? appEl.getAttribute('data-page') : 'schedule';
            if (typeof window.__setPage === 'function') window.__setPage(curPage);
        }
        // One-time cleanup of the legacy localStorage key from the old
        // homegrown auth (no longer used now that Firebase persists sessions).
        try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch (_) {}
        hideLoginOverlay();
        // Reset Changes page scope to its default for the new session.
        activeChangesScope = 'mine';
        // Requests page likewise lands on the Pending tab — without this the
        // tab selection leaks from the previous user in the same session.
        activeRequestsPageTab = 'pending';
        // Start the data listeners now that reads are permitted. When data
        // arrives, checkReady() handles filter defaults + render.
        startDataListeners();
        // After re-login without reload, cached-warm listeners may not re-fire —
        // refresh filter + view directly.
        if (pathologistsReady && vacationsReady) {
            populatePathFilter();
            if (isGrossRoom() || isManager() || isReadOnlyGuest()) {
                setPathFilter('all');
            } else {
                setPathFilter(settings.defaultPathFilter === 'all' ? 'all' : String(id));
            }
            renderAll();
        }
    } else {
        // Signed out (or never signed in).
        loggedInPathId = null;
        stopDataListeners();
        hideLoading();
        if (typeof showLoginOverlay === 'function') showLoginOverlay();
    }
});

// ────────────── FIREBASE LISTENERS ──────────────
regListener('scheduler/pathologists', async snap => {
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

regListener('scheduler/vacations', snap => {
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

regListener('scheduler/onCallOverrides', snap => {
    onCallOverrides = snap.exists() ? snap.val() : {};
    clearDayCache();
    if (pathologistsReady && vacationsReady) renderAll();
});

regListener('scheduler/onCallDayOverrides', snap => {
    onCallDayOverrides = snap.exists() ? snap.val() : {};
    clearDayCache();
    if (pathologistsReady && vacationsReady) renderAll();
});

regListener('scheduler/serviceOverrides', snap => {
    serviceOverrides = snap.exists() ? snap.val() : {};
    clearDayCache();
    if (pathologistsReady && vacationsReady) renderAll();
});

// Locks only mark slots as protected (the matching serviceOverride moves
// people), so no day-cache clear — just repaint for the glow.
regListener('scheduler/serviceLocks', snap => {
    serviceLocks = snap.exists() ? snap.val() : {};
    if (pathologistsReady && vacationsReady) renderAll();
}, err => {
    console.error('Firebase serviceLocks error:', err);
});

// Allotments don't affect assignments (no day-cache clear); renderAll()
// refreshes every surface showing allotted totals.
regListener('scheduler/ptoAllotments', snap => {
    ptoAllotments = snap.exists() ? snap.val() : {};
    if (pathologistsReady && vacationsReady) renderAll();
}, err => {
    console.error('Firebase ptoAllotments error:', err);
});

// Lake Forest sendout flags — see isLfSendoutDay() for how they're consumed.
regListener('scheduler/lfSendoutDays', snap => {
    lfSendoutDays = snap.exists() ? snap.val() : {};
    if (pathologistsReady && vacationsReady) renderAll();
});

regListener('scheduler/lfSendoutWeeks', snap => {
    lfSendoutWeeks = snap.exists() ? snap.val() : {};
    if (pathologistsReady && vacationsReady) renderAll();
});

// Procedures are rotation-independent: no day-cache clear; re-render only
// week/day (the views that show them). The re-render is REQUIRED when the
// procedures snapshot lands after the initial renderAll(), or the grid
// stays blank until the user changes view.
regListener('scheduler/procedures', snap => {
    procedures = snap.exists() ? snap.val() : {};
    if (pathologistsReady && vacationsReady && (view === 'week' || view === 'day')) renderMain();
}, err => {
    console.error('Firebase procedures error:', err);
});

// Natalie PTO flags — display-only; only procedure-bearing views re-render.
regListener('scheduler/natalieptoDays', snap => {
    nataliePtoDays = snap.exists() ? snap.val() : {};
    if (pathologistsReady && vacationsReady && (view === 'week' || view === 'day')) renderMain();
}, err => {
    console.error('Firebase natalieptoDays error:', err);
});

// Request queue: every change a non-admin wants to make goes here first
// and is then approved/denied by the admin.  Each request looks like:
//   { requesterId, type, status, createdAt, payload, note,
//     decisionAt?, decisionBy?, decisionNote? }
regListener('scheduler/requests', snap => {
    const next = snap.exists() ? snap.val() : {};

    // After the first load, detect newly-added pending requests so we can
    // show a small alert to the admin (one toast per refresh, not spammy).
    // Requests the admin sent out themselves (lf_dates_request) don't count —
    // those wait on the target, not on the admin.
    if (_seenRequestKeys && isAdmin()) {
        const newPending = Object.entries(next).filter(([k, r]) =>
            !_seenRequestKeys.has(k) && r && r.status === 'pending'
            && r.requesterId !== loggedInPathId
        );
        if (newPending.length > 0) {
            showToast(`${newPending.length} new request${newPending.length === 1 ? '' : 's'} pending review.`);
        }
    } else if (_seenRequestKeys && loggedInPathId !== null && !isAdmin()) {
        // Non-admins get a toast when a new pending request is aimed AT them
        // (admin asking Lake Forest for sendout dates).
        const newForMe = Object.entries(next).filter(([k, r]) =>
            !_seenRequestKeys.has(k) && r && r.status === 'pending'
            && r.targetId === loggedInPathId
        );
        if (newForMe.length > 0) {
            showToast('The admin has requested your sendout dates — see Requests.');
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
    // Lake Forest guest mode: body class drives the CSS that strips the
    // calendar down to LF sendout days and hides non-schedule chrome.
    document.body.classList.toggle('lf-guest', isLakeForest());
    // Show/hide admin-only controls based on signed-in user's role
    const admin = isAdmin();
    const grossRoom = isGrossRoom();
    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) exportBtn.style.display = admin ? '' : 'none';

    // ── Recompute Schedule buttons (admin-only) ──
    const rcBtn = document.getElementById('recomputeBtn');
    if (rcBtn) rcBtn.style.display = admin ? '' : 'none';
    const sbRcBtn = document.getElementById('sidebarRecomputeBtn');
    if (sbRcBtn) sbRcBtn.style.display = admin ? '' : 'none';

    // Gross room / manager / histology cannot manage PTO or view requests at all — hide those buttons
    const addPtoBtnEl = document.getElementById('addPtoBtn');
    if (addPtoBtnEl) addPtoBtnEl.style.display = (grossRoom || isManager() || isReadOnlyGuest()) ? 'none' : '';

    // The "Manage PTO" label changes to "Request PTO" for non-admins (not gross room)
    const ptoBtnLabel = document.getElementById('addPtoBtnLabel');
    if (ptoBtnLabel) ptoBtnLabel.textContent = admin ? 'Manage PTO' : 'Request PTO';

    // Natalie PTO (procedure-schedule PTO marker) — Gross Room only.
    const canNatalie = grossRoom;
    const npToolbarBtn = document.getElementById('toolbarNataliePtoBtn');
    if (npToolbarBtn) npToolbarBtn.style.display = canNatalie ? '' : 'none';
    const npProxyBtn = document.getElementById('addNataliePtoBtn');
    if (npProxyBtn) npProxyBtn.style.display = canNatalie ? '' : 'none';

    // Show/hide & update the Requests button + badge
    updateRequestsBadge();

    // Changes nav dot (depends on who is signed in)
    updateNavChangesIndicator();

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

    // Pathologist list (compact) — used/allotted for the CURRENT fiscal
    // year, honoring any year-specific allotment.
    const list = document.getElementById('pathList');
    const sidebarAy = getAcademicYearOfDate(today);
    const sidebarFy = getFiscalYearRange(sidebarAy);
    list.innerHTML = pathologists.map(p => {
        const used = ptoDaysScheduled(p.id, { start: sidebarFy.start, end: sidebarFy.end });
        const allot = ptoAllotmentFor(p.id, sidebarAy);
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
        } else if (isLakeForest()) {
            sWho.textContent = 'Signed in · Lake Forest (read-only)';
            sInfo.style.display = 'flex';
        } else if (isHistology()) {
            sWho.textContent = 'Signed in · Histology (read-only)';
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
// One-line float-in message, auto-dismisses.
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
// opts (optional): { targetId } aims the request at another account
// (admin → Lake Forest asks); { toast } overrides the confirmation text.
async function submitRequest(type, payload, note, opts) {
    if (loggedInPathId === null) {
        alert('You must be signed in to submit a request.');
        return false;
    }
    try {
        await db.ref('scheduler/requests').push({
            requesterId: loggedInPathId,
            targetId: (opts && opts.targetId) || null,
            type: type,
            status: 'pending',
            createdAt: Date.now(),
            payload: payload || {},
            note: (note || '').trim() || null,
        });
        showToast((opts && opts.toast) || 'Request submitted — admin will review.');
        return true;
    } catch (err) {
        console.error('submitRequest error:', err);
        showToast('Failed to submit request: ' + (err.message || err), { type: 'error' });
        return false;
    }
}

// Counts of pending requests visible to the current user.  Admin sees all
// pending across the team; non-admin sees their own pending count plus any
// pending requests aimed at them (targetId).
function getVisiblePendingCount() {
    const arr = Object.entries(requests).filter(([, r]) => r && r.status === 'pending');
    // Admin's badge means "needs my review" — asks the admin sent out
    // (lf_dates_request) wait on the target instead, so exclude them.
    if (isAdmin()) return arr.filter(([, r]) => r.type !== 'lf_dates_request').length;
    return arr.filter(([, r]) =>
        r.requesterId === loggedInPathId || r.targetId === loggedInPathId
    ).length;
}

// Sidebar Requests button + badge; also drives the mobile hamburger's
// alert dot and in-menu badge.
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

    // Hide entirely if not signed in OR if gross room / manager / histology
    // (who cannot manage requests or PTO). Lake Forest CAN file sendout
    // requests, so it falls through to the requester path below.
    if (loggedInPathId === null || isGrossRoom() || isManager() || isHistology()) {
        if (btn) btn.style.display = 'none';
        if (menuBtn) menuBtn.classList.remove('has-alert');
        if (menuReqItem) menuReqItem.style.display = 'none';
        if (menuExportItem) menuExportItem.style.display = 'none';
        if (menuRcItem) menuRcItem.style.display = 'none';
        // Also hide the PTO menu item for gross room / manager / histology
        const menuPtoItem = document.querySelector('.menu-item[data-action="pto"]');
        if (menuPtoItem) menuPtoItem.style.display = (isGrossRoom() || isManager() || isReadOnlyGuest()) ? 'none' : '';
        return;
    }

    // ── Sidebar button (desktop) ──
    if (btn) {
        btn.style.display = '';
        if (lbl) lbl.textContent = isAdmin() ? 'Requests' : 'My Requests';
    }

    // ── Mobile menu items ──
    if (menuPtoLabel) menuPtoLabel.textContent = isAdmin() ? 'Manage PTO' : 'Request PTO';
    // Lake Forest files sendout requests, not PTO — hide the PTO menu item.
    const menuPtoItemMain = document.querySelector('.menu-item[data-action="pto"]');
    if (menuPtoItemMain) menuPtoItemMain.style.display = isLakeForest() ? 'none' : '';
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
// Dot on "Requests": amber = pending, green = approved since last visit,
// red = denied since last visit. Visiting the page stamps
// reqDecisionAck_{pathId} in localStorage; older decisions count as seen.
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

    if (!loggedInPathId || isGrossRoom() || isManager() || isHistology()) {
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

    // Non-admins: check for unseen decisions, then pending. Requests aimed
    // at this user (targetId) count too; decisions the user made themselves
    // (e.g. LF marking an ask complete) never light the dot.
    const ackTs = _getAckTs();
    const mine = Object.values(requests || {}).filter(
        r => r && (r.requesterId === loggedInPathId || r.targetId === loggedInPathId)
    );
    const hasUnseenDenied = mine.some(
        r => r.status === 'denied' && (r.decisionAt || 0) > ackTs
            && r.decisionBy !== loggedInPathId
    );
    const hasUnseenApproved = mine.some(
        r => r.status === 'approved' && (r.decisionAt || 0) > ackTs
            && r.decisionBy !== loggedInPathId
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

// Apply a tone class to the dot, optionally with the pop animation for
// newly-arrived decisions.
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

// Stamp the visit time so later updateNavRequestsIndicator() calls know
// which decisions are "new".
function markRequestsPageSeen() {
    if (!loggedInPathId || isAdmin()) return;
    const key = 'reqDecisionAck_' + loggedInPathId;
    try { localStorage.setItem(key, String(Date.now())); } catch (_) {}
    updateNavRequestsIndicator();
}

// ────────────── CHANGES NAV DOT INDICATOR ──────────────
// Blue dot on "Changes": an unseen change affecting the signed-in
// pathologist's schedule has landed. Visiting the page stamps
// chgSeenAck_{pathId} in localStorage; older changes count as seen.
// Changes the user made themselves never light the dot.
function _getChangesAckTs() {
    if (loggedInPathId === null) return Date.now();
    const key = 'chgSeenAck_' + loggedInPathId;
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

function updateNavChangesIndicator() {
    const dot = document.getElementById('navChangesBadge');
    if (!dot) return;

    // Lake Forest guest: light the dot for unseen sendout entries.
    if (isLakeForest()) {
        const ackTs = _getChangesAckTs();
        const hasUnseen = Object.values(changes || {}).some(c =>
            c && c.kind === 'lf_sendout'
            && (c.at || 0) > ackTs
            && c.byPathId !== loggedInPathId
        );
        if (hasUnseen) _setNavDot(dot, 'tone-changed', true);
        else dot.style.display = 'none';
        return;
    }

    // Otherwise only pathologist accounts can be change targets.
    if (typeof loggedInPathId !== 'number') {
        dot.style.display = 'none';
        return;
    }

    const ackTs = _getChangesAckTs();
    const hasUnseen = Object.values(changes || {}).some(c =>
        c && (c.at || 0) > ackTs
        && c.byPathId !== loggedInPathId
        && _chgAffectsUser(c, loggedInPathId)
    );

    if (hasUnseen) {
        _setNavDot(dot, 'tone-changed', true);
    } else {
        dot.style.display = 'none';
    }
}

// Stamp the visit time so later updateNavChangesIndicator() calls know
// which changes are "new".
function markChangesPageSeen() {
    if (typeof loggedInPathId !== 'number' && !isLakeForest()) return;
    const key = 'chgSeenAck_' + loggedInPathId;
    try { localStorage.setItem(key, String(Date.now())); } catch (_) {}
    updateNavChangesIndicator();
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
    if (p) return p.name;
    // Special non-pathologist accounts aren't in the pathologists array, so
    // resolve their display names explicitly before falling back to unknown.
    if (id === MANAGER_ID) return 'Kathleen';
    if (id === GROSS_ROOM_ID) return 'Gross Room';
    if (id === HISTOLOGY_ID) return 'Histology';
    if (id === LAKE_FOREST_ID) return 'Lake Forest';
    return `(unknown #${id})`;
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
        case 'lf_sendout': {
            const d = parseDate(req.payload.date);
            const isRemove = req.payload.action === 'remove';
            const title = `${who} → Sendout ${isRemove ? 'removal' : 'day'}`;
            const verb = isRemove ? 'removed' : 'added';
            if (req.payload.scope === 'week') {
                const cs = getCallCycleStart(d);
                const ce = getCallCycleEnd(cs);
                const weekLabel = `${MONTHS_SHORT[cs.getMonth()]} ${cs.getDate()} – ${MONTHS_SHORT[ce.getMonth()]} ${ce.getDate()}, ${ce.getFullYear()}`;
                return {
                    title,
                    body: `Requesting Lake Forest sendout be <strong>${verb}</strong> for the <strong>full call week</strong> of <strong>${weekLabel}</strong>.`,
                };
            }
            const dateLabel = `${DOW[d.getDay()]}, ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
            return {
                title,
                body: `Requesting Lake Forest sendout be <strong>${verb}</strong> for <strong>${dateLabel}</strong>.`,
            };
        }
        case 'lf_dates_request': {
            // Admin → Lake Forest: please provide your sendout dates.
            const p = req.payload || {};
            const range = (p.start && p.end) ? _reqDateRange(p.start, p.end) : null;
            const about = p.aboutName
                ? ` (re: ${escapeHtml(p.aboutName)}'s PTO)`
                : '';
            return {
                title: `${who} → Sendout dates requested`,
                body: `Asking <strong>Lake Forest</strong> to provide their sendout dates`
                    + (range ? ` covering <strong>${range}</strong>` : '')
                    + about + '.',
            };
        }
        default:
            return { title: `${who} → ${req.type}`, body: 'Unknown request type.' };
    }
}

// When PTO is added (any path), strip pre-existing REGULAR service
// overrides on those days — otherwise "override beats PTO" keeps the person
// working ("approved his PTO but he's still showing as working"). Off-site
// overrides stay: they already read as onPto, only the label differs.
async function clearConflictingServiceOverridesForPto(pathId, startDateStr, endDateStr) {
    const start = parseDate(startDateStr);
    const end = parseDate(endDateStr);
    if (!start || !end || isNaN(start) || isNaN(end)) return;

    const writes = {};
    for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
        const k = fmt(d);
        const dayOv = serviceOverrides[k];
        const ovId = dayOv ? dayOv[pathId] : null;
        const lockId = getServiceLock(k, pathId);

        if (ovId && !isOffSiteServiceId(ovId)) {
            // Regular override conflicts with PTO — remove it and its lock (approving
            // PTO over an approved service is itself an admin decision).
            const updated = Object.assign({}, dayOv);
            delete updated[pathId];
            writes['scheduler/serviceOverrides/' + k] =
                Object.keys(updated).length === 0 ? null : updated;
            if (lockId) {
                writes['scheduler/serviceLocks/' + k + '/' + pathId] = null;
            }
        } else if (!ovId && lockId) {
            // Stale lock with no matching override — clean it up so it
            // can't silently pin a future recompute.
            writes['scheduler/serviceLocks/' + k + '/' + pathId] = null;
        }
        // Off-site overrides (and their locks) don't conflict with PTO —
        // leave both alone.
    }
    if (Object.keys(writes).length > 0) {
        await db.ref().update(writes);
    }
}

// ────────────── SERVICE LOCK HELPERS ──────────────
// A lock marks a {day, pathologist} assignment as approved: renders with a
// glow, recompute treats it as a hard pin, released only by admin edit,
// PTO approval on top, revocation, or explicit unlock.

// Returns the locked serviceId for this {dayKey, pid}, or null.
function getServiceLock(dayKey, pid) {
    const day = serviceLocks[dayKey];
    if (!day) return null;
    const v = (day[pid] !== undefined) ? day[pid] : day[String(pid)];
    return v === undefined || v === null ? null : v;
}

// True when the lock matches what's actually rendered — no misleading
// glow if data drifted.
function isLockActiveForRender(dayKey, pid, assignment) {
    if (!assignment || !assignment.service) return false;
    if (assignment.type !== 'service' && assignment.type !== 'off_site') return false;
    const lockId = getServiceLock(dayKey, pid);
    return !!lockId && lockId === assignment.service.id;
}

// Multi-path write fragment that clears the lock for {dayKey, pid}.
// Merge into a db.ref().update(writes) payload.
function _lockClearWrite(writes, dayKey, pid) {
    writes['scheduler/serviceLocks/' + dayKey + '/' + pid] = null;
}

// True while an approved service_change's lock still holds on ≥1 affected
// day (drives the "locked on the schedule" note).
function _requestLockActive(req) {
    if (!req || req.type !== 'service_change' || req.status !== 'approved') return false;
    if (!req.payload || !req.payload.serviceId || !req.payload.date) return false;
    const scope = req.payload.scope || 'day';
    let dayKeys;
    try {
        dayKeys = scope === 'week'
            ? workdaysInCallCycle(parseDate(req.payload.date)).map(d => fmt(d))
            : [req.payload.date];
    } catch (e) {
        return false;
    }
    return dayKeys.some(k => getServiceLock(k, req.requesterId) === req.payload.serviceId);
}

// Every distinct freetext service name currently in use (overrides + locks),
// for the "Custom service…" input's autocomplete suggestions.
function collectFreetextServiceNames() {
    const names = new Set();
    const scan = store => {
        Object.values(store || {}).forEach(dayMap => {
            if (!dayMap || typeof dayMap !== 'object') return;
            Object.values(dayMap).forEach(sid => {
                if (isFreetextServiceId(sid)) {
                    names.add(String(sid).slice(FREETEXT_SERVICE_PREFIX.length));
                }
            });
        });
    };
    scan(serviceOverrides);
    scan(serviceLocks);
    return Array.from(names).sort((a, b) => a.localeCompare(b));
}

// (Re)build the shared <datalist> the custom-service text inputs point at.
// Called whenever a surface with such an input opens.
function renderFreetextDatalist() {
    let dl = document.getElementById('ftServiceNames');
    if (!dl) {
        dl = document.createElement('datalist');
        dl.id = 'ftServiceNames';
        document.body.appendChild(dl);
    }
    dl.innerHTML = collectFreetextServiceNames()
        .map(n => `<option value="${escapeHtml(n)}"></option>`)
        .join('');
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
            // Strip stale regular overrides so the new PTO takes effect.
            await clearConflictingServiceOverridesForPto(
                req.requesterId, req.payload.start, req.payload.end);
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

            // Day-keys to touch: the date itself, or every workday in its call cycle.
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
                    // LOCK the approved assignment (hard pin + glow) until admin edit/clear,
                    // PTO on top, revocation, or a newer approval.
                    writes['scheduler/serviceLocks/' + k + '/' + pid] =
                        req.payload.serviceId;
                    // Pin ONLY the just-approved path; pre-existing overrides
                    // shouldn't lock the recompute against fixing flags.
                    rcPinnedByDay[k] = { [pid]: req.payload.serviceId };
                } else {
                    // Clear just this user's slot for the day
                    const existing = Object.assign({}, serviceOverrides[k] || {});
                    delete existing[pid];
                    writes['scheduler/serviceOverrides/' + k] =
                        Object.keys(existing).length === 0 ? null : existing;
                    // An approved "clear my service" also releases any lock
                    // this pathologist held on the day.
                    writes['scheduler/serviceLocks/' + k + '/' + pid] = null;
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
        } else if (req.type === 'lf_sendout') {
            // Mirror the admin LF modal writes. Sendout flags don't touch
            // the service rotation, so no recompute offer.
            const dKey = req.payload.date;
            const scope = req.payload.scope || 'day';
            const wKey = fmt(getCallCycleStart(parseDate(dKey)));
            if (req.payload.action === 'remove') {
                if (scope === 'week') {
                    await db.ref('scheduler/lfSendoutWeeks/' + wKey).remove();
                    await _clearLfDayFlagsForCycle(parseDate(dKey));
                } else {
                    await db.ref('scheduler/lfSendoutDays/' + dKey).remove();
                }
            } else {
                if (scope === 'week') {
                    await db.ref('scheduler/lfSendoutWeeks/' + wKey).set(true);
                    await _clearLfDayFlagsForCycle(parseDate(dKey));
                } else {
                    await db.ref('scheduler/lfSendoutDays/' + dKey).set(true);
                }
            }
        }

        // Mark approved
        await db.ref('scheduler/requests/' + reqKey).update({
            status: 'approved',
            decisionAt: Date.now(),
            decisionBy: loggedInPathId,
        });
        showToast('Request approved.');

        // ── Change log ── one entry summarizing what was applied; source flag
        // distinguishes request approvals from direct admin edits.
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
            } else if (req.type === 'lf_sendout') {
                const scope = req.payload.scope || 'day';
                const isRemove = req.payload.action === 'remove';
                logChange(Object.assign({
                    kind: 'lf_sendout',
                    type: isRemove ? 'lf_clear' : 'lf_set',
                    source: 'request_approved', requestKey: reqKey,
                    forPathId: reqPid,
                    date: req.payload.date,
                    scope: scope,
                }, isRemove
                    ? _chgSummaryLfClear(req.payload.date, scope)
                    : _chgSummaryLfSet(req.payload.date, scope)));
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
                // Release the approval lock along with the override.
                writes['scheduler/serviceLocks/' + k + '/' + pid] = null;
                rcPinnedByDay[k] = {};
            });
            if (Object.keys(writes).length > 0) await db.ref().update(writes);
            if (dayKeys.length > 0) {
                rcFromDate    = parseDate(dayKeys.slice().sort()[0]);
                rcDayBeforeFix = true;
                rcMessage     = 'Approval revoked and service override removed. Recompute the future schedule?';
            }

        } else if (req.type === 'lf_sendout') {
            // Reverse the flag change that was applied on approval.
            const dKey  = req.payload.date;
            const scope = req.payload.scope || 'day';
            const wKey  = fmt(getCallCycleStart(parseDate(dKey)));
            if (req.payload.action === 'remove') {
                // Approval removed the flag — restore it.
                if (scope === 'week') {
                    await db.ref('scheduler/lfSendoutWeeks/' + wKey).set(true);
                    await _clearLfDayFlagsForCycle(parseDate(dKey));
                } else {
                    await db.ref('scheduler/lfSendoutDays/' + dKey).set(true);
                }
            } else {
                // Approval added the flag — clear it.
                if (scope === 'week') {
                    await db.ref('scheduler/lfSendoutWeeks/' + wKey).remove();
                    await _clearLfDayFlagsForCycle(parseDate(dKey));
                } else {
                    await db.ref('scheduler/lfSendoutDays/' + dKey).remove();
                }
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

        // ── Change log ── revocation logs the *reversal* (what actually mutated
        // the schedule now), not the original.
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
            } else if (req.type === 'lf_sendout') {
                // Revocation applied the OPPOSITE of the original request.
                const scope = req.payload.scope || 'day';
                const restored = req.payload.action === 'remove';
                logChange(Object.assign({
                    kind: 'lf_sendout',
                    type: restored ? 'lf_set' : 'lf_clear',
                    source: 'request_revoked', requestKey: reqKey,
                    forPathId: req.requesterId,
                    date: req.payload.date,
                    scope: scope,
                }, restored
                    ? _chgSummaryLfSet(req.payload.date, scope)
                    : _chgSummaryLfClear(req.payload.date, scope)));
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

// Target of an lf_dates_request (Lake Forest) marks it complete once they
// have responded with sendout requests. Reuses the 'approved' status so the
// existing tabs/history plumbing applies; cards label it "completed".
async function completeLfDatesRequest(reqKey) {
    const req = requests[reqKey];
    if (!req || req.status !== 'pending') return;
    if (req.targetId !== loggedInPathId) return;
    try {
        await db.ref('scheduler/requests/' + reqKey).update({
            status: 'approved',
            decisionAt: Date.now(),
            decisionBy: loggedInPathId,
        });
        showToast('Marked complete — the admin can see your response.');
    } catch (err) {
        console.error('completeLfDatesRequest error:', err);
        showToast('Failed to mark complete: ' + (err.message || err), { type: 'error' });
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
    // No args → modal list + modal tab state; explicit args → that surface
    // (Requests page).
    const listEl = targetEl || document.getElementById('requestsList');
    if (!listEl) return;
    const tab = tabState || activeRequestsTab;

    // Filter: admin sees everyone's; non-admin sees their own plus any
    // requests aimed at them (admin → Lake Forest sendout-dates asks)
    let entries = Object.entries(requests).filter(([, r]) => !!r);
    if (!isAdmin()) {
        entries = entries.filter(([, r]) =>
            r.requesterId === loggedInPathId || r.targetId === loggedInPathId);
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
        // Admin→LF asks aren't approved/denied in the usual sense — the
        // target completes them. Relabel while reusing the same statuses.
        const isAskType = req.type === 'lf_dates_request';
        const isTarget = req.targetId != null && req.targetId === loggedInPathId;
        const decisionLine = (req.status !== 'pending')
            ? `<div class="req-meta">${req.status === 'approved' ? (isAskType ? '✓ Completed' : '✓ Approved') : '✗ Denied'}${req.decisionAt ? ' · ' + new Date(req.decisionAt).toLocaleString([], {
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
        // Admin follow-up on PTO requests: ask Lake Forest for their sendout
        // dates covering the request's window.
        const askLfBtnHtml = (isAdmin()
            && (req.type === 'pto_add' || req.type === 'pto_remove'))
            ? `<button data-act="asklf" data-key="${key}">Request LF dates</button>`
            : '';
        if (req.status === 'pending') {
            if (isAskType) {
                if (isTarget) {
                    // Lake Forest responds via sendout requests, then marks done
                    actions = `
                            <div class="req-card-actions">
                                <button data-act="lfprovide" data-key="${key}">Provide dates…</button>
                                <button class="approve" data-act="lfdone" data-key="${key}">Mark complete</button>
                            </div>`;
                } else if (isAdmin() || req.requesterId === loggedInPathId) {
                    actions = `
                            <div class="req-card-actions">
                                <button data-act="cancel" data-key="${key}">Cancel request</button>
                            </div>`;
                }
            } else if (isAdmin()) {
                actions = `
                            <div class="req-card-actions">
                                ${askLfBtnHtml}
                                <button class="deny" data-act="deny" data-key="${key}">Deny</button>
                                <button class="approve" data-act="approve" data-key="${key}">Approve</button>
                            </div>`;
            } else if (req.requesterId === loggedInPathId) {
                actions = `
                            <div class="req-card-actions">
                                <button data-act="cancel" data-key="${key}">Cancel request</button>
                            </div>`;
            }
        } else if (req.status === 'approved' && isAdmin() && !isAskType) {
            actions = `
                        <div class="req-card-actions">
                            ${askLfBtnHtml}
                            <button class="revoke" data-act="revoke" data-key="${key}">Revoke approval</button>
                        </div>`;
        }

        const typeShort = ({
            'pto_add': 'PTO ADD',
            'pto_remove': 'PTO REMOVE',
            'oncall_change': 'ON-CALL',
            'service_change': 'SERVICE',
            'lf_sendout': 'LF SENDOUT',
            'lf_dates_request': 'LF DATES',
        })[req.type] || req.type;

        // Approved service changes that are still locked on the schedule get
        // a callout, so both sides can see the assignment is protected.
        const lockLine = _requestLockActive(req)
            ? `<div class="req-lock-note"><span class="req-lock-dot" aria-hidden="true"></span>Locked on the schedule — recompute won't move this assignment.</div>`
            : '';

        return `
                    <div class="req-card status-${req.status}">
                        <div class="req-card-head">
                            <div>
                                <span class="req-who">${escapeHtml(desc.title)}</span>
                                <span class="req-type">${typeShort}</span>
                            </div>
                            <span class="req-status-pill ${req.status}">${isAskType && req.status === 'approved' ? 'completed' : req.status}</span>
                        </div>
                        <div class="req-detail">${desc.body}</div>
                        ${noteLine}
                        ${decisionLine}
                        ${lockLine}
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
            else if (act === 'asklf') openLfAskModalForRequest(key);
            else if (act === 'lfprovide') {
                const r = requests[key];
                const p = (r && r.payload) || {};
                openLfRequestModal(p.start ? parseDate(p.start) : today);
            }
            else if (act === 'lfdone') completeLfDatesRequest(key);
        });
    });
}

// Tiny HTML escape used in request descriptions / notes
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

    // Inject (once) a "New Request" button for non-admins: opens the same PTO
    // modal flow, which renders as "Request PTO". Hidden for admins.
    let newBtn = document.getElementById('requestsPageNewBtn');
    if (!newBtn) {
        newBtn = document.createElement('button');
        newBtn.id = 'requestsPageNewBtn';
        newBtn.type = 'button';
        newBtn.className = 'req-new-btn';
        newBtn.innerHTML = '<span aria-hidden="true" style="margin-right:6px;font-weight:700;">+</span>New PTO Request';
        newBtn.style.cssText = [
            'margin: 0 0 12px',
            'padding: 8px 14px',
            'border-radius: 8px',
            'border: 1px solid var(--accent-soft, #2a2a2a)',
            'background: var(--accent-soft, #2a2a2a)',
            'color: var(--ink-2, #ddd)',
            'font: inherit',
            'font-weight: 600',
            'cursor: pointer',
            'display: inline-flex',
            'align-items: center',
        ].join(';');
        newBtn.addEventListener('click', () => {
            // Lake Forest requests sendout days; everyone else requests PTO.
            if (isLakeForest()) { openLfRequestModal(today); return; }
            const addBtn = document.getElementById('addPtoBtn');
            if (addBtn) addBtn.click();
        });
        // Place it directly above the tab bar so it's prominent without
        // overlapping the page header/summary.
        const tabsEl = document.getElementById('requestsPageTabs');
        if (tabsEl && tabsEl.parentNode) {
            tabsEl.parentNode.insertBefore(newBtn, tabsEl);
        } else {
            pg.appendChild(newBtn);
        }
    }
    newBtn.style.display = admin ? 'none' : 'inline-flex';
    newBtn.innerHTML = '<span aria-hidden="true" style="margin-right:6px;font-weight:700;">+</span>'
        + (isLakeForest() ? 'New Sendout Request' : 'New PTO Request');

    // Inject (once) an admin-only button that asks the Lake Forest account
    // for their sendout dates (files an lf_dates_request aimed at LF).
    let askLfBtn = document.getElementById('requestsPageAskLfBtn');
    if (!askLfBtn) {
        askLfBtn = document.createElement('button');
        askLfBtn.id = 'requestsPageAskLfBtn';
        askLfBtn.type = 'button';
        askLfBtn.className = 'req-new-btn';
        askLfBtn.innerHTML = '<span aria-hidden="true" style="margin-right:6px;font-weight:700;">+</span>Request LF Sendout Dates';
        askLfBtn.style.cssText = [
            'margin: 0 0 12px',
            'padding: 8px 14px',
            'border-radius: 8px',
            'border: 1px solid var(--accent-soft, #2a2a2a)',
            'background: var(--accent-soft, #2a2a2a)',
            'color: var(--ink-2, #ddd)',
            'font: inherit',
            'font-weight: 600',
            'cursor: pointer',
            'display: inline-flex',
            'align-items: center',
        ].join(';');
        askLfBtn.addEventListener('click', () => openLfAskModal());
        const tabsEl = document.getElementById('requestsPageTabs');
        if (tabsEl && tabsEl.parentNode) {
            tabsEl.parentNode.insertBefore(askLfBtn, tabsEl);
        } else {
            pg.appendChild(askLfBtn);
        }
    }
    askLfBtn.style.display = admin ? 'inline-flex' : 'none';

    // Compute counts visible to this user (admin = all, else own +
    // requests aimed at them)
    let visible = Object.entries(requests || {}).filter(([, r]) => !!r);
    if (!admin) {
        visible = visible.filter(([, r]) =>
            r.requesterId === loggedInPathId || r.targetId === loggedInPathId);
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

// Nav click already calls setPage('requests'); piggy-back to (re)render
// the page contents.
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

// ════ CHANGE LOG SUBSYSTEM ════
// Applied schedule changes (PTO, on-call/service overrides, recompute,
// request approve/revoke) push a summarized entry into scheduler/changes;
// the Changes page renders them newest-first. Denied requests are NOT
// logged — only actions that mutate scheduler state. Entry shape:
// { kind:'pto'|'oncall'|'service'|'recompute', type:'pto_add'|'pto_remove'|
// 'pto_edit'|'oncall_set'|'oncall_clear'|'service_set'|'service_reset'|
// 'recompute', byPathId, byName, at, summary, details,
// source:'direct'|'request_approved'|'request_revoked'|'recompute',
// requestKey|null, forPathId|null, + type-specific fields (date, scope, …) }

let changes = {};                  // { pushKey: change-entry } from Firebase
let changesReady = false;

// Subscribe to the change log so the page stays live
regListener('scheduler/changes', snap => {
    changes = snap.exists() ? snap.val() : {};
    changesReady = true;

    // If the Changes page is the active page, refresh it live — and count
    // the new entries as seen, since the user is looking right at them.
    const _appEl = document.getElementById('app');
    if (_appEl && _appEl.getAttribute('data-page') === 'changes'
        && typeof renderChangesPage === 'function') {
        renderChangesPage();
        markChangesPageSeen();
    } else {
        // Otherwise light the nav dot if something new affects this user
        updateNavChangesIndicator();
    }
}, err => {
    console.error('Firebase changes error:', err);
});

// ── Summary helpers ── pre-render summaries at write time so the log
// stays readable even if names later change.

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

// ── Core writer ── push one entry; non-fatal on failure (console.error
// only — the schedule change already happened).
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

// ── Scope filter (Mine vs All) ── default: only entries affecting the
// signed-in user, phrased personally; toggle shows the full log.

let activeChangesScope = 'mine'; // 'mine' | 'all'

// Does entry `c` affect `pid`? Conservative: if the entry can't say (e.g.
// service_reset), treat as not-personal so it shows only under "All".
function _chgAffectsUser(c, pid) {
    if (pid === null || pid === undefined) return false;
    if (!c) return false;

    // Direct affected-user marker covers PTO, oncall_set, single-target
    // service_set/service_reset from request flow, and conferences.
    if (c.forPathId === pid) return true;

    // Bulk service edit: assignments is { pathId: serviceId }, cleared is
    // an array of pathIds.
    if (c.kind === 'service' && c.type === 'service_set') {
        const a = c.assignments;
        if (a && Object.prototype.hasOwnProperty.call(a, pid)) return true;
        if (a && Object.prototype.hasOwnProperty.call(a, String(pid))) return true;
        if (Array.isArray(c.cleared)) {
            if (c.cleared.includes(pid) || c.cleared.includes(String(pid))) return true;
        }
    }

    // Recompute: by nature touches everybody's future schedule, so it's
    // relevant to every pathologist.
    if (c.kind === 'recompute') return true;

    return false;
}

// Format a date or date range from a change entry for personal phrasing.
function _chgWhenText(c) {
    // Prefer date range if present; fall back to single date / call-week scope.
    if (c.startDate && c.endDate) return _chgFmtRange(c.startDate, c.endDate);
    if (c.date) {
        if (c.scope === 'week') return `the call week of ${_chgFmtCallWeek(c.date)}`;
        return _chgFmtDate(c.date);
    }
    return '';
}

// Return a user-centric description of how change `c` affects user `pid`.
// Falls back to the original summary if we don't have a tailored phrasing.
function _chgDescribeForUser(c, pid) {
    if (!c) return { summary: '', details: '' };
    const orig = { summary: c.summary || '', details: c.details || '' };
    const when = _chgWhenText(c);
    const sourceTail = c.source === 'request_approved'
        ? ' (your request was approved)'
        : c.source === 'request_revoked'
            ? ' (a prior approval was revoked)'
            : '';

    // PTO
    if (c.kind === 'pto') {
        if (c.forPathId !== pid) return orig;
        const range = (c.startDate && c.endDate) ? _chgFmtRange(c.startDate, c.endDate) : when;
        if (c.type === 'pto_add') {
            return { summary: `PTO added to your schedule for ${range}${sourceTail}.`, details: '' };
        }
        if (c.type === 'pto_remove') {
            return { summary: `PTO removed from your schedule for ${range}${sourceTail}.`, details: '' };
        }
        if (c.type === 'pto_edit') {
            return { summary: `Your PTO dates were updated.`, details: c.details || '' };
        }
    }

    // On-call
    if (c.kind === 'oncall') {
        if (c.type === 'oncall_set' && c.forPathId === pid) {
            return { summary: `You were placed on call for ${when}${sourceTail}.`, details: '' };
        }
        // oncall_clear doesn't carry the old assignee, so we can't personalize
        // it; fall through to the team summary.
    }

    // Service overrides
    if (c.kind === 'service') {
        if (c.type === 'service_set') {
            // Single-target (e.g. approved request)
            if (c.forPathId === pid && c.serviceId !== undefined) {
                const svc = _chgServiceName(c.serviceId);
                if (c.serviceId) {
                    return { summary: `Your service was set to ${svc} for ${when}${sourceTail}.`, details: '' };
                }
                return { summary: `Your service override was cleared for ${when}${sourceTail}.`, details: '' };
            }
            // Bulk edit: check assignments / cleared for this user
            const a = c.assignments || {};
            const has = (k) => Object.prototype.hasOwnProperty.call(a, k);
            const cleared = Array.isArray(c.cleared) ? c.cleared : [];
            const isCleared = cleared.includes(pid) || cleared.includes(String(pid));
            const newSid = has(pid) ? a[pid] : (has(String(pid)) ? a[String(pid)] : undefined);
            if (newSid !== undefined) {
                return { summary: `Your service was set to ${_chgServiceName(newSid)} for ${when}.`, details: '' };
            }
            if (isCleared) {
                return { summary: `Your service override was cleared for ${when}.`, details: '' };
            }
        }
        if (c.type === 'service_reset' && c.forPathId === pid) {
            return { summary: `Your service override was cleared for ${when}${sourceTail}.`, details: '' };
        }
    }

    // Conferences
    if (c.kind === 'conference' && c.forPathId === pid) {
        // Original summary is like "Logged Tumor Board on Jan 5, 2026 for Dr. Smith"
        // Rewrite the trailing "for <name>" to "for you" so it reads personally.
        const me = _pathName(pid);
        const meShort = me.replace(/^Dr\. /, '');
        let s = orig.summary
            .replace(new RegExp(' for ' + me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), ' for you')
            .replace(new RegExp(' for ' + meShort.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), ' for you');
        return { summary: s, details: '' };
    }

    // Recompute: applies to everyone's service schedule. Newer entries
    // carry the actual changed-date range; older ones fall back to the
    // team-wide summary.
    if (c.kind === 'recompute') {
        if (c.startDate && c.endDate) {
            const whenBit = c.startDate === c.endDate
                ? `on ${_chgFmtDate(c.startDate)}`
                : `from ${_chgFmtDate(c.startDate)} to ${_chgFmtDate(c.endDate)}`;
            return { summary: `Your service schedule has been changed ${whenBit}.`, details: '' };
        }
        return orig;
    }

    return orig;
}

function renderChangesPage() {
    const pg = document.getElementById('changesPage');
    if (!pg) return;

    const listEl = document.getElementById('changesList');
    const totalEl = document.getElementById('changesSummaryTotal');
    const labelEl = document.getElementById('changesSummaryLabel');
    const subEl = document.getElementById('changesPageSubtitle');
    const countMineEl = document.getElementById('changesTabCountMine');
    const countAllEl = document.getElementById('changesTabCountAll');
    if (!listEl) return;

    // Non-pathologist accounts can't be change targets — default them to "all".
    const meIsPath = (typeof loggedInPathId === 'number');
    if (!meIsPath && activeChangesScope === 'mine') {
        activeChangesScope = 'all';
    }

    // Lake Forest guest: the log is just sendout entries — no Mine/All
    // split, so the scope tabs are hidden entirely.
    const lfGuest = isLakeForest();
    const tabsWrap = document.getElementById('changesPageTabs');
    if (tabsWrap) tabsWrap.style.display = lfGuest ? 'none' : '';

    const allEntries = Object.entries(changes || {})
        .filter(([, c]) => !!c)
        .filter(([, c]) => !lfGuest || c.kind === 'lf_sendout')
        .sort((a, b) => (b[1].at || 0) - (a[1].at || 0));

    const mineEntries = meIsPath
        ? allEntries.filter(([, c]) => _chgAffectsUser(c, loggedInPathId))
        : [];

    // Keep the tab badges in sync regardless of which view is active
    if (countMineEl) countMineEl.textContent = String(mineEntries.length);
    if (countAllEl) countAllEl.textContent = String(allEntries.length);

    // Reflect the active scope in the tab UI
    const tabs = document.querySelectorAll('#changesPageTabs .req-tab');
    tabs.forEach(btn => {
        const isActive = btn.getAttribute('data-ctab') === activeChangesScope;
        btn.classList.toggle('active', isActive);
    });

    // Disable the "Affecting me" tab for non-pathologist accounts
    const mineTab = document.querySelector('#changesPageTabs .req-tab[data-ctab="mine"]');
    if (mineTab) {
        mineTab.disabled = !meIsPath;
        mineTab.style.opacity = meIsPath ? '' : '0.5';
        mineTab.style.cursor = meIsPath ? '' : 'not-allowed';
        mineTab.title = meIsPath ? '' : 'Sign in as a pathologist to see your personal changes';
    }

    const showMine = (activeChangesScope === 'mine' && meIsPath);
    const entries = showMine ? mineEntries : allEntries;

    // Subtitle + summary stat reflect the active scope
    if (subEl) {
        subEl.textContent = lfGuest
            ? 'Lake Forest sendout updates, newest first.'
            : showMine
                ? 'Recent updates that affect your schedule, newest first.'
                : 'Every recent update to the schedule, newest first.';
    }
    if (labelEl) labelEl.textContent = showMine ? 'Affecting you' : 'Logged';
    if (totalEl) totalEl.textContent = String(entries.length);

    if (entries.length === 0) {
        const emptyHeadline = lfGuest ? 'No sendout updates yet.'
            : showMine ? 'Nothing for you yet.' : 'Nothing yet.';
        const emptyBody = lfGuest
            ? 'Lake Forest sendout changes will appear here as they happen.'
            : showMine
                ? 'Changes that affect your schedule will appear here. Switch to <strong>All changes</strong> to see team-wide updates.'
                : 'Schedule changes will appear here as they happen.';
        listEl.innerHTML = `
            <div class="empty">
                <span class="empty-headline">${emptyHeadline}</span>
                ${emptyBody}
            </div>`;
        return;
    }

    const KIND_LABEL = {
        pto:        'PTO',
        oncall:     'ON-CALL',
        service:    'SERVICE',
        recompute:  'RECOMPUTE',
        lf_sendout: 'LF SENDOUT',
        conference: 'CONFERENCE',
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

        // For the "Mine" view we use personalized phrasing; for "All" we
        // keep the original neutral team-wide summary.
        const display = showMine
            ? _chgDescribeForUser(c, loggedInPathId)
            : { summary: c.summary || '', details: c.details || '' };

        const detailLine = display.details
            ? `<div class="chg-details">${escapeHtml(display.details)}</div>`
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
                    <div class="chg-summary">${escapeHtml(display.summary)}</div>
                    <span class="chg-kind">${escapeHtml(kindLabel)}</span>
                </div>
                ${detailLine}
                <div class="chg-meta">${metaMain}${sourceHtml}</div>
            </div>`;
    }).join('');
}

// Expose so other code (e.g. login flow) can refresh the page on demand
window.__renderChangesPage = renderChangesPage;

// Wire up the scope tabs (Affecting me / All changes)
document.querySelectorAll('#changesPageTabs .req-tab').forEach(btn => {
    btn.addEventListener('click', () => {
        if (btn.disabled) return;
        const scope = btn.getAttribute('data-ctab');
        if (scope !== 'mine' && scope !== 'all') return;
        if (scope === activeChangesScope) return;
        activeChangesScope = scope;
        renderChangesPage();
    });
});

// Re-render the page when the user clicks the Changes nav item, just like
// the requests page does (defer a tick so setPage un-hides the shell first)
document.querySelectorAll('.nav-item[data-page="changes"]').forEach(btn => {
    btn.addEventListener('click', () => {
        // Mark changes seen before re-rendering so the nav dot clears at
        // the same moment the content appears (no flash of old dot).
        markChangesPageSeen();
        setTimeout(renderChangesPage, 0);
    });
});

// ════ CONFERENCE TRACKER SUBSYSTEM ════
// Counts conference presentations per pathologist. scheduler/conferenceLog
// entries: { pathologistId, type:'breast'|'lung'|'thoracic'|'cdh'|'other',
// date:'YYYY-MM-DD', subtype (cdh only), otherTitle (other only), note?,
// createdAt, createdBy }. Editing: admin or anyone in
// scheduler/conferencePresenters. Page = summary grid + per-type tabs +
// entries list, all scoped to the selected academic-year period.

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

// Consult rotation log; "next up" cycles past the most recent entry's
// recipient. Shape: { date, source, pathologistId,
// caseNumber:'MHSC26-0001', createdAt, createdBy }
let consultLog = {};                  // { pushKey: entry }

// ── UI state ─────────────────────────────────────────────────────────────
let activeTrackingTab = 'breast';
// Period filter: '<startYearShort>' string like '2025' (= academic year
// Sept 2025 – Aug 2026), or 'all' for no filter.
let trackingPeriod = null;            // set on first render

// ── Firebase subscriptions ───────────────────────────────────────────────
regListener('scheduler/conferenceLog', snap => {
    conferenceLog = snap.exists() ? snap.val() : {};
    conferenceLogReady = true;
    const _appEl = document.getElementById('app');
    if (_appEl && _appEl.getAttribute('data-page') === 'tracking'
        && typeof renderTrackingPage === 'function') {
        renderTrackingPage();
    }
    // Conferences also render on week/day procedure grids — repaint those on
    // log changes (month/year are summary-only).
    if (pathologistsReady && vacationsReady
        && (typeof view !== 'undefined') && (view === 'week' || view === 'day')
        && typeof renderMain === 'function') {
        renderMain();
    }
}, err => {
    console.error('Firebase conferenceLog error:', err);
});

// Consult log — only the tracking page shows consults, so a change just
// repaints that page when it's active.
regListener('scheduler/consultLog', snap => {
    consultLog = snap.exists() ? snap.val() : {};
    const _appEl = document.getElementById('app');
    if (_appEl && _appEl.getAttribute('data-page') === 'tracking'
        && typeof renderTrackingPage === 'function') {
        renderTrackingPage();
    }
}, err => {
    console.error('Firebase consultLog error:', err);
});

regListener('scheduler/conferencePresenters', snap => {
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

// ── Permission helper ── admin, or in the conferencePresenters
// allow-list; gross room never.
function canEditConferences(pathId) {
    const id = (pathId !== undefined && pathId !== null) ? pathId : loggedInPathId;
    if (id === null || id === undefined) return false;
    if (id === GROSS_ROOM_ID) return false;
    if (id === HISTOLOGY_ID) return false;
    if (id === LAKE_FOREST_ID) return false;
    if (id === MANAGER_ID) return true;
    if (isAdmin(id)) return true;
    return !!(conferencePresenters && conferencePresenters[id]);
}

// ── Consult rotation helpers ── tighter gate: only Kathleen or the admin.
function canEditConsults(pathId) {
    const id = (pathId !== undefined && pathId !== null) ? pathId : loggedInPathId;
    if (id === null || id === undefined) return false;
    if (id === MANAGER_ID) return true;
    return isAdmin(id);
}

// Case numbers look like MHSC26-0001: 'MHSC' + 2-digit calendar year of
// the date received + a 4-digit sequence that starts at 0001 each year
// and goes up by one per logged consult.
const CONSULT_CASE_RE = /^MHSC(\d{2})-(\d{4})$/;

function consultCaseYearDigits(dateKey) {
    const d = parseDate(dateKey);
    const y = (d && !isNaN(d)) ? d.getFullYear() : new Date().getFullYear();
    return String(y % 100).padStart(2, '0');
}

// Next case number for the year: one past the highest logged sequence (no
// reuse after deletions). `excludeKey` skips the entry being edited.
function suggestConsultCaseNumber(dateKey, excludeKey) {
    const yy = consultCaseYearDigits(dateKey);
    let maxN = 0;
    Object.entries(consultLog || {}).forEach(([key, e]) => {
        if (!e || (excludeKey && key === excludeKey)) return;
        const m = CONSULT_CASE_RE.exec(String(e.caseNumber || '').trim().toUpperCase());
        if (m && m[1] === yy) {
            const n = parseInt(m[2], 10);
            if (Number.isFinite(n) && n > maxN) maxN = n;
        }
    });
    return 'MHSC' + yy + '-' + String(maxN + 1).padStart(4, '0');
}

// Next up = whoever follows the most recent consult's recipient in
// `pathologists` order (no entries → first). A suggestion only — the logger
// can pick someone else and the pointer continues from there.
function nextConsultPathologist() {
    if (!pathologists || pathologists.length === 0) return null;
    const entries = Object.values(consultLog || {})
        .filter(e => e && e.date && e.pathologistId !== undefined);
    if (entries.length === 0) return pathologists[0];
    entries.sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        return (b.createdAt || 0) - (a.createdAt || 0);
    });
    const lastPid = entries[0].pathologistId;
    const idx = pathologists.findIndex(p => String(p.id) === String(lastPid));
    return pathologists[(idx + 1) % pathologists.length];   // idx -1 → [0]
}

// Consults matching the tracking-page period filter (same fiscal-year
// semantics as conferences), newest first.
function getFilteredConsults() {
    const entries = Object.entries(consultLog || {})
        .filter(([, e]) => !!e && e.date && e.pathologistId !== undefined);
    let filtered = entries;
    if (trackingPeriod !== null && trackingPeriod !== 'all') {
        const yr = parseInt(trackingPeriod, 10);
        if (Number.isFinite(yr)) {
            filtered = entries.filter(([, e]) => getAcademicYearOfKey(e.date) === yr);
        }
    }
    return filtered.sort((a, b) => {
        if (a[1].date !== b[1].date) return a[1].date < b[1].date ? 1 : -1;
        return (b[1].createdAt || 0) - (a[1].createdAt || 0);
    });
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

// ── Filtered-entries cache ── {key, entry} pairs for the current period,
// newest first.
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

// ── PTO usage tracker (left column) ── per-pathologist working days used
// in the selected fiscal year vs allotted; 'all' shows lifetime with no
// denominator (allotments are per-year).
function renderTrackingPto() {
    const listEl = document.getElementById('trackingPtoList');
    const periodLabelEl = document.getElementById('trackingPtoPeriod');
    if (!listEl) return;

    if (!pathologists || pathologists.length === 0) {
        listEl.innerHTML = '<div class="tracking-pto-empty">No pathologists loaded.</div>';
        if (periodLabelEl) periodLabelEl.textContent = '';
        return;
    }

    // Determine the range to count over from the active period filter.
    // For 'all', leave the range unbounded and skip the allotted denominator.
    let range = null;
    let fiscalYear = null;
    let periodLabel = '';
    let showAllotted = true;
    if (trackingPeriod === 'all') {
        showAllotted = false;
        periodLabel = 'All time';
    } else {
        const yr = parseInt(trackingPeriod, 10);
        if (Number.isFinite(yr)) {
            range = getFiscalYearRange(yr);
            fiscalYear = yr;
            periodLabel = 'Sep ' + yr + ' – Aug ' + (yr + 1);
        }
    }
    if (periodLabelEl) periodLabelEl.textContent = periodLabel;

    listEl.innerHTML = pathologists.map(p => {
        const used = ptoDaysScheduled(p.id, range ? { start: range.start, end: range.end } : undefined);
        // Allotments are per fiscal year (legacy value = fallback default) —
        // resolve against the selected period.
        const allot = fiscalYear !== null ? ptoAllotmentFor(p.id, fiscalYear) : 0;
        const lastName = (p.name || '').replace(/^Dr\.\s*/, '').split(/\s+/).pop() || p.name;

        let pctRaw = (showAllotted && allot > 0) ? (used / allot) : 0;
        if (!Number.isFinite(pctRaw)) pctRaw = 0;
        const pct = Math.max(0, Math.min(1, pctRaw));
        const isOver = showAllotted && allot > 0 && used > allot;

        const numbersHtml = showAllotted
            ? `<span class="tracking-pto-numbers${isOver ? ' is-over' : ''}">
                   <span class="tracking-pto-used">${used}</span>
                   <span class="tracking-pto-allot"> / ${allot} days</span>
               </span>`
            : `<span class="tracking-pto-numbers">
                   <span class="tracking-pto-used">${used}</span>
                   <span class="tracking-pto-allot"> days</span>
               </span>`;

        const barHtml = showAllotted
            ? `<div class="tracking-pto-bar" aria-hidden="true">
                   <div class="tracking-pto-bar-fill${isOver ? ' is-over' : ''}" style="width:${(pct * 100).toFixed(1)}%;"></div>
               </div>`
            : '';

        return `
            <div class="tracking-pto-row" style="--c:${p.color};" title="Dr. ${escapeHtml(lastName)} — ${used}${showAllotted ? ' of ' + allot : ''} working days of PTO">
                <span class="tracking-pto-dot" aria-hidden="true"></span>
                <span class="tracking-pto-name">Dr. ${escapeHtml(lastName)}</span>
                ${numbersHtml}
                ${barHtml}
            </div>`;
    }).join('');
}

// ── Holiday call tracker ─────────────────────────────────────────────────
// Who is on call for each of the six federal holidays from the fixed start
// of FY26 (Sept 1, 2025) through 12 months from today — past holidays stay
// counted forever, upcoming ones are projected from the rotation, but never
// more than a year ahead. Independent of the Period selector. Derived from
// onCallIdForDay (rotation + overrides), so swaps credit the actual coverer;
// nothing is logged by hand. Counted on the true calendar date (July 4 even
// on a Saturday — weekly call covers weekends).
const HOLIDAY_CALL_START = new Date(2025, 8, 1);   // Sept 1, 2025 (month 0-indexed)

// Six federal holidays in calendar order (Jan → Dec). `name` matches what
// getActualFederalHoliday returns; `label` is the column heading. Single
// source of truth for both the header row and the per-holiday columns, so a
// count can never land under the wrong holiday.
const HOLIDAY_ORDER = [
    { name: "New Year's Day",   label: 'New Year' },
    { name: 'Memorial Day',     label: 'Memorial' },
    { name: 'Independence Day', label: 'July 4' },
    { name: 'Labor Day',        label: 'Labor Day' },
    { name: 'Thanksgiving',     label: 'Thanksgiving' },
    { name: 'Christmas Day',    label: 'Christmas' },
];

// Every actual federal holiday from HOLIDAY_CALL_START (Sept 1, 2025)
// through 12 months from today, resolved to whoever is on call that date:
// [{ date, name, pathId }]. `now` is injectable for tests; omit it in
// app code.
function holidayCallEntries(now) {
    const today = now ? new Date(now) : new Date();
    today.setHours(0, 0, 0, 0);
    const end = new Date(today);
    end.setFullYear(end.getFullYear() + 1);
    const out = [];
    for (let d = new Date(HOLIDAY_CALL_START); d <= end; d = addDays(d, 1)) {
        const name = getActualFederalHoliday(d);
        if (name) out.push({ date: new Date(d), name: name, pathId: onCallIdForDay(d) });
    }
    return out;
}

// Matrix view: one row per pathologist, one column per holiday, each cell a
// count of holidays that person has covered. A trailing Total sums the row.
// Header and columns both come from HOLIDAY_ORDER (see above).
function renderTrackingHolidayCall() {
    const headEl = document.getElementById('trackingHolidayHead');
    const bodyEl = document.getElementById('trackingHolidayBody');
    const capEl = document.getElementById('trackingHolidayPeriod');
    if (!bodyEl) return;

    if (capEl) {
        const end = new Date();
        end.setFullYear(end.getFullYear() + 1);
        capEl.textContent = 'Sep 1, 2025 – ' + MONTHS_SHORT[end.getMonth()] + ' '
            + end.getDate() + ', ' + end.getFullYear() + ' · includes upcoming call';
    }

    // Header row: Pathologist | <each holiday> | Total.
    if (headEl) {
        headEl.innerHTML =
            '<th class="t-sum-name-col">Pathologist</th>' +
            HOLIDAY_ORDER.map(h => `<th>${escapeHtml(h.label)}</th>`).join('') +
            '<th class="t-sum-total-col">Total</th>';
    }

    if (!pathologists || pathologists.length === 0) {
        bodyEl.innerHTML = `<tr><td class="t-sum-empty" colspan="${HOLIDAY_ORDER.length + 2}">No pathologists loaded.</td></tr>`;
        return;
    }

    const entries = holidayCallEntries();

    // (pathId → { holidayName → count, total }); a separate `former` bucket
    // collects holidays credited to ids no longer in the roster (departed
    // staff still named by old overrides) so the tally is surfaced, not lost.
    const counts = {};
    pathologists.forEach(p => { counts[p.id] = { total: 0 }; });
    const former = { total: 0 };
    entries.forEach(e => {
        const bucket = counts[e.pathId] || former;
        bucket[e.name] = (bucket[e.name] || 0) + 1;
        bucket.total += 1;
    });

    const rowFor = (label, initials, color, bucket, extraCls) => {
        const cells = HOLIDAY_ORDER.map(h => {
            const n = bucket[h.name] || 0;
            return `<td class="${n === 0 ? 't-sum-zero' : ''}">${n}</td>`;
        }).join('');
        const initialsHtml = initials
            ? `<span class="t-sum-initials">${escapeHtml(initials)}</span>` : '';
        return `
            <tr class="${extraCls}">
                <td class="t-sum-name" style="--c:${color};">
                    <span class="t-sum-dot"></span>
                    <span>${escapeHtml(label)}</span>
                    ${initialsHtml}
                </td>
                ${cells}
                <td class="t-sum-total">${bucket.total}</td>
            </tr>`;
    };

    let html = pathologists.map(p => {
        const lastName = (p.name || '').replace(/^Dr\.\s*/, '').split(/\s+/).pop() || p.name;
        return rowFor('Dr. ' + lastName, p.initials || '', p.color, counts[p.id], '');
    }).join('');

    if (former.total > 0) {
        html += rowFor('Former staff', '', 'var(--rule)', former, 'tracking-hc-former');
    }

    bodyEl.innerHTML = html;
}

// ── Summary count grid ───────────────────────────────────────────────────
function renderTrackingSummary(filteredEntries, filteredConsults) {
    const body = document.getElementById('trackingSummaryBody');
    if (!body) return;

    if (!pathologists || pathologists.length === 0) {
        body.innerHTML = '';
        return;
    }

    // Build a (pathId, type) → count map
    const counts = {};
    pathologists.forEach(p => {
        counts[p.id] = { breast: 0, lung: 0, thoracic: 0, cdh: 0, other: 0, total: 0, consult: 0 };
    });
    filteredEntries.forEach(([, e]) => {
        const c = counts[e.pathologistId];
        if (!c) return;
        if (CONF_TYPE_BY_ID[e.type]) {
            c[e.type] = (c[e.type] || 0) + 1;
            c.total += 1;
        }
    });
    // Consults tally separately (they aren't presentations, so they don't
    // feed the presentation Total — the column shows rotation fairness).
    (filteredConsults || []).forEach(([, e]) => {
        const c = counts[e.pathologistId];
        if (c) c.consult += 1;
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
                <td class="t-sum-consult${c.consult === 0 ? ' t-sum-zero' : ''}">${c.consult}</td>
            </tr>`;
    }).join('');
}

// ── Tab counts ───────────────────────────────────────────────────────────
function renderTrackingTabCounts(filteredEntries, consultCount) {
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
    set('trackingTabCountConsult', consultCount || 0);
}

// ── Entries list (per active tab) ────────────────────────────────────────
function renderTrackingEntries(filteredEntries) {
    const listEl = document.getElementById('trackingEntries');
    if (!listEl) return;

    // ── Consults tab: its own entry shape (case number + source) ──
    if (activeTrackingTab === 'consult') {
        const consults = getFilteredConsults();
        const editable = canEditConsults();

        if (consults.length === 0) {
            listEl.innerHTML = `
                <div class="empty">
                    <span class="empty-headline">No consults yet.</span>
                    Logged consult cases will appear here.
                </div>`;
            return;
        }

        listEl.innerHTML = consults.map(([key, e]) => {
            const p = pathologists.find(x => String(x.id) === String(e.pathologistId));
            const dateLabel = (function () {
                try {
                    const d = parseDate(e.date);
                    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
                } catch (_) {
                    return e.date;
                }
            })();
            const who = p ? p.name : 'Unknown pathologist';
            const color = p ? p.color : 'var(--ink-3)';

            const metaParts = [];
            if (e.caseNumber) {
                metaParts.push(`<span class="te-case">${escapeHtml(e.caseNumber)}</span>`);
            }
            if (e.source) {
                metaParts.push(`<span class="te-source">from ${escapeHtml(e.source)}</span>`);
            }
            const metaHtml = metaParts.length
                ? `<div class="te-meta">${metaParts.join(' ')}</div>`
                : '';

            const editBtn = editable
                ? `<button class="te-edit-btn" data-consult-edit="${escapeHtml(key)}" type="button">Edit</button>`
                : '';

            return `
                <div class="tracking-entry" style="--c:${color};">
                    <div class="te-date">${escapeHtml(dateLabel)}</div>
                    <div class="te-main">
                        <div class="te-presenter">
                            <span class="te-dot"></span>
                            <span>${escapeHtml(who)}</span>
                        </div>
                        ${metaHtml}
                    </div>
                    ${editBtn}
                </div>`;
        }).join('');
        return;
    }

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

// ── Consult rotation card (left column) ── full cycle order, next
// recipient highlighted; "Log a consult" only for Kathleen / admin.
function renderConsultNext() {
    const card = document.getElementById('consultNextCard');
    const addBtn = document.getElementById('consultAddBtn');
    if (!card) return;

    if (addBtn) addBtn.style.display = canEditConsults() ? '' : 'none';

    if (!pathologists || pathologists.length === 0) {
        card.innerHTML = '';
        return;
    }

    const next = nextConsultPathologist();
    const nextId = next ? next.id : null;

    const chips = pathologists.map((p, i) => {
        const isNext = String(p.id) === String(nextId);
        const arrow = i < pathologists.length - 1
            ? '<span class="consult-rot-arrow" aria-hidden="true">›</span>'
            : '';
        return `<span class="consult-rot-chip${isNext ? ' is-next' : ''}"
                    style="--c:${p.color};"
                    title="${escapeHtml(p.name)}${isNext ? ' — next up' : ''}">${escapeHtml(p.initials || '')}</span>${arrow}`;
    }).join('');

    const nextLine = next
        ? `<div class="consult-next-line">Next consult
               <span class="consult-next-arrow" aria-hidden="true">→</span>
               <strong style="--c:${next.color};">${escapeHtml(next.name)}</strong>
           </div>`
        : '';

    card.innerHTML = `
        <div class="consult-rot-strip" title="Rotation order — cycles back to the start after the last pathologist">${chips}</div>
        ${nextLine}`;
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
    const filteredConsults = getFilteredConsults();
    renderConsultNext();
    renderTrackingSummary(filtered, filteredConsults);
    renderTrackingTabCounts(filtered, filteredConsults.length);
    renderTrackingEntries(filtered);
    renderTrackingPto();
    renderTrackingHolidayCall();
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
        const consultBtn = e.target.closest('[data-consult-edit]');
        if (consultBtn) {
            if (!canEditConsults()) return;
            openConsultModal(consultBtn.getAttribute('data-consult-edit'));
            return;
        }
        const btn = e.target.closest('[data-conf-edit]');
        if (!btn) return;
        if (!canEditConferences()) return;
        openConferenceModal(btn.getAttribute('data-conf-edit'));
    });
})();

// ── Consult modal (add/edit/delete) ── pathologist prefilled from the
// rotation; case number prefilled with the next MHSC<yy>-<nnnn> for the
// date's year, regenerated on date change until hand-edited.
let _editingConsultKey = null;

function openConsultModal(editKey) {
    if (!canEditConsults()) return;

    const back = document.getElementById('consultModalBack');
    if (!back) return;

    const titleEl = document.getElementById('consultModalTitle');
    const subEl = document.getElementById('consultModalSub');
    const dateInput = document.getElementById('consultDate');
    const sourceInput = document.getElementById('consultSource');
    const pathSel = document.getElementById('consultPathologist');
    const hintEl = document.getElementById('consultRotationHint');
    const caseInput = document.getElementById('consultCaseNumber');
    const deleteBtn = document.getElementById('consultDelete');
    const saveBtn = document.getElementById('consultSave');
    const errEl = document.getElementById('consultFormError');

    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

    // Fresh pathologist options each open
    pathSel.innerHTML = pathologists
        .map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
        .join('');

    if (editKey && consultLog[editKey]) {
        // ── Edit an existing consult ──
        _editingConsultKey = editKey;
        const e = consultLog[editKey];
        titleEl.textContent = 'Edit consult';
        if (subEl) subEl.textContent = 'Update or remove this consult case.';
        saveBtn.textContent = 'Save changes';
        deleteBtn.style.display = '';

        dateInput.value = e.date || '';
        sourceInput.value = e.source || '';
        pathSel.value = String(e.pathologistId);
        caseInput.value = e.caseNumber || '';
        caseInput.dataset.userEdited = '1';   // don't overwrite on date change
        if (hintEl) hintEl.textContent = '';
    } else {
        // ── Log a new consult ──
        _editingConsultKey = null;
        titleEl.textContent = 'Log a consult';
        if (subEl) subEl.textContent = 'Record an incoming consult case and who takes it.';
        saveBtn.textContent = 'Add consult';
        deleteBtn.style.display = 'none';

        const todayKey = fmt(new Date());
        dateInput.value = todayKey;
        sourceInput.value = '';
        const next = nextConsultPathologist();
        if (next) pathSel.value = String(next.id);
        if (hintEl) {
            hintEl.textContent = next
                ? 'Rotation suggests ' + next.name + ' — pick someone else to skip them this round.'
                : '';
        }
        caseInput.value = suggestConsultCaseNumber(todayKey, null);
        delete caseInput.dataset.userEdited;
    }

    back.classList.add('open');
    setTimeout(() => sourceInput.focus(), 50);
}

// Date changed → refresh the suggested case number for that year, unless
// the admin already typed their own.
document.getElementById('consultDate').addEventListener('change', () => {
    const caseInput = document.getElementById('consultCaseNumber');
    const dateVal = document.getElementById('consultDate').value;
    if (!dateVal || !caseInput || caseInput.dataset.userEdited === '1') return;
    caseInput.value = suggestConsultCaseNumber(dateVal, _editingConsultKey);
});
document.getElementById('consultCaseNumber').addEventListener('input', e => {
    e.target.dataset.userEdited = '1';
});

document.getElementById('consultSave').addEventListener('click', async () => {
    if (!canEditConsults()) return;

    const dateVal = document.getElementById('consultDate').value;
    const sourceVal = (document.getElementById('consultSource').value || '').trim();
    const pidVal = parseInt(document.getElementById('consultPathologist').value, 10);
    const caseInput = document.getElementById('consultCaseNumber');
    const caseVal = String(caseInput.value || '').trim().toUpperCase();
    const errEl = document.getElementById('consultFormError');

    function fail(msg) {
        if (errEl) { errEl.textContent = msg; errEl.style.display = ''; }
    }

    if (!dateVal) { fail('Please pick the date the consult was received.'); return; }
    if (!Number.isFinite(pidVal)) { fail('Please pick a pathologist.'); return; }
    if (!CONSULT_CASE_RE.test(caseVal)) {
        fail('Case number must look like MHSC26-0001 (MHSC + 2-digit year + dash + 4-digit number).');
        return;
    }
    // No two consults may share a case number.
    const dup = Object.entries(consultLog || {}).find(([key, e]) =>
        e && key !== _editingConsultKey
        && String(e.caseNumber || '').trim().toUpperCase() === caseVal);
    if (dup) { fail('Case number ' + caseVal + ' is already logged.'); return; }

    caseInput.value = caseVal;   // reflect normalization (uppercasing)

    try {
        if (_editingConsultKey) {
            await db.ref('scheduler/consultLog/' + _editingConsultKey).update({
                date: dateVal,
                source: sourceVal || null,
                pathologistId: pidVal,
                caseNumber: caseVal,
            });
            showToast('Consult updated.');
        } else {
            await db.ref('scheduler/consultLog').push({
                date: dateVal,
                source: sourceVal || null,
                pathologistId: pidVal,
                caseNumber: caseVal,
                createdAt: Date.now(),
                createdBy: loggedInPathId,
            });
            showToast('Consult logged — ' + caseVal + '.');
        }
        document.getElementById('consultModalBack').classList.remove('open');
    } catch (err) {
        console.error('consult save error:', err);
        fail('Save failed: ' + (err.message || err));
    }
});

document.getElementById('consultDelete').addEventListener('click', async () => {
    if (!canEditConsults() || !_editingConsultKey) return;
    const e = consultLog[_editingConsultKey];
    const label = e && e.caseNumber ? e.caseNumber : 'this consult';
    if (!confirm('Delete ' + label + '? This cannot be undone.')) return;
    try {
        await db.ref('scheduler/consultLog/' + _editingConsultKey).remove();
        showToast('Consult deleted.');
        document.getElementById('consultModalBack').classList.remove('open');
    } catch (err) {
        console.error('consult delete error:', err);
        showToast('Delete failed: ' + (err.message || err), { type: 'error' });
    }
});

document.getElementById('consultCancel').addEventListener('click', () => {
    document.getElementById('consultModalBack').classList.remove('open');
});
document.getElementById('consultModalBack').addEventListener('click', e => {
    if (e.target.id === 'consultModalBack') e.target.classList.remove('open');
});

// "Log a consult" button in the tracking page's left column
(function wireConsultAddBtn() {
    const btn = document.getElementById('consultAddBtn');
    if (!btn) return;
    btn.addEventListener('click', () => openConsultModal(null));
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

// ── Conference time helpers ── default start ("HH:MM") by type + date:
// breast/lung → 12:00; Morning/CDH → 7:00 Fri; others 7:30 — except no 7:30
// conferences exist on Fridays, so non-breast Friday conferences default to
// 7:00. Invalid/empty dateStr → treated as a non-Friday weekday.
function defaultConfTime(type, dateStr) {
    if (type === 'breast' || type === 'lung') return '12:00';

    let isFriday = false;
    if (dateStr) {
        try {
            const d = parseDate(dateStr);
            if (d && !isNaN(d.getTime())) isFriday = (d.getDay() === 5);
        } catch (_) { /* leave isFriday false */ }
    }
    // Friday: no 7:30 AM slot exists, so every non-breast conference is 7:00 AM
    // (this also covers the Morning/CDH Heme-on-Friday case).
    if (isFriday) return '07:00';
    return '07:30';
}

// Effective start time: the entry's own valid `time`, else the type+date
// default (keeps pre-time-tracking entries rendering sensibly).
function effectiveConfTime(entry) {
    if (entry && typeof entry.time === 'string' && /^\d{2}:\d{2}$/.test(entry.time)) {
        return entry.time;
    }
    return defaultConfTime(entry && entry.type, entry && entry.date);
}

// Flat array of the day's conference entries { key, time, type, subtype,
// otherTitle, note, pathologistId, label }. Personal to the presenter:
// shown only on the signed-in presenter's own schedule (Group AND
// Individual views), never to other users; non-pathologist accounts see none.
function getConferencesForDay(dayKey) {
    // Resolve the signed-in pathologist. Special non-pathologist accounts
    // (string ids) have no personal conferences.
    const meId = (typeof loggedInPathId === 'number') ? loggedInPathId : null;
    if (meId === null) return [];

    const out = [];
    Object.entries(conferenceLog || {}).forEach(([key, e]) => {
        if (!e || e.date !== dayKey) return;
        // Only the presenter sees their own conference on the schedule.
        if (Number(e.pathologistId) !== meId) return;
        out.push({
            key,
            time: effectiveConfTime(e),
            type: e.type,
            subtype: e.subtype || null,
            otherTitle: e.otherTitle || null,
            note: e.note || null,
            pathologistId: e.pathologistId,
            label: confScheduleLabel(e),
        });
    });
    return out.sort((a, b) => a.time.localeCompare(b.time));
}

// Short label for a conference pill on the schedule, e.g. "Breast Conf",
// "Morning/CDH (Heme)", or "Tumor Board — NMH Gyn Onc".
function confScheduleLabel(e) {
    const meta = CONF_TYPE_BY_ID[e.type];
    if (e.type === 'cdh') {
        return 'Morning/CDH' + (e.subtype ? ` (${e.subtype})` : '');
    }
    if (e.type === 'other') {
        return 'Tumor Board' + (e.otherTitle ? ` — ${e.otherTitle}` : '');
    }
    if (e.type === 'breast') return 'Breast Conf';
    if (e.type === 'lung') return 'Lung Conf';
    if (e.type === 'thoracic') return 'Thoracic Conf';
    return (meta && meta.singular) || 'Conference';
}

// ── Conference modal: open / close / save / delete ───────────────────────
// Track which entry is being edited (null when adding a new one)
let _editingConferenceKey = null;

// Paints the "Schedule for this day" panel in the conference modal: one
// row per pathologist with their service/PTO/on-call for #confDate;
// selected presenter highlighted; rows clickable. Handles
// weekend/holiday/pre-cutoff dates.
function renderConferenceDaySchedule() {
    const panel = document.getElementById('confDaySchedule');
    const dateInput = document.getElementById('confDate');
    const pathSel = document.getElementById('confPathologist');
    if (!panel || !dateInput) return;

    const dateStr = dateInput.value;
    if (!dateStr) {
        panel.innerHTML = `<div class="conf-day-schedule-empty">Pick a date to see who's on which service.</div>`;
        return;
    }

    let date;
    try { date = parseDate(dateStr); } catch (_) { date = null; }
    if (!date || isNaN(date.getTime())) {
        panel.innerHTML = `<div class="conf-day-schedule-empty">Pick a date to see who's on which service.</div>`;
        return;
    }

    const selectedPathId = pathSel ? parseInt(pathSel.value, 10) : NaN;
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
    const monthShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getMonth()];
    const dateLabel = `${dow}, ${monthShort} ${date.getDate()}`;

    // Pre-cutoff date: nothing to show, all assignments are blank.
    if (isBeforeEarliest(date)) {
        panel.innerHTML = `
            <div class="conf-day-schedule-head">
                <span class="conf-day-schedule-title">Schedule for this day</span>
                <span class="conf-day-schedule-date">${dateLabel}</span>
            </div>
            <div class="conf-day-schedule-empty">This date is before the scheduling start.</div>
        `;
        return;
    }

    const holiday = getFederalHoliday(date);
    const we = isWeekend(date);
    let badgeHtml = '';
    if (holiday) badgeHtml = ` <span class="conf-day-badge" title="${escapeHtml(holiday)}">${escapeHtml(holiday)}</span>`;
    else if (we) badgeHtml = ` <span class="conf-day-badge">Weekend</span>`;

    const assignments = getDayAssignments(date);

    const rows = pathologists.map(p => {
        const a = assignments[p.id] || { type: 'off', service: null, onCall: false };
        const isSelected = p.id === selectedPathId;
        const oc = a.onCall ? '<span class="conf-day-oc">On Call</span>' : '';

        let svcHtml;
        if (a.type === 'service' && a.service) {
            svcHtml = `<span class="conf-day-svc" style="--sc:var(${a.service.cssVar})"><span class="swatch"></span>${escapeHtml(a.service.short)}${oc}</span>`;
        } else if (a.type === 'off_site' && a.service) {
            svcHtml = `<span class="conf-day-svc off-site" style="--sc:var(${a.service.cssVar})"><span class="swatch"></span>${escapeHtml(a.service.short)}${oc}</span>`;
        } else if (a.type === 'pto') {
            svcHtml = `<span class="conf-day-svc pto">PTO${oc}</span>`;
        } else if (a.type === 'off') {
            svcHtml = `<span class="conf-day-svc off">${(we || holiday) ? 'Off' : 'Unstaffed'}${oc}</span>`;
        } else {
            svcHtml = `<span class="conf-day-svc off">—${oc}</span>`;
        }

        // Last word of name, with "Dr." prefix stripped, gives a clean label.
        const cleanedName = (p.name || '').replace(/^Dr\.\s*/, '');
        const lastName = cleanedName.split(/\s+/).slice(-1)[0] || p.initials || '';
        const cbg = pathBgColor(p.color);
        const rowStyle = `--c:${p.color}${cbg ? `; --c-bg:${cbg}` : ''}`;

        return `<div class="conf-day-schedule-row${isSelected ? ' selected' : ''}" data-pid="${p.id}" style="${rowStyle}">
            <span class="conf-day-pid">${escapeHtml(p.initials || '')}</span>
            <span class="conf-day-name">${escapeHtml(lastName)}</span>
            ${svcHtml}
        </div>`;
    }).join('');

    panel.innerHTML = `
        <div class="conf-day-schedule-head">
            <span class="conf-day-schedule-title">Schedule for this day</span>
            <span class="conf-day-schedule-date">${dateLabel}${badgeHtml}</span>
        </div>
        <div class="conf-day-schedule-list">${rows}</div>
    `;

    // Row click sets the presenter; dispatching 'change' re-paints the panel.
    panel.querySelectorAll('.conf-day-schedule-row').forEach(row => {
        row.addEventListener('click', () => {
            const pid = row.getAttribute('data-pid');
            if (!pid || !pathSel) return;
            if (pathologists.some(p => String(p.id) === pid)) {
                pathSel.value = pid;
                pathSel.dispatchEvent(new Event('change'));
            }
        });
    });
}

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
    const timeInput = document.getElementById('confTime');
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
        if (timeInput) { timeInput.value = effectiveConfTime(e); timeInput.dataset.userEdited = '1'; }
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
        // Autofill the time placeholder per the standing conference schedule.
        if (timeInput) {
            const _t = defaultConfTime(_confType, fmt(_predDate));
            timeInput.value = _t;
            timeInput.placeholder = formatTime12(_t);
            timeInput.dataset.userEdited = '';
        }
        const _bigsId = getBigsPathForDate(_predDate);
        if (_bigsId !== null && pathologists.some(p => p.id === _bigsId)) {
            pathSel.value = String(_bigsId);
        } else if (pathologists.length) {
            pathSel.value = String(pathologists[0].id);
        }
    }

    syncConferenceTypeFields();

    // Final guarantee of a valid HH:MM before the modal shows, however it was
    // opened: edits keep the stored time; new entries derive the standing
    // default from type + date.
    if (timeInput) {
        if (_editingConferenceKey && conferenceLog[_editingConferenceKey]) {
            timeInput.value = effectiveConfTime(conferenceLog[_editingConferenceKey]);
        } else if (!/^\d{2}:\d{2}$/.test(timeInput.value || '')) {
            const _t = defaultConfTime(typeSel.value, dateInput.value);
            timeInput.value = _t;
            timeInput.placeholder = formatTime12(_t);
        }
    }

    renderConferenceDaySchedule();
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
    const timeInput = document.getElementById('confTime');
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
    // Time: use the entered value when valid, otherwise fall back to the
    // standing default for this conference type + date.
    let time = (timeInput && timeInput.value) ? timeInput.value : '';
    if (!/^\d{2}:\d{2}$/.test(time)) time = defaultConfTime(type, date);

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
        time,
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
                await logChange({ kind: 'conference', summary, source: 'direct', forPathId: pathId });
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
                await logChange({ kind: 'conference', summary, source: 'direct', forPathId: pathId });
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
                await logChange({ kind: 'conference', summary, source: 'direct', forPathId: existing.pathologistId });
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

    // Live-update the panel on date/presenter change (listeners attach once;
    // openConferenceModal paints first).
    const confDateEl = document.getElementById('confDate');
    const confPathEl = document.getElementById('confPathologist');
    const confTimeEl = document.getElementById('confTime');

    // Re-apply the standing default on type/date change — skipped for edits
    // and once the user touches the time field.
    function reapplyDefaultConfTime() {
        if (_editingConferenceKey) return;
        if (confTimeEl && confTimeEl.dataset.userEdited === '1') return;
        if (!confTimeEl || !typeSel || !confDateEl) return;
        const t = defaultConfTime(typeSel.value, confDateEl.value);
        confTimeEl.value = t;
        confTimeEl.placeholder = formatTime12(t);
    }

    // Note when the user edits the time directly so autofill stops overriding.
    if (confTimeEl) {
        confTimeEl.addEventListener('input', () => { confTimeEl.dataset.userEdited = '1'; });
    }

    if (confDateEl) {
        confDateEl.addEventListener('change', () => {
            reapplyDefaultConfTime();
            renderConferenceDaySchedule();
        });
        confDateEl.addEventListener('input', renderConferenceDaySchedule);
    }
    if (confPathEl) confPathEl.addEventListener('change', renderConferenceDaySchedule);

    if (typeSel) typeSel.addEventListener('change', () => {
        syncConferenceTypeFields();
        // For new entries only, re-autofill date and pathologist to match the
        // newly selected conference type.
        if (_editingConferenceKey) {
            // Even on an edit, the schedule panel should still reflect the
            // current date — nothing else changed but call once to be safe.
            renderConferenceDaySchedule();
            return;
        }
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
        // Switching conference type resets the time back to that type's
        // standing default (clearing any prior manual edit).
        if (confTimeEl) confTimeEl.dataset.userEdited = '';
        reapplyDefaultConfTime();
        // Programmatic value changes don't fire 'change', so repaint manually.
        renderConferenceDaySchedule();
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

// ── Historical data import (one-time) ── the 2025–26 spreadsheet as seed
// data (entries ≤ May 11 2026; cancelled rows skipped). Import stamps
// scheduler/conferenceLogImported (hides the banner); deterministic
// hist_<type>_<date>[_<subtypeOrTitle>] keys make re-clicks idempotent.

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
regListener('scheduler/conferenceLogImported', snap => {
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

// Sync banner visibility/disabled state (also mid-save: "Importing…").
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

// Validate every initials → current pathologist, build one multi-path
// update, write atomically.
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
        return getAcademicYearOfDate(cursor) === getAcademicYearOfDate(today);
    }
}

function renderPeriodLabel() {
    const el = document.getElementById('currentPeriod');
    if (view === 'day') {
        // Single-day label, year separated for styling (e.g. "Tue, May 12 2026").
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
        const ayStart = getAcademicYearOfDate(cursor);
        el.innerHTML = `<span class="year">${ayStart}–${ayStart + 1}</span>`;
    }
    // Show the small "•" affordance + tap-to-today cursor when not viewing today
    el.classList.toggle('off-today', !periodContainsToday());
}

// ────────────── DAY VIEW ──────────────
// Mobile-first single-day view reusing the week-view .week-day card so all
// CSS/handlers/DnD Just Work — one full-width day instead of seven columns.
// The only mobile view with the procedure schedule.
function renderDay() {
    const main = document.getElementById('main');
    // Normalize cursor to midnight so date math/comparisons are stable.
    const d = new Date(cursor);
    d.setHours(0, 0, 0, 0);

    const td = sameDay(d, today);
    const we = isWeekend(d);
    const holiday = getFederalHoliday(d);
    const dayAssign = getDayAssignments(d);
    const dayKey = fmt(d);

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
        const locked = isLockActiveForRender(dayKey, p.id, a);
        const lockCls = locked ? ' locked' : '';
        const lockTitle = locked ? ` title="${p.name} — ${a.service.name} · Approved & locked (protected from recompute)"` : '';
        if (a.type === 'pto') {
            rows += `<div class="wd-row pto" style="--c:${p.color}">
          <span class="pid">${p.initials}</span>
          <span class="svc">PTO</span>
          ${oc}
        </div>`;
        } else if (a.type === 'off_site') {
            const cbg = pathBgColor(p.color);
            rows += `<div class="wd-row off-site${lockCls}"${lockTitle} style="--c:${p.color}; --sc:var(${a.service.cssVar})${cbg ? `; --c-bg:${cbg}` : ''}">
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
            rows += `<div class="wd-row${lockCls}"${lockTitle} style="--c:${p.color}; --sc:var(${a.service.cssVar})${cbg ? `; --c-bg:${cbg}` : ''}">
          <span class="pid">${p.initials}</span>
          <span class="svc"><span class="swatch"></span>${a.service.short}</span>
          ${oc}
        </div>`;
        }
    });

    const holidayBadge = holiday ? `<span class="holiday-badge" title="${holiday}">${holiday}</span>` : '';
    const hoursHtml = renderHourGrid(d);

    // Wrapper is layout-only; the card reuses .week-day, with .day-view-card
    // opting into the wider mobile treatment.
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
        const dayKey = fmt(d);
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
            const locked = isLockActiveForRender(dayKey, p.id, a);
            const lockCls = locked ? ' locked' : '';
            const lockTitle = locked ? ` title="${p.name} — ${a.service.name} · Approved & locked (protected from recompute)"` : '';
            if (a.type === 'pto') {
                rows += `<div class="wd-row pto" style="--c:${p.color}">
            <span class="pid">${p.initials}</span>
            <span class="svc">PTO</span>
            ${oc}
          </div>`;
            } else if (a.type === 'off_site') {
                const cbg = pathBgColor(p.color);
                rows += `<div class="wd-row off-site${lockCls}"${lockTitle} style="--c:${p.color}; --sc:var(${a.service.cssVar})${cbg ? `; --c-bg:${cbg}` : ''}">
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
                rows += `<div class="wd-row${lockCls}"${lockTitle} style="--c:${p.color}; --sc:var(${a.service.cssVar})${cbg ? `; --c-bg:${cbg}` : ''}">
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
    // The signed-in presenter's own conferences for the day (see
    // getConferencesForDay); they share the hourly grid but render as a
    // distinct banner.
    const confs = getConferencesForDay(dayKey);

    // Bucket procedures into half-hour slots (8:15 → 8:00, 8:45 → 8:30):
    // fixed grid, arbitrary start times.
    const bySlot = {};
    procs.forEach(p => {
        const slotKey = slotKeyForTime(p.time);
        if (!slotKey) return; // outside the visible window
        if (!bySlot[slotKey]) bySlot[slotKey] = [];
        bySlot[slotKey].push(p);
    });

    // Conferences bucket the same way. Tagged so the slot renderer knows to
    // draw a conference pill rather than a procedure pill.
    const confBySlot = {};
    confs.forEach(c => {
        const slotKey = slotKeyForTime(c.time);
        if (!slotKey) return; // outside the visible window
        if (!confBySlot[slotKey]) confBySlot[slotKey] = [];
        confBySlot[slotKey].push(c);
    });

    let rowsHtml = '';
    for (let h = HOURS_START; h <= HOURS_END; h++) {
        for (let m of [0, 30]) {
            const timeKey = pad2(h) + ':' + pad2(m);   // "08:30"
            const isHourMark = (m === 0);
            const cls = isHourMark ? 'hour-mark' : 'half';
            const label = isHourMark ? formatHour12(h) : '';
            // Conference pills render first so they sit at the front of the
            // slot and catch the eye before the procedure pills.
            const confItems = (confBySlot[timeKey] || []).map(c => {
                const lbl = `${formatTime12Short(c.time)} ${c.label}`;
                const tipParts = [c.label, formatTime12(c.time)];
                if (c.note) tipParts.push(c.note);
                const tooltip = tipParts.join(' — ');
                return `<span class="conf-item conf-type-${escapeHtml(c.type)}" data-day="${dayKey}" data-conf-key="${escapeHtml(c.key)}" tabindex="0" title="${escapeHtml(tooltip)}"><span class="conf-item-dot" aria-hidden="true"></span>${escapeHtml(lbl)}</span>`;
            }).join('');
            const items = (bySlot[timeKey] || []).map(p => {
                // Pill label always prefixes the exact start time
                // ("8:15 HH - CT Kidney bx").
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
              <div class="hour-slot">${confItems}${items}</div>
            </div>`;
        }
    }
    // Banner lives INSIDE the procedure grid (first child) so it's attached
    // to the procedure schedule.
    return `<div class="wd-hours">
      ${nataliePtoBannerHtml(date)}
      <div class="wd-hours-head"></div>
      ${rowsHtml}
    </div>`;
}

// "Natalie PTO" banner above the hourly grid on flagged days (week + day
// views); Gross Room/admin get an inline "×" (wired in
// attachHourGridHandlers).
function nataliePtoBannerHtml(date) {
    if (!isNataliePtoDay(date)) return '';
    const dayKey = fmt(date);
    const removable = canManageNataliePto();
    const removeBtn = removable
        ? `<button type="button" class="natalie-pto-remove" data-day="${dayKey}" title="Remove Natalie PTO" aria-label="Remove Natalie PTO">×</button>`
        : '';
    return `<div class="natalie-pto-banner${removable ? ' removable' : ''}" data-day="${dayKey}" title="Natalie PTO">
      <span class="natalie-pto-label">Natalie PTO</span>
      ${removeBtn}
    </div>`;
}

// Remove the Natalie PTO flag for a single day (used by the inline banner
// "×" control). Safe no-op for users who can't manage it.
async function removeNataliePtoDay(dayKey) {
    if (!canManageNataliePto() || !dayKey) return;
    try {
        await db.ref('scheduler/natalieptoDays/' + dayKey).remove();
    } catch (err) {
        showToast('Could not remove Natalie PTO: ' + (err.message || err), { type: 'error' });
    }
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

// Pill label, e.g. "HH - CT Random Kidney bx"; "Procedure" for legacy
// entries.
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

// "8:00 AM – 8:30 AM" for timeKey + durationMin (default 30); end
// clamped to the same day ("11:59 PM").
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
    // Banner "×" removes the day's flag; banner clicks don't fall through to
    // the day-detail modal.
    document.querySelectorAll('.natalie-pto-banner').forEach(banner => {
        banner.addEventListener('click', e => {
            e.stopPropagation();
            const rm = e.target.closest('.natalie-pto-remove');
            if (rm) {
                e.preventDefault();
                removeNataliePtoDay(rm.dataset.day);
            }
        });
        banner.addEventListener('dblclick', e => e.stopPropagation());
    });

    document.querySelectorAll('.wd-hours').forEach(grid => {
        // Block the parent day-modal click; clicking empty grid clears the
        // procedure selection (pill clicks stopPropagation).
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
            // Read-only guests (histology) can't add procedures.
            if (isReadOnlyGuest()) return;
            // Dblclick on a pill → its own edit handler; conference pills are
            // read-only here (managed from Tracking).
            if (e.target.closest('.proc-item') || e.target.closest('.conf-item')) return;
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
        // Double click → edit (same modal, prefilled). Disabled for histology.
        item.addEventListener('dblclick', e => {
            e.stopPropagation();
            if (isReadOnlyGuest()) return;
            const dayKey = item.dataset.day;
            const procKey = item.dataset.key;
            if (!dayKey || !procKey) return;
            const proc = (procedures[dayKey] || {})[procKey];
            if (!proc) return;
            openProcedureModal(dayKey, proc.time, procKey);
        });

        // ── Drag-and-drop: move procedure to a different time slot ──
        item.addEventListener('dragstart', e => {
            // Read-only guests (histology) cannot move procedures.
            if (isReadOnlyGuest()) { e.preventDefault(); return; }
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

    // Re-apply selection after re-render (snapshots blow away the DOM); drop
    // stale references.
    if (_selectedProc) {
        const sel = document.querySelector(
            '.proc-item[data-day="' + _selectedProc.dayKey + '"][data-key="' + _selectedProc.procKey + '"]'
        );
        if (sel) sel.classList.add('selected');
        else _selectedProc = null;
    }
}

// Click outside a pill → deselect; clicks inside modals keep the
// selection.
document.addEventListener('click', e => {
    if (e.target.closest('.proc-item')) return;
    if (e.target.closest('.modal-back')) return;
    clearProcedureSelection();
});

// Delete/Backspace removes the selection — skipped while typing or in a
// modal; disabled for read-only guests.
document.addEventListener('keydown', async e => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (!_selectedProc) return;
    if (isReadOnlyGuest()) return;
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

// Procedure modal — location + type, confirm enabled when both chosen.
// `editingKey` → edit mode: prefill, relabel, update in place.
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
    // Delete is only available when editing an existing procedure.
    const deleteBtn = document.getElementById('procDelete');
    if (deleteBtn) deleteBtn.style.display = editingKey ? '' : 'none';

    // Prefill time: dblclicked slot for new, stored time for edits; editable.
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
        const variants = PROCEDURE_VARIANTS[name];

        // Plain (non-expandable) button — unchanged behaviour.
        if (!variants || !variants.length) {
            return `<button type="button" class="proc-type-btn proc-cat-${cat}" data-name="${escapeHtml(name)}">${escapeHtml(name)}</button>`;
        }

        // Expandable parent: label selects the base; chevron toggles sub-options
        // (shared grid cell spanning both columns).
        const subBtns = variants.map(v => {
            const vcat = getProcedureCategory(null, v);
            return `<button type="button" class="proc-type-btn proc-type-subbtn proc-cat-${vcat}" data-name="${escapeHtml(v)}">${escapeHtml(v)}</button>`;
        }).join('');

        return `<div class="proc-type-expandable" data-parent="${escapeHtml(name)}">` +
            `<button type="button" class="proc-type-btn proc-type-parent proc-cat-${cat}" data-name="${escapeHtml(name)}" aria-expanded="false">` +
            `<span class="proc-type-parent-label">${escapeHtml(name)}</span>` +
            `<span class="proc-type-caret" role="button" tabindex="0" aria-label="Show options for ${escapeHtml(name)}">` +
            `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,6 8,10 12,6"/></svg>` +
            `</span>` +
            `</button>` +
            `<div class="proc-type-suboptions">${subBtns}</div>` +
            `</div>`;
    }).join('') +
        `<div class="proc-freetext-wrap" id="procFreetextWrap">` +
        `<input type="text" id="procFreetextInput" class="proc-freetext-input" placeholder="Or type a custom procedure…" maxlength="80">` +
        `</div>`;

    // Pre-select the matching preset button or populate the freetext input
    // when editing an existing procedure.
    if (existing && existing.procedureName) {
        const existingName = existing.procedureName;
        const isPreset = PROCEDURE_TYPES.includes(existingName);
        // Find the parent whose variant list contains this name (if any).
        const parentOfVariant = Object.keys(PROCEDURE_VARIANTS).find(
            p => PROCEDURE_VARIANTS[p].includes(existingName)
        );
        if (isPreset || parentOfVariant) {
            const presetBtn = document.querySelector(
                '#procTypeGrid .proc-type-btn[data-name="' + CSS.escape(existingName) + '"]'
            );
            if (presetBtn) {
                presetBtn.classList.add('selected');
                // For a variant, leave the dropdown collapsed — the parent row
                // will display the chosen variant via syncProcParentLabels().
            }
        } else {
            const input = document.getElementById('procFreetextInput');
            const wrap = document.getElementById('procFreetextWrap');
            if (input) input.value = existingName;
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
        syncProcParentLabels();
        updateModalProcColors();
        updateProcConfirmEnabled();
    });

    syncProcParentLabels();
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

// Refresh colour-category classes on type buttons + free-text wrap when
// location/name changes, so buttons preview the pill colour.
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
            // Edit mode — update only mutable fields (time included); stamp
            // updatedAt.
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

// Delete the edited procedure (edit mode only); confirm first.
async function deleteProcedure() {
    if (!_pendingProc || !_pendingProc.editingKey) return;
    if (!confirm('Delete this procedure? This cannot be undone.')) return;
    const { dayKey, editingKey } = _pendingProc;
    try {
        await db.ref('scheduler/procedures/' + dayKey + '/' + editingKey).remove();
        closeProcedureModal();
    } catch (err) {
        showToast('Could not delete procedure: ' + (err.message || err), { type: 'error' });
    }
}

// Wire up the modal once. Inputs delegate from the modal back so the
// dynamically-rendered procedure-type buttons work without re-binding.

// ── Restructure procedure modal HTML ── richer markup the new CSS
// expects.
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
    </div>
    <p class="sub proc-header-date" id="procModalSub"></p>
  </div>

  <div class="proc-section-label">Time</div>
  <div class="proc-time-row">
    <input type="time" id="procTimeInput" class="proc-time-input" step="60">
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
    <button id="procDelete" class="danger" type="button" style="display:none;">Delete</button>
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
document.getElementById('procDelete').addEventListener('click', deleteProcedure);
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

// Keep expandable parents' collapsed label/selected state in sync with
// the current selection (variant name shows on the parent row).
function syncProcParentLabels() {
    const selectedName = _pendingProc ? _pendingProc.procedureName : null;
    document.querySelectorAll('#procTypeGrid .proc-type-expandable').forEach(exp => {
        const base = exp.dataset.parent;
        const parentBtn = exp.querySelector('.proc-type-parent');
        const label = exp.querySelector('.proc-type-parent-label');
        if (!parentBtn || !label) return;

        const variants = PROCEDURE_VARIANTS[base] || [];
        const variantSelected = variants.includes(selectedName);
        const baseSelected = selectedName === base;

        if (variantSelected) {
            // Show the chosen variant on the collapsed parent row.
            label.textContent = selectedName;
            parentBtn.classList.add('selected', 'proc-type-parent-variant');
        } else {
            // Revert to the base label; selected only if the base itself is chosen.
            label.textContent = base;
            parentBtn.classList.toggle('selected', baseSelected);
            parentBtn.classList.remove('proc-type-parent-variant');
        }
    });
}

// Type buttons are single-select; preset click clears free-text; caret
// toggles sub-options without selecting the parent.
document.getElementById('procTypeGrid').addEventListener('click', e => {
    if (!_pendingProc) return;

    // Caret toggle: expand / collapse the variant list without selecting.
    const caret = e.target.closest('.proc-type-caret');
    if (caret) {
        e.stopPropagation();
        const exp = caret.closest('.proc-type-expandable');
        if (exp) {
            const nowExpanded = exp.classList.toggle('expanded');
            const parentBtn = exp.querySelector('.proc-type-parent');
            if (parentBtn) parentBtn.setAttribute('aria-expanded', nowExpanded ? 'true' : 'false');
        }
        return;
    }

    const btn = e.target.closest('.proc-type-btn');
    if (!btn) return;
    document.querySelectorAll('#procTypeGrid .proc-type-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    // Clear freetext state
    const input = document.getElementById('procFreetextInput');
    const wrap = document.getElementById('procFreetextWrap');
    if (input) input.value = '';
    if (wrap) wrap.classList.remove('active');
    _pendingProc.procedureName = btn.dataset.name;

    // If a variant sub-option was chosen, collapse its dropdown — the parent
    // now shows the chosen variant as the selected option.
    if (btn.classList.contains('proc-type-subbtn')) {
        const exp = btn.closest('.proc-type-expandable');
        if (exp) {
            exp.classList.remove('expanded');
            const parentBtn = exp.querySelector('.proc-type-parent');
            if (parentBtn) parentBtn.setAttribute('aria-expanded', 'false');
        }
    }

    syncProcParentLabels();
    updateModalProcColors();
    updateProcConfirmEnabled();
});

// Keyboard support for the caret (Enter / Space toggles expansion).
document.getElementById('procTypeGrid').addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const caret = e.target.closest('.proc-type-caret');
    if (!caret) return;
    e.preventDefault();
    e.stopPropagation();
    const exp = caret.closest('.proc-type-expandable');
    if (exp) {
        const nowExpanded = exp.classList.toggle('expanded');
        const parentBtn = exp.querySelector('.proc-type-parent');
        if (parentBtn) parentBtn.setAttribute('aria-expanded', nowExpanded ? 'true' : 'false');
    }
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

        // LF sendout banner above the first pathologist row (in-month days
        // only); full + abbr labels emitted, CSS picks per viewport.
        if (inMonth && isLfSendoutDay(date)) {
            rows += `<div class="wd-row lf-sendout" title="Lake Forest sendout">
            <span class="lf-label lf-label-full">Lake Forest sendout</span>
            <span class="lf-label lf-label-abbr">LF sendout</span>
          </div>`;
        }

        activePathologists.forEach(p => {
            const a = dayAssign[p.id];
            if (a.type === 'blank') return; // pre-cutoff date — render no rows
            const oc = a.onCall ? `<span class="oc-mark" title="On call this week">On Call</span>` : '';
            const locked = isLockActiveForRender(fmt(date), p.id, a);
            const lockCls = locked ? ' locked' : '';
            const lockTip = locked ? ' · Approved & locked' : '';
            if (a.type === 'pto') {
                rows += `<div class="wd-row pto" style="--c:${p.color}" title="${p.name} — PTO${a.onCall ? ' · On call' : ''}">
            <span class="pid">${p.initials}</span>
            <span class="svc">PTO</span>
            ${oc}
          </div>`;
            } else if (a.type === 'off_site') {
                const cbg = pathBgColor(p.color);
                rows += `<div class="wd-row off-site${lockCls}" style="--c:${p.color}; --sc:var(${a.service.cssVar})${cbg ? `; --c-bg:${cbg}` : ''}" title="${p.name} — ${a.service.name}${a.onCall ? ' · On call' : ''}${lockTip}">
            <span class="pid">${p.initials}</span>
            <span class="svc"><span class="swatch"></span><span class="svc-full">${a.service.short}</span><span class="svc-abbr">${a.service.abbr}</span></span>
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
                rows += `<div class="wd-row${lockCls}" style="--c:${p.color}; --sc:var(${a.service.cssVar})${cbg ? `; --c-bg:${cbg}` : ''}" title="${p.name} — ${a.service.name}${a.onCall ? ' · On call' : ''}${lockTip}">
            <span class="pid">${p.initials}</span>
            <span class="svc"><span class="swatch"></span><span class="svc-full">${a.service.short}</span><span class="svc-abbr">${a.service.abbr}</span></span>
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

    // Lake Forest guest: the only calendar content is sendout days, drawn
    // with the same square-and-label treatment as call/PTO, badged "LF".
    if (isLakeForest()) {
        if (!isLfSendoutDay(date)) return null;
        return {
            folks: [],
            background: '#4E2E85', // matches .lf-sendout banner purple
            label: 'LF',
            title: 'Lake Forest sendout',
            multi: false,
            count: false,
        };
    }

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
    const ayStart = getAcademicYearOfDate(cursor); // e.g. 2025 for 2025–2026

    // PTO day chips — shown alongside the mode toggle when in PTO mode.
    // Computes used/allotted days per pathologist for the displayed fiscal year.
    let ptoDaysSummaryHtml = '';
    if (yearMode === 'pto' && !isLakeForest() && pathologists && pathologists.length > 0) {
        const fyRange = getFiscalYearRange(ayStart);
        ptoDaysSummaryHtml = `<div class="year-pto-summary">` +
            pathologists.map(p => {
                const used = ptoDaysScheduled(p.id, { start: fyRange.start, end: fyRange.end });
                // Per-year allotment for the fiscal year on display (falls
                // back to the pathologist's default when the year has none).
                const allot = ptoAllotmentFor(p.id, ayStart);
                const isOver = allot > 0 && used > allot;
                const label = escapeHtml(p.name) + ' — ' + used + (allot > 0 ? ' of ' + allot : '') + ' PTO days';
                return `<span class="year-pto-chip${isOver ? ' is-over' : ''}" style="--c:${p.color};" title="${label}">` +
                    `<span class="year-pto-dot" aria-hidden="true"></span>` +
                    `<span class="year-pto-initials">${escapeHtml(p.initials)}</span>` +
                    `<span class="year-pto-count">${used}<span class="year-pto-allot">${allot > 0 ? '/' + allot : ''}</span></span>` +
                    `</span>`;
            }).join('') +
            `</div>`;
    }

    // Mode tabs + pathologist key
    const modeTabsHtml = `
      <div class="mode-tabs" role="tablist">
        <button class="${yearMode === 'pto' ? 'active' : ''}" data-mode="pto">PTO</button>
        <button class="${yearMode === 'call' ? 'active' : ''}" data-mode="call">Call</button>
      </div>
      ${ptoDaysSummaryHtml}`;

    // Lake Forest guest: no PTO/Call modes and no pathologist roster — the
    // legend is a single key pill matching the LF sendout squares.
    const keyHtml = isLakeForest()
        ? `
      <div class="key">
        <span class="key-label">Key</span>
        <span class="key-pill"><span class="swatch" style="--c:#4E2E85">LF</span>Lake Forest sendout</span>
      </div>`
        : `
      <div class="key">
        <span class="key-label">Pathologists</span>
        ${pathologists.map(p =>
        `<span class="key-pill"><span class="swatch" style="--c:${p.color}">${p.initials}</span>${p.name.replace(/^Dr\. /, '')}</span>`
    ).join('')}
      </div>`;
    let html = `<div class="year-view">
      <div class="year-legend">
        ${isLakeForest() ? '' : modeTabsHtml}
        ${keyHtml}
      </div>`;

    // Render 12 months starting from September (month index 8)
    for (let i = 0; i < 12; i++) {
        const m = (8 + i) % 12;                      // Sep=8…Dec=11, Jan=0…Aug=7
        const y = m >= 8 ? ayStart : ayStart + 1;    // Sep–Dec use start year; Jan–Aug use next year
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

    // Click any day in the year view → open day detail modal (edit PTO /
    // on-call). Lake Forest instead gets the sendout request modal
    // prefilled with the clicked day.
    main.querySelectorAll('.md').forEach(el => {
        if (el.classList.contains('outside')) return;
        el.addEventListener('click', () => {
            const ds = el.dataset.date;
            if (!ds) return;
            if (isLakeForest()) { openLfRequestModal(parseDate(ds)); return; }
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
    if (isLakeForest()) return; // LF guest: calendar is view-only, no day drill-in
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
        const locked = isLockActiveForRender(fmt(date), p.id, a);
        const lockBadge = locked
            ? `<span class="lock-badge" title="Approved via request — protected from recompute">Locked</span>`
            : '';
        const lockCls = locked ? ' locked' : '';
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
            return `<div class="day-detail-row${adminCls}${lockCls}"${adminAttrs} style="--c:${p.color}; --sc:var(${a.service.cssVar})${cbg ? `; --c-bg:${cbg}` : ''}">
          <div class="ddot"></div>
          <div class="dname">${p.name}</div>
          <div class="dservice"><span class="swatch"></span>${a.service.name}</div>
          ${lockBadge}
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
        return `<div class="day-detail-row${adminCls}${lockCls}"${adminAttrs} style="--c:${p.color}; --sc:var(${a.service.cssVar})${cbg ? `; --c-bg:${cbg}` : ''}">
        <div class="ddot"></div>
        <div class="dname">${p.name}</div>
        <div class="dservice"><span class="swatch"></span>${a.service.name}</div>
        ${lockBadge}
        ${ocPill}
      </div>`;
    }).join('');

    if (admin) attachPathRowHandlers(date);

    // Hide "change service rotation" button on weekends and federal holidays
    const svcBtn = document.getElementById('dayChangeService');
    if (svcBtn) svcBtn.style.display = (isWk || holiday) ? 'none' : '';

    // Day-modal action labels by role: gross room gets no
    // pathologist-schedule changes; histology is read-only.
    const grossRoom = isGrossRoom();
    const readOnlyGuest = grossRoom || isReadOnlyGuest();
    const ptoBtn = document.getElementById('dayAddPto');
    const ocBtn = document.getElementById('dayChangeOnCall');
    if (ptoBtn) {
        ptoBtn.style.display = readOnlyGuest ? 'none' : '';
        if (!readOnlyGuest) ptoBtn.textContent = admin ? 'Add PTO for this day' : '+ Request PTO for this day';
    }
    if (ocBtn) {
        ocBtn.style.display = readOnlyGuest ? 'none' : '';
        if (!readOnlyGuest) ocBtn.textContent = admin ? "Change who's on call" : "Request on-call change";
    }
    if (svcBtn && !(isWk || holiday)) {
        if (readOnlyGuest) {
            svcBtn.style.display = 'none';
        } else {
            svcBtn.style.display = '';
            svcBtn.textContent = admin ? 'Override services this day' : 'Request service change';
        }
    }

    // LF sendout button (admin-only) — label flips between add and remove.
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

                // Auto-advance end date when start is moved past it
                panel.querySelectorAll('input[id^="pqpStart_"]').forEach(startInput => {
                    const key = startInput.id.replace('pqpStart_', '');
                    startInput.addEventListener('change', () => {
                        const endInput = panel.querySelector(`#pqpEnd_${key}`);
                        if (endInput && startInput.value && endInput.value && startInput.value > endInput.value) {
                            endInput.value = startInput.value;
                        }
                    });
                });

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
                        // Strip stale regular overrides on the (possibly extended) range so the
                        // updated PTO takes effect.
                        if (oldVac) {
                            await clearConflictingServiceOverridesForPto(
                                oldVac.pathologistId, newStart, newEnd);
                        }
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
                const currentId = currentSvc ? currentSvc.id : '';
                const currentIsFt = isFreetextServiceId(currentId);
                const allOptions = [...SERVICES, COMBO_SVC, ...OFF_SERVICES];
                const opts = allOptions.map(s =>
                    `<option value="${s.id}" ${!currentIsFt && s.id === currentId ? 'selected' : ''}>${s.name}</option>`
                ).join('');
                const noneOpt = `<option value="">— No service —</option>`;
                const customOpt = `<option value="__ft__" ${currentIsFt ? 'selected' : ''}>Custom service…</option>`;

                // Check if there's an existing day-level override for this path on this date
                const dayKey = fmt(date);
                const hasOverride = serviceOverrides[dayKey] && serviceOverrides[dayKey][pid];
                // Lock on this slot? (glow on the schedule — approved request
                // or a previous admin lock-in)
                const lockId = getServiceLock(dayKey, pid);

                renderFreetextDatalist();
                panel.innerHTML = `
                    <div class="pqp-label">Service — ${path.name}</div>
                    <div class="pqp-row">
                        <select id="pqpSvcSel_${pid}">${noneOpt}${opts}${customOpt}</select>
                        <button class="pqp-btn primary" id="pqpSvcSave_${pid}">Save</button>
                    </div>
                    <div class="pqp-row pqp-ft-row" id="pqpFtRow_${pid}" style="display:${currentIsFt ? '' : 'none'};">
                        <input type="text" class="pqp-ft-input" id="pqpFtInput_${pid}"
                               list="ftServiceNames" maxlength="40" autocomplete="off" spellcheck="false"
                               placeholder="Type the service, e.g. CAP Inspection"
                               value="${currentIsFt ? escapeHtml(currentSvc.name) : ''}" />
                    </div>
                    <label class="pqp-lock-row" id="pqpLockRow_${pid}">
                        <input type="checkbox" id="pqpLockCb_${pid}" ${lockId ? 'checked' : ''} />
                        <span class="pqp-lock-text" id="pqpLockText_${pid}" title="Recompute won't move a locked assignment">Lock in place</span>
                    </label>
                    ${hasOverride ? `<button class="pqp-reset" id="pqpSvcReset_${pid}">Reset to default rotation</button>` : ''}
                `;

                const svcSel = panel.querySelector(`#pqpSvcSel_${pid}`);
                const ftRow = panel.querySelector(`#pqpFtRow_${pid}`);
                const ftInput = panel.querySelector(`#pqpFtInput_${pid}`);
                const lockCb = panel.querySelector(`#pqpLockCb_${pid}`);
                const lockText = panel.querySelector(`#pqpLockText_${pid}`);

                // Non-standard picks are ALWAYS locked (checkbox forced + disabled);
                // standard picks restore the admin's manual choice.
                function syncLockForced() {
                    const v = svcSel.value;
                    const forced = v === '__ft__' || (v && isNonStandardServiceId(v));
                    if (forced) {
                        if (lockCb.dataset.prevManual === undefined) {
                            lockCb.dataset.prevManual = lockCb.checked ? '1' : '0';
                        }
                        lockCb.checked = true;
                        lockCb.disabled = true;
                        lockText.textContent = 'Locked automatically — custom & off-site services are always locked';
                    } else {
                        lockCb.disabled = false;
                        if (lockCb.dataset.prevManual !== undefined) {
                            lockCb.checked = lockCb.dataset.prevManual === '1';
                            delete lockCb.dataset.prevManual;
                        }
                        lockText.textContent = 'Lock in place';
                    }
                }
                svcSel.addEventListener('change', () => {
                    ftRow.style.display = svcSel.value === '__ft__' ? '' : 'none';
                    if (svcSel.value === '__ft__') setTimeout(() => ftInput.focus(), 0);
                    syncLockForced();
                });
                syncLockForced();

                panel.querySelector(`#pqpSvcSave_${pid}`).addEventListener('click', async () => {
                    const dayKey = fmt(date);

                    // Resolve the chosen service id (custom → 'ft:' id).
                    let newVal;
                    if (svcSel.value === '__ft__') {
                        newVal = makeFreetextServiceId(ftInput.value);
                        if (!newVal) {
                            showToast('Type a name for the custom service first.', { type: 'error' });
                            ftInput.focus();
                            return;
                        }
                    } else {
                        newVal = svcSel.value;
                    }

                    const initialVal = currentId;
                    const initialLock = !!lockId;
                    const wantLock = newVal
                        ? (isNonStandardServiceId(newVal) || lockCb.checked)
                        : false;

                    // Nothing changed at all → just close.
                    if (newVal === initialVal && wantLock === initialLock) {
                        closePanel();
                        openDayDetail(date);
                        return;
                    }

                    // ── Same service, lock toggled ──
                    if (newVal === initialVal) {
                        if (wantLock) {
                            // Lock the current assignment in place: back it
                            // with a concrete override, then write the lock.
                            const existing = serviceOverrides[dayKey] ? { ...serviceOverrides[dayKey] } : {};
                            existing[pid] = newVal;
                            await db.ref('scheduler/serviceOverrides/' + dayKey).set(existing);
                            await db.ref('scheduler/serviceLocks/' + dayKey + '/' + pid).set(newVal);
                            showToast('Assignment locked — recompute won\'t move it.');
                        } else {
                            // Unlock only — the service stays.
                            await db.ref('scheduler/serviceLocks/' + dayKey + '/' + pid).remove();
                            showToast('Lock removed — assignment kept, but no longer protected from recompute.');
                        }
                        closePanel();
                        openDayDetail(date);
                        return;
                    }

                    // ── Service changed ──
                    // Replacing a locked slot is allowed (the admin is the
                    // approver) but is called out first.
                    if (initialLock) {
                        const okGo = confirm(
                            `${path.name.replace(/^Dr\. /, '')}'s assignment on this day is locked. ` +
                            `Saving will replace it${wantLock ? ' (the new assignment stays locked)' : ' and remove the lock'}. Continue?`);
                        if (!okGo) return;
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
                    // Lock follows the choice: keep/replace it, or release it.
                    if (newVal && wantLock) {
                        await db.ref('scheduler/serviceLocks/' + dayKey + '/' + pid).set(newVal);
                    } else if (initialLock || getServiceLock(dayKey, pid)) {
                        await db.ref('scheduler/serviceLocks/' + dayKey + '/' + pid).remove();
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
                        if (lockId) {
                            const okGo = confirm(
                                `${path.name.replace(/^Dr\. /, '')}'s assignment on this day was approved ` +
                                `from a request and is locked. Resetting will remove the lock too. Continue?`);
                            if (!okGo) return;
                        }
                        const existing = serviceOverrides[dayKey] ? { ...serviceOverrides[dayKey] } : {};
                        delete existing[pid];
                        if (Object.keys(existing).length === 0) {
                            await db.ref('scheduler/serviceOverrides/' + dayKey).remove();
                        } else {
                            await db.ref('scheduler/serviceOverrides/' + dayKey).set(existing);
                        }
                        // Reset releases the lock along with the override.
                        await db.ref('scheduler/serviceLocks/' + dayKey + '/' + pid).remove();
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
                    renderFreetextDatalist();
                    parts.push(`<div class="pqp-row">
                        <select id="pqpOffSvcSel_${pid}"><option value="">— Assign service —</option>${opts}<option value="__ft__">Custom service…</option></select>
                        <button class="pqp-btn primary" id="pqpOffSvcSave_${pid}">Save</button>
                    </div>
                    <div class="pqp-row pqp-ft-row" id="pqpOffFtRow_${pid}" style="display:none;">
                        <input type="text" class="pqp-ft-input" id="pqpOffFtInput_${pid}"
                               list="ftServiceNames" maxlength="40" autocomplete="off" spellcheck="false"
                               placeholder="Type the service, e.g. CAP Inspection" />
                    </div>
                    <label class="pqp-lock-row">
                        <input type="checkbox" id="pqpOffLockCb_${pid}" />
                        <span class="pqp-lock-text" id="pqpOffLockText_${pid}" title="Recompute won't move a locked assignment">Lock in place</span>
                    </label>`);
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
                    const offSel = panel.querySelector(`#pqpOffSvcSel_${pid}`);
                    const offFtRow = panel.querySelector(`#pqpOffFtRow_${pid}`);
                    const offFtInput = panel.querySelector(`#pqpOffFtInput_${pid}`);
                    const offLockCb = panel.querySelector(`#pqpOffLockCb_${pid}`);
                    const offLockText = panel.querySelector(`#pqpOffLockText_${pid}`);

                    function syncOffLockForced() {
                        const v = offSel.value;
                        const forced = v === '__ft__' || (v && isNonStandardServiceId(v));
                        if (forced) {
                            if (offLockCb.dataset.prevManual === undefined) {
                                offLockCb.dataset.prevManual = offLockCb.checked ? '1' : '0';
                            }
                            offLockCb.checked = true;
                            offLockCb.disabled = true;
                            offLockText.textContent = 'Locked automatically — custom & off-site services are always locked';
                        } else {
                            offLockCb.disabled = false;
                            if (offLockCb.dataset.prevManual !== undefined) {
                                offLockCb.checked = offLockCb.dataset.prevManual === '1';
                                delete offLockCb.dataset.prevManual;
                            }
                            offLockText.textContent = 'Lock in place';
                        }
                    }
                    offSel.addEventListener('change', () => {
                        if (offFtRow) offFtRow.style.display = offSel.value === '__ft__' ? '' : 'none';
                        if (offSel.value === '__ft__' && offFtInput) setTimeout(() => offFtInput.focus(), 0);
                        syncOffLockForced();
                    });
                    syncOffLockForced();

                    offSvcSave.addEventListener('click', async () => {
                        let newVal;
                        if (offSel.value === '__ft__') {
                            newVal = makeFreetextServiceId(offFtInput ? offFtInput.value : '');
                            if (!newVal) {
                                showToast('Type a name for the custom service first.', { type: 'error' });
                                if (offFtInput) offFtInput.focus();
                                return;
                            }
                        } else {
                            newVal = offSel.value;
                        }
                        if (!newVal) return;
                        const wantLock = isNonStandardServiceId(newVal) || offLockCb.checked;
                        const dayKey = fmt(date);
                        const existing = serviceOverrides[dayKey] ? { ...serviceOverrides[dayKey] } : {};
                        existing[pid] = newVal;
                        await db.ref('scheduler/serviceOverrides/' + dayKey).set(existing);
                        // Lock the new assignment, or clear any stale lock
                        // this slot might still carry.
                        if (wantLock) {
                            await db.ref('scheduler/serviceLocks/' + dayKey + '/' + pid).set(newVal);
                        } else if (getServiceLock(dayKey, pid)) {
                            await db.ref('scheduler/serviceLocks/' + dayKey + '/' + pid).remove();
                        }
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

// Auto-advance end date when start is moved past it
document.getElementById('ptoStart').addEventListener('change', () => {
    const startEl = document.getElementById('ptoStart');
    const endEl   = document.getElementById('ptoEnd');
    if (startEl.value && endEl.value && startEl.value > endEl.value) {
        endEl.value = startEl.value;
    }
});

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
        // Strip stale regular overrides so the new PTO takes effect.
        await clearConflictingServiceOverridesForPto(pid, fmt(s), fmt(e));
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
// Remove all day-level on-call overrides inside activeOcDate's call
// cycle (so day overrides can't shadow a new week setting).
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
// Admin-only: flag one day or a full call cycle.
//   lfSendoutDays/<YYYY-MM-DD> → true; lfSendoutWeeks/<cycle-start> → true
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

// Helper: clear all per-day LF flags within the call cycle containing
// `date`. Called after a week-scope add/remove so day flags can't silently
// shadow the week flag (admin modal and request approvals both use it).
async function _clearLfDayFlagsForCycle(date) {
    const cs = getCallCycleStart(date);
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
        await _clearLfDayFlagsForCycle(activeLfDate);
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
        await _clearLfDayFlagsForCycle(activeLfDate);
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

// ────────────── LAKE FOREST SENDOUT REQUEST MODAL (LF guest) ──────────────
// The read-only Lake Forest account can't write flags directly. Instead it
// files an 'lf_sendout' request — payload { date, scope: 'day'|'week',
// action: 'add'|'remove' } — that the admin approves or denies from the
// regular requests queue. The modal reads the current flag state for the
// chosen date/scope and offers whichever action makes sense.
let _lfReqAction = null; // 'add' | 'remove' | null (nothing sensible to ask)

function _refreshLfReqModalUi() {
    const statusEl = document.getElementById('lfReqStatus');
    const submitBtn = document.getElementById('lfReqSubmit');
    const v = document.getElementById('lfReqDate').value;
    _lfReqAction = null;

    if (!v) {
        statusEl.textContent = 'Pick a date to get started.';
        statusEl.style.background = 'var(--bg-2)';
        statusEl.style.color = 'var(--ink-2)';
        submitBtn.disabled = true;
        return;
    }

    const date = parseDate(v);
    const scope = document.querySelector('input[name="lfReqScope"]:checked').value;
    const dayOn = _lfDayFlag(date);
    const weekOn = _lfWeekFlag(date);
    const cs = getCallCycleStart(date);
    const ce = getCallCycleEnd(cs);
    const weekLabel = `${MONTHS_SHORT[cs.getMonth()]} ${cs.getDate()} – ${MONTHS_SHORT[ce.getMonth()]} ${ce.getDate()}, ${ce.getFullYear()}`;

    if (scope === 'day') {
        if (dayOn) {
            _lfReqAction = 'remove';
            statusEl.textContent = 'This day is currently a sendout day. Submit to request its removal.';
            submitBtn.textContent = 'Request removal for this day';
        } else if (weekOn) {
            statusEl.textContent = `The full call week (${weekLabel}) is flagged — switch to "Full call week" to request removal.`;
            submitBtn.textContent = 'Submit request';
        } else {
            _lfReqAction = 'add';
            statusEl.textContent = 'Not currently a sendout day. Submit to request it be added.';
            submitBtn.textContent = 'Request sendout for this day';
        }
    } else {
        if (weekOn) {
            _lfReqAction = 'remove';
            statusEl.textContent = `The call week of ${weekLabel} is currently flagged. Submit to request its removal.`;
            submitBtn.textContent = 'Request removal for full week';
        } else {
            _lfReqAction = 'add';
            statusEl.textContent = `Submit to request sendout for every day in the call week of ${weekLabel}.`;
            submitBtn.textContent = 'Request sendout for full week';
        }
    }
    statusEl.style.background = _lfReqAction ? 'var(--bg-2)' : 'var(--accent-soft)';
    statusEl.style.color = 'var(--ink-2)';
    submitBtn.disabled = !_lfReqAction;
}

function openLfRequestModal(date) {
    if (!isLakeForest()) return;
    document.getElementById('lfReqDate').value = fmt(date || today);
    document.getElementById('lfReqScopeDay').checked = true;
    document.getElementById('lfReqNote').value = '';
    _refreshLfReqModalUi();
    document.getElementById('lfReqModalBack').classList.add('open');
}

document.getElementById('lfReqDate').addEventListener('change', _refreshLfReqModalUi);
document.querySelectorAll('input[name="lfReqScope"]').forEach(radio => {
    radio.addEventListener('change', _refreshLfReqModalUi);
});
document.getElementById('lfReqCancel').addEventListener('click', () => {
    document.getElementById('lfReqModalBack').classList.remove('open');
});
document.getElementById('lfReqModalBack').addEventListener('click', e => {
    if (e.target.id === 'lfReqModalBack') e.target.classList.remove('open');
});
document.getElementById('lfReqSubmit').addEventListener('click', async () => {
    if (!isLakeForest() || !_lfReqAction) return;
    const v = document.getElementById('lfReqDate').value;
    if (!v) return;
    const scope = document.querySelector('input[name="lfReqScope"]:checked').value;
    const note = document.getElementById('lfReqNote').value;
    const ok = await submitRequest('lf_sendout', {
        date: v,
        scope: scope,
        action: _lfReqAction,
    }, note);
    if (ok) document.getElementById('lfReqModalBack').classList.remove('open');
});

// ────────────── LAKE FOREST DATES ASK MODAL (admin) ──────────────
// Admin files an 'lf_dates_request' aimed at the Lake Forest account —
// payload { start?, end?, aboutName?, aboutRequestKey? } — asking LF to
// provide their sendout dates. LF responds with regular lf_sendout requests
// and then marks the ask complete. Opened standalone from the Requests page
// or pre-filled from a PTO request card.
let _lfAskAbout = null; // { aboutName, aboutRequestKey } carried into payload

function openLfAskModal(prefill) {
    if (!isAdmin()) return;
    prefill = prefill || {};
    _lfAskAbout = prefill.aboutName
        ? { aboutName: prefill.aboutName, aboutRequestKey: prefill.aboutRequestKey || null }
        : null;
    document.getElementById('lfAskStart').value = prefill.start || '';
    document.getElementById('lfAskEnd').value = prefill.end || '';
    document.getElementById('lfAskNote').value = '';
    const ctx = document.getElementById('lfAskContext');
    if (_lfAskAbout) {
        ctx.textContent = `Re: ${_lfAskAbout.aboutName}'s PTO request.`;
        ctx.style.display = '';
    } else {
        ctx.style.display = 'none';
    }
    document.getElementById('lfAskModalBack').classList.add('open');
}

// Pre-filled variant launched from a PTO request card: seed the covering
// dates from the request's window and tag who it's about.
function openLfAskModalForRequest(reqKey) {
    const req = requests[reqKey];
    if (!req) return;
    let start = null, end = null;
    if (req.type === 'pto_add') {
        start = req.payload.start;
        end = req.payload.end;
    } else if (req.type === 'pto_remove') {
        const v = vacations.find(x => x.key === req.payload.vacationKey);
        if (v) { start = fmt(v.start); end = fmt(v.end); }
    }
    openLfAskModal({
        start: start,
        end: end,
        aboutName: _pathName(req.requesterId).replace(/^Dr\. /, ''),
        aboutRequestKey: reqKey,
    });
}

document.getElementById('lfAskCancel').addEventListener('click', () => {
    document.getElementById('lfAskModalBack').classList.remove('open');
});
document.getElementById('lfAskModalBack').addEventListener('click', e => {
    if (e.target.id === 'lfAskModalBack') e.target.classList.remove('open');
});
document.getElementById('lfAskSubmit').addEventListener('click', async () => {
    if (!isAdmin()) return;
    let start = document.getElementById('lfAskStart').value || null;
    let end = document.getElementById('lfAskEnd').value || null;
    // Single date filled in either slot → treat as a one-day window;
    // reversed range → swap.
    if (start && !end) end = start;
    if (!start && end) start = end;
    if (start && end && end < start) { const t = start; start = end; end = t; }
    const payload = { start: start, end: end };
    if (_lfAskAbout) {
        payload.aboutName = _lfAskAbout.aboutName;
        if (_lfAskAbout.aboutRequestKey) payload.aboutRequestKey = _lfAskAbout.aboutRequestKey;
    }
    const note = document.getElementById('lfAskNote').value;
    const ok = await submitRequest('lf_dates_request', payload, note, {
        targetId: LAKE_FOREST_ID,
        toast: 'Request sent to Lake Forest.',
    });
    if (ok) document.getElementById('lfAskModalBack').classList.remove('open');
});

// ────────────── NATALIE PTO MODAL (Gross Room + admin) ──────────────
// Scopes: day / week (Mon–Fri, skipping holidays) / range — all resolve to
// per-day flags under scheduler/natalieptoDays/<YYYY-MM-DD>; no effect on
// rotation or allotments.
let activeNpDate = null;

// True for anyone allowed to manage Natalie PTO: Gross Room only.
function canManageNataliePto() {
    return isGrossRoom();
}

// Dates a scope affects (preview + write). Week/range skip weekends +
// holidays; day writes exactly the chosen date.
function _npDatesForScope(scope) {
    if (scope === 'day') {
        const v = document.getElementById('npDay').value;
        if (!v) return [];
        return [parseDate(v)];
    }
    if (scope === 'week') {
        const base = activeNpDate || today;
        const ws = startOfWeek(base);
        const out = [];
        for (let i = 0; i < 7; i++) {
            const d = addDays(ws, i);
            if (isWeekend(d) || getFederalHoliday(d)) continue;
            out.push(d);
        }
        return out;
    }
    // range
    const sV = document.getElementById('npStart').value;
    const eV = document.getElementById('npEnd').value;
    if (!sV || !eV) return [];
    const s = parseDate(sV);
    const e = parseDate(eV);
    if (isNaN(s) || isNaN(e) || e < s) return [];
    const out = [];
    for (let d = new Date(s); d.getTime() <= e.getTime(); d = addDays(d, 1)) {
        if (isWeekend(d) || getFederalHoliday(d)) continue;
        out.push(new Date(d));
    }
    return out;
}

function _refreshNpModalUi() {
    const scope = document.querySelector('input[name="npScope"]:checked').value;
    document.getElementById('npDayWrap').style.display = (scope === 'day') ? '' : 'none';
    document.getElementById('npRangeWrap').style.display = (scope === 'range') ? '' : 'none';

    const statusEl = document.getElementById('npStatus');
    const saveBtn = document.getElementById('npSave');
    const dates = _npDatesForScope(scope);

    statusEl.style.background = 'var(--bg-2)';
    statusEl.style.color = 'var(--ink-2)';

    if (scope === 'week') {
        const base = activeNpDate || today;
        const ws = startOfWeek(base);
        const we = addDays(ws, 6);
        const already = dates.filter(d => isNataliePtoDay(d)).length;
        statusEl.textContent = dates.length === 0
            ? 'No working days in this week.'
            : `Flags Natalie PTO on ${dates.length} weekday(s) in the week of ${MONTHS_SHORT[ws.getMonth()]} ${ws.getDate()} – ${MONTHS_SHORT[we.getMonth()]} ${we.getDate()}, ${we.getFullYear()}.` +
              (already > 0 ? ` (${already} already flagged.)` : '');
        saveBtn.textContent = 'Add for this week';
        saveBtn.disabled = dates.length === 0;
    } else if (scope === 'range') {
        statusEl.textContent = dates.length === 0
            ? 'Choose a valid start and end date (weekends and holidays are skipped).'
            : `Flags Natalie PTO on ${dates.length} weekday(s) in the selected range.`;
        saveBtn.textContent = 'Add for range';
        saveBtn.disabled = dates.length === 0;
    } else {
        const d = dates[0];
        if (!d) {
            statusEl.textContent = 'Choose a date.';
            saveBtn.disabled = true;
        } else if (isNataliePtoDay(d)) {
            statusEl.textContent = 'This day is already flagged as Natalie PTO. Use the list below to remove it.';
            statusEl.style.background = 'var(--accent-soft)';
            saveBtn.disabled = true;
        } else {
            statusEl.textContent = `Flags Natalie PTO on ${DOW[d.getDay()]}, ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}.`;
            saveBtn.disabled = false;
        }
        saveBtn.textContent = 'Add PTO';
    }
}

function renderNpList() {
    const list = document.getElementById('npList');
    // Show upcoming flagged days (today onward), sorted, capped.
    const todayKey = fmt(today);
    const keys = Object.keys(nataliePtoDays || {})
        .filter(k => nataliePtoDays[k] && k >= todayKey)
        .sort()
        .slice(0, 60);

    if (keys.length === 0) {
        list.innerHTML = `<div class="empty">No upcoming Natalie PTO scheduled.</div>`;
        return;
    }

    list.innerHTML = keys.map(k => {
        const d = parseDate(k);
        const label = `${DOW[d.getDay()]}, ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
        return `<div class="pto-list-item natalie-pto-item">
        <div class="pdot"></div>
        <div class="prange">
          <div class="pname">Natalie PTO</div>
          <div class="pdates">${label}</div>
        </div>
        <button data-key="${k}">Remove</button>
      </div>`;
    }).join('');

    list.querySelectorAll('button[data-key]').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!canManageNataliePto()) return;
            const k = btn.dataset.key;
            try {
                await db.ref('scheduler/natalieptoDays/' + k).remove();
                renderNpList();
                _refreshNpModalUi();
            } catch (err) {
                showToast('Could not remove Natalie PTO: ' + (err.message || err), { type: 'error' });
            }
        });
    });
}

function openNataliePtoModal(prefillDate) {
    if (!canManageNataliePto()) return; // Belt-and-suspenders — button is also hidden.
    const d = prefillDate || activeDayDate || cursor || today;
    activeNpDate = new Date(d);
    activeNpDate.setHours(0, 0, 0, 0);

    document.getElementById('npScopeDay').checked = true;
    document.getElementById('npDay').value = fmt(activeNpDate);
    document.getElementById('npStart').value = fmt(activeNpDate);
    document.getElementById('npEnd').value = fmt(activeNpDate);

    renderNpList();
    _refreshNpModalUi();
    document.getElementById('npModalBack').classList.add('open');
}

document.querySelectorAll('input[name="npScope"]').forEach(radio => {
    radio.addEventListener('change', _refreshNpModalUi);
});
document.getElementById('npDay').addEventListener('change', () => {
    const v = document.getElementById('npDay').value;
    if (v) { activeNpDate = parseDate(v); }
    _refreshNpModalUi();
});
// Auto-advance end date when start is moved past it (mirrors the PTO modal).
document.getElementById('npStart').addEventListener('change', () => {
    const s = document.getElementById('npStart');
    const e = document.getElementById('npEnd');
    if (s.value && e.value && s.value > e.value) e.value = s.value;
    _refreshNpModalUi();
});
document.getElementById('npEnd').addEventListener('change', _refreshNpModalUi);

document.getElementById('npCancel').addEventListener('click', () => {
    document.getElementById('npModalBack').classList.remove('open');
});
document.getElementById('npModalBack').addEventListener('click', e => {
    if (e.target.id === 'npModalBack') e.target.classList.remove('open');
});

document.getElementById('npSave').addEventListener('click', async () => {
    if (!canManageNataliePto()) return;
    const scope = document.querySelector('input[name="npScope"]:checked').value;
    const dates = _npDatesForScope(scope);
    if (dates.length === 0) {
        showToast('Nothing to add — check the dates.', { type: 'error' });
        return;
    }
    const writes = {};
    dates.forEach(d => { writes['scheduler/natalieptoDays/' + fmt(d)] = true; });
    try {
        await db.ref().update(writes);
        renderNpList();
        _refreshNpModalUi();
        showToast(
            dates.length === 1 ? 'Natalie PTO added.' : `Natalie PTO added for ${dates.length} days.`,
            { type: 'success' }
        );
        document.getElementById('npModalBack').classList.remove('open');
    } catch (err) {
        showToast('Could not save Natalie PTO: ' + (err.message || err), { type: 'error' });
    }
});

// Proxy + toolbar button → open the modal.
document.getElementById('addNataliePtoBtn').addEventListener('click', () => openNataliePtoModal(null));
(function wireNataliePtoToolbarBtn() {
    const btn = document.getElementById('toolbarNataliePtoBtn');
    if (btn) btn.addEventListener('click', () => openNataliePtoModal(null));
})();

// Every workday in the call cycle containing `date` (for full-call-week
// overrides/requests).
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
    renderFreetextDatalist();

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
        // PTO/off-site rows are editable: a regular override brings them back on
        // duty; "— No service —" clears it.
        const currentId = (a.type === 'service' || a.type === 'off_site')
            ? (a.service ? a.service.id : '')
            : '';
        const currentIsFt = isFreetextServiceId(currentId);
        const allOptions = [...SERVICES, COMBO_SVC, ...OFF_SERVICES];
        const opts = allOptions.map(s =>
            `<option value="${s.id}" ${!currentIsFt && s.id === currentId ? 'selected' : ''}>${s.name}</option>`
        ).join('');
        const noneOpt = `<option value="" ${currentId === '' ? 'selected' : ''}>— No service —</option>`;
        // Admin extras: "Custom service…" freetext + per-row Lock. Non-admins
        // see neither, but a current freetext assignment is injected so the select
        // displays correctly.
        const customOpt = admin
            ? `<option value="__ft__" ${currentIsFt ? 'selected' : ''}>Custom service…</option>`
            : (currentIsFt
                ? `<option value="${escapeHtml(currentId)}" selected>${escapeHtml(a.service.name)} (custom)</option>`
                : '');
        const lockId = getServiceLock(activeSvcDayKey, p.id);
        // data-initial = displayed value at open, so only selects the admin
        // actually changed become recompute pins (pinning every prefilled dropdown
        // would overconstrain the optimizer).
        const selectHtml = `<select data-pid="${p.id}" data-initial="${escapeHtml(currentId)}">${noneOpt}${opts}${customOpt}</select>`;
        const lockToggleHtml = admin
            ? `<label class="svc-lock-toggle" title="Lock this assignment in place — recompute won't move it. Custom & off-site services are always locked.">
                   <input type="checkbox" class="svc-lock-cb" data-lock-pid="${p.id}"
                          data-initial-lock="${lockId ? '1' : '0'}" ${lockId ? 'checked' : ''} />
                   <span>Lock</span>
               </label>`
            : '';
        const ftInputHtml = admin
            ? `<input type="text" class="svc-ft-input" data-ft-pid="${p.id}"
                      list="ftServiceNames" maxlength="40" autocomplete="off" spellcheck="false"
                      placeholder="Type the service, e.g. CAP Inspection"
                      style="display:${currentIsFt ? '' : 'none'};"
                      value="${currentIsFt ? escapeHtml(a.service.name) : ''}" />`
            : '';
        return `<label style="margin-top:10px;">${p.name}${a.type === 'pto' ? ' <span style="font-size:11px;color:var(--ink-3);">(PTO)</span>' : a.type === 'off_site' ? ' <span style="font-size:11px;color:var(--ink-3);">(Off Site)</span>' : ''}</label>
        <div class="svc-row">${selectHtml}${lockToggleHtml}</div>${ftInputHtml}`;
    }).join('');

    // Sync each admin row's forced-lock state (non-standard picks are
    // always locked) for the values shown at open time.
    if (admin) {
        container.querySelectorAll('select[data-pid]').forEach(sel => {
            _svcRowSyncLock(sel);
        });
    }
    document.getElementById('svcModalBack').classList.add('open');
}

// ── Service-modal row behavior (delegated, wired once) ── non-standard
// picks force + disable the Lock checkbox; the manual choice is remembered
// for standard services.
function _svcRowSyncLock(sel) {
    const pid = sel.dataset.pid;
    const cb = document.querySelector(`#svcAssignments .svc-lock-cb[data-lock-pid="${pid}"]`);
    if (!cb) return;
    const v = sel.value;
    const forced = v === '__ft__' || (v && isNonStandardServiceId(v));
    if (forced) {
        if (cb.dataset.prevManual === undefined) {
            cb.dataset.prevManual = cb.checked ? '1' : '0';
        }
        cb.checked = true;
        cb.disabled = true;
    } else {
        cb.disabled = false;
        if (cb.dataset.prevManual !== undefined) {
            cb.checked = cb.dataset.prevManual === '1';
            delete cb.dataset.prevManual;
        }
    }
}

(function wireSvcAssignmentRows() {
    const container = document.getElementById('svcAssignments');
    if (!container) return;
    container.addEventListener('change', e => {
        const sel = e.target.closest('select[data-pid]');
        if (!sel) return;
        const pid = sel.dataset.pid;
        const ftInput = container.querySelector(`.svc-ft-input[data-ft-pid="${pid}"]`);
        if (ftInput) {
            ftInput.style.display = sel.value === '__ft__' ? '' : 'none';
            if (sel.value === '__ft__') setTimeout(() => ftInput.focus(), 0);
        }
        _svcRowSyncLock(sel);
    });
})();

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
        // Per-row intent: resolved service id ('ft:' for custom) + desired lock.
        // Only rows whose SERVICE or LOCK changed are touched — unchanged prefills
        // must never become recompute pins (overconstrains the optimizer).
        const rows = [];
        for (const s of selects) {
            const pid = s.dataset.pid;
            const initialSid = s.dataset.initial || '';
            let sid;
            if (s.value === '__ft__') {
                const ftInput = document.querySelector(`#svcAssignments .svc-ft-input[data-ft-pid="${pid}"]`);
                sid = makeFreetextServiceId(ftInput ? ftInput.value : '');
                if (!sid) {
                    showToast(`Type a name for ${_chgShortName(parseInt(pid, 10))}'s custom service first.`, { type: 'error' });
                    if (ftInput) ftInput.focus();
                    return;
                }
            } else {
                sid = s.value || '';
            }
            const cb = document.querySelector(`#svcAssignments .svc-lock-cb[data-lock-pid="${pid}"]`);
            const initialLock = cb ? cb.dataset.initialLock === '1' : false;
            // Non-standard services are ALWAYS locked when set; standard
            // ones follow the checkbox. Clearing a slot never keeps a lock.
            const wantLock = sid
                ? (isNonStandardServiceId(sid) || (cb ? cb.checked : false))
                : false;
            rows.push({
                pid,
                initialSid,
                sid,
                initialLock,
                wantLock,
                sidChanged: sid !== initialSid,
                lockChanged: (sid ? wantLock : false) !== initialLock,
            });
        }

        const touched = rows.filter(r => r.sidChanged || r.lockChanged);
        if (touched.length === 0) {
            document.getElementById('svcModalBack').classList.remove('open');
            return;
        }

        // ── Locked-slot guard ── replacing/unlocking is allowed (admin is the
        // approver) but called out first.
        const lockedTouched = touched.filter(r => r.initialLock && (r.sidChanged || !r.wantLock));
        if (lockedTouched.length > 0) {
            const names = lockedTouched
                .map(r => _chgShortName(parseInt(r.pid, 10)))
                .join(', ');
            const okGo = confirm(
                `${names}: this day's assignment is locked. ` +
                `Saving will replace or unlock it. Continue?`);
            if (!okGo) return;
        }

        // Track what was just saved so the recompute prompt can use the new
        // values as locks before the listener fires.
        let recomputeFromDate = null;
        const recomputePins = {};
        const anySidChanged = touched.some(r => r.sidChanged);

        // Apply one day's worth of changes to an overrides map + build the
        // matching lock writes and pins for that day.
        function applyRowsToDay(dKey, existingOverrides, lockWrites, pins) {
            const merged = Object.assign({}, existingOverrides || {});
            touched.forEach(r => {
                if (r.sidChanged) {
                    if (r.sid) merged[r.pid] = r.sid;
                    else delete merged[r.pid];
                } else if (r.lockChanged && r.wantLock) {
                    // Lock-in of the CURRENT assignment: back the lock with
                    // a concrete override so the schedule can't drift under it.
                    merged[r.pid] = r.sid;
                }
                if (r.sid && r.wantLock) {
                    lockWrites['scheduler/serviceLocks/' + dKey + '/' + r.pid] = r.sid;
                } else {
                    _lockClearWrite(lockWrites, dKey, r.pid);
                }
                if (r.sid && (r.sidChanged || r.wantLock)) {
                    pins[r.pid] = r.sid;
                }
            });
            return merged;
        }

        if (scope === 'day') {
            const lockWrites = {};
            const pins = {};
            const merged = applyRowsToDay(activeSvcDayKey,
                serviceOverrides[activeSvcDayKey], lockWrites, pins);

            if (Object.keys(merged).length === 0) {
                await db.ref('scheduler/serviceOverrides/' + activeSvcDayKey).remove();
            } else {
                await db.ref('scheduler/serviceOverrides/' + activeSvcDayKey).set(merged);
            }
            if (Object.keys(lockWrites).length > 0) {
                await db.ref().update(lockWrites);
            }
            recomputePins[activeSvcDayKey] = pins;
            if (anySidChanged) recomputeFromDate = activeSvcDate;
        } else {
            // Full call week: merge into every workday in the cycle.
            const days = workdaysInCallCycle(activeSvcDate);
            const writes = {};
            days.forEach(d => {
                const dKey = fmt(d);
                const pins = {};
                const merged = applyRowsToDay(dKey, serviceOverrides[dKey], writes, pins);
                if (Object.keys(merged).length === 0) {
                    writes['scheduler/serviceOverrides/' + dKey] = null;
                } else {
                    writes['scheduler/serviceOverrides/' + dKey] = merged;
                }
                recomputePins[dKey] = pins;
            });
            if (Object.keys(writes).length > 0) {
                await db.ref().update(writes);
            }
            if (anySidChanged && days.length > 0) recomputeFromDate = days[0];
        }

        // ── Change log ── one line per touched row, including pure lock flips.
        const update = {};
        const cleared = new Set();
        const lines = [];
        touched.forEach(r => {
            const who = _chgShortName(parseInt(r.pid, 10));
            if (r.sidChanged) {
                if (r.sid) {
                    update[r.pid] = r.sid;
                    lines.push(`${who} → ${_chgServiceName(r.sid)}${r.wantLock ? ' (locked)' : ''}`);
                } else {
                    cleared.add(String(r.pid));
                    lines.push(`${who} → cleared`);
                }
            } else if (r.wantLock) {
                lines.push(`${who} → locked (${_chgServiceName(r.sid)})`);
            } else {
                lines.push(`${who} → unlocked`);
            }
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
        } else {
            // Pure lock/unlock save — nothing moved, so no recompute offer.
            showToast('Locks updated.');
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

    // Warn if the reset will discard approved-locked assignments.
    const dayLocks = serviceLocks[activeSvcDayKey] || {};
    if (Object.keys(dayLocks).length > 0) {
        const names = Object.keys(dayLocks)
            .map(pid => _chgShortName(parseInt(pid, 10)))
            .join(', ');
        const okGo = confirm(
            `${names}: assignment(s) on this day were approved from requests and are locked. ` +
            `Resetting will remove the lock(s) too. Continue?`);
        if (!okGo) return;
    }

    if (scope === 'day') {
        await db.ref('scheduler/serviceOverrides/' + activeSvcDayKey).remove();
        await db.ref('scheduler/serviceLocks/' + activeSvcDayKey).remove();
        recomputePins[activeSvcDayKey] = {};
        recomputeFromDate = activeSvcDate;
    } else {
        // Wipe overrides (and locks) for every workday in the call cycle
        const days = workdaysInCallCycle(activeSvcDate);
        const writes = {};
        days.forEach(d => {
            const dKey = fmt(d);
            writes['scheduler/serviceOverrides/' + dKey] = null;
            writes['scheduler/serviceLocks/' + dKey] = null;
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
    // If the user is currently on the tracking page, refresh it too so the
    // PTO tracker reflects the latest vacations and allotment data.
    const _appEl = document.getElementById('app');
    if (_appEl && _appEl.getAttribute('data-page') === 'tracking'
        && typeof renderTrackingPage === 'function') {
        try { renderTrackingPage(); } catch (_) { /* ignore */ }
    }
    // Likewise refresh the PTO allotment list in Settings when visible —
    // so multi-tab edits propagate without requiring a page switch.
    if (_appEl && _appEl.getAttribute('data-page') === 'settings'
        && typeof renderPtoAllotmentSettings === 'function') {
        try { renderPtoAllotmentSettings(); } catch (_) { /* ignore */ }
    }
}

// ────────────── NAV EVENTS ──────────────
document.getElementById('viewTabs').addEventListener('click', e => {
    const btn = e.target.closest('.view-tab');
    if (!btn) return;
    document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    view = btn.dataset.view;
    // Mirror to the mobile view select so the surfaces stay in sync.
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

// ── Mobile dropdown handlers ── the selects delegate to the hidden tab
// buttons via .click() so the canonical logic runs from one code path.
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

// ── Swipe navigation (mobile only) ── prev/next periods are
// pre-rendered snapshots flush to either side of #main; all three translate
// with the finger. Qualifying swipe → the band continues; aborted drag →
// snap back. Snapshots are #main's siblings in .content-area (already
// overflow:hidden); the toolbar above is unaffected.
(function setupSwipeNavigation() {
    const mainEl = document.getElementById('main');
    if (!mainEl) return;

    let startX = 0, startY = 0, startTime = 0;
    let tracking = false, dragging = false;
    let isAnimating = false;

    // Live-drag tracking. Commit decisions key off lastDx — the position the
    // user SEES (fingers roll back a few px on release) — while
    // prevDx/prevT/lastT feed a release-velocity estimate so a fling commits
    // under half.
    let lastDx = 0, lastT = 0, prevDx = 0, prevT = 0;

    // Neighbor snapshots built on first confirmed horizontal move and
    // torn down at the end of every gesture (commit or abort).
    let prevSnap = null, nextSnap = null;
    let snapWidth = 0;

    const MIN_DISTANCE_PX = 60;   // horizontal travel required to count as a swipe
    const MAX_VERTICAL_PX  = 60;  // vertical drift allowed (keeps scroll gestures intact)
    const ANIM_MS          = 280; // slide-in / slide-out duration

    // Cursor value `delta` periods away; mirrors the prev/next handlers so
    // swipes and buttons stay aligned.
    function cursorFor(delta) {
        if (view === 'day')        return addDays(cursor, delta);
        else if (view === 'week')  return addDays(cursor, 7 * delta);
        else if (view === 'month') return new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1);
        else                       return new Date(cursor.getFullYear() + delta, cursor.getMonth(), 1);
    }

    // Render the neighbor into a temporary DETACHED element by swapping ids
    // so renderMain()'s getElementById('main') hits the temp. Writing into the
    // real #main mid-gesture destroys the touch-target and iOS Safari stops
    // dispatching touchmove/touchend (swipe freezes). Also save/restore the
    // global `cursor` (+ period label) — otherwise the second snapshot renders
    // the wrong period and both panels show the same date.
    function snapshotPeriod(periodCursor) {
        const savedCursor = cursor;
        cursor = periodCursor;

        // Use <main> (not <div>) so `main {}` / `.content-area > main {}` padding
        // rules match the snapshot; a <div> gets the universal 0-padding reset and
        // the incoming panel appears raised, snapping down on commit.
        const temp = document.createElement('main');
        // Off-screen + hidden so the in-progress render never paints.
        temp.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden';
        mainEl.id = '__main_swipe_real';
        temp.id  = 'main';
        document.body.appendChild(temp);
        try {
            renderMain();
        } finally {
            temp.id  = '';
            mainEl.id = 'main';
            document.body.removeChild(temp);
            // Restore what renderMain mutated outside the temp: the global cursor
            // and the period label (#currentPeriod lives outside #main).
            cursor = savedCursor;
            renderPeriodLabel();
        }
        temp.setAttribute('aria-hidden', 'true');
        return temp;
    }

    // Build prev + next snapshots flush to either side of #main, once per
    // gesture after the 8px horizontal dead zone (~3 renderMain calls, so pure
    // taps and vertical scrolls don't pay).
    function buildNeighbors() {
        const w      = mainEl.offsetWidth || window.innerWidth;
        const parent = mainEl.offsetParent || mainEl.parentElement;
        const top    = mainEl.offsetTop;
        const left   = mainEl.offsetLeft;
        const height = mainEl.offsetHeight;
        snapWidth = w;

        // snapshotPeriod restores `cursor` and the period label — safe to call
        // without outer-state side effects.
        prevSnap = snapshotPeriod(cursorFor(-1));
        nextSnap = snapshotPeriod(cursorFor(+1));

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

    // Run `cb` when #main's transform transition ends, with a setTimeout
    // fallback (identical start/end values, hidden tab).
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

    // Commit: neighbor slides center, #main slides off, other neighbor
    // further off; on end, update cursor, re-render, snap transform, drop
    // snapshots. Snapshots' z-index:5 masks #main during the swap — no flash.
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
        lastDx = 0; lastT = startTime;
        prevDx = 0; prevT = startTime;
        // Kill any residual transition so the live-drag is instant.
        mainEl.style.transition = 'none';
        mainEl.style.transform  = '';
    }, { passive: true });

    // passive:false so preventDefault() can claim confirmed-horizontal
    // gestures while vertical scroll stays native.
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
            // Build neighbor previews once the swipe is confirmed (~3 renderMain
            // calls; one possible hitched frame, then smooth).
            buildNeighbors();
        }

        // Confirmed horizontal drag: move the whole band with the finger
        // and suppress native scroll.
        e.preventDefault();
        // Record where the band actually is, plus a short velocity window
        // (previous sample → current sample) for the release-fling test.
        prevDx = lastDx; prevT = lastT;
        lastDx = dx;     lastT = Date.now();
        moveAll(dx);
    }, { passive: false });

    mainEl.addEventListener('touchend', (e) => {
        if (!tracking) return;
        tracking = false;
        if (!dragging) return;
        dragging = false;

        const t  = e.changedTouches[0];
        const dy = t.clientY - startY;

        // Commit off the band's last RENDERED position (lastDx), not touchend —
        // fingers roll back on lift and lastDx is what the user saw.
        const dx = lastDx;

        // Too much vertical drift — this was a scroll, not a swipe.
        if (Math.abs(dy) > MAX_VERTICAL_PX) {
            snapBack(dx);
            return;
        }

        // Release velocity (px/ms, signed) over the last touchmove window — a
        // fast fling commits even before halfway.
        const dt  = Math.max(1, lastT - prevT);
        const vel = (lastDx - prevDx) / dt;

        // Commit if dragged ≥ halfway, OR a deliberate fling past minimum
        // distance with release velocity in the drag direction.
        const draggedHalf = snapWidth > 0 && Math.abs(dx) >= snapWidth * 0.5;
        const FLING_VEL    = 0.5; // px/ms ≈ a brisk flick
        const flung        = Math.abs(dx) >= MIN_DISTANCE_PX &&
                             Math.abs(vel) >= FLING_VEL &&
                             Math.sign(vel) === Math.sign(dx);

        if (draggedHalf || flung) {
            // Valid swipe — commit. swipe left → next; swipe right → prev.
            commitAnimation(dx < 0, dx);
        } else {
            snapBack(dx);
        }
    }, { passive: true });

    mainEl.addEventListener('touchcancel', () => {
        // Cancel always aborts; snap back from the last rendered position.
        if (dragging) snapBack(lastDx);
        tracking = false;
        dragging = false;
    }, { passive: true });
})();

// Day tab is mobile-only: crossing to desktop while on Day swaps to
// Week. No auto-switch the other way (respects a deliberate mid-session
// choice); the mobile Day override only fires on first load.
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
// Phone-only dropdown for Manage PTO / Requests / Export; items delegate
// to the sidebar button handlers so behavior stays in lock-step.
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

// Tap-to-today on the period label: desktop only when off-today; mobile
// always (no dedicated Today button).
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
// Builds an iCalendar file; Outlook / Google / Apple import natively.

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

// Contiguous PTO blocks per pathologist with weekend flanks (PTO
// touching Mon extends back to Sat, Fri forward to Sun); sorted, merged,
// clipped to range.
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

// Contiguous on-call blocks in range; day-by-day walk so day overrides
// split blocks and holiday-shifted cycles come through onCallIdForDay.
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

// VEVENT blocks per pathologist + range + options, matching the user's
// Outlook formatting ("Dr. {Last} {tag}", consolidated PTO/Call blocks,
// category colors).
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

// Auto-advance end date when start is moved past it
document.getElementById('exportStart').addEventListener('change', () => {
    const startEl = document.getElementById('exportStart');
    const endEl   = document.getElementById('exportEnd');
    if (startEl.value && endEl.value && startEl.value > endEl.value) {
        endEl.value = startEl.value;
    }
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

    // Default-page segmented control. Sets which page opens on launch.
    const defaultPageSeg = document.getElementById('defaultPageSeg');
    if (defaultPageSeg) {
        defaultPageSeg.addEventListener('click', e => {
            const b = e.target.closest('.seg-btn');
            if (!b) return;
            const v = b.dataset.value;
            if (!VALID_DEFAULT_PAGES.includes(v)) return;
            if (settings.defaultPage === v) return;
            settings.defaultPage = v;
            saveSettings();
            applySettings();
        });
    }

    // Default-view control sets the LAUNCH default only — not the current
    // view.
    const defaultViewSeg = document.getElementById('defaultViewSeg');
    if (defaultViewSeg) {
        defaultViewSeg.addEventListener('click', e => {
            const b = e.target.closest('.seg-btn');
            if (!b) return;
            const v = b.dataset.value;
            // Lake Forest's choice lands in its own field so it never
            // clobbers a pathologist's saved default on a shared browser.
            if (isLakeForest()) {
                if (!VALID_LF_DEFAULT_VIEWS.includes(v)) return;
                if (settings.lfDefaultView === v) return;
                settings.lfDefaultView = v;
            } else {
                if (!VALID_DEFAULT_VIEWS.includes(v)) return;
                if (settings.defaultView === v) return;
                settings.defaultView = v;
            }
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
            // Firebase sign-out; the onAuthStateChanged handler tears down the
            // data listeners and shows the login overlay.
            auth.signOut();
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
// ════ REWORKED LAYOUT — page navigation + sidebar ════
// Sidebar pages: schedule (calendar) / requests / changes / tracking, plus
// Settings and Sign out. The toolbar kebab still mirrors Manage PTO /
// Requests / Export / Recompute.

(function initPageNavigation() {
    const VALID_PAGES = ['schedule', 'requests', 'changes', 'tracking', 'settings'];
    let currentPage = 'schedule';

    const app = document.getElementById('app');
    const navItems = document.querySelectorAll('.page-nav .nav-item, .aside-bottom .nav-item');

    // Switch the visible "page": schedule shows toolbar+main; others show
    // their page-shell; settings is the full settings page.
    function setPage(page) {
        if (isLakeForest() && page === 'tracking') page = 'schedule'; // LF guest: no tracking page
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

    // Initial page — use the user's saved default (falls back to 'schedule')
    const initialPage = VALID_DEFAULT_PAGES.includes(settings.defaultPage)
        ? settings.defaultPage : 'schedule';
    setPage(initialPage);

    // ── Mobile sidebar (slide-out drawer) ─────────────────────────────
    const asideToggleBtn = document.getElementById('asideToggleBtn');
    const sidebarBackdrop = document.getElementById('sidebarBackdrop');

    // Scroll-lock: save scrollY, pin body with position:fixed (CSS class),
    // restore on close — the only reliable iOS Safari approach;
    // overflow:hidden isn't enough there.
    let sidebarSavedScrollY = 0;

    function lockBodyScrollForSidebar() {
        sidebarSavedScrollY = window.scrollY || window.pageYOffset || 0;
        // Apply the saved offset as a negative top so the visible page
        // doesn't jump back to 0 when position:fixed engages.
        document.body.style.top = `-${sidebarSavedScrollY}px`;
        document.body.classList.add('sidebar-scroll-locked');
    }

    function unlockBodyScrollForSidebar() {
        if (!document.body.classList.contains('sidebar-scroll-locked')) return;
        document.body.classList.remove('sidebar-scroll-locked');
        document.body.style.top = '';
        // Restore scroll position (skip the smooth-scroll behavior).
        window.scrollTo(0, sidebarSavedScrollY);
    }

    function openMobileSidebar() {
        if (!app) return;
        if (app.classList.contains('sidebar-open')) return;
        app.classList.add('sidebar-open');
        lockBodyScrollForSidebar();
    }
    function closeMobileSidebar() {
        if (!app) return;
        if (!app.classList.contains('sidebar-open')) return;
        app.classList.remove('sidebar-open');
        unlockBodyScrollForSidebar();
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
        // Swallow touch-drag gestures on the backdrop so they can't be
        // interpreted as scroll on the (now position:fixed) page behind it.
        sidebarBackdrop.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
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
            // Reset to schedule page so re-login lands there.
            setPage('schedule');
            // Firebase sign-out; onAuthStateChanged handles teardown + overlay.
            auth.signOut();
        });
    }

    // Mirror the kebab's alert dot onto the mobile hamburger (pending
    // requests visible before the menu opens).
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

// 'T' shortcut still jumps to today when the Today button is hidden
// (#todayBtn stays in the DOM for click-through; this is a safety net).
// Tracking-page per-conference "Add entry" buttons — moved from an inline
// <script>; mirrors admin visibility from #trackingAddBtn and opens the
// conference modal pre-set to each type.
(function () {
    function init() {
        var addBtn = document.getElementById('trackingAddBtn');
        var section = document.getElementById('trackingConfAdd');
        if (!addBtn || !section) return;

        // Mirror admin-only visibility from the hidden proxy button to our section.
        // schedule.js toggles addBtn.style.display = 'none' / '' / 'inline-flex'.
        function syncVisibility() {
            section.style.display = (addBtn.style.display === 'none') ? 'none' : '';
        }
        syncVisibility();
        new MutationObserver(syncVisibility).observe(addBtn, {
            attributes: true,
            attributeFilter: ['style']
        });

        // Wire each button: open via the proxy, pre-select the type, dispatch
        // 'change' so dependent fields render.
        var btns = section.querySelectorAll('.tracking-conf-btn');
        for (var i = 0; i < btns.length; i++) {
            btns[i].addEventListener('click', function () {
                var conf = this.getAttribute('data-conf');
                addBtn.click();
                var sel = document.getElementById('confType');
                if (sel && conf) {
                    sel.value = conf;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();