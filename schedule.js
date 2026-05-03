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

        // ────────────── STATE ──────────────
        let pathologists = [];
        let vacations = [];                  // [{ key, pathologistId, start: Date, end: Date }]
        let onCallOverrides = {};            // { weekKey: pathologistId }
        let onCallDayOverrides = {};         // { dayKey: pathologistId }
        let serviceOverrides = {};           // { weekKey: { pathId: serviceId } }

        let pathologistsReady = false;
        let vacationsReady = false;
        let currentPathFilter = 'all';
        let view = 'week';                    // 'week' | 'month' | 'year'
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        let cursor = new Date(today);

        // Year view mode: 'pto' shows PTO schedule, 'call' shows on-call schedule
        let yearMode = 'pto';

        // ────────────── AUTH STATE ──────────────
        // Authenticated pathologist id (number) or null when nobody is signed in on
        // this device. We persist this in localStorage so users only see the login
        // screen on first use of a given browser.
        const AUTH_STORAGE_KEY = 'rotaCurrentPathId';
        let loggedInPathId = (() => {
            const raw = localStorage.getItem(AUTH_STORAGE_KEY);
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

        // Next/previous workday — skips weekends. Used by hard-rule logic so that
        // "the day before Monday" resolves to the previous Friday.
        function nextWorkday(date) {
            let d = addDays(date, 1);
            while (isWeekend(d)) d = addDays(d, 1);
            return d;
        }
        function prevWorkday(date) {
            let d = addDays(date, -1);
            while (isWeekend(d)) d = addDays(d, -1);
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
  CALL_ANCHOR.setHours(0,0,0,0);

  // Daily service rotation anchor (Mondays): Jan 1 2024 = workDay 0
  const WORK_ANCHOR = new Date(2024, 0, 1);
  WORK_ANCHOR.setHours(0,0,0,0);

  // Finds the start of the dynamic call block for any given date
  function getCallCycleStart(date) {
    let d = new Date(date);
    d.setHours(0,0,0,0);
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

        // Populate filter dropdown
        const pf = document.getElementById('pathFilter');
        if (pf) {
            const prevVal = pf.value;
            pf.innerHTML = '<option value="all">All Pathologists</option>' +
                pathologists.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
            pf.value = prevVal || 'all';
        }

        function clearDayCache() {
            _dayCache.clear();
            _naturalCache.clear();
            _violationFlags.clear();
        }

        function ptoDaysScheduled(pathId) {
            let count = 0;
            vacations.filter(v => v.pathologistId === pathId).forEach(v => {
                count += daysBetween(v.start, v.end) + 1;
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
                if (loggedInPathId !== null && !pathologists.find(p => p.id === loggedInPathId)) {
                    // Stored id no longer matches anyone — clear it and force re-login
                    localStorage.removeItem(AUTH_STORAGE_KEY);
                    loggedInPathId = null;
                }
                if (loggedInPathId === null) {
                    showLoginOverlay();
                } else {
                    // Default the filter to the signed-in user's own calendar
                    if (currentPathFilter === 'all') {
                        currentPathFilter = String(loggedInPathId);
                        const pf = document.getElementById('pathFilter');
                        if (pf) pf.value = currentPathFilter;
                    }
                    renderAll();
                }
            }
        }

        // ────────────── AUTH / LOGIN ──────────────
        // Populate the header filter dropdown.
        // - When signed in: only "All Pathologists" + the signed-in user appear.
        // - When signed out (login screen up): show all options so the dropdown still
        //   exists in the DOM (it's hidden behind the overlay anyway).
        function populatePathFilter() {
            const pf = document.getElementById('pathFilter');
            if (!pf) return;
            const prevVal = pf.value;
            const me = loggedInPathId !== null
                ? pathologists.find(p => p.id === loggedInPathId)
                : null;

            let html = '<option value="all">All Pathologists</option>';
            if (me) {
                html += `<option value="${me.id}">${me.name} (you)</option>`;
            } else {
                html += pathologists.map(p =>
                    `<option value="${p.id}">${p.name}</option>`
                ).join('');
            }
            pf.innerHTML = html;

            // Pick a sensible default:
            //   - signed in:  default to "you" on first paint, else preserve choice
            //                 (only "all" or the user's own id are valid options)
            //   - signed out: preserve previous selection or fall back to "all"
            if (me) {
                const validOptions = new Set(['all', String(me.id)]);
                if (prevVal && validOptions.has(prevVal)) {
                    pf.value = prevVal;
                } else {
                    pf.value = String(me.id);
                }
                currentPathFilter = pf.value;
            } else {
                pf.value = prevVal || 'all';
                currentPathFilter = pf.value;
            }
        }

        function showLoginOverlay() {
            const overlay = document.getElementById('loginOverlay');
            const sel = document.getElementById('loginPath');
            const pwInput = document.getElementById('loginPassword');
            const errEl = document.getElementById('loginError');

            sel.innerHTML = '<option value="">— Select your name —</option>' +
                pathologists.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
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

            const pid = parseInt(pidRaw, 10);
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
                // Refresh the filter dropdown to its restricted form, then default
                // to "your own calendar" (overrides whatever populatePathFilter chose).
                populatePathFilter();
                currentPathFilter = String(pid);
                const pf = document.getElementById('pathFilter');
                if (pf) pf.value = currentPathFilter;
                renderAll();
            } catch (err) {
                errEl.textContent = 'Login failed: ' + (err.message || 'unknown error');
            } finally {
                btn.disabled = false;
                btn.textContent = 'Sign in';
            }
        }

        function signOut() {
            if (!confirm('Sign out of Rota on this device? You\'ll need your password to sign back in.')) return;
            localStorage.removeItem(AUTH_STORAGE_KEY);
            loggedInPathId = null;
            // Reload to reset all state cleanly
            location.reload();
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

        // ────────────── SIDEBAR ──────────────
        function renderSidebar() {
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
                if (loggedInPathId !== null) {
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

        // Returns a small "!" flag pill if the day has hard-rule violations that
        // couldn't be resolved by swapping. Empty string otherwise.
        function flagHtml(date) {
            if (isWeekend(date)) return '';
            const issues = violationsForDay(date);
            if (!issues) return '';
            const tip = 'Hard-rule conflict — manual review needed:\n• ' + issues.join('\n• ');
            return `<span class="rule-flag" title="${tip.replace(/"/g, '&quot;')}">!</span>`;
        }

        // ────────────── PERIOD LABEL ──────────────
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
        }

        // ────────────── WEEK VIEW ──────────────
        function renderWeek() {
            const main = document.getElementById('main');
            const start = startOfWeek(cursor);
            let html = `<div class="week-view">`;
            for (let i = 0; i < 7; i++) {
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
                html += `<div class="week-day ${td ? 'today' : ''} ${we ? 'weekend' : ''} ${holiday ? 'holiday' : ''}" data-date="${fmt(d)}">
        <div class="wd-head">
          <span class="dow">${DOW[d.getDay()]}</span>
          ${holidayBadge}
          <span class="num">${d.getDate()}${flagHtml(d)}</span>
        </div>
        <div class="wd-rows">${rows}</div>
      </div>`;
            }
            html += `</div>`;
            main.innerHTML = html;
            attachDayClickHandlers();
        }

        // ────────────── MONTH VIEW ──────────────
        function renderMonth() {
            const main = document.getElementById('main');
            const y = cursor.getFullYear();
            const m = cursor.getMonth();
            const first = new Date(y, m, 1);
            const last = new Date(y, m + 1, 0);
            const gridStart = startOfWeek(first);
            const totalCells = Math.ceil((last.getDate() + first.getDay()) / 7) * 7;

            let html = `<div class="month-view">`;
            DOW.forEach(d => { html += `<div class="dow-h">${d}</div>`; });

            for (let i = 0; i < totalCells; i++) {
                const date = addDays(gridStart, i);
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

// Call mode — exactly one pathologist on call for the whole block
    const cs = getCallCycleStart(date);
    const ocId = onCallIdForCycle(cs);
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

            const hint = yearMode === 'pto'
                ? 'Each coloured day shows who is on PTO.'
                : 'Each coloured week shows who is on call.';

            let html = `<div class="year-view">
      <div class="year-legend">
        ${modeTabsHtml}
        <span class="mode-hint">${hint}</span>
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

                    const styleAttr = content ? ` style="background:${content.background}"` : '';
                    const titleAttr = (content || holiday)
                        ? ` title="${holiday ? holiday + (content ? ' · ' : '') : ''}${content ? content.title : ''}"`
                        : '';
                    const inner = content
                        ? `<span class="md-label">${content.label}</span>`
                        : `${date.getDate()}`;

                    cells += `<div class="${classes.join(' ')}" data-date="${fmt(date)}"${styleAttr}${titleAttr}>${inner}</div>`;
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

            // Click any day in the year view → jump to month view
            main.querySelectorAll('.md').forEach(el => {
                if (el.classList.contains('outside')) return;
                el.addEventListener('click', () => {
                    const ds = el.dataset.date;
                    if (!ds) return;
                    cursor = parseDate(ds);
                    view = 'month';
                    document.querySelectorAll('.view-tab').forEach(t => t.classList.toggle('active', t.dataset.view === 'month'));
                    renderMain();
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
            rows.innerHTML = pathologists.map(p => {
                const a = dayAssign[p.id];
                const ocPill = a.onCall ? `<span class="doc-pill">On Call</span>` : '';
                if (a.type === 'pto') {
                    return `<div class="day-detail-row pto-row" style="--c:${p.color}">
          <div class="ddot"></div>
          <div class="dname">${p.name}</div>
          <div class="dservice">PTO</div>
          ${ocPill}
        </div>`;
                }
                if (a.type === 'off') {
                    return `<div class="day-detail-row off-row" style="--c:${p.color}">
          <div class="ddot"></div>
          <div class="dname">${p.name}</div>
          <div class="dservice">${(isWk || holiday) ? 'Off' : 'Unstaffed'}</div>
          ${ocPill}
        </div>`;
                }
                const cbg = pathBgColor(p.color);
                return `<div class="day-detail-row" style="--c:${p.color}; --sc:var(${a.service.cssVar})${cbg ? `; --c-bg:${cbg}` : ''}">
        <div class="ddot"></div>
        <div class="dname">${p.name}</div>
        <div class="dservice"><span class="swatch"></span>${a.service.name}</div>
        ${ocPill}
      </div>`;
            }).join('');

            // Hide "change service rotation" button on weekends and federal holidays
            const svcBtn = document.getElementById('dayChangeService');
            if (svcBtn) svcBtn.style.display = (isWk || holiday) ? 'none' : '';

            document.getElementById('dayModalBack').classList.add('open');
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
            sel.innerHTML = pathologists.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
            const d = prefillDate || today;
            document.getElementById('ptoStart').value = fmt(d);
            document.getElementById('ptoEnd').value = fmt(d);
            renderPtoList();
            document.getElementById('ptoModalBack').classList.add('open');
        }

        function renderPtoList() {
            const list = document.getElementById('ptoList');
            const upcoming = vacations
                .filter(v => v.end >= today)
                .sort((a, b) => a.start - b.start)
                .slice(0, 30);
            if (upcoming.length === 0) {
                list.innerHTML = `<div class="empty">No upcoming PTO scheduled.</div>`;
                return;
            }
            list.innerHTML = upcoming.map(v => {
                const p = pathologists.find(x => x.id === v.pathologistId);
                if (!p) return '';
                const same = sameDay(v.start, v.end);
                const range = same
                    ? `${MONTHS_SHORT[v.start.getMonth()]} ${v.start.getDate()}, ${v.start.getFullYear()}`
                    : `${MONTHS_SHORT[v.start.getMonth()]} ${v.start.getDate()} – ${MONTHS_SHORT[v.end.getMonth()]} ${v.end.getDate()}, ${v.end.getFullYear()}`;
                return `<div class="pto-list-item" style="--c:${p.color}">
        <div class="pdot"></div>
        <div class="prange">
          <div class="pname">${p.name.replace(/^Dr\. /, '')}</div>
          <div class="pdates">${range}</div>
        </div>
        <button data-key="${v.key}">Remove</button>
      </div>`;
            }).join('');
            list.querySelectorAll('button[data-key]').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const key = btn.dataset.key;
                    if (!confirm('Remove this PTO entry?')) return;
                    await db.ref('scheduler/vacations/' + key).remove();
                });
            });
        }

        document.getElementById('addPtoBtn').addEventListener('click', () => openPtoModal(null));
        document.getElementById('signOutBtn').addEventListener('click', signOut);
        document.getElementById('ptoCancel').addEventListener('click', () => {
            document.getElementById('ptoModalBack').classList.remove('open');
        });
        document.getElementById('ptoModalBack').addEventListener('click', e => {
            if (e.target.id === 'ptoModalBack') e.target.classList.remove('open');
        });
        document.getElementById('ptoSave').addEventListener('click', async () => {
            const pid = parseInt(document.getElementById('ptoPath').value, 10);
            const sStr = document.getElementById('ptoStart').value;
            const eStr = document.getElementById('ptoEnd').value;
            if (!sStr || !eStr) { alert('Please choose start and end dates.'); return; }
            const s = new Date(sStr + 'T00:00:00');
            const e = new Date(eStr + 'T00:00:00');
            if (isNaN(s) || isNaN(e) || e < s) { alert('Please enter a valid date range.'); return; }
            await db.ref('scheduler/vacations').push({
                pathologistId: pid,
                start: fmt(s),
                end: fmt(e),
            });
            renderPtoList();
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
    activeOcDayKey  = fmt(date);
    activeOcDate    = date;

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
        document.getElementById('ocSave').addEventListener('click', async () => {
            const pid = parseInt(document.getElementById('ocPath').value, 10);
            const scope = document.querySelector('input[name="ocScope"]:checked').value;
            if (scope === 'day') {
                await db.ref('scheduler/onCallDayOverrides/' + activeOcDayKey).set(pid);
            } else {
                await db.ref('scheduler/onCallOverrides/' + activeOcWeekKey).set(pid);
            }
            document.getElementById('ocModalBack').classList.remove('open');
        });
        document.getElementById('ocReset').addEventListener('click', async () => {
            const scope = document.querySelector('input[name="ocScope"]:checked').value;
            if (scope === 'day') {
                await db.ref('scheduler/onCallDayOverrides/' + activeOcDayKey).remove();
            } else {
                await db.ref('scheduler/onCallOverrides/' + activeOcWeekKey).remove();
            }
            document.getElementById('ocModalBack').classList.remove('open');
        });

        // ────────────── SERVICE OVERRIDE MODAL (per day) ──────────────
        let activeSvcDayKey = null;
        function openServiceModal(date) {
            if (isWeekend(date)) return;   // no service rotation on weekends
            if (getFederalHoliday(date)) return;  // no service rotation on federal holidays
            activeSvcDayKey = fmt(date);
            document.getElementById('svcModalSub').textContent =
                `${DOW[date.getDay()]}, ${MONTHS_SHORT[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}. PTO pathologists are skipped — manage PTO separately.`;
            const dayAssign = getDayAssignments(date);
            const container = document.getElementById('svcAssignments');
            container.innerHTML = pathologists.map(p => {
                const a = dayAssign[p.id];
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
        document.getElementById('svcCancel').addEventListener('click', () => {
            document.getElementById('svcModalBack').classList.remove('open');
        });
        document.getElementById('svcModalBack').addEventListener('click', e => {
            if (e.target.id === 'svcModalBack') e.target.classList.remove('open');
        });
        document.getElementById('svcSave').addEventListener('click', async () => {
            const selects = document.querySelectorAll('#svcAssignments select[data-pid]');
            const update = {};
            selects.forEach(s => {
                if (s.value) update[s.dataset.pid] = s.value;
            });
            if (Object.keys(update).length === 0) {
                await db.ref('scheduler/serviceOverrides/' + activeSvcDayKey).remove();
            } else {
                await db.ref('scheduler/serviceOverrides/' + activeSvcDayKey).set(update);
            }
            document.getElementById('svcModalBack').classList.remove('open');
        });
        document.getElementById('svcReset').addEventListener('click', async () => {
            await db.ref('scheduler/serviceOverrides/' + activeSvcDayKey).remove();
            document.getElementById('svcModalBack').classList.remove('open');
        });

        // ────────────── DISPATCH ──────────────
        function renderAgenda() {
            const main = document.getElementById('main');
            if (currentPathFilter === 'all') {
                main.innerHTML = `
        <div style="text-align: center; margin-top: 60px; color: var(--ink-3); font-style: italic; font-size: 15px;">
          Please select a specific pathologist from the dropdown above to view their compact schedule.
        </div>`;
                return;
            }

            const pid = parseInt(currentPathFilter);
            const p = pathologists.find(x => x.id === pid);
            if (!p) return;

            let html = `<div style="max-width: 600px; margin: 0 auto;">
      <h3 style="font-family: var(--serif); font-size: 26px; margin-bottom: 16px; color: var(--ink);">Compact Schedule: ${p.name.replace(/^Dr\. /, '')}</h3>
      <div style="background: var(--paper); border: 1px solid var(--rule-soft); border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.02);">`;

            let found = 0;
            // Look ahead 60 days to find upcoming shifts/PTO
            for (let i = 0; i < 60; i++) {
                const d = addDays(today, i);
                const a = getDayAssignments(d)[pid];

                // Skip weekends/unstaffed days for a compact look
                if (!a || a.type === 'off') continue;

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

        document.getElementById('pathFilter').addEventListener('change', e => {
            currentPathFilter = e.target.value;
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
        case 'cyto':     return 'M cyto/gross';
        case 'bigs':     return 'M bigs';
        case 'huntley':  return 'H';
        case 'wfh':      return 'breast bx/work from home';
        case 'cytobigs': return 'M cyto/gross/bigs';
        default:         return serviceId || '';
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
        if (b.end.getDay()   === 5) b.end   = addDays(b.end,  2);   // Fri → Sun
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
            end:   b.end   > endDate   ? new Date(endDate)   : b.end,
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
        const uid = `rota-${pathId}-${fmt(start)}-${uidSuffix}@pathology-rota`;
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
    const calName = `Rota \u2014 ${path ? path.name : 'Pathologist'}`;
    const events = buildIcsEvents(pathId, startDate, endDate, opts);

    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Pathology Group Rota//Schedule Export//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        _icsFold(`X-WR-CALNAME:${_icsEscape(calName)}`),
        _icsFold(`X-WR-CALDESC:${_icsEscape('Pathology group schedule exported from Rota')}`),
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
        'PRODID:-//Pathology Group Rota//Schedule Export//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        _icsFold(`X-WR-CALNAME:${_icsEscape('Rota \u2014 All Pathologists')}`),
        _icsFold(`X-WR-CALDESC:${_icsEscape('Full pathology group schedule exported from Rota')}`),
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
    const end   = parseDate(endStr);
    if (end.getTime() < start.getTime()) {
        alert('End date must be on or after the start date.');
        return;
    }

    const opts = {
        includeService: document.getElementById('exportIncludeService').checked,
        includePto:     document.getElementById('exportIncludePto').checked,
        includeOnCall:  document.getElementById('exportIncludeOnCall').checked,
    };
    if (!opts.includeService && !opts.includePto && !opts.includeOnCall) {
        alert('Please select at least one event type to include.');
        return;
    }

    if (isAll) {
        const ics      = buildIcsFileAll(start, end, opts);
        const filename = `rota_all_pathologists_${startStr}_to_${endStr}.ics`;
        downloadIcs(filename, ics);
    } else {
        const path     = pathologists.find(p => p.id === pathId);
        const ics      = buildIcsFile(pathId, start, end, opts);
        const safeName = (path ? path.name : 'pathologist')
            .replace(/^Dr\.\s*/i, '')
            .replace(/[^a-z0-9]+/gi, '_')
            .replace(/^_+|_+$/g, '');
        const filename = `rota_${safeName}_${startStr}_to_${endStr}.ics`;
        downloadIcs(filename, ics);
    }

    document.getElementById('exportModalBack').classList.remove('open');
});
