// ════════════════════════════════════════════════════════════════════════
// RECOMPUTE
// ════════════════════════════════════════════════════════════════════════
//
// Extracted from schedule.js as a straight cut — no logic changes, no
// re-wrapping. All identifiers remain on the global scope.
//
// Load order: this file must load AFTER schedule.js (so the state globals
// and helper functions it references are declared) and AFTER the DOM has
// parsed the recompute modal markup (the bottom of this file registers
// click handlers on #recomputeBtn, #rcCancelBtn, #rcConfirmBtn, etc., at
// parse time). The simplest setup is to include both <script> tags at the
// end of <body>, in this order:
//     <script src="schedule.js"></script>
//     <script src="recompute.js"></script>
//
// Public surface used from schedule.js:
//   recomputeFutureSchedule(pinnedByDay, opts)
//   maybeOfferRecompute(pinnedByDay, opts)
//   triggerManualRecompute()
//   backFixDayBefore(pinnedByDay, fromDate)
//
// Globals this file reads from schedule.js:
//   state:    pathologists, vacations, requests, requestsReady,
//             serviceOverrides, serviceLocks, loggedInPathId, today, db
//   const:    SERVICE_BY_ID, EARLIEST_DATE
//   helpers:  isOffSiteServiceId, isBeforeEarliest, fmt, parseDate, addDays,
//             isWeekend, getFederalHoliday, prevWorkday, nextWorkday,
//             workdaysInCallCycle, getDayAssignments, isOnPto, isAdmin,
//             showToast, escapeHtml, logChange, _chgShortName,
//             _chgServiceName, _chgFmtDate
// ════════════════════════════════════════════════════════════════════════

// ────────────── ROTATION OPTIMIZER (recompute future schedule) ──────────────
//
// After a service or PTO change, re-plan every workday in a window and write
// the days whose plan differs from what is currently shown. The window runs
// from a short lead-in before opts.fromDate (RC_LEAD_IN_WORKDAYS, never
// before today) to opts.horizonDays calendar days after fromDate.
//
// The whole window is planned at once rather than day by day, so a lock on
// day X can move things on day X−1, and a fairness debt created on one day
// can be repaid a few days later.
//
// Rules, most important first:
//   Hard — broken only when locks leave no alternative (the red-flag layer
//   surfaces those days):
//     1. Someone at McHenry every working day.
//     2. Someone at Huntley every working day.
//     3. Locked slots (serviceLocks + the caller's pins) never move.
//   Structural — enforced by which day arrangements are considered at all:
//     4. Two at McHenry (Cyto/Gross + Bigs) whenever 3+ are working; one
//        pathologist covers Cyto/Gross/Bigs only when that's unavoidable.
//   Weighted — RC_WEIGHTS; the optimizer minimizes their sum:
//     5. No Bigs the workday before PTO: heavy before multi-day PTO, lighter
//        before a single PTO day ("not ideal, but if need be").
//     6. No Bigs the workday before Breast Bx/WFH.
//     7. Fair shares of every service — now a light touch. Everything a
//        pathologist works counts toward their tally, LOCKED DAYS INCLUDED.
//        Whoever takes PTO absorbs its cost; spreading it over everyone is
//        exactly what the admin doesn't want, so these weights are small.
//        Service desirability, best first: WFH, Huntley, Bigs, Cyto/Gross.
//     8. Friday Bigs (= breast conference) evened out over the academic
//        year. Lightly weighted — only a real imbalance moves anything.
//     9. Stay on the cyto → bigs → huntley (→ wfh) rotation, advancing one
//        step per weekday, from wherever each pathologist currently is — NOT
//        back to their old phase. A step away from the expected next service
//        costs distance², plus extra for a jump of 2+ steps, so a one-day
//        repeat (Bigs–Bigs) is the cheap way to absorb a change. WFH two
//        days running and three McHenry days running cost extra.
//   Plus a small stability term for the RC_STABLE_WORKDAYS after the change:
//   an unchanged slot beats an equally good change there. Further out the
//   plan just continues the rotation (ties still go to the current
//   schedule, so recomputes don't reshuffle for nothing).
//
// Fairness (rule 7) is a running imbalance per pathologist and service:
//   D(t) = λ·D(t−1) + (worked on it today − fair share today)
// with a penalty of Σ_t D(t)². The longer an imbalance stands the more it
// costs, so debts get repaid within days; the decay λ (RC_FAIR_DECAY) lets
// a small leftover fade instead of justifying a reshuffle months later.
// The tally starts RC_LOOKBACK_WORKDAYS before the window, so recent
// history counts too.
//
// Search (all deterministic):
//   1. Viterbi — an exact dynamic program over the chain of days — on the
//      pairwise rules (5, 6, 9 + stability).
//   2. Alternate (a) Viterbi on a linearization of the fairness/Friday terms
//      around the current plan, accepted only if the true objective
//      improves, and (b) local search over one- and two-day re-arrangements,
//      scored exactly.
//   3. The same polish starting from the current schedule; the better of
//      the two results wins, so a recompute never makes the schedule worse
//      by its own measure.
//   4. Repeat 1–3 against the result until it stops changing, so pressing
//      Recompute again right away finds nothing to change.
//
// pinnedByDay[dayKey] = {pid: serviceId} locks specific paths to specific
// services. Pins come from two sources, merged on entry:
//   • Caller-supplied (the admin's just-made change) — these win on conflict.
//   • Approved-and-locked assignments from scheduler/serviceLocks.
//
// opts:
//   fromDate     — required Date; the day of the change
//   horizonDays  — calendar days to walk forward (default 180)
//   dayBeforeFix — also re-plan the lead-in days before fromDate (default true)
//   changedPathIds — who asked for the change (for requesterGain/othersLoss)
//   stableWorkdays, keepSeam — override RC_STABLE_WORKDAYS / keep the pull
//                  toward the day after the window (tools/tuning replays
//                  the pre-tuning behavior with these)
//
// Returns { processed, dayBeforeProcessed, firstChangedKey, lastChangedKey }.

const ROTATION_CYCLE = ['cyto', 'bigs', 'huntley', 'wfh'];

// cytobigs covers both cyto + bigs; for cycle purposes treat it as bigs
// (the next step from cytobigs is huntley = bigs's natural successor).
function _cycleId(svcId) { return svcId === 'cytobigs' ? 'bigs' : svcId; }

function _nextInCycle(svcId) {
    const i = ROTATION_CYCLE.indexOf(_cycleId(svcId));
    return i < 0 ? null : ROTATION_CYCLE[(i + 1) % 4];
}

// Today's effective cycle, used for deviation measurement.
//   n>=4 → cyto, bigs, huntley, wfh
//   n==3 → cyto, bigs, huntley     (no wfh slot)
//   n==2 → cytobigs, huntley       (cyto+bigs collapse to one slot)
function _dayCycleFor(n) {
    if (n >= 4) return ['cyto', 'bigs', 'huntley', 'wfh'];
    if (n === 3) return ['cyto', 'bigs', 'huntley'];
    if (n === 2) return ['cytobigs', 'huntley'];
    return null;
}

// Index of a service inside today's cycle. On 2-path days both 'cyto' and
// 'bigs' map to the cytobigs slot, since they're served jointly.
function _dayCycleIndex(svcId, dayCycle) {
    if (!svcId) return -1;
    if (dayCycle.length === 2) {
        if (svcId === 'cyto' || svcId === 'bigs' || svcId === 'cytobigs') {
            return dayCycle.indexOf('cytobigs');
        }
        return dayCycle.indexOf(svcId);
    }
    // 3- and 4-cycles: cytobigs only appears as bigs (3-cycle has bigs).
    if (svcId === 'cytobigs') return dayCycle.indexOf('bigs');
    return dayCycle.indexOf(svcId);
}

// Map an "expected" service (from yesterday's +1 in the universal 4-cycle)
// onto today's effective cycle. If the expected service isn't present today
// (e.g. expected=wfh but n=3, or expected=bigs but n=2), walk forward in the
// universal 4-cycle until we find one that does exist — that's the closest
// in-cycle expectation under the rotation.
function _expectedIdxInDayCycle(expectedId, dayCycle) {
    if (!expectedId) return -1;
    let idx = _dayCycleIndex(expectedId, dayCycle);
    if (idx >= 0) return idx;
    let cur = _cycleId(expectedId);
    for (let step = 0; step < 4; step++) {
        cur = _nextInCycle(cur);
        if (!cur) break;
        idx = _dayCycleIndex(cur, dayCycle);
        if (idx >= 0) return idx;
    }
    return -1;
}

// Minimum cyclical distance between actual position `a` and expected `e`
// in a cycle of length `len`. Returns 0 when same, 1 for adjacent in either
// direction, etc.
function _minCycleDist(a, e, len) {
    if (a < 0 || e < 0 || len <= 0) return 0;
    const d = Math.abs(a - e) % len;
    return Math.min(d, len - d);
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

// Required service multiset for N working pathologists. For N > 4 we pad
// with extra wfh slots so every working pathologist gets assigned (multiple
// paths can each work from home; duplicating a McHenry station service
// would put two paths at the same lab). Used by the back-fix below; the
// optimizer derives the same sets from _rcDayStates.
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

// Deep-equal helper for {pid: serviceId} maps. Used to detect whether the
// optimizer's plan for a day differs from the pre-recompute baseline,
// which is what gates the Firebase write.
function _sameServiceMap(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
        if (a[k] !== b[k]) return false;
    }
    return true;
}

// ── Tuning ──────────────────────────────────────────────────────────────
// Costs are in "rotation steps": one pathologist one step off their
// expected next service costs 1 (two steps cost 4). Rule 5/6 weights sit far
// above anything fairness or rotation can add up to, so they only give way
// when there's genuinely no other arrangement. The fairness weights apply
// to D² per day (see the header); an unrepaid one-day WFH surplus costs
// ~20 for its holder alone — enough to be repaid within the week at the
// price of a few rotation steps. Friday Bigs is deliberately light (F² per
// pathologist-year, F = Fridays over fair share): moving one Friday pays
// off only once someone is about two Fridays out of line.
// These were tuned against simulated schedules (random PTO + locks): raising
// mchStreak or the fairness weights trades away rotation predictability
// quickly.
//
// Tuned (Sep 2026) against the admin's own hand-built schedules — see
// tools/tuning/. What the admin's schedules showed:
//   • A change is absorbed by trading rotation phases between people (one
//     repeats a service, e.g. Bigs–Bigs; another steps ahead) and everyone
//     then keeps cycling from there. Being pulled back to the old phase is
//     NOT wanted — hence stability only near the change
//     (RC_STABLE_WORKDAYS) and no seam at the end of the window.
//   • Whoever takes PTO absorbs its cost; others shouldn't lose WFH for it.
//     The pro-rated fairness terms spread that cost over everyone, so they
//     are now light (~0.05–0.1, from 0.6–2).
//   • No WFH two days running; prefer a one-day repeat over a rotation
//     jump of 2+ steps.
// On 27 hand-built scenarios these weights get 113 of 1019 cells different
// from the admin's choice (15 scenarios exact) vs 183 (8 exact) before.
const RC_WEIGHTS = {
    bigsBeforeMultiPto: 1000,
    bigsBeforeWfh: 300,
    bigsBeforeSinglePto: 60,
    fair: { cyto: 0.0911, bigs: 0.0397, huntley: 0.110, wfh: 0.0761 },
    fridayBigs: 0.605,
    rotation: 1.0,
    mchStreak: 0.344,
    stability: 0.0124,
    // Distance² (in today's cycle) from where the untouched default rotation
    // (defaultServiceId) would put each pathologist — pulls the plan back
    // into phase with the base calendar after a change. 0 = off.
    templateDrift: 0,
    // (Σ over the window of desirability worked − desirability the default
    // rotation gives on the same days)², per pathologist. Whoever takes PTO
    // simply misses their rotation days; everyone else keeps what their
    // rotation would have given them. 0 = off.
    tmplDesir: 0,
    // Same pathologist on Breast Bx/WFH two workdays running.
    wfhRepeat: 7,
    // Cyto/Gross the workday before PTO (Huntley or WFH preferred). 0 = off.
    cytoBeforePto: 0,
    // Same service two workdays running (any service).
    sameServiceRepeat: 0.3,
    // A step of 2+ away from the expected next service, on top of
    // rotation's distance².
    rotationJump: 3,
    // Friday Bigs (breast conference) held by someone who wasn't at
    // McHenry the workday before / who is just back from PTO. 0 = off.
    friBigsNoMchBefore: 0,
    friBigsAfterPto: 0,
    // One-sided versions of tmplDesir, keyed on who asked for the change
    // (opts.changedPathIds): the requester / PTO taker ending up ahead of
    // their rotation, and anyone else ending up behind theirs. 0 = off.
    requesterGain: 0,
    othersLoss: 0,
};

// Desirability used by tmplDesir, best first: WFH, Huntley, Bigs, Cyto/Gross.
const RC_DESIRABILITY = { wfh: 3, huntley: 2, bigs: 1, cyto: 0, cytobigs: 0 };

// Workdays before fromDate that are re-planned too (never before today), so
// a change on day X can be paid for on the days just before it.
const RC_LEAD_IN_WORKDAYS = 5;

// Workdays from fromDate over which the stability term applies. Past them
// the plan simply keeps everyone cycling from wherever the change left
// them, instead of being pulled back onto the old schedule.
const RC_STABLE_WORKDAYS = 10;

// Per-workday decay of the fairness tallies (rule 7): an imbalance fades
// with a half-life of ~13 workdays (λ^13 ≈ ½). Debts still get repaid
// soon — standing imbalance keeps costing — but a small leftover from months
// ago can't justify reshuffling today.
const RC_FAIR_DECAY = 0.95;

// Workdays of history (not re-planned) that seed the fairness tallies.
const RC_LOOKBACK_WORKDAYS = 20;

const RC_FAIR_CATS = ['cyto', 'bigs', 'huntley', 'wfh'];
const RC_STATE_OPTIONS = ['cyto', 'bigs', 'huntley', 'wfh', 'cytobigs'];

function _rcIsBigs(sid) { return sid === 'bigs' || sid === 'cytobigs'; }

// Fairness categories a service counts toward (indices into RC_FAIR_CATS).
// The one-pathologist McHenry combo counts as both Cyto/Gross and Bigs.
function _rcCatsOf(sid) {
    if (sid === 'cytobigs') return [0, 1];
    const i = RC_FAIR_CATS.indexOf(sid);
    return i < 0 ? [] : [i];
}

// Every arrangement worth considering for one day: pinned slots keep their
// service; free slots take cyto/bigs/huntley/wfh/cytobigs with no two free
// paths on the same station. Only the arrangements that best satisfy rules
// 1, 2 and 4 survive, so e.g. a 4-working day yields the 24 permutations of
// cyto/bigs/huntley/wfh, and a 3-working day with one path pinned to WFH
// yields Huntley + Cyto/Gross/Bigs for the other two.
// Returns an array of service-id arrays aligned with `pids`.
function _rcDayStates(pids, pins) {
    const n = pids.length;
    if (n === 0) return [[]];
    const cur = new Array(n).fill(null);
    const free = [];
    pids.forEach((pid, j) => {
        const pin = pins ? (pins[pid] !== undefined ? pins[pid] : pins[String(pid)]) : undefined;
        if (pin && SERVICE_BY_ID[pin] && !isOffSiteServiceId(pin)) cur[j] = pin;
        else free.push(j);
    });
    const cnt = { cyto: 0, bigs: 0, huntley: 0, wfh: 0, cytobigs: 0 };
    cur.forEach(s => { if (s && cnt[s] !== undefined) cnt[s]++; });
    const allowed = s => {
        switch (s) {
            case 'huntley': return cnt.huntley === 0;
            case 'cyto': return cnt.cyto === 0 && cnt.cytobigs === 0;
            case 'bigs': return cnt.bigs === 0 && cnt.cytobigs === 0;
            case 'cytobigs': return cnt.cyto === 0 && cnt.bigs === 0 && cnt.cytobigs === 0;
            default: return true;
        }
    };
    const all = [];
    (function rec(i) {
        if (i === free.length) { all.push(cur.slice()); return; }
        for (const s of RC_STATE_OPTIONS) {
            if (!allowed(s)) continue;
            cur[free[i]] = s;
            cnt[s]++;
            rec(i + 1);
            cnt[s]--;
        }
        cur[free[i]] = null;
    })(0);

    // Rank by rules 1, 2, 4 (lexicographic, packed into one number) and
    // keep only the best tier.
    const tierOf = st => {
        let mch = 0, hun = 0, cyto = false, bigs = false, combo = false;
        st.forEach(s => {
            if (s === 'cyto') { mch++; cyto = true; }
            else if (s === 'bigs') { mch++; bigs = true; }
            else if (s === 'cytobigs') { mch++; combo = true; }
            else if (s === 'huntley') hun++;
        });
        const odd = mch >= 2 ? (combo || !(cyto && bigs)) : (mch === 1 && !combo);
        return (mch === 0 ? 8 : 0) + (hun === 0 ? 4 : 0) + (mch < 2 ? 2 : 0) + (odd ? 1 : 0);
    };
    let bestTier = Infinity;
    const tiers = all.map(st => {
        const t = tierOf(st);
        if (t < bestTier) bestTier = t;
        return t;
    });
    return all.filter((st, i) => tiers[i] === bestTier);
}

