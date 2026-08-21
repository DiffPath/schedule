// ════════════════════════════════════════════════════════════════════════
// MOCK FIREBASE — in-browser stand-in for the real Firebase SDK
// ════════════════════════════════════════════════════════════════════════
//
// Load this INSTEAD of the four firebasejs/*-compat.js scripts (see
// schedule-mock.html). It defines a `window.firebase` global implementing
// exactly the API surface schedule.js + recompute.js use:
//
//   firebase.initializeApp(config)          → no-op
//   firebase.database().ref(path?)          → mock ref
//       .on('value', cb, errCb) / .off('value')
//       .set(v) / .update(obj) / .remove() / .push(v)      (all Promises)
//       snapshots: .exists() / .val()
//   firebase.auth()
//       .onAuthStateChanged(cb)
//       .signInWithEmailAndPassword(email, pw)
//       .signOut()
//   firebase.analytics()                    → no-op
//
// NOTHING touches the network. All data lives in memory and is persisted
// to THIS BROWSER's localStorage so the demo survives page refreshes and
// the sign-out → sign-in-as-admin flow. A floating banner offers a
// "Reset demo data" button that wipes the mock store and reloads.
//
// Sign-in: pick any name, password is "demo" for every account.
// (Histology stays passwordless — the app signs it in behind the scenes
// with its fixed credential, which the mock also accepts.)
//
// Fidelity notes (matching real RTDB behavior the app relies on):
//   • Local writes raise value events SYNCHRONOUSLY, so module globals
//     updated by listeners are already fresh when an awaited set()/update()
//     continues — same as the compat SDK.
//   • Initial .on('value') snapshots and auth-state emissions are ASYNC
//     (setTimeout 0), so nothing fires mid-parse of schedule.js.
//   • null values are stripped from written payloads and empty objects are
//     pruned, so update({...: null}) deletes and snap.exists() behaves.
//   • The app self-seeds scheduler/pathologists when the node is empty —
//     the mock deliberately leaves it empty so that real code path runs.
// ════════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    var DB_KEY = 'mockScheduler.db.v1';
    var AUTH_KEY = 'mockScheduler.auth.v1';
    var DEMO_PASSWORD = 'demo';
    var HISTOLOGY_FIXED_PW = 'histology-guest'; // the app auto-submits this
    var LAKE_FOREST_FIXED_PW = 'lakeforest-guest'; // ditto for the LF guest

    // ── localStorage with in-memory fallback (private mode, odd file:// setups) ──
    var memStore = {};
    function lsGet(k) {
        try { return window.localStorage.getItem(k); } catch (_) { return memStore[k] || null; }
    }
    function lsSet(k, v) {
        try { window.localStorage.setItem(k, v); } catch (_) { memStore[k] = v; }
    }
    function lsRemove(k) {
        try { window.localStorage.removeItem(k); } catch (_) { delete memStore[k]; }
    }

    // ── small utils ─────────────────────────────────────────────────────
    function deepClone(v) {
        return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
    }
    function splitPath(path) {
        return String(path == null ? '' : path).split('/').filter(function (s) { return s !== ''; });
    }
    function joinPath(a, b) {
        var segs = splitPath(a).concat(splitPath(b));
        return segs.join('/');
    }
    function isPlainObject(v) {
        return v !== null && typeof v === 'object' && !Array.isArray(v);
    }
    // Firebase strips nulls inside written payloads; empty containers don't
    // exist. Returns a cleaned copy, or null when nothing remains.
    function sanitize(v) {
        if (v === null || v === undefined) return null;
        if (Array.isArray(v)) {
            var outA = {};
            var anyA = false;
            v.forEach(function (item, i) {
                var c = sanitize(item);
                if (c !== null) { outA[String(i)] = c; anyA = true; }
            });
            return anyA ? outA : null;
        }
        if (isPlainObject(v)) {
            var out = {};
            var any = false;
            for (var k in v) {
                var c2 = sanitize(v[k]);
                if (c2 !== null) { out[k] = c2; any = true; }
            }
            return any ? out : null;
        }
        return v; // primitive
    }

    // ── data store ──────────────────────────────────────────────────────
    var data = loadData();

    function loadData() {
        var raw = lsGet(DB_KEY);
        if (raw) {
            try { return JSON.parse(raw) || {}; } catch (_) { /* fall through */ }
        }
        var seeded = buildSeed();
        lsSet(DB_KEY, JSON.stringify(seeded));
        return seeded;
    }
    function persist() {
        lsSet(DB_KEY, JSON.stringify(data));
    }

    function getAt(segs) {
        var node = data;
        for (var i = 0; i < segs.length; i++) {
            if (!isPlainObject(node)) return undefined;
            node = node[segs[i]];
            if (node === undefined) return undefined;
        }
        return node;
    }
    // Set (or delete, when value is null) at path; prunes empty parents.
    function setAt(segs, value) {
        var clean = sanitize(value);
        if (segs.length === 0) {
            data = clean === null ? {} : clean;
            return;
        }
        if (clean === null) {
            // delete + prune upward
            var stack = [];
            var node = data;
            for (var i = 0; i < segs.length - 1; i++) {
                if (!isPlainObject(node)) return; // path doesn't exist
                stack.push([node, segs[i]]);
                node = node[segs[i]];
                if (node === undefined) return;
            }
            if (!isPlainObject(node)) return;
            delete node[segs[segs.length - 1]];
            for (var j = stack.length - 1; j >= 0; j--) {
                var parent = stack[j][0];
                var key = stack[j][1];
                var child = parent[key];
                if (isPlainObject(child) && Object.keys(child).length === 0) {
                    delete parent[key];
                } else {
                    break;
                }
            }
            return;
        }
        var cur = data;
        for (var s = 0; s < segs.length - 1; s++) {
            if (!isPlainObject(cur[segs[s]])) cur[segs[s]] = {};
            cur = cur[segs[s]];
        }
        cur[segs[segs.length - 1]] = clean;
    }

    // ── listeners + notification ────────────────────────────────────────
    // Local writes raise events synchronously (matching the compat SDK), so
    // code like `await ref.set(x); openDayDetail(...)` sees fresh globals.
    // A reentrancy guard turns writes-from-within-a-listener (e.g. the app
    // seeding scheduler/pathologists) into one follow-up pass.
    var listeners = []; // { path, cb, errCb }
    var notifying = false;
    var notifyAgain = false;

    function snapshotFor(path) {
        var segs = splitPath(path);
        var v = deepClone(getAt(segs));
        return {
            key: segs.length ? segs[segs.length - 1] : null,
            exists: function () { return v !== undefined && v !== null; },
            val: function () { return v === undefined ? null : v; },
        };
    }
    function notifyAll() {
        if (notifying) { notifyAgain = true; return; }
        notifying = true;
        try {
            var passes = 0;
            do {
                notifyAgain = false;
                passes++;
                persist();
                listeners.slice().forEach(function (l) {
                    try {
                        l.cb(snapshotFor(l.path));
                    } catch (e) {
                        console.error('[mock-firebase] listener error at "' + l.path + '":', e);
                    }
                });
            } while (notifyAgain && passes < 10);
        } finally {
            notifying = false;
        }
    }

    // ── push keys (Firebase-ish: time-ordered, collision-proofed) ───────
    var lastPushMs = 0;
    var pushSeq = 0;
    function genPushKey() {
        var now = Date.now();
        if (now === lastPushMs) { pushSeq++; } else { lastPushMs = now; pushSeq = 0; }
        var rand = '';
        for (var i = 0; i < 8; i++) {
            rand += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
                .charAt(Math.floor(Math.random() * 62));
        }
        return '-M' + now.toString(36) + ('00' + pushSeq.toString(36)).slice(-2) + rand;
    }

    // ── ref ─────────────────────────────────────────────────────────────
    function makeRef(path) {
        var norm = splitPath(path).join('/');
        var ref = {
            key: splitPath(norm).length ? splitPath(norm)[splitPath(norm).length - 1] : null,
            toString: function () { return 'mock://' + norm; },

            on: function (evt, cb, errCb) {
                if (evt !== 'value') {
                    console.warn('[mock-firebase] only "value" events are supported (got "' + evt + '")');
                    return cb;
                }
                var entry = { path: norm, cb: cb, errCb: errCb };
                listeners.push(entry);
                // Initial snapshot is async, like the real SDK.
                setTimeout(function () {
                    if (listeners.indexOf(entry) === -1) return; // off() before first fire
                    try { cb(snapshotFor(norm)); }
                    catch (e) { console.error('[mock-firebase] listener error at "' + norm + '":', e); }
                }, 0);
                return cb;
            },
            off: function (evt, cb) {
                listeners = listeners.filter(function (l) {
                    if (l.path !== norm) return true;
                    if (cb && l.cb !== cb) return true;
                    return false;
                });
            },

            set: function (value) {
                setAt(splitPath(norm), value);
                notifyAll();
                return Promise.resolve();
            },
            remove: function () {
                setAt(splitPath(norm), null);
                notifyAll();
                return Promise.resolve();
            },
            update: function (obj) {
                if (obj && typeof obj === 'object') {
                    Object.keys(obj).forEach(function (rel) {
                        setAt(splitPath(joinPath(norm, rel)), obj[rel]);
                    });
                    notifyAll();
                }
                return Promise.resolve();
            },
            push: function (value) {
                var key = genPushKey();
                var childPath = joinPath(norm, key);
                if (value !== undefined) {
                    setAt(splitPath(childPath), value);
                    notifyAll();
                }
                // ThenableReference: awaitable AND usable as a ref (.key etc).
                // CRITICAL: the promise must resolve with a PLAIN ref — if it
                // resolved with the thenable itself, promise adoption would
                // unwrap it recursively forever. (The real compat SDK resolves
                // with the underlying plain Reference for the same reason.)
                var plainRef = makeRef(childPath);
                var thenable = makeRef(childPath);
                thenable.then = function (res, rej) {
                    return Promise.resolve(plainRef).then(res, rej);
                };
                thenable.catch = function (rej) {
                    return Promise.resolve(plainRef).catch(rej);
                };
                return thenable;
            },
        };
        return ref;
    }

    var dbApi = {
        ref: function (path) { return makeRef(path || ''); },
    };

    // ── auth ────────────────────────────────────────────────────────────
    var currentUser = null;
    try {
        var savedEmail = lsGet(AUTH_KEY);
        if (savedEmail) currentUser = { email: savedEmail };
    } catch (_) { /* signed out */ }

    var authHandlers = [];
    function emitAuth() {
        var u = currentUser;
        authHandlers.slice().forEach(function (cb) {
            setTimeout(function () {
                try { cb(u); }
                catch (e) { console.error('[mock-firebase] auth handler error:', e); }
            }, 0);
        });
    }
    function knownLocalPart(local) {
        if (local === 'grossroom' || local === 'kathleen' || local === 'histology' || local === 'lakeforest') return true;
        return /^p\d{1,4}$/.test(local); // p<id>; the app validates the id itself
    }
    function authError(code, message) {
        var e = new Error(message);
        e.code = code;
        return e;
    }

    var authApi = {
        onAuthStateChanged: function (cb) {
            authHandlers.push(cb);
            var u = currentUser;
            setTimeout(function () {
                try { cb(u); }
                catch (e) { console.error('[mock-firebase] auth handler error:', e); }
            }, 0);
            return function () {
                var i = authHandlers.indexOf(cb);
                if (i >= 0) authHandlers.splice(i, 1);
            };
        },
        signInWithEmailAndPassword: function (email, password) {
            email = String(email || '').toLowerCase().trim();
            var at = email.indexOf('@');
            var local = at > 0 ? email.slice(0, at) : '';
            if (!knownLocalPart(local)) {
                return Promise.reject(authError('auth/user-not-found',
                    '[mock] No account for ' + email + '.'));
            }
            var ok = (password === DEMO_PASSWORD)
                || (local === 'histology' && password === HISTOLOGY_FIXED_PW)
                || (local === 'lakeforest' && password === LAKE_FOREST_FIXED_PW);
            if (!ok) {
                return Promise.reject(authError('auth/wrong-password',
                    '[mock] Wrong password — every mock account uses "' + DEMO_PASSWORD + '".'));
            }
            currentUser = { email: email };
            lsSet(AUTH_KEY, email);
            emitAuth();
            return Promise.resolve({ user: currentUser });
        },
        signOut: function () {
            currentUser = null;
            lsRemove(AUTH_KEY);
            emitAuth();
            return Promise.resolve();
        },
        get currentUser() { return currentUser; },
    };

    // ── firebase global ─────────────────────────────────────────────────
    window.firebase = {
        initializeApp: function () { return {}; },
        database: function () { return dbApi; },
        auth: function () { return authApi; },
        analytics: function () { return { logEvent: function () { } }; },
        apps: [{}],
        SDK_VERSION: 'mock-1.0.0',
    };

    // ── demo seed ───────────────────────────────────────────────────────
    // Kept intentionally small. scheduler/pathologists is ABSENT so the
    // app's own "seed if empty" write path runs on first sign-in. Dates are
    // computed relative to today so the demo always looks current:
    //   • one pending service_change request (from Dr. Mujeeb, next workday
    //     +3) — approve it as the admin to watch the lock + glow appear
    //   • one upcoming PTO range for Dr. Rehman, for calendar realism
    function isoLocal(d) {
        var p = function (n) { return String(n).padStart(2, '0'); };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }
    function nextWorkday(base, daysAhead) {
        var d = new Date(base);
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() + daysAhead);
        while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
        return d;
    }
    function buildSeed() {
        var today = new Date();
        var reqDay = nextWorkday(today, 3);
        var ptoStart = nextWorkday(today, 10);
        var ptoEnd = nextWorkday(ptoStart, 2);
        // Fiscal year (Sept 1 – Aug 31) labelled by its start year — matches
        // the app's getAcademicYearOfDate().
        var fiscalYear = today.getMonth() >= 8 ? today.getFullYear() : today.getFullYear() - 1;
        return {
            scheduler: {
                vacations: {
                    'seedvac1': {
                        pathologistId: 3,
                        start: isoLocal(ptoStart),
                        end: isoLocal(ptoEnd),
                    },
                },
                requests: {
                    'seedreq1': {
                        requesterId: 2,
                        type: 'service_change',
                        status: 'pending',
                        createdAt: Date.now(),
                        payload: {
                            date: isoLocal(reqDay),
                            serviceId: 'huntley',
                            scope: 'day',
                        },
                        note: 'Clinic conflict that morning — Huntley works best. (demo seed)',
                    },
                },
                // Per-fiscal-year PTO allotment demo: Dr. Mujeeb (id 2) gets
                // 30 days THIS fiscal year instead of his 35-day default.
                // Visible in Settings → PTO allotments and the tracking page.
                ptoAllotments: (function () {
                    var m = {};
                    m[String(fiscalYear)] = { '2': 30 };
                    return m;
                })(),
                // Consult rotation demo: two cases already logged (Moravek
                // then Mujeeb), so the tracker shows Dr. Rehman as next up
                // and suggests the next MHSC<yy>-<nnnn> in sequence. Case
                // numbers restart at 0001 each calendar year, so a seed
                // that straddles New Year stays valid.
                consultLog: (function () {
                    function daysAgo(n) {
                        var d = new Date(today);
                        d.setHours(0, 0, 0, 0);
                        d.setDate(d.getDate() - n);
                        return d;
                    }
                    function yy(d) { return String(d.getFullYear() % 100).padStart(2, '0'); }
                    var d1 = daysAgo(8);
                    var d2 = daysAgo(3);
                    var y1 = yy(d1);
                    var y2 = yy(d2);
                    return {
                        'seedcon1': {
                            date: isoLocal(d1),
                            source: 'Northwestern Medicine',
                            pathologistId: 1,
                            caseNumber: 'MHSC' + y1 + '-0001',
                            createdAt: d1.getTime(),
                        },
                        'seedcon2': {
                            date: isoLocal(d2),
                            source: 'Rush Copley',
                            pathologistId: 2,
                            caseNumber: 'MHSC' + y2 + '-' + (y1 === y2 ? '0002' : '0001'),
                            createdAt: d2.getTime(),
                        },
                    };
                })(),
                // Freetext-service demo: Dr. Raouf (id 4) is on an admin-
                // typed "CAP Inspection" next week. Freetext services are
                // ALWAYS locked, so both the override and the matching lock
                // are seeded — the pill renders in the custom gold with the
                // locked glow, and she's excluded from that day's rotation.
                serviceOverrides: (function () {
                    var d = nextWorkday(today, 5);
                    var m = {};
                    m[isoLocal(d)] = { '4': 'ft:CAP Inspection' };
                    return m;
                })(),
                serviceLocks: (function () {
                    var d = nextWorkday(today, 5);
                    var m = {};
                    m[isoLocal(d)] = { '4': 'ft:CAP Inspection' };
                    return m;
                })(),
            },
        };
    }

    // ── reset + banner ──────────────────────────────────────────────────
    function resetDemo() {
        lsRemove(DB_KEY);
        lsRemove(AUTH_KEY);
        window.location.reload();
    }

    function injectBanner() {
        try {
            document.title = '[MOCK] ' + document.title;

            var bar = document.createElement('div');
            bar.id = 'mockModeBanner';
            bar.setAttribute('role', 'status');
            bar.style.cssText = [
                'position:fixed', 'left:50%', 'bottom:14px',
                'transform:translateX(-50%)',
                'z-index:100001',
                'display:flex', 'align-items:center', 'gap:10px',
                'background:rgba(17,24,39,0.94)', 'color:#fff',
                'padding:8px 12px 8px 14px', 'border-radius:999px',
                'font:500 12px/1.3 "Geist", system-ui, sans-serif',
                'box-shadow:0 8px 24px rgba(0,0,0,0.28)',
                'max-width:calc(100vw - 24px)',
                'pointer-events:auto',
            ].join(';');

            var dot = document.createElement('span');
            dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#f5b544;flex-shrink:0;box-shadow:0 0 8px 1px rgba(245,181,68,0.7);';
            bar.appendChild(dot);

            var txt = document.createElement('span');
            txt.textContent = 'Mock mode — nothing reaches the real server. Sign in as anyone, password \u201C' + DEMO_PASSWORD + '\u201D.';
            txt.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            bar.appendChild(txt);

            var btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = 'Reset demo data';
            btn.style.cssText = [
                'font:600 11px/1 "Geist", system-ui, sans-serif',
                'color:#111827', 'background:#f5b544',
                'border:0', 'border-radius:999px',
                'padding:6px 11px', 'cursor:pointer', 'flex-shrink:0',
            ].join(';');
            btn.addEventListener('click', function () {
                if (window.confirm('Reset all mock data (schedule changes, requests, locks, sign-in)?')) {
                    resetDemo();
                }
            });
            bar.appendChild(btn);

            document.body.appendChild(bar);
        } catch (e) {
            console.warn('[mock-firebase] banner injection failed:', e);
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectBanner);
    } else {
        injectBanner();
    }

    // ── debug handle ────────────────────────────────────────────────────
    window.MockScheduler = {
        reset: resetDemo,
        dump: function () { return deepClone(data); },
        demoPassword: DEMO_PASSWORD,
    };

    console.info('%c[mock-firebase] Mock mode active — no network writes. '
        + 'Password for every account: "' + DEMO_PASSWORD + '". '
        + 'window.MockScheduler.reset() wipes the demo store.',
        'color:#b45309;font-weight:bold');
})();