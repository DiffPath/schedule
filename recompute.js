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
//
// Globals this file reads from schedule.js:
//   state:    pathologists, vacations, requests, requestsReady,
//             serviceOverrides, serviceLocks, loggedInPathId, today, db
//   const:    SERVICE_BY_ID, EARLIEST_DATE
//   helpers:  isOffSiteServiceId, isBeforeEarliest, fmt, parseDate, addDays,
//             isWeekend, getFederalHoliday, prevWorkday, nextWorkday,
//             workdaysInCallCycle, getDayAssignments, isOnPto, isAdmin,
//             showToast, escapeHtml, logChange
// ════════════════════════════════════════════════════════════════════════

// ────────────── ROTATION OPTIMIZER (recompute future schedule) ──────────────
//
// After a service or PTO change, walk forward from opts.fromDate (default
// 180 calendar days) and, for each workday, write the {pid: serviceId}
// arrangement that:
//   1. covers the required services for that day's working count (red flag), then
//   2. honors any locked services (admin-pinned + previously-approved requests), then
//   3. minimizes the bigs-before-PTO/WFH violation count (soft 1), then
//   4. minimizes the maximum per-pathologist deviation from the natural
//      cyto → bigs → huntley → wfh rotation, then
//   5. minimizes the total deviation across all pathologists.
//
// Required services (mirrors coverageViolationsForDay):
//   2 working → Huntley + McH cyto/gross/bigs (combo)
//   3 working → Huntley + McH cyto/gross + McH bigs
//   4 working → Huntley + McH cyto/gross + McH bigs + Breast Bx/WFH
//   5+ working → as for 4, with extras on Breast Bx/WFH
//
// Score (lower wins, lexicographic — earlier components dominate):
//   vBigs    — bigs-before-PTO + bigs-before-WFH transitions (both directions)
//   maxSkip  — largest single-pathologist deviation in the day's effective cycle
//   totalSkip — sum of deviations across all pathologists
//
// Deviation is the MIN cyclical distance (forward or backward) between where
// a pathologist landed and where the rotation says they should be, measured
// in the day's effective cycle:
//   4+ paths → [cyto, bigs, huntley, wfh]   (length 4)
//   3 paths  → [cyto, bigs, huntley]        (length 3)
//   2 paths  → [cytobigs, huntley]          (length 2; cyto/bigs collapse)
// e.g. cyto→huntley = 2 on a 4-path day, but only 1 on a 3-path day, since
// in the 3-cycle they're adjacent going the other way around.
//
// pinnedByDay[dayKey] = {pid: serviceId} locks specific paths to specific
// services. Pins come from two sources, auto-merged on entry:
//   • Caller-supplied (the admin's just-made change) — these win on conflict.
//   • Approved-and-locked assignments from scheduler/serviceLocks (written
//     when the admin approves a service_change request, released only by an
//     explicit admin action). A locked assignment can't be moved by any
//     recompute — the optimizer rotates everyone else around it.
// Pins are honored even when they break coverage — the red-flag layer
// surfaces those cases for review.
//
// Idempotency: the optimizer is a fixed-point iteration over an in-memory
// snapshot. Each pass reads neighbour state from the snapshot (current pass's
// decisions) rather than from Firebase, and Firebase is only written at the
// end with days whose snapshot differs from the pre-recompute baseline.
// Re-running with no input change finds the same fixed point and writes
// nothing.
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
    // Walk forward through the universal 4-cycle looking for a service that
    // does exist in today's cycle. Bounded by 4 steps; one is guaranteed to
    // hit since dayCycle is non-empty and is a subset of the universal cycle.
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

// Score a {pid: serviceId} candidate as [vBigs, maxSkip, totalSkip].
//   vBigs  — bigs-before-PTO/WFH transitions touching this day (both directions).
//   maxSkip — largest min-cyclical deviation across pathologists.
//   totalSkip — sum of those deviations.
//
// prevAssign / nextAssign are getDayAssignments-shape maps for the adjacent
// workdays. The neighbour lookup in recomputeFutureSchedule pulls these from
// the iteration snapshot (not Firebase), which is what makes scoring stable
// across recompute runs.
function _scoreAssignment(candidate, prevAssign, nextAssign, dayCycle) {
    let vBigs = 0;
    let maxSkip = 0;
    let totalSkip = 0;
    for (const pid in candidate) {
        const sid = candidate[pid];
        if (!sid) continue;
        const isBigs = (sid === 'bigs' || sid === 'cytobigs');
        const isWfh = (sid === 'wfh');

        const next = nextAssign && (nextAssign[pid] || nextAssign[String(pid)]);
        const prev = prevAssign && (prevAssign[pid] || prevAssign[String(pid)]);
        const prevId = (prev && prev.type === 'service' && prev.service)
            ? prev.service.id : null;

        // No-bigs-before-PTO (forward). PTO is static across recomputes —
        // a path on PTO tomorrow stays on PTO tomorrow no matter what we
        // pick today — so this is a reliable component to score against.
        if (isBigs && next && next.type === 'pto') vBigs++;

        // No-bigs-before-WFH — BACKWARD ONLY.
        //
        // The natural way to state this rule is "today's path on bigs
        // should not be on wfh tomorrow", which suggests a forward check.
        // But the forward check reads tomorrow's service from nextAssign,
        // and on the first pass nextAssign reflects the pre-recompute
        // baseline (potentially the very broken state we're trying to
        // fix). That biases the optimizer into avoiding the bigs slot
        // today whenever the baseline happens to have wfh tomorrow for
        // the same path — which, in a broken-rotation baseline, is
        // exactly where rotation says bigs SHOULD go. The optimizer
        // settles on a stable-but-wrong fixed point: one path stuck on
        // bigs every day while the other three rotate around it.
        //
        // We catch the same violation from the wfh side instead. When
        // scoring a day where some path is on wfh and was on bigs the
        // previous workday (per prevAssign — the just-computed snapshot,
        // which IS reliable), vBigs goes up. The violation is still
        // detected; it just attaches to the wfh-day's score rather than
        // the bigs-day's. Both passes converge on the rotation-correct
        // arrangement now, because pass 1 isn't poisoned by stale
        // baseline lookups.
        if (isWfh && (prevId === 'bigs' || prevId === 'cytobigs')) vBigs++;

        // Deviation: where should this pathologist be today, given yesterday?
        // No yesterday-service (off, PTO, weekend, holiday) → no deviation
        // measurable; treat as 0 so we don't bias the choice.
        if (!prevId) continue;
        const expected = _nextInCycle(prevId);
        const expectedIdx = _expectedIdxInDayCycle(expected, dayCycle);
        const actualIdx = _dayCycleIndex(sid, dayCycle);
        const dist = _minCycleDist(actualIdx, expectedIdx, dayCycle.length);
        if (dist > maxSkip) maxSkip = dist;
        totalSkip += dist;
    }
    return [vBigs, maxSkip, totalSkip];
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
        const sid = overrideMap && (overrideMap[p.id] || overrideMap[String(p.id)]);

        if (sid && SERVICE_BY_ID[sid]) {
            if (isOffSiteServiceId(sid)) {
                // Off-site override: treated as absent for coverage purposes
                result[p.id] = { type: 'off_site', service: SERVICE_BY_ID[sid], onCall: false };
            } else {
                // Regular service override: on duty (overrides any PTO entry)
                result[p.id] = { type: 'service', service: SERVICE_BY_ID[sid], onCall: false };
            }
            return;
        }

        // No override from the recompute buffer — fall back to vacation PTO or off
        if (isOnPto(p.id, date)) {
            result[p.id] = { type: 'pto', service: null, onCall: false };
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

// Deep-equal helper for {pid: serviceId} maps. Used to detect whether the
// optimizer's snapshot for a day differs from the pre-recompute baseline,
// which is what gates the Firebase write. Object.keys handles numeric/string
// pid coercion cleanly.
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

// Compute the optimal full {pid: serviceId} map for `date`, honoring the
// supplied pins. Always returns the optimal arrangement (caller decides
// whether it differs from any baseline). Returns null only when the day
// has too few working pathologists or no required-service template.
function _computeOptimalDay(date, pins, prevAssign, nextAssign) {
    const assign = getDayAssignments(date);
    const working = pathologists.filter(p =>
        assign[p.id] && assign[p.id].type === 'service'
    );
    const n = working.length;
    if (n < 2) return null;
    const required = requiredServicesFor(n);
    if (!required) return null;
    const dayCycle = _dayCycleFor(n);
    if (!dayCycle) return null;

    const currentSvc = {};
    working.forEach(p => {
        currentSvc[p.id] = assign[p.id].service && assign[p.id].service.id;
    });

    // Honor pins; subtract pinned services from the required pool.
    const result = {};
    let remaining = required.slice();
    const unpinned = [];
    const pinnedPids = [];
    working.forEach(p => {
        const pinId = pins && (pins[p.id] || pins[String(p.id)]);
        if (pinId) {
            result[p.id] = pinId;
            pinnedPids.push(p.id);
        } else {
            unpinned.push(p.id);
        }
    });

    // ── Over-pinning safety net ─────────────────────────────────────────
    // If pins assign more paths to a service than `required` calls for
    // (e.g., two paths pinned to 'huntley' when only one is needed), demote
    // the excess pins back to unpinned so coverage rules can still be met.
    // Without this, the fallback branch below would happily leave the
    // duplicate pins in place and a different required service uncovered —
    // which is exactly the "two pathologists on Huntley, no Bigs" symptom.
    const requiredCount = {};
    required.forEach(sid => { requiredCount[sid] = (requiredCount[sid] || 0) + 1; });
    const pinnedByService = {};
    pinnedPids.forEach(pid => {
        const sid = result[pid];
        if (!pinnedByService[sid]) pinnedByService[sid] = [];
        pinnedByService[sid].push(pid);
    });
    for (const sid in pinnedByService) {
        const allowed = requiredCount[sid] || 0;
        // Off-required pins (sid not in required) are intentional admin
        // overrides — keep them and let the fallback branch below cope with
        // coverage best-effort. Only demote duplicates of in-required services.
        if (allowed === 0) continue;
        const pids = pinnedByService[sid];
        if (pids.length > allowed) {
            // Keep the first `allowed` pins for this service; demote the rest.
            // (Insertion order matches `working`, which matches `pathologists`.)
            for (let i = allowed; i < pids.length; i++) {
                delete result[pids[i]];
                unpinned.push(pids[i]);
            }
        }
    }

    // Rebuild `remaining` from the (possibly demoted) kept pins.
    remaining = required.slice();
    for (const pid in result) {
        const idx = remaining.indexOf(result[pid]);
        if (idx >= 0) remaining.splice(idx, 1);
    }

    // ── Assign the rest ─────────────────────────────────────────────────
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
        // pick the arrangement with the best (vBigs, maxSkip, totalSkip)
        // score. With at most 4 unpinned slots that's at most 24 perms.
        let bestPerm = null;
        let bestScore = null;
        const perms = _allPermutations(remaining);
        for (const perm of perms) {
            const cand = Object.assign({}, result);
            for (let i = 0; i < unpinned.length; i++) {
                cand[unpinned[i]] = perm[i];
            }
            const score = _scoreAssignment(cand, prevAssign, nextAssign, dayCycle);
            if (!bestScore || _compareScores(score, bestScore) < 0) {
                bestScore = score;
                bestPerm = cand;
            }
        }
        if (bestPerm) {
            for (const pid in bestPerm) result[pid] = bestPerm[pid];
        }
    }

    // Drop unassigned paths (only when pins overconstrain).
    const clean = {};
    let count = 0;
    for (const pid in result) {
        if (result[pid]) { clean[pid] = result[pid]; count++; }
    }
    return count > 0 ? clean : null;
}

// Build pin entries from the serviceLocks store (scheduler/serviceLocks).
//
// History
// -------
// An earlier version pinned from the approved-request LOG itself: every
// approved service_change inside the recompute window became a hard lock.
// That caused stacked week-scope approvals to permanently pin one
// pathologist to one service for weeks (the "Michael Moravek on M Bigs for
// six straight weeks" symptom), because stale approvals could never be
// released — the log is immutable.
//
// Current contract
// ----------------
// Locks now live in a dedicated, explicitly-managed store:
//   scheduler/serviceLocks/{dayKey}/{pathId} = serviceId
// written when the admin APPROVES a service_change request, and released
// when the admin explicitly edits/clears that slot, resets the day,
// approves PTO on top, revokes the approval, or clicks "Unlock" in the
// day-detail quick panel. Locked slots render with a glow on the schedule,
// so — unlike the old log-derived pins — they are always visible and
// always releasable.
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
    // Returning ALL locks (not just the window) is safe: recomputeFutureSchedule
    // only visits days inside its window, so extra keys are simply never read.
    // This also covers the day-before-fromDate pass without window math.
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
    // Lock pins (approved-and-locked assignments from scheduler/serviceLocks)
    // enforce the "approved = locked" rule across the whole window, even for
    // approvals from prior sessions. Caller-supplied pins (the admin's
    // just-made change) win on direct conflict at the same {date, pid} —
    // by the time a caller pin conflicts with a lock, the save handler has
    // already released that lock in Firebase anyway.
    const lockPins = _pinsFromServiceLocks();
    const mergedPins = {};
    for (const k in lockPins) {
        mergedPins[k] = Object.assign({}, lockPins[k]);
    }
    for (const k in pinnedByDay) {
        if (!pinnedByDay[k]) continue;
        mergedPins[k] = Object.assign(mergedPins[k] || {}, pinnedByDay[k]);
    }

    // ── Build the workday list ──────────────────────────────────────────
    const workdays = [];
    for (let i = 0; i < horizonDays; i++) {
        const d = addDays(fromDate, i);
        if (isBeforeEarliest(d)) continue;
        if (isWeekend(d)) continue;
        if (getFederalHoliday(d)) continue;
        workdays.push(d);
    }

    // The day before fromDate, if eligible, is appended at the END of each
    // pass so it sees fromDate's already-decided state as its nextAssign.
    let prevWd = null;
    if (dayBeforeFix) {
        const p = prevWorkday(fromDate);
        if (!isBeforeEarliest(p) && !isWeekend(p) && !getFederalHoliday(p)) {
            prevWd = p;
        }
    }

    // ── Baseline + snapshot ─────────────────────────────────────────────
    // baseline[k] = {pid: serviceId} for the day's working pathologists,
    // captured from Firebase BEFORE any optimization. The Firebase write
    // at the end is filtered to days where snapshot[k] differs from
    // baseline[k] — so an idempotent recompute writes nothing.
    //
    // snapshot[k] = the optimizer's running decision for day k. Days with
    // no entry fall back to baseline for neighbour lookups.
    const baseline = {};
    const snapshot = {};

    function baselineFor(d) {
        const k = fmt(d);
        if (baseline.hasOwnProperty(k)) return baseline[k];
        const a = getDayAssignments(d);
        const m = {};
        pathologists.forEach(p => {
            if (a[p.id] && a[p.id].type === 'service' && a[p.id].service) {
                m[p.id] = a[p.id].service.id;
            }
        });
        baseline[k] = m;
        return m;
    }

    function neighbourAssign(d) {
        const k = fmt(d);
        if (snapshot[k]) return _synthesizeAssign(d, snapshot[k]);
        return getDayAssignments(d);
    }

    // ── Fixed-point iteration ───────────────────────────────────────────
    // Each pass walks workdays forward (then prevWd at the end). When a
    // pass produces no changes to the snapshot, we've converged. In
    // practice this takes 2 passes: one to decide, one to confirm.
    // MAX_ITER is a safety cap; with these scoring rules and 4 paths
    // there's no oscillation path I can construct, but the cap prevents
    // any pathological case from spinning forever.
    const MAX_ITER = 8;
    let iter = 0;
    while (iter < MAX_ITER) {
        iter++;
        let changedThisPass = false;

        const order = prevWd ? workdays.concat([prevWd]) : workdays.slice();
        for (const d of order) {
            const k = fmt(d);
            const prevA = neighbourAssign(prevWorkday(d));
            const nextA = neighbourAssign(nextWorkday(d));
            const optimal = _computeOptimalDay(
                d, mergedPins[k] || null, prevA, nextA);
            if (!optimal) continue;
            // Ensure baseline is captured before we overwrite snapshot,
            // so the final write-decision comparison is against the true
            // pre-recompute state.
            baselineFor(d);
            const prior = snapshot[k] || baseline[k];
            if (!_sameServiceMap(prior, optimal)) {
                snapshot[k] = optimal;
                changedThisPass = true;
            } else if (!snapshot[k]) {
                // First time we visit this day and it already matches the
                // baseline — record an explicit no-op snapshot so future
                // passes use this day's optimal as a stable neighbour.
                snapshot[k] = optimal;
            }
        }

        if (!changedThisPass) break;
    }

    // ── Compute writes (only days where snapshot ≠ baseline) ────────────
    const writes = {};
    let processed = 0;
    let dayBeforeProcessed = false;
    for (const k in snapshot) {
        const base = baseline[k] || {};
        if (_sameServiceMap(snapshot[k], base)) continue;
        // The snapshot only covers WORKING pathologists (the optimizer never
        // considers anyone else), but the day's override map in Firebase may
        // also hold entries for non-working paths — off-site overrides like
        // Director Retreat / Lab Inspection / Off Service (possibly locked
        // via an approved request). Writing the snapshot wholesale would
        // silently wipe those, so merge them back in before writing.
        const dbDay = (typeof serviceOverrides === 'object' && serviceOverrides && serviceOverrides[k]) || {};
        const preserved = {};
        for (const pid in dbDay) {
            if (!(pid in snapshot[k])) preserved[pid] = dbDay[pid];
        }
        writes['scheduler/serviceOverrides/' + k] =
            Object.assign({}, preserved, snapshot[k]);
        processed++;
        if (prevWd && k === fmt(prevWd)) dayBeforeProcessed = true;
    }

    if (Object.keys(writes).length > 0) {
        await db.ref().update(writes);
    }
    return { processed: processed, dayBeforeProcessed: dayBeforeProcessed };
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
            }, _chgSummaryRecompute(res.processed, fromKey, !!res.dayBeforeProcessed)));
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
            }, _chgSummaryRecompute(res.processed, fromKey, !!res.dayBeforeProcessed)));
        }
    } catch (err) {
        console.error('recomputeFutureSchedule error', err);
        showToast('Recompute failed: ' + (err && err.message ? err.message : err), { type: 'error' });
    }
}

function _chgSummaryRecompute(processed, fromDateKey, dayBeforeProcessed) {
    const dayWord = processed === 1 ? 'day' : 'days';
    const tail = dayBeforeProcessed ? ' (incl. day before)' : '';
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