// Build the optimization problem from app state. Days run: lookback history
// (fixed) → window (re-planned) → one boundary day after the window (fixed,
// so the plan hands back to the existing schedule smoothly).
function _rcBuildProblem(windowDays, mergedPins) {
    const pis = new Map();
    pathologists.forEach((p, i) => pis.set(String(p.id), i));
    const nP = pathologists.length;

    const workingMap = d => {
        const a = getDayAssignments(d);
        const m = {};
        pathologists.forEach(p => {
            const x = a[p.id];
            if (x && x.type === 'service' && x.service) m[p.id] = x.service.id;
        });
        return m;
    };
    const isWorkday = d => !isWeekend(d) && !getFederalHoliday(d) && !isBeforeEarliest(d);

    const lookback = [];
    {
        let d = prevWorkday(windowDays[0]);
        for (let i = 0; i < RC_LOOKBACK_WORKDAYS && !isBeforeEarliest(d); i++) {
            lookback.unshift(d);
            d = prevWorkday(d);
        }
    }
    const boundary = nextWorkday(windowDays[windowDays.length - 1]);

    const days = [];
    const pushDay = (date, variable, counted) => {
        const key = fmt(date);
        const cur = workingMap(date);
        const pids = pathologists.map(p => p.id).filter(id => cur[id] !== undefined);
        const states = variable
            ? _rcDayStates(pids, mergedPins[key] || null)
            : [pids.map(id => cur[id])];
        days.push({
            date: date, key: key, variable: variable, counted: counted,
            pids: pids, pi: pids.map(id => pis.get(String(id))),
            states: states, baseline: cur,
        });
    };
    lookback.forEach(d => pushDay(d, false, false));
    windowDays.forEach(d => pushDay(d, true, true));
    pushDay(boundary, false, false);

    // Per-day derived data: cycle, fair shares, PTO look-ahead, Friday year.
    const W = RC_WEIGHTS;
    days.forEach(day => {
        const n = day.pids.length;
        day.cycle = _dayCycleFor(n);
        day.share = new Float64Array(nP * 4);
        if (n > 0) {
            const slots = [0, 0, 0, 0];
            day.states[0].forEach(s => _rcCatsOf(s).forEach(c => { slots[c]++; }));
            day.pi.forEach(pi => {
                for (let c = 0; c < 4; c++) day.share[pi * 4 + c] = slots[c] / n;
            });
        }
        day.isFri = day.date.getDay() === 5;
        day.year = getAcademicYearOfDate(day.date);

        // Rule 5 look-ahead: 0 = working tomorrow, 1 = single PTO day,
        // 2 = PTO for 2+ workdays (Fri + Mon counts).
        const tmrw = nextWorkday(day.date);
        const tA = getDayAssignments(tmrw);
        const aA = getDayAssignments(nextWorkday(tmrw));
        const ptoRun = day.pids.map(pid => {
            if (!(tA[pid] && tA[pid].type === 'pto')) return 0;
            return (aA[pid] && aA[pid].type === 'pto') ? 2 : 1;
        });

        day.ptoRun = ptoRun;
        const yA = day.isFri ? getDayAssignments(prevWorkday(day.date)) : null;
        const backFromPto = day.pids.map(pid => !!yA && !(yA[pid] && yA[pid].type === 'service'));
        // Each pathologist's position in today's cycle under the default
        // rotation (−1 when today has no cycle).
        day.tmplIdx = day.pids.map(pid =>
            day.cycle ? _expectedIdxInDayCycle(defaultServiceId(pid, day.date), day.cycle) : -1);

        day.unaryFixed = day.states.map(st => {
            let c = 0;
            st.forEach((s, j) => {
                if (_rcIsBigs(s) && ptoRun[j] > 0) {
                    c += ptoRun[j] === 2 ? W.bigsBeforeMultiPto : W.bigsBeforeSinglePto;
                }
                if (s === 'cyto' && ptoRun[j] > 0 && day.variable) c += W.cytoBeforePto || 0;
                if (_rcIsBigs(s) && backFromPto[j] && day.variable) c += W.friBigsAfterPto || 0;
                if (W.templateDrift && day.variable && day.cycle) {
                    const dist = _minCycleDist(_dayCycleIndex(s, day.cycle), day.tmplIdx[j], day.cycle.length);
                    c += W.templateDrift * dist * dist;
                }
            });
            return c;
        });
        _rcSetReference(day, day.baseline);
        // Fairness contribution vector and Friday-Bigs holder per state.
        day.vec = day.states.map(st => {
            const v = new Int8Array(nP * 4);
            st.forEach((s, j) => _rcCatsOf(s).forEach(c => { v[day.pi[j] * 4 + c]++; }));
            return v;
        });
        // Bitmask (by pathologist index) of who is at McHenry, for the
        // three-days-running check.
        day.mch = day.states.map(st => {
            let m = 0;
            st.forEach((s, j) => { if (s === 'cyto' || _rcIsBigs(s)) m |= 1 << day.pi[j]; });
            return m;
        });
        day.friHolder = day.states.map(st => {
            if (!day.isFri) return -1;
            const j = st.findIndex(_rcIsBigs);
            return j < 0 ? -1 : day.pi[j];
        });
        _rcSetDesirRef(day, null);
    });

    // Pairwise costs between consecutive days (rules 6 and 9). The rotation
    // advances one step per WEEKDAY, holidays included — the same convention
    // as the default rotation (defaultServiceId), so the plan stays in phase
    // with the schedule outside the window instead of fighting it at every
    // holiday.
    for (let t = 1; t < days.length; t++) {
        const a = days[t - 1], b = days[t];
        const prevJ = b.pids.map(pid => a.pids.indexOf(pid));
        let steps = 0;
        for (let d = addDays(a.date, 1); d.getTime() <= b.date.getTime(); d = addDays(d, 1)) {
            if (!isWeekend(d)) steps++;
        }
        b.steps = steps;
        b.prevJ = prevJ;
        const memo = new Map();
        const stepCost = (prev, now) => {
            const key = prev + '|' + now;
            if (memo.has(key)) return memo.get(key);
            let c = 0;
            if (_rcIsBigs(prev) && now === 'wfh') c += W.bigsBeforeWfh;
            if (prev === 'wfh' && now === 'wfh') c += W.wfhRepeat || 0;
            if (prev === now) c += W.sameServiceRepeat || 0;
            if (b.isFri && _rcIsBigs(now) && !(prev === 'cyto' || _rcIsBigs(prev))) c += W.friBigsNoMchBefore || 0;
            if (b.cycle) {
                let exp = prev;
                for (let i = 0; i < steps && exp; i++) exp = _nextInCycle(exp);
                const e = _expectedIdxInDayCycle(exp, b.cycle);
                const dist = _minCycleDist(_dayCycleIndex(now, b.cycle), e, b.cycle.length);
                c += W.rotation * dist * dist;
                if (dist >= 2) c += W.rotationJump || 0;
            }
            memo.set(key, c);
            return c;
        };
        const m = new Float64Array(a.states.length * b.states.length);
        for (let x = 0; x < a.states.length; x++) {
            const sa = a.states[x];
            for (let y = 0; y < b.states.length; y++) {
                const sb = b.states[y];
                let c = 0;
                for (let j = 0; j < sb.length; j++) {
                    if (prevJ[j] < 0) continue;   // wasn't working yesterday
                    c += stepCost(sa[prevJ[j]], sb[j]);
                }
                m[x * b.states.length + y] = c;
            }
        }
        b.pair = m;
    }

    // Friday Bigs tallies per academic year, flat-indexed yearIdx·nP + pi:
    //   S  — fair share (1/n for each pathologist working that Friday)
    //   F0 — Bigs Fridays already fixed: from the academic year's start up
    //        to the first day of the problem.
    // day.fy = yearIdx·nP on Fridays, −1 otherwise.
    const firstDate = days[0].date;
    const firstYear = getAcademicYearOfDate(firstDate);
    const years = [firstYear];
    days.forEach(day => { if (day.isFri && years.indexOf(day.year) < 0) years.push(day.year); });
    const fri = { S: new Float64Array(years.length * nP), F0: new Float64Array(years.length * nP) };
    {
        let d = new Date(firstYear, 8, 1);
        if (isBeforeEarliest(d)) d = new Date(EARLIEST_DATE);
        for (; d.getTime() < firstDate.getTime(); d = addDays(d, 1)) {
            if (d.getDay() !== 5 || !isWorkday(d)) continue;
            const m = workingMap(d);
            const ids = Object.keys(m);
            ids.forEach(id => {
                const pi = pis.get(String(id));
                fri.S[pi] += 1 / ids.length;
                if (_rcIsBigs(m[id])) fri.F0[pi]++;
            });
        }
    }
    days.forEach(day => {
        day.fy = day.isFri && day.pids.length > 0 ? years.indexOf(day.year) * nP : -1;
        if (day.fy < 0) return;
        day.pi.forEach(pi => { fri.S[day.fy + pi] += 1 / day.pids.length; });
    });

    return { days: days, nP: nP, fri: fri };
}

// Desirability terms (tmplDesir, requesterGain, othersLoss) per state and
// pathologist index, on window days: desirability worked minus desirability
// in `ref` ({pid: serviceId}; null = the default rotation). The entry point
// uses what was published before the change, so "ahead" / "behind" mean
// relative to what each person already had.
function _rcSetDesirRef(day, ref) {
    day.desir = day.states.map(st => {
        const v = new Int8Array(pathologists.length);
        if (!day.counted) return v;
        st.forEach((s, j) => {
            const r = ref ? ref[day.pids[j]] : defaultServiceId(day.pids[j], day.date);
            v[day.pi[j]] = (RC_DESIRABILITY[s] || 0) - (RC_DESIRABILITY[r] || 0);
        });
        return v;
    });
}

// Point a day's stability term at `ref` ({pid: serviceId}): arrangements
// that differ from it pay RC_WEIGHTS.stability per changed slot (scaled by
// day.stabScale when set), and day.baseIdx is its state index (−1 when it
// isn't a candidate).
function _rcSetReference(day, ref) {
    day.baseIdx = day.states.findIndex(st => st.every((s, j) => s === ref[day.pids[j]]));
    const w = RC_WEIGHTS.stability * (day.stabScale === undefined ? 1 : day.stabScale);
    day.unary = day.unaryFixed.map((c, i) => {
        if (!day.variable) return c;
        day.states[i].forEach((s, j) => { if (s !== ref[day.pids[j]]) c += w; });
        return c;
    });
}

// Optimize the problem; returns the chosen state index per day.
function _rcOptimize(prob) {
    const days = prob.days;
    const T = days.length;
    const K = prob.nP * 4;
    const W = RC_WEIGHTS;
    const fairW = RC_FAIR_CATS.map(c => W.fair[c]);
    const EPS = 1e-9;

    // Fairness tallies decay by RC_FAIR_DECAY per workday:
    //   D(t) = λ·D(t−1) + worked(t) − share(t)
    // so a change of δ on day a shifts every later D(t) by δ·λ^(t−a). The
    // delta and gradient formulas below lean on λ^t-weighted prefix sums.
    const lam = RC_FAIR_DECAY;
    const pw = new Float64Array(T), ipw = new Float64Array(T);
    for (let t = 0; t < T; t++) { pw[t] = Math.pow(lam, t); ipw[t] = 1 / pw[t]; }
    // geo[n] = Σ_{i<n} λ^(2i)
    const geo = new Float64Array(T + 1);
    for (let n = 1; n <= T; n++) geo[n] = geo[n - 1] * lam * lam + 1;
    // Prefix count of penalty-counted days (a contiguous run: the window).
    const PC = new Float64Array(T + 1);
    for (let t = 0; t < T; t++) PC[t + 1] = PC[t] + (days[t].counted ? 1 : 0);

    // ── Mutable plan state ──
    let cur = null;
    let D = null;    // D[k][t]   running fairness imbalance
    let PS = null;   // PS[k][t]  Σ_{u<t, counted} D[k][u]·λ^u
    const fri = prob.fri;
    const F = new Float64Array(fri.S.length);   // Friday-Bigs counts, by fri index
    const G = new Float64Array(prob.nP);         // tmplDesir running totals, by pathologist
    const Wd = W.tmplDesir || 0, Wg = W.requesterGain || 0, Wl = W.othersLoss || 0;
    const useG = !!(Wd || Wg || Wl);
    const isChanger = new Uint8Array(prob.nP);
    (prob.changers || []).forEach(pi => { if (pi >= 0) isChanger[pi] = 1; });
    // Penalty on one pathologist's running desirability total g, and its slope.
    const gPen = (p, g) => Wd * g * g + (isChanger[p] ? (g > 0 ? Wg * g * g : 0) : (g < 0 ? Wl * g * g : 0));
    const gSlope = (p, g) => 2 * Wd * g + (isChanger[p] ? (g > 0 ? 2 * Wg * g : 0) : (g < 0 ? 2 * Wl * g : 0));

    const rebuildK = k => {
        const d = D[k], ps = PS[k];
        let acc = 0;
        for (let t = 0; t < T; t++) {
            const day = days[t];
            acc = acc * lam + day.vec[cur[t]][k] - day.share[k];
            d[t] = acc;
            ps[t + 1] = ps[t] + (day.counted ? acc * pw[t] : 0);
        }
    };
    const rebuildFri = () => {
        F.set(fri.F0);
        for (let t = 0; t < T; t++) {
            const h = days[t].friHolder[cur[t]];
            if (h >= 0) F[days[t].fy + h]++;
        }
    };
    const rebuildDes = () => {
        G.fill(0);
        if (!useG) return;
        for (let t = 0; t < T; t++) {
            const v = days[t].desir[cur[t]];
            for (let p = 0; p < G.length; p++) G[p] += v[p];
        }
    };
    const desPenalty = () => {
        let c = 0;
        for (let p = 0; p < G.length; p++) c += gPen(p, G[p]);
        return c;
    };
    const dG = new Float64Array(prob.nP);
    // Exact tmplDesir change for day t0 → a (and t0+1 → b when b >= 0).
    const desDelta = (t0, a, b) => {
        if (!useG) return 0;
        const va = days[t0].desir[a], vo = days[t0].desir[cur[t0]];
        for (let p = 0; p < G.length; p++) dG[p] = va[p] - vo[p];
        if (b >= 0) {
            const vb = days[t0 + 1].desir[b], vp = days[t0 + 1].desir[cur[t0 + 1]];
            for (let p = 0; p < G.length; p++) dG[p] += vb[p] - vp[p];
        }
        let d = 0;
        for (let p = 0; p < G.length; p++) if (dG[p]) d += gPen(p, G[p] + dG[p]) - gPen(p, G[p]);
        return d;
    };
    const setPlan = plan => {
        cur = plan.slice();
        D = []; PS = [];
        for (let k = 0; k < K; k++) {
            D.push(new Float64Array(T));
            PS.push(new Float64Array(T + 1));
            rebuildK(k);
        }
        rebuildFri();
        rebuildDes();
    };
    const friPenalty = () => {
        let c = 0;
        for (let i = 0; i < F.length; i++) {
            const dv = F[i] - fri.S[i];
            c += W.fridayBigs * dv * dv;
        }
        return c;
    };
    // Pathologists at McHenry three workdays running, ending on day t
    // (days are consecutive workdays; a day off clears the bit).
    const streak = (t, s2, s1, s0) => {
        let m = days[t - 2].mch[s2] & days[t - 1].mch[s1] & days[t].mch[s0];
        let n = 0;
        while (m) { m &= m - 1; n++; }
        return n * W.mchStreak;
    };
    const total = () => {
        let c = 0;
        for (let t = 0; t < T; t++) {
            c += days[t].unary[cur[t]];
            if (t > 0) c += days[t].pair[cur[t - 1] * days[t].states.length + cur[t]];
            if (t > 1) c += streak(t, cur[t - 2], cur[t - 1], cur[t]);
        }
        for (let k = 0; k < K; k++) {
            const d = D[k];
            let s = 0;
            for (let t = 0; t < T; t++) if (days[t].counted) s += d[t] * d[t];
            c += fairW[k % 4] * s;
        }
        return c + friPenalty() + desPenalty();
    };

    // Exact cost change of putting day t0 on state a and, when b >= 0, day
    // t0+1 on state b. Allocation-free: local search calls this ~10^5 times
    // per sweep.
    const deltaCost = (t0, a, b) => {
        const t1 = t0 + 1;
        const two = b >= 0;
        const stateAt = t => (t === t0 ? a : (two && t === t1 ? b : cur[t]));
        let delta = days[t0].unary[a] - days[t0].unary[cur[t0]];
        if (two) delta += days[t1].unary[b] - days[t1].unary[cur[t1]];
        const lastEdge = Math.min(T - 1, two ? t0 + 2 : t1);
        for (let t = Math.max(1, t0); t <= lastEdge; t++) {
            const n = days[t].states.length, pair = days[t].pair;
            delta += pair[stateAt(t - 1) * n + stateAt(t)] - pair[cur[t - 1] * n + cur[t]];
        }
        const lastTri = Math.min(T - 1, two ? t0 + 3 : t0 + 2);
        for (let t = Math.max(2, t0); t <= lastTri; t++) {
            delta += streak(t, stateAt(t - 2), stateAt(t - 1), stateAt(t))
                - streak(t, cur[t - 2], cur[t - 1], cur[t]);
        }
        // Fairness: ΔD(t) = c·λ^(t−t0) on [t0, t1), then (c·λ + c')·λ^(t−t1).
        const va = days[t0].vec[a], vo = days[t0].vec[cur[t0]];
        const vb = two ? days[t1].vec[b] : null, vp = two ? days[t1].vec[cur[t1]] : null;
        const end0 = two ? t1 : T;
        for (let k = 0; k < K; k++) {
            let c = va[k] - vo[k];
            let part = 0;
            if (c !== 0) {
                part += 2 * c * ipw[t0] * (PS[k][end0] - PS[k][t0]) + c * c * geo[PC[end0] - PC[t0]];
            }
            if (two) {
                c = c * lam + vb[k] - vp[k];
                if (c !== 0) {
                    part += 2 * c * ipw[t1] * (PS[k][T] - PS[k][t1]) + c * c * geo[PC[T] - PC[t1]];
                }
            }
            if (part !== 0) delta += fairW[k % 4] * part;
        }
        // Friday Bigs (at most one of two consecutive workdays is a Friday).
        delta += friDelta(t0, a);
        if (two) delta += friDelta(t1, b);
        delta += desDelta(t0, a, b);
        return delta;
    };
    const friDelta = (t, s) => {
        const day = days[t];
        if (day.fy < 0) return 0;
        const o = day.friHolder[cur[t]], n = day.friHolder[s];
        if (o === n) return 0;
        let d = 0;
        if (o >= 0) { const e = F[day.fy + o] - fri.S[day.fy + o]; d += (e - 1) * (e - 1) - e * e; }
        if (n >= 0) { const e = F[day.fy + n] - fri.S[day.fy + n]; d += (e + 1) * (e + 1) - e * e; }
        return W.fridayBigs * d;
    };

    const apply = (t0, a, b) => {
        const touched = new Set();
        const set = (t, s) => {
            const oldV = days[t].vec[cur[t]], newV = days[t].vec[s];
            for (let k = 0; k < K; k++) if (oldV[k] !== newV[k]) touched.add(k);
            cur[t] = s;
        };
        set(t0, a);
        if (b >= 0) set(t0 + 1, b);
        touched.forEach(rebuildK);
        rebuildFri();
        rebuildDes();
    };

    // Viterbi over the day chain. alpha scales the fairness/Friday gradient
    // at the current plan (0 = pairwise rules only).
    const viterbi = alpha => {
        let grad = null, friGrad = null;
        if (alpha > 0) {
            grad = [];
            for (let k = 0; k < K; k++) {
                const g = new Float64Array(T), ps = PS[k], tot = ps[T];
                const w = 2 * fairW[k % 4] * alpha;
                for (let t = 0; t < T; t++) g[t] = w * ipw[t] * (tot - ps[t]);
                grad.push(g);
            }
            friGrad = new Float64Array(F.length);
            for (let i = 0; i < F.length; i++) friGrad[i] = 2 * W.fridayBigs * alpha * (F[i] - fri.S[i]);
        }
        const desGrad = alpha > 0 && useG ? Array.from(G, (g, p) => alpha * gSlope(p, g)) : null;
        const nodeCost = (t, s) => {
            const day = days[t];
            let c = day.unary[s];
            if (grad) {
                const v = day.vec[s];
                for (let k = 0; k < K; k++) if (v[k]) c += v[k] * grad[k][t];
                const h = day.friHolder[s];
                if (h >= 0) c += friGrad[day.fy + h];
            }
            if (desGrad) {
                const v = day.desir[s];
                for (let p = 0; p < desGrad.length; p++) if (v[p]) c += v[p] * desGrad[p];
            }
            return c;
        };
        const best = [], from = [];
        for (let t = 0; t < T; t++) {
            const n = days[t].states.length;
            const b = new Float64Array(n), f = new Int32Array(n);
            for (let s = 0; s < n; s++) {
                let m = 0, arg = 0;
                if (t > 0) {
                    const pb = best[t - 1], pair = days[t].pair;
                    m = Infinity;
                    for (let a = 0; a < pb.length; a++) {
                        const v = pb[a] + pair[a * n + s];
                        if (v < m - EPS) { m = v; arg = a; }
                    }
                }
                b[s] = m + nodeCost(t, s);
                f[s] = arg;
            }
            best.push(b);
            from.push(f);
        }
        const plan = new Array(T);
        let s = 0;
        const last = best[T - 1];
        for (let i = 1; i < last.length; i++) if (last[i] < last[s] - EPS) s = i;
        for (let t = T - 1; t >= 0; t--) { plan[t] = s; s = from[t][s]; }
        return plan;
    };

    // Local search: best single-day and two-consecutive-day re-arrangements.
    const localSearch = () => {
        let improvedAny = false;
        for (let sweep = 0; sweep < 25; sweep++) {
            let improved = false;
            for (let t = 0; t < T; t++) {
                const day = days[t];
                if (!day.variable || day.states.length < 2) continue;
                let bestD = -EPS, bestS = -1;
                for (let s = 0; s < day.states.length; s++) {
                    if (s === cur[t]) continue;
                    const dl = deltaCost(t, s, -1);
                    if (dl < bestD) { bestD = dl; bestS = s; }
                }
                if (bestS >= 0) { apply(t, bestS, -1); improved = true; }
            }
            for (let t = 0; t + 1 < T; t++) {
                const a = days[t], b = days[t + 1];
                if (!a.variable || !b.variable) continue;
                let bestD = -EPS, bestX = -1, bestY = -1;
                for (let x = 0; x < a.states.length; x++) {
                    if (x === cur[t]) continue;   // single moves cover these
                    for (let y = 0; y < b.states.length; y++) {
                        if (y === cur[t + 1]) continue;
                        const dl = deltaCost(t, x, y);
                        if (dl < bestD) { bestD = dl; bestX = x; bestY = y; }
                    }
                }
                if (bestX >= 0) { apply(t, bestX, bestY); improved = true; }
            }
            if (!improved) break;
            improvedAny = true;
        }
        return improvedAny;
    };

    const polish = () => {
        let cost = total();
        for (let round = 0; round < 12; round++) {
            let changed = false;
            for (const alpha of [1, 0.5, 0.25, 0.1]) {
                const saved = cur.slice();
                setPlan(viterbi(alpha));
                const c = total();
                if (c < cost - EPS) { cost = c; changed = true; break; }
                setPlan(saved);
            }
            if (localSearch()) { cost = total(); changed = true; }
            if (!changed) break;
        }
        return cost;
    };

    // Tuning tools (tools/tuning): score a given plan instead of optimizing.
    if (prob.evaluatePlan) {
        setPlan(prob.evaluatePlan);
        return total();
    }

    // Run 1: from the pairwise-optimal plan.
    setPlan(new Array(T).fill(0));
    setPlan(viterbi(0));
    const costA = polish();
    const planA = cur.slice();

    // Run 2: from the current schedule (days whose current arrangement isn't
    // a candidate — changed pins, broken coverage — start from run 1's pick).
    setPlan(days.map((day, t) => day.baseIdx >= 0 ? day.baseIdx : planA[t]));
    const costB = polish();

    return costB <= costA + EPS ? cur.slice() : planA;
}

// Optimize the problem the way a recompute does: phase-aware stability,
// then re-plan against the plan's own output until it stops moving.
// fromT = index of the change day in prob.days; stableN = workdays of plain
// stability from there (Infinity = everywhere); keepSeam keeps the pull
// toward the fixed day after the window. Returns the state index per day.
function _rcSolve(prob, fromT, stableN, keepSeam) {
    // Phase-aware stability (see RC_STABLE_WORKDAYS). Near the change the
    // plan is pulled toward what's shown. Further out it's pulled toward
    // what's shown WITH the plan's own phase trades carried forward: if the
    // change left Moravek on Mujeeb's old phase, Moravek's reference is
    // Mujeeb's old schedule. So continuing new phases is free, while any
    // other reshuffle still costs — an untouched schedule stays untouched.
    //   A. Solve keeping everyone's phase (plain stability everywhere).
    //   B. Solve with no pull past the stable window to see where the change
    //      settles, read the phase trades off it at the window's last day,
    //      and re-solve pulled toward the shown schedule under those trades.
    //   Then judge A and B the same way — stability past the window against
    //   the shown schedule under each plan's OWN trades — and keep the
    //   better. (B alone can invent a trade just to exploit the free far
    //   future; judged fairly, such a trade loses.)
    // No seam with the fixed day after the window: a change's phase trades
    // carry on to the horizon instead of bending back to meet it. (Enforcing
    // even the day-to-day rules there discourages every trade; the day
    // after the horizon may clash, and gets planned properly by the next
    // recompute that reaches it.)
    if (!keepSeam) {
        const last = prob.days[prob.days.length - 1];
        if (!last.variable && last.pair) last.pair = new Float64Array(last.pair.length);
    }
    const lastVar = prob.days.reduce((a, day, t) => (day.variable ? t : a), -1);
    const anchorT = fromT < 0 ? -1 : Math.min(fromT + stableN - 1, lastVar);
    const beyond = (day, t) => day.variable && t > anchorT;
    const planMap = (day, st) => { const m = {}; st.forEach((s, j) => { m[day.pids[j]] = s; }); return m; };

    // References: window days → shown; later days → shown under `holder`.
    const setRefs = holder => {
        prob.days.forEach((day, t) => {
            if (!day.variable) return;
            if (!beyond(day, t) || !holder) { delete day.stabScale; _rcSetReference(day, day.baseline); return; }
            const ref = {};
            day.pids.forEach(pid => { ref[pid] = day.baseline[holder[pid] !== undefined ? holder[pid] : pid]; });
            delete day.stabScale;
            _rcSetReference(day, ref);
        });
    };
    // Optimize, then re-plan against the plan's own output until it stops
    // moving — exactly what pressing Recompute again would do — so a second
    // recompute finds nothing left to change.
    const settle = () => {
        let plan = _rcOptimize(prob);
        for (let pass = 0; pass < 4; pass++) {
            prob.days.forEach((day, t) => { if (day.variable) _rcSetReference(day, planMap(day, day.states[plan[t]])); });
            const next = _rcOptimize(prob);
            if (next.every((s, t) => s === plan[t])) break;
            plan = next;
        }
        return plan;
    };
    const holderOf = plan => {
        const aDay = prob.days[anchorT];
        return _rcPhaseMap(aDay.pids, aDay.states[plan[anchorT]], aDay.baseline);
    };

    setRefs(null);
    const planA = settle();
    if (anchorT < 0 || anchorT >= lastVar) return planA;

    prob.days.forEach((day, t) => { if (beyond(day, t)) { day.stabScale = 0; _rcSetReference(day, day.baseline); } });
    const free = _rcOptimize(prob);
    setRefs(holderOf(free));
    const planB = settle();

    const judge = plan => {
        setRefs(holderOf(plan));
        prob.evaluatePlan = plan;
        const c = _rcOptimize(prob);
        delete prob.evaluatePlan;
        return c;
    };
    const costA = judge(planA), costB = judge(planB);
    const best = costB < costA - 1e-9 ? planB : planA;
    // Leave the references on the chosen plan, as a settled recompute would.
    prob.days.forEach((day, t) => { if (day.variable) { delete day.stabScale; _rcSetReference(day, planMap(day, day.states[best[t]])); } });
    return best;
}

// Phase trades on one day: for each pathologist, whose SHOWN service they
// hold in the plan (pids and planned states aligned; shown = {pid: sid}).
// A service held by nobody in `shown` — or any ambiguity — maps a
// pathologist to themselves. Returns {pid: pid}.
function _rcPhaseMap(pids, planned, shown) {
    const map = {};
    const used = new Set();
    pids.forEach((pid, j) => {
        const holders = pids.filter(q => shown[q] === planned[j]);
        if (holders.length === 1 && !used.has(holders[0])) { map[pid] = holders[0]; used.add(holders[0]); }
    });
    pids.forEach(pid => {
        if (map[pid] === undefined) {
            if (used.has(pid)) {
                // Someone took this pathologist's phase but they took no one's
                // unique service — give them whichever phase is left.
                const left = pids.find(q => !used.has(q));
                if (left !== undefined) { map[pid] = left; used.add(left); }
            } else { map[pid] = pid; used.add(pid); }
        }
    });
    return map;
}

// Build pin entries from the serviceLocks store (scheduler/serviceLocks).
//
// Locks live in a dedicated, explicitly-managed store:
//   scheduler/serviceLocks/{dayKey}/{pathId} = serviceId
// written when the admin APPROVES a service_change request (or locks an
// edit), and released when the admin explicitly edits/clears that slot,
// resets the day, approves PTO on top, revokes the approval, or clicks
// "Unlock" in the day-detail quick panel. Locked slots render with a glow
// on the schedule, so they are always visible and always releasable.
//
// The optimizer treats each lock as a hard pin: the locked pathologist
// stays on the locked service for that day, and everyone else rotates
// around them. Pins are honored even when they break coverage — the
// red-flag layer surfaces those cases for review.
function _pinsFromServiceLocks() {
    const pins = {};
    const locks = (typeof serviceLocks === 'object' && serviceLocks) ? serviceLocks : {};
    for (const dayKey in locks) {
        const dayLocks = locks[dayKey];
        if (!dayLocks) continue;
        for (const pid in dayLocks) {
            const sid = dayLocks[pid];
            if (!sid || !SERVICE_BY_ID[sid]) continue;   // ignore malformed entries
            if (!pins[dayKey]) pins[dayKey] = {};
            pins[dayKey][pid] = sid;
        }
    }
    return pins;
}

async function recomputeFutureSchedule(pinnedByDay, opts) {
    pinnedByDay = pinnedByDay || {};
    opts = opts || {};
    const fromDate = opts.fromDate;
    if (!fromDate) return { processed: 0, dayBeforeProcessed: false };
    const horizonDays = Math.max(1, opts.horizonDays || 180);
    const dayBeforeFix = opts.dayBeforeFix !== false;

    // ── Merge pin sources ───────────────────────────────────────────────
    // Caller-supplied pins (the admin's just-made change) win on direct
    // conflict at the same {date, pid} — by the time a caller pin conflicts
    // with a lock, the save handler has already released that lock anyway.
    const lockPins = _pinsFromServiceLocks();
    const mergedPins = {};
    for (const k in lockPins) {
        mergedPins[k] = Object.assign({}, lockPins[k]);
    }
    for (const k in pinnedByDay) {
        if (!pinnedByDay[k]) continue;
        mergedPins[k] = Object.assign(mergedPins[k] || {}, pinnedByDay[k]);
    }

    // ── Build the window ────────────────────────────────────────────────
    const isWorkday = d => !isBeforeEarliest(d) && !isWeekend(d) && !getFederalHoliday(d);
    const workdays = [];
    if (dayBeforeFix) {
        let d = prevWorkday(fromDate);
        for (let i = 0; i < RC_LEAD_IN_WORKDAYS; i++) {
            if (d.getTime() < today.getTime() || isBeforeEarliest(d)) break;
            workdays.unshift(d);
            d = prevWorkday(d);
        }
    }
    for (let i = 0; i < horizonDays; i++) {
        const d = addDays(fromDate, i);
        if (isWorkday(d)) workdays.push(d);
    }
    if (workdays.length === 0) return { processed: 0, dayBeforeProcessed: false };

    // Planning a long window takes a few seconds and blocks the page; say
    // so first, and give the toast a moment to paint.
    if (workdays.length > 60) {
        showToast('Recomputing the schedule…', { duration: 3000 });
        await new Promise(r => setTimeout(r, 60));
    }

    const prob = _rcBuildProblem(workdays, mergedPins);
    prob.changers = (opts.changedPathIds || []).map(id => pathologists.findIndex(p => String(p.id) === String(id)));
    const fromT = prob.days.findIndex(day => day.variable && day.date.getTime() >= fromDate.getTime());
    const plan = _rcSolve(prob, fromT,
        opts.stableWorkdays !== undefined ? opts.stableWorkdays : RC_STABLE_WORKDAYS, !!opts.keepSeam);

    // snapshot[k] = the plan for window day k; baseline[k] = what's shown now.
    const snapshot = {};
    const baseline = {};
    prob.days.forEach((day, t) => {
        if (!day.variable) return;
        const m = {};
        day.states[plan[t]].forEach((s, j) => { m[day.pids[j]] = s; });
        snapshot[day.key] = m;
        baseline[day.key] = day.baseline;
    });

    // Full-day write for key k: the plan (or the given map) plus any
    // non-working entries already in the day's override map. The plan only
    // covers WORKING pathologists, but the override map may also hold
    // off-site entries (Director Retreat / Lab Inspection / Off Service,
    // possibly locked) — writing the plan wholesale would wipe those.
    const fullDayWrite = (k, map) => {
        const dbDay = (typeof serviceOverrides === 'object' && serviceOverrides && serviceOverrides[k]) || {};
        const preserved = {};
        for (const pid in dbDay) {
            if (!(pid in map)) preserved[pid] = dbDay[pid];
        }
        return Object.assign({}, preserved, map);
    };

    // ── Compute writes (only days where snapshot ≠ baseline) ────────────
    const writes = {};
    let processed = 0;
    let dayBeforeProcessed = false;
    let firstChangedKey = null;
    let lastChangedKey = null;
    const fromKey = fmt(fromDate);
    for (const k in snapshot) {
        if (_sameServiceMap(snapshot[k], baseline[k])) continue;
        writes['scheduler/serviceOverrides/' + k] = fullDayWrite(k, snapshot[k]);
        processed++;
        if (k < fromKey) dayBeforeProcessed = true;
        if (firstChangedKey === null || k < firstChangedKey) firstChangedKey = k;
        if (lastChangedKey === null || k > lastChangedKey) lastChangedKey = k;
    }

    // ── Materialize the adjacency ring ──────────────────────────────────
    // An unwritten day next to a written day re-renders against its NEW
    // neighbours: the render-time hard-rule layer (which knows nothing about
    // locks or the plan) can shuffle it away from what the optimizer
    // decided. Freeze any unwritten day that touches a written day by
    // writing what it shows now (its plan equals its baseline) — including
    // the fixed days just outside the window. Re-runs stay idempotent: the
    // ring only exists when real changes were written, and ring days don't
    // count toward `processed`.
    if (Object.keys(writes).length > 0) {
        const firstVar = prob.days.findIndex(day => day.variable);
        const ringDays = prob.days.filter((day, t) =>
            day.variable || t === firstVar - 1 || t === prob.days.length - 1);
        const written = k => !!writes['scheduler/serviceOverrides/' + k];
        let grew = true;
        while (grew) {
            grew = false;
            for (const day of ringDays) {
                const k = day.key;
                if (written(k)) continue;
                if (!written(fmt(prevWorkday(day.date))) && !written(fmt(nextWorkday(day.date)))) continue;
                writes['scheduler/serviceOverrides/' + k] = fullDayWrite(k, snapshot[k] || day.baseline);
                grew = true;
            }
        }
    }

    if (Object.keys(writes).length > 0) {
        await db.ref().update(writes);
    }
    return {
        processed: processed,
        dayBeforeProcessed: dayBeforeProcessed,
        firstChangedKey: firstChangedKey,
        lastChangedKey: lastChangedKey,
    };
}

// ────────────── BACK-FIX (repair "Bigs the day before" conflicts) ──────────
//
// Runs right after an admin change saves (from maybeOfferRecompute, which
// every change flow funnels through — day edits, resets, request approvals,
// PTO changes). When the just-made change puts a pathologist on Breast
// Bx/WFH (or starts their PTO) on day X while they hold McH Bigs on the
// workday before, the soft-rule flag lights up on X−1. The render-time
// hard-rule layer can't always fix that: once X−1 has been materialized
// into serviceOverrides by an earlier recompute, every slot on it is
// treated as locked and nothing can move. The recompute optimizer would
// fix it, but only runs if the admin chooses to recompute — this pass
// repairs the day(s) before the change even on "Just apply this change":
//
//   1. Re-arrange X−1 to take the pathologist off Bigs — Huntley is the
//      PREFERRED day-before service, before WFH and PTO alike. In a natural
//      rotation a two-way swap on X−1 alone is NEVER rule-clean (the
//      Huntley holder came from Bigs on X−2, the fixed pathologist came
//      from Cyto on X−2 — either swap direction repeats a service), so
//      when X−1 alone can't be fixed the search widens to re-arranging
//      X−2 as well. Never further back than that.
//   2. Huntley is the light service, so netting an EXTRA Huntley day out
//      of the fix would skew fairness. When the fix lands on Huntley, one
//      of the pathologist's OTHER Huntley days nearby (previous days
//      first, never in the past; upcoming days as fallback) is handed to
//      the displaced partner in a second swap — everyone's Huntley count
//      ends up exactly where it started. WFH days are never taken in
//      trade (also a light day — trading one away would still lighten
//      the fixed pathologist's week).
//   3. If no compensating swap exists, prefer Cyto/Gross for X−1;
//      Huntley-without-compensation is the last resort before leaving
//      the flag in place.
//
// Every swap is vetted against the cross-day service rules in both
// directions (no Bigs before PTO/WFH, no WFH after Bigs, no same-service
// repeats) and never touches admin-locked (serviceLocks) or caller-pinned
// slots. If no clean swap exists the day is left alone and the flag stays
// — exactly the pre-existing behavior.
//
// Touched days are written as full-day override maps (the same shape
// recompute writes) and merged into pinnedByDay, so an immediately-
// following recompute preserves the repair.

const BACKFIX_COMP_WINDOW = 14;   // workdays scanned each direction for the fairness swap

function _bfIsBigs(sid) { return sid === 'bigs' || sid === 'cytobigs'; }

function _bfLockedAt(dayKey, pid) {
    const l = (typeof serviceLocks === 'object' && serviceLocks) ? serviceLocks[dayKey] : null;
    return !!(l && (l[pid] !== undefined || l[String(pid)] !== undefined));
}

function _bfPinnedAt(pinnedByDay, dayKey, pid) {
    const p = pinnedByDay && pinnedByDay[dayKey];
    return !!(p && (p[pid] !== undefined || p[String(pid)] !== undefined));
}

// Effective service id for pid on date, with caller pins overlaid on the
// rendered assignment (the pins are the just-saved change, which the
// Firebase listener may not have echoed back yet). null when not working
// a regular service that day.
function _bfServiceAt(pinnedByDay, date, pid) {
    const pins = pinnedByDay && pinnedByDay[fmt(date)];
    const pinned = pins && (pins[pid] !== undefined ? pins[pid] : pins[String(pid)]);
    if (pinned !== undefined) {
        return (pinned && !isOffSiteServiceId(pinned)) ? pinned : null;
    }
    const a = getDayAssignments(date)[pid];
    return (a && a.type === 'service' && a.service) ? a.service.id : null;
}

// Would giving `pid` service `sid` on `date` break a cross-day rule against
// its workday neighbours? `planned` maps dayKey → {pid: sid} for swaps this
// back-fix has already decided, so adjacent decisions see each other.
function _bfCreatesViolation(pinnedByDay, planned, date, pid, sid) {
    const svcAt = (d, p) => {
        const k = fmt(d);
        if (planned[k] && planned[k][p] !== undefined) return planned[k][p];
        return _bfServiceAt(pinnedByDay, d, p);
    };
    const ySid = svcAt(prevWorkday(date), pid);
    const tmrw = nextWorkday(date);
    const tSid = svcAt(tmrw, pid);
    // Same-service repeat (bigs and cytobigs count as the same station).
    if (sid === ySid || sid === tSid) return true;
    if (_bfIsBigs(sid) && (_bfIsBigs(ySid) || _bfIsBigs(tSid))) return true;
    // No Bigs the day before PTO or WFH.
    if (_bfIsBigs(sid) && (isOnPto(pid, tmrw) || tSid === 'wfh')) return true;
    // No WFH the day after Bigs.
    if (sid === 'wfh' && _bfIsBigs(ySid)) return true;
    return false;
}

// Effective {pid: serviceId} map for a day (regular services only).
function _bfDayMap(pinnedByDay, date) {
    const m = {};
    pathologists.forEach(p => {
        const sid = _bfServiceAt(pinnedByDay, date, p.id);
        if (sid) m[p.id] = sid;
    });
    return m;
}

// Same-station repeat: identical service, or both in the bigs family.
function _bfRepeat(a, b) {
    return !!a && !!b && (a === b || (_bfIsBigs(a) && _bfIsBigs(b)));
}

// Rule violations for a candidate day map given its neighbour maps (either
// may itself be a candidate). Cross-boundary rules are visible from both
// sides, so checking each candidate day against both neighbours covers
// every boundary.
function _bfMapViolations(date, dayMap, prevMap, nextMap) {
    let v = 0;
    const tmrw = nextWorkday(date);
    for (const pid in dayMap) {
        const sid = dayMap[pid];
        const prevSid = prevMap ? prevMap[pid] : null;
        const nextSid = nextMap ? nextMap[pid] : null;
        if (_bfRepeat(sid, prevSid) || _bfRepeat(sid, nextSid)) v++;
        const p = pathologists.find(x => String(x.id) === String(pid));
        if (_bfIsBigs(sid) && ((p && isOnPto(p.id, tmrw)) || nextSid === 'wfh')) v++;
        if (sid === 'wfh' && _bfIsBigs(prevSid)) v++;
    }
    return v;
}

// All rule-checkable arrangements for a day: locked/pinned slots keep their
// service, the remaining required services permute over the free slots.
// Returns [] when the day can't be searched (too few working, pins outside
// the required set, …) — the caller then leaves the day alone.
function _bfCandidateMaps(pinnedByDay, date) {
    const cur = _bfDayMap(pinnedByDay, date);
    const pids = Object.keys(cur);
    const required = requiredServicesFor(pids.length);
    if (!required) return [];
    const k = fmt(date);
    const fixed = {};
    const remaining = required.slice();
    const free = [];
    pids.forEach(pid => {
        if (_bfLockedAt(k, pid) || _bfPinnedAt(pinnedByDay, k, pid)) {
            fixed[pid] = cur[pid];
            const i = remaining.indexOf(cur[pid]);
            if (i < 0) return;   // pinned outside required → handled below
            remaining.splice(i, 1);
        } else {
            free.push(pid);
        }
    });
    if (remaining.length !== free.length) return [];
    const seen = new Set();
    const out = [];
    _allPermutations(remaining).forEach(perm => {
        const key = perm.join('|');
        if (seen.has(key)) return;   // extra-wfh days produce duplicate perms
        seen.add(key);
        const m = Object.assign({}, fixed);
        free.forEach((pid, i) => { m[pid] = perm[i]; });
        out.push(m);
    });
    return out;
}

// Search for a rule-clean re-arrangement of X−1 (and, only when X−1 alone
// can't be fixed, X−2 jointly — "adjust 1–2 days beforehand") that takes P
// off Bigs on X−1. preferHuntley ranks P-on-Huntley solutions first (the
// pre-WFH preference); banHuntleyForP forbids them outright (used to avoid
// an uncompensated extra Huntley day). Ties break on fewest changed slots.
// Returns {maps: {dayKey: fullDayMap}, pHuntley, changed} or null.
function _bfSolve(pinnedByDay, P, X, Xm1, preferHuntley, banHuntleyForP) {
    const kXm1 = fmt(Xm1);
    const curXm1 = _bfDayMap(pinnedByDay, Xm1);
    const nextMap = _bfDayMap(pinnedByDay, X);
    const Xm2 = prevWorkday(Xm1);
    const canTouchXm2 = Xm2.getTime() >= today.getTime() && !isBeforeEarliest(Xm2);
    const curXm2 = _bfDayMap(pinnedByDay, Xm2);
    const xm3Map = _bfDayMap(pinnedByDay, prevWorkday(Xm2));

    const pSidOf = m => (m[P] !== undefined ? m[P] : m[String(P)]);
    const okForP = m => {
        const sid = pSidOf(m);
        if (!sid || _bfIsBigs(sid)) return false;
        if (banHuntleyForP && sid === 'huntley') return false;
        return true;
    };
    const changedCount = (m, cur) => {
        let c = 0;
        for (const pid in m) if (m[pid] !== cur[pid]) c++;
        return c;
    };

    let best = null;
    const consider = (maps, pSid, changed) => {
        const cand = { maps: maps, pHuntley: pSid === 'huntley', changed: changed };
        const rank = c => [
            preferHuntley ? (c.pHuntley ? 0 : 1) : (c.pHuntley ? 1 : 0),
            c.changed,
        ];
        if (!best) { best = cand; return; }
        const a = rank(cand), b = rank(best);
        if (a[0] !== b[0] ? a[0] < b[0] : a[1] < b[1]) best = cand;
    };

    // Pass 1: X−1 alone (X−2 stays as-is).
    _bfCandidateMaps(pinnedByDay, Xm1).forEach(m => {
        if (!okForP(m)) return;
        if (_bfMapViolations(Xm1, m, curXm2, nextMap) > 0) return;
        const maps = {};
        maps[kXm1] = m;
        consider(maps, pSidOf(m), changedCount(m, curXm1));
    });
    if (best) return best;
    if (!canTouchXm2) return null;

    // Pass 2: joint X−2 + X−1 (at most 24×24 combos — trivial to search).
    const kXm2 = fmt(Xm2);
    const xm1Cands = _bfCandidateMaps(pinnedByDay, Xm1);
    _bfCandidateMaps(pinnedByDay, Xm2).forEach(m2 => {
        if (banHuntleyForP && pSidOf(m2) === 'huntley') return;
        if (_bfMapViolations(Xm2, m2, xm3Map, null) > 0) return;   // prefilter vs X−3
        xm1Cands.forEach(m1 => {
            if (!okForP(m1)) return;
            if (_bfMapViolations(Xm1, m1, m2, nextMap) > 0) return;
            if (_bfMapViolations(Xm2, m2, xm3Map, m1) > 0) return;
            const maps = {};
            maps[kXm2] = m2;
            maps[kXm1] = m1;
            consider(maps, pSidOf(m1),
                changedCount(m1, curXm1) + changedCount(m2, curXm2));
        });
    });
    return best;
}

// Find the fairness-compensation swap: a nearby day where `pid` already has
// Huntley that can be handed to a partner in exchange for the partner's
// McHenry station service that day. Previous days first ("a previous
// Huntley day"), never before today; upcoming days after X as a fallback.
// Partner preference: `preferredPartner` (whoever lost Huntley in the X−1
// repair) first, then whoever has the fewest Huntley days coming up (they
// benefit most from receiving one). Structurally the loser often CAN'T
// trade — in a clean rotation they hold WFH on every one of pid's Huntley
// days — which is why other partners are considered at all.
// Returns {date, partner, pSvc} or null.
function _bfFindCompSwap(pinnedByDay, planned, pid, preferredPartner, X, Xm1) {
    const huntCount = q => {
        let c = 0;
        let d2 = new Date(today);
        for (let i = 0; i < 28; i++, d2 = addDays(d2, 1)) {
            if (isWeekend(d2) || getFederalHoliday(d2)) continue;
            if (_bfServiceAt(pinnedByDay, d2, q) === 'huntley') c++;
        }
        return c;
    };
    const others = pathologists.map(p => p.id)
        .filter(q => String(q) !== String(pid) && String(q) !== String(preferredPartner))
        .sort((a, b) => huntCount(a) - huntCount(b));
    const partners = (preferredPartner !== null && preferredPartner !== undefined
        ? [preferredPartner] : []).concat(others);

    const tryDay = d => {
        const k = fmt(d);
        if (planned[k]) return null;
        if (_bfServiceAt(pinnedByDay, d, pid) !== 'huntley') return null;
        if (_bfLockedAt(k, pid) || _bfPinnedAt(pinnedByDay, k, pid)) return null;
        for (const q of partners) {
            const qSid = _bfServiceAt(pinnedByDay, d, q);
            // Only trade for a McHenry station day (cyto/bigs/cytobigs):
            // taking a WFH day in trade would still lighten pid's week.
            if (!qSid || qSid === 'huntley' || qSid === 'wfh') continue;
            if (_bfLockedAt(k, q) || _bfPinnedAt(pinnedByDay, k, q)) continue;
            if (_bfCreatesViolation(pinnedByDay, planned, d, pid, qSid)) continue;
            if (_bfCreatesViolation(pinnedByDay, planned, d, q, 'huntley')) continue;
            return { date: new Date(d), partner: q, pSvc: qSid };
        }
        return null;
    };
    let d = prevWorkday(Xm1);
    for (let i = 0; i < BACKFIX_COMP_WINDOW && d.getTime() >= today.getTime(); i++) {
        const hit = tryDay(d);
        if (hit) return hit;
        d = prevWorkday(d);
    }
    d = nextWorkday(X);
    for (let i = 0; i < BACKFIX_COMP_WINDOW; i++) {
        const hit = tryDay(d);
        if (hit) return hit;
        d = nextWorkday(d);
    }
    return null;
}

// Main entry — see the section comment above. Mutates pinnedByDay (adds
// pins for repaired days) and writes serviceOverrides. Returns the number
// of days repaired (0 = nothing needed or nothing safely fixable).
async function backFixDayBefore(pinnedByDay, fromDate) {
    // ── Collect triggers: {pid, date, kind} ─────────────────────────────
    const triggers = [];
    const seen = new Set();
    const addTrigger = (pid, date, kind) => {
        const p = pathologists.find(x => String(x.id) === String(pid));
        if (!p) return;
        const key = p.id + '|' + fmt(date);
        if (seen.has(key)) return;
        seen.add(key);
        triggers.push({ pid: p.id, date: date, kind: kind });
    };
    for (const dayKey in (pinnedByDay || {})) {
        const pins = pinnedByDay[dayKey];
        for (const pid in pins) {
            if (pins[pid] !== 'wfh') continue;
            const d = parseDate(dayKey);
            if (!d || d.getTime() < today.getTime()) continue;
            addTrigger(pid, d, 'wfh');
        }
    }
    // PTO beginning on fromDate (PTO adds/approvals don't pin services).
    if (fromDate && fromDate.getTime() >= today.getTime()) {
        pathologists.forEach(p => {
            if (!isOnPto(p.id, fromDate)) return;
            if (isOnPto(p.id, prevWorkday(fromDate))) return;   // not the start day
            addTrigger(p.id, fromDate, 'pto');
        });
    }
    if (triggers.length === 0) return 0;
    triggers.sort((a, b) => a.date.getTime() - b.date.getTime());

    // ── Plan repairs ────────────────────────────────────────────────────
    const planned = {};   // dayKey → {pid: serviceId}
    const notes = [];
    for (const t of triggers.slice(0, 4)) {
        const Xm1 = prevWorkday(t.date);
        if (Xm1.getTime() < today.getTime() || isBeforeEarliest(Xm1)) continue;
        const kXm1 = fmt(Xm1);
        if (planned[kXm1]) continue;   // already repaired for an earlier trigger
        const pSid = _bfServiceAt(pinnedByDay, Xm1, t.pid);
        if (!_bfIsBigs(pSid)) continue;   // no bigs-the-day-before conflict
        if (_bfLockedAt(kXm1, t.pid) || _bfPinnedAt(pinnedByDay, kXm1, t.pid)) continue;

        // Huntley is the preferred day-before service, before WFH and PTO
        // alike (the admin prefers Huntley/WFH over Cyto/Gross before PTO).
        const preferHun = true;
        let solution = _bfSolve(pinnedByDay, t.pid, t.date, Xm1, preferHun, false);
        if (!solution) continue;   // no clean arrangement — leave the flag

        // Net change in `pid`'s Huntley-day count across the solution days.
        const huntDelta = (sol, pid) => {
            let dlt = 0;
            for (const k in sol.maps) {
                const d = parseDate(k);
                const beforeSid = _bfServiceAt(pinnedByDay, d, pid);
                const afterSid = sol.maps[k][pid];
                if (afterSid === 'huntley' && beforeSid !== 'huntley') dlt++;
                if (beforeSid === 'huntley' && afterSid !== 'huntley') dlt--;
            }
            return dlt;
        };

        // ── Fairness ── the fix must not hand the pathologist a net extra
        // Huntley day. If it does, trade one of their OTHER Huntley days to
        // whoever lost Huntley in the repair; failing that, re-solve with
        // Huntley banned for them; failing that too, the extra-Huntley fix
        // stands (clearing the flag beats perfect fairness).
        let comp = null;
        if (huntDelta(solution, t.pid) > 0) {
            const loser = pathologists.find(p =>
                String(p.id) !== String(t.pid) && huntDelta(solution, p.id) < 0);
            const prov = Object.assign({}, planned, solution.maps);
            comp = _bfFindCompSwap(pinnedByDay, prov, t.pid,
                loser ? loser.id : null, t.date, Xm1);
            if (!comp) {
                const noHun = _bfSolve(pinnedByDay, t.pid, t.date, Xm1, false, true);
                if (noHun) solution = noHun;
            }
        }

        const who = _chgShortName(parseInt(t.pid, 10));
        for (const k in solution.maps) {
            const d = parseDate(k);
            const changes = [];
            for (const pid in solution.maps[k]) {
                const beforeSid = _bfServiceAt(pinnedByDay, d, pid);
                const afterSid = solution.maps[k][pid];
                if (beforeSid !== afterSid) {
                    changes.push(_chgShortName(parseInt(pid, 10)) + ' → ' + _chgServiceName(afterSid));
                }
            }
            if (changes.length > 0) notes.push(_chgFmtDate(k) + ': ' + changes.join(', '));
            planned[k] = solution.maps[k];
        }
        if (comp) {
            const kY = fmt(comp.date);
            planned[kY] = {};
            planned[kY][t.pid] = comp.pSvc;
            planned[kY][comp.partner] = 'huntley';
            notes.push('fairness: ' + who + '’s Huntley on ' + _chgFmtDate(kY)
                + ' → ' + _chgShortName(parseInt(comp.partner, 10))
                + ' (' + who + ' takes ' + _chgServiceName(comp.pSvc) + ')');
        }
    }

    const dayKeys = Object.keys(planned);
    if (dayKeys.length === 0) return 0;

    // ── Write full-day override maps (recompute's write shape) ──────────
    const writes = {};
    dayKeys.forEach(k => {
        const d = parseDate(k);
        const map = {};
        pathologists.forEach(p => {
            const swap = planned[k][p.id] !== undefined ? planned[k][p.id] : planned[k][String(p.id)];
            const sid = swap !== undefined ? swap : _bfServiceAt(pinnedByDay, d, p.id);
            if (sid) map[p.id] = sid;
        });
        // Preserve override entries for non-working paths (off-site etc.).
        const dbDay = (typeof serviceOverrides === 'object' && serviceOverrides && serviceOverrides[k]) || {};
        const preserved = {};
        for (const pid in dbDay) {
            if (!(pid in map)) preserved[pid] = dbDay[pid];
        }
        writes['scheduler/serviceOverrides/' + k] = Object.assign({}, preserved, map);
    });
    await db.ref().update(writes);

    // Pin the swapped slots so an immediately-following recompute keeps them.
    dayKeys.forEach(k => {
        pinnedByDay[k] = Object.assign({}, pinnedByDay[k], planned[k]);
    });

    if (notes.length > 0) {
        showToast('Adjusted day(s) before the change — ' + notes.join(' · '));
        try {
            logChange({
                kind: 'service',
                type: 'service_backfix',
                days: dayKeys.slice().sort(),
                summary: 'Auto-adjusted day(s) before a change — ' + notes.join('; '),
            });
        } catch (logErr) {
            console.error('logChange (backFixDayBefore) error:', logErr);
        }
    }
    return dayKeys.length;
}

// ────────────── MANUAL RECOMPUTE ──────────────
// Standalone trigger: opens the Recompute Schedule modal so the admin can
// either pick a "from today" horizon (30/90/180/365 days) or specify a
// custom date range. Used by the sidebar "Recompute Schedule" button and
// the matching mobile menu item.
function triggerManualRecompute() {
    if (!isAdmin()) return;

    // Reset modal state on every open
    const modeHorizon = document.getElementById('rcModeHorizon');
    const modeRange = document.getElementById('rcModeRange');
    const horizonWrap = document.getElementById('rcHorizonWrap');
    const rangeWrap = document.getElementById('rcRangeWrap');
    const errEl = document.getElementById('rcRangeError');
    const horizonSel = document.getElementById('rcHorizonSelect');
    const startInput = document.getElementById('rcStart');
    const endInput = document.getElementById('rcEnd');

    if (modeHorizon) modeHorizon.checked = true;
    if (modeRange) modeRange.checked = false;
    if (horizonWrap) horizonWrap.style.display = '';
    if (rangeWrap) rangeWrap.style.display = 'none';
    if (errEl) errEl.style.display = 'none';
    if (horizonSel) horizonSel.value = '180';

    // Default the date-range pickers to today → today + 90d, but keep
    // them hidden until the user switches modes.
    if (startInput) startInput.value = fmt(today);
    if (endInput) endInput.value = fmt(addDays(today, 90));

    document.getElementById('recomputeModalBack').classList.add('open');
}

// Run the optimizer with the given window and surface the result via toast.
async function _runManualRecompute(fromDate, horizonDays) {
    try {
        const res = await recomputeFutureSchedule({}, {
            fromDate: fromDate,
            horizonDays: horizonDays,
            dayBeforeFix: false,
        });
        const dayPart = res.dayBeforeProcessed ? ' (incl. day before)' : '';
        showToast('Schedule recomputed: '
            + res.processed + ' day' + (res.processed === 1 ? '' : 's')
            + ' updated' + dayPart + '.');
        // ── Change log ──
        // Only log if the recompute actually mutated something; a 0-day
        // recompute means everything was already optimal and nothing
        // changed in the database.
        if (res.processed > 0) {
            const fromKey = fromDate ? fmt(fromDate) : null;
            logChange(Object.assign({
                kind: 'recompute',
                type: 'recompute',
                source: 'recompute',
                fromDate: fromKey,
                horizonDays: horizonDays,
                daysAffected: res.processed,
                dayBeforeProcessed: !!res.dayBeforeProcessed,
                startDate: res.firstChangedKey || null,
                endDate: res.lastChangedKey || null,
            }, _chgSummaryRecompute(res.processed, fromKey, !!res.dayBeforeProcessed,
                res.firstChangedKey, res.lastChangedKey)));
        }
    } catch (err) {
        console.error('triggerManualRecompute error', err);
        showToast('Recompute failed: ' + (err && err.message ? err.message : err), { type: 'error' });
    }
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
            + '<label for="rcHorizon">Horizon:</label>'
            + '<select id="rcHorizon" style="padding:5px 8px;font-size:13px;border-radius:4px;border:1px solid var(--rule-soft,#ccc);">'
            + '<option value="30">Next 30 days</option>'
            + '<option value="90">Next 90 days</option>'
            + '<option value="180" selected>Next 180 days</option>'
            + '<option value="365">Next 365 days</option>'
            + '</select>'
            + '</div>'
            + '<div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;">'
            + '<button id="rcCancel" style="padding:8px 14px;font-size:13px;border:1px solid var(--rule-soft,#ccc);background:transparent;color:var(--ink,#222);border-radius:4px;cursor:pointer;">'
            + 'Just apply this change'
            + '</button>'
            + '<button id="rcOk" style="padding:8px 16px;font-size:13px;background:var(--accent,#37e);color:#fff;border:0;border-radius:4px;cursor:pointer;font-weight:500;">'
            + 'Recompute'
            + '</button>'
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

// Set by the "Save & recompute" / "Approve & recompute" buttons immediately
// before their save runs, and consumed once by the next maybeOfferRecompute()
// call. When it's set the dialog is skipped — the admin already answered it
// by choosing which button to press. Surfaces that don't offer the pair
// (PTO list edits, LF sendouts, on-call) leave it null and still get asked.
//   null | { recompute: boolean, horizonDays: number }
let _pendingRecomputeChoice = null;

function setPendingRecomputeChoice(choice) {
    _pendingRecomputeChoice = choice || null;
}

// Wrapper used from save handlers: only offers recompute to admins, only
// when fromDate is today or later, then runs recomputeFutureSchedule().
async function maybeOfferRecompute(pinnedByDay, opts) {
    pinnedByDay = pinnedByDay || {};
    opts = opts || {};
    if (!isAdmin()) return;
    if (!opts.fromDate) return;
    // Don't rewrite history
    if (opts.fromDate.getTime() < today.getTime()) return;

    // Repair any "Bigs the day before WFH/PTO" conflict the change just
    // created (see backFixDayBefore). Runs before the recompute dialog so
    // the fix happens even when the admin picks "Just apply this change".
    // A recompute re-plans those days itself (with the lead-in), so it gets
    // only the caller's own pins, not the back-fix's repairs.
    const callerPins = JSON.parse(JSON.stringify(pinnedByDay));
    try {
        await backFixDayBefore(pinnedByDay, opts.fromDate);
    } catch (bfErr) {
        console.error('backFixDayBefore error:', bfErr);
    }

    let choice;
    if (_pendingRecomputeChoice) {
        // Answered up front by the button the admin pressed — consume it.
        choice = _pendingRecomputeChoice;
        _pendingRecomputeChoice = null;
    } else {
        try {
            choice = await showRecomputeDialog({ message: opts.message });
        } catch (err) {
            console.error('recompute dialog error', err);
            return;
        }
    }
    if (!choice || !choice.recompute) return;

    try {
        const res = await recomputeFutureSchedule(
            callerPins,
            Object.assign({}, opts, { horizonDays: choice.horizonDays })
        );
        const dayPart = res.dayBeforeProcessed ? ' (incl. day before)' : '';
        showToast('Future schedule recomputed: '
            + res.processed + ' day' + (res.processed === 1 ? '' : 's')
            + ' updated' + dayPart + '.');
        // ── Change log ──
        // Skip if nothing actually changed (no DB writes happened).
        if (res.processed > 0) {
            const fromKey = opts.fromDate ? fmt(opts.fromDate) : null;
            logChange(Object.assign({
                kind: 'recompute',
                type: 'recompute',
                source: 'recompute',
                fromDate: fromKey,
                horizonDays: choice.horizonDays,
                daysAffected: res.processed,
                dayBeforeProcessed: !!res.dayBeforeProcessed,
                startDate: res.firstChangedKey || null,
                endDate: res.lastChangedKey || null,
            }, _chgSummaryRecompute(res.processed, fromKey, !!res.dayBeforeProcessed,
                res.firstChangedKey, res.lastChangedKey)));
        }
    } catch (err) {
        console.error('recomputeFutureSchedule error', err);
        showToast('Recompute failed: ' + (err && err.message ? err.message : err), { type: 'error' });
    }
}

function _chgSummaryRecompute(processed, fromDateKey, dayBeforeProcessed, firstKey, lastKey) {
    const dayWord = processed === 1 ? 'day' : 'days';
    const tail = dayBeforeProcessed ? ' (incl. day before)' : '';
    // Prefer the actual changed-date range; fall back to the old "starting
    // <date>" phrasing if the range isn't available.
    if (firstKey && lastKey) {
        const whenBit = firstKey === lastKey
            ? `on ${_chgFmtDate(firstKey)}`
            : `from ${_chgFmtDate(firstKey)} to ${_chgFmtDate(lastKey)}`;
        return {
            summary: `Service schedule changed ${whenBit} — ${processed} ${dayWord} updated${tail}`,
        };
    }
    const fromBit = fromDateKey ? `, starting ${_chgFmtDate(fromDateKey)}` : '';
    return {
        summary: `Schedule recomputed — ${processed} ${dayWord} updated${tail}${fromBit}`,
    };
}

// ── Wire up the Recompute Schedule modal ──
document.getElementById('recomputeBtn').addEventListener('click', () => {
    if (!isAdmin()) {
        showToast('Only the admin can recompute the schedule.', { type: 'error' });
        return;
    }
    triggerManualRecompute();
});

// Visible sidebar entry point (admin-only; renderSidebar toggles visibility).
// Delegates to the #recomputeBtn proxy so the open logic stays in one place.
(function wireSidebarRecompute() {
    const btn = document.getElementById('sidebarRecomputeBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        document.getElementById('recomputeBtn').click();
    });
})();

// Mode toggle: switch between "from today" horizon and a custom date range
(function wireRecomputeModeToggle() {
    const modeHorizon = document.getElementById('rcModeHorizon');
    const modeRange = document.getElementById('rcModeRange');
    const horizonWrap = document.getElementById('rcHorizonWrap');
    const rangeWrap = document.getElementById('rcRangeWrap');
    const errEl = document.getElementById('rcRangeError');

    function syncMode() {
        const useRange = modeRange && modeRange.checked;
        if (horizonWrap) horizonWrap.style.display = useRange ? 'none' : '';
        if (rangeWrap) rangeWrap.style.display = useRange ? '' : 'none';
        if (errEl) errEl.style.display = 'none';
    }

    if (modeHorizon) modeHorizon.addEventListener('change', syncMode);
    if (modeRange) modeRange.addEventListener('change', syncMode);
})();

document.getElementById('rcCancelBtn').addEventListener('click', () => {
    document.getElementById('recomputeModalBack').classList.remove('open');
});
document.getElementById('recomputeModalBack').addEventListener('click', e => {
    if (e.target.id === 'recomputeModalBack') e.target.classList.remove('open');
});

document.getElementById('rcConfirmBtn').addEventListener('click', async () => {
    if (!isAdmin()) return;

    const useRange = document.getElementById('rcModeRange').checked;
    const errEl = document.getElementById('rcRangeError');

    let fromDate;
    let horizonDays;

    if (useRange) {
        const startStr = document.getElementById('rcStart').value;
        const endStr = document.getElementById('rcEnd').value;
        if (!startStr || !endStr) {
            errEl.textContent = 'Please pick both a start and end date.';
            errEl.style.display = '';
            return;
        }
        const start = parseDate(startStr);
        const end = parseDate(endStr);
        if (end.getTime() < start.getTime()) {
            errEl.textContent = 'End date must be on or after the start date.';
            errEl.style.display = '';
            return;
        }
        // Don't rewrite history — the optimizer skips earlier days anyway,
        // but warn the admin clearly so the result isn't surprising.
        if (start.getTime() < today.getTime()) {
            errEl.textContent = 'Start date can\u2019t be before today.';
            errEl.style.display = '';
            return;
        }
        fromDate = start;
        horizonDays = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
    } else {
        const sel = document.getElementById('rcHorizonSelect');
        horizonDays = parseInt(sel.value, 10) || 180;
        fromDate = new Date(today);
    }

    document.getElementById('recomputeModalBack').classList.remove('open');
    await _runManualRecompute(fromDate, horizonDays);
});