// Injected into schedule-mock.html by generate.js; uses the app's globals.
// Builds "same change, several possible outcomes" situations and the raw
// feature vector of every outcome, for the preference trainer.

const TUNE_HORIZON = 120;       // calendar days re-planned after the change
const TUNE_SHOW_AFTER = 30;     // workdays shown after the change
const TUNE_SHOW_BEFORE = 7;     // workdays shown before the change

function _tIsWd(d) { return !isWeekend(d) && !getFederalHoliday(d) && !isBeforeEarliest(d); }
function _tRng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function _tNth(from, n) { let d = _tIsWd(from) ? new Date(from) : nextWorkday(from); for (let i = 0; i < n; i++) d = nextWorkday(d); return d; }
function _tBack(from, n) { let d = new Date(from); for (let i = 0; i < n; i++) d = prevWorkday(d); return d; }

async function _tReset() {
    await db.ref('scheduler/serviceOverrides').remove();
    await db.ref('scheduler/serviceLocks').remove();
    await db.ref('scheduler/vacations').remove();
    clearDayCache();
}
// Scenarios generated before spec.v = 2 skipped the override clearing the
// app does when PTO is added, so on days with saved assignments the new
// PTO never showed. Answers to those scenarios are still valid for the
// world that was shown, so it's reproduced exactly for them.
let _tLegacy = false;
let _tFrom = null;   // change day of the situation last set up
async function _tPto(pid, start, end) {
    const ref = db.ref('scheduler/vacations').push();
    await ref.set({ pathologistId: pid, start: fmt(start), end: fmt(end) });
    // Same as savePtoFromModal: strip regular overrides so the PTO shows.
    if (!_tLegacy) await clearConflictingServiceOverridesForPto(pid, fmt(start), fmt(end));
    clearDayCache();
    return ref.key;
}
async function _tLock(pid, d, sid) {
    const k = fmt(d);
    await db.ref('scheduler/serviceOverrides/' + k + '/' + pid).set(sid);
    await db.ref('scheduler/serviceLocks/' + k + '/' + pid).set(sid);
    clearDayCache();
}
function _tSvc(d, pid) {
    const a = getDayAssignments(d)[pid];
    if (!a) return null;
    if (a.type === 'service' && a.service) return a.service.id;
    return a.type;   // 'pto' | 'off' | 'off_site'
}

// What the schedule shows for each workday in [from, to].
function _tSnapshot(from, to) {
    const out = {};
    for (let d = new Date(from); d <= to; d = addDays(d, 1)) {
        if (!_tIsWd(d)) continue;
        const m = {};
        pathologists.forEach(p => { m[p.id] = _tSvc(d, p.id); });
        out[fmt(d)] = m;
    }
    return out;
}

// Mirror of recomputeFutureSchedule's window + pin handling.
function _tProblem(fromDate, callerPins, leadIn) {
    const lockPins = _pinsFromServiceLocks();
    const merged = {};
    for (const k in lockPins) merged[k] = Object.assign({}, lockPins[k]);
    for (const k in callerPins) merged[k] = Object.assign(merged[k] || {}, callerPins[k]);
    const workdays = [];
    let d = prevWorkday(fromDate);
    for (let i = 0; i < leadIn; i++) {
        if (d.getTime() < today.getTime()) break;
        workdays.unshift(d);
        d = prevWorkday(d);
    }
    for (let i = 0; i < TUNE_HORIZON; i++) {
        const x = addDays(fromDate, i);
        if (_tIsWd(x)) workdays.push(x);
    }
    return _rcBuildProblem(workdays, merged);
}

// Optimize exactly like recomputeFutureSchedule (incl. fixed-point passes).
function _tSolve(prob) {
    if (prob.fromT !== undefined) {
        // Edit problems: exactly what a recompute does (recompute.js _rcSolve).
        const plan = _rcSolve(prob, prob.fromT, RC_STABLE_WORKDAYS, false);
        prob.days.forEach(day => { if (day.variable) { delete day.stabScale; _rcSetReference(day, day.baseline); } });
        return plan;
    }
    let plan = _rcOptimize(prob);
    for (let pass = 0; pass < 4; pass++) {
        prob.days.forEach((day, t) => {
            if (!day.variable) return;
            const m = {};
            day.states[plan[t]].forEach((s, j) => { m[day.pids[j]] = s; });
            _rcSetReference(day, m);
        });
        const next = _rcOptimize(prob);
        if (next.every((s, t) => s === plan[t])) break;
        plan = next;
    }
    // Restore the stability reference to what's shown now.
    prob.days.forEach(day => { if (day.variable) _rcSetReference(day, day.baseline); });
    return plan;
}

// plan (state indices) → {dayKey: {pid: sid}} over variable days.
function _tPlanMap(prob, plan) {
    const out = {};
    prob.days.forEach((day, t) => {
        if (!day.variable) return;
        const m = {};
        day.states[plan[t]].forEach((s, j) => { m[day.pids[j]] = s; });
        out[day.key] = m;
    });
    return out;
}

// Map a {dayKey: {pid: sid}} plan onto `prob`'s state indices; days the map
// doesn't cover keep what's shown now. null if some day isn't a candidate.
function _tPlanIdx(prob, map, lenient) {
    const plan = [];
    for (const day of prob.days) {
        const m = (day.variable && map[day.key]) || day.baseline;
        const i = day.states.findIndex(st => st.every((s, j) => s === m[day.pids[j]]));
        if (i < 0) {
            if (!day.variable || (lenient && !map[day.key])) { plan.push(0); continue; }
            return null;
        }
        plan.push(i);
    }
    return plan;
}

// Raw (unweighted) features of a plan. The first block is exactly the
// optimizer's objective split by term (Σ RC_WEIGHTS·f reproduces its
// total); the rest are candidate terms the objective doesn't have yet.
function _tFeatures(prob, plan, ctx) {
    const days = prob.days, T = days.length, nP = prob.nP;
    const f = {
        ptoMulti: 0, ptoSingle: 0, bbWfh: 0,
        fair_cyto: 0, fair_bigs: 0, fair_huntley: 0, fair_wfh: 0,
        fri: 0, rotation: 0, streak: 0, stability: 0, templateDrift: 0,
        // candidates
        tmplSlots: 0, changedVsBefore: 0, changedDays: 0, peopleAffected: 0,
        spreadWorkdays: 0, leadInChanges: 0, repeats: 0, rotBigJumps: 0,
        wfhSpread: 0, huntSpread: 0, desirSpread: 0,
        fair90_wfh: 0, fair98_wfh: 0, fair90_all: 0, fair98_all: 0,
        // from the admin's notes (round 1)
        cytoBeforePto: 0,   // Cyto/Gross the workday before PTO (Huntley/WFH preferred)
        wfhRepeat: 0,       // WFH two workdays running
        wfhRepeatAll: 0,    //   … incl. history/boundary edges (what the optimizer sums)
        tmplWfhDev: 0,      // Σ_person (WFH worked − WFH the default rotation gives on their worked days)²
        tmplHunDev: 0,      //   … same for Huntley
        tmplDesirDev: 0,    //   … same for desirability score
        // from the admin's round-3 notes
        othersLoss: 0,      // Σ over people who didn't ask: (desirability shortfall vs their rotation)²
        changerGain: 0,     // Σ over the requester/PTO taker: (desirability surplus vs their rotation)²
        friAfterPto: 0,     // Friday Bigs the day back from PTO
        friNoMchBefore: 0,  // Friday Bigs holder not at McHenry the workday before
        othersLossB: 0,     // othersLoss / changerGain vs the pre-change schedule
        changerGainB: 0,
    };
    const tdev = {};
    pathologists.forEach(p => { tdev[p.id] = { w: 0, h: 0, s: 0, b: 0 }; });
    const affected = new Set();
    let lastChangeT = -1;
    const cnt = {};
    pathologists.forEach(p => { cnt[p.id] = { wfh: 0, huntley: 0, score: 0, exp: 0, expW: 0, expH: 0 }; });
    const SCORE = { wfh: 3, huntley: 2, bigs: 1, cyto: 0, cytobigs: 0 };
    const fromT = days.findIndex(d => d.key === ctx.fromKey);
    // Edit mode: change/drift/count terms only inside the admin's two weeks
    // (past it the plan is an implied continuation, not a choice), and no
    // seam with the fixed day after the extension.
    const edit = days.some(d => d.inWin);
    const inScope = day => day.variable && (!edit || day.inWin);
    const seam = t => edit && t === T - 1 && !days[t].variable;

    for (let t = 0; t < T; t++) {
        const day = days[t], st = day.states[plan[t]];
        if (seam(t)) continue;
        st.forEach((s, j) => {
            if (_rcIsBigs(s) && day.ptoRun[j] > 0) {
                if (day.ptoRun[j] === 2) f.ptoMulti++; else f.ptoSingle++;
            }
            if (day.variable && s === 'cyto' && day.ptoRun[j] > 0) f.cytoBeforePto++;
            if (inScope(day)) {
                const d = tdev[day.pids[j]], tm = defaultServiceId(day.pids[j], day.date);
                d.w += (s === 'wfh') - (tm === 'wfh');
                d.h += (s === 'huntley') - (tm === 'huntley');
                d.s += (SCORE[s] || 0) - (SCORE[tm] || 0);
                const bs = (ctx.before[day.key] || {})[day.pids[j]];
                d.b += (SCORE[s] || 0) - (SCORE[bs] || 0);
            }
        });
        if (inScope(day)) {
            let dayChanged = false;
            const before = ctx.before[day.key] || {};
            const tot = st.reduce((x, s) => x + (SCORE[s] || 0), 0);
            const wfhN = st.filter(s => s === 'wfh').length, hunN = st.filter(s => s === 'huntley').length;
            st.forEach((s, j) => {
                const pid = day.pids[j];
                if (s !== day.baseline[pid]) f.stability++;
                if (day.cycle) {
                    const dist = _minCycleDist(_dayCycleIndex(s, day.cycle), day.tmplIdx[j], day.cycle.length);
                    f.templateDrift += dist * dist;
                    if (dist) f.tmplSlots++;
                }
                const b = before[pid];
                if (b && b !== s && SERVICE_BY_ID[b] && !isOffSiteServiceId(b)) {
                    f.changedVsBefore++;
                    dayChanged = true;
                    affected.add(pid);
                    if (t < fromT) f.leadInChanges++;
                }
                const c = cnt[pid];
                if (s === 'wfh') c.wfh++;
                if (s === 'huntley') c.huntley++;
                c.score += SCORE[s] || 0;
                c.exp += tot / st.length; c.expW += wfhN / st.length; c.expH += hunN / st.length;
            });
            if (dayChanged) { f.changedDays++; lastChangeT = t; }
        }
        if (t > 0) {
            const a = days[t - 1], sa = a.states[plan[t - 1]];
            st.forEach((s, j) => {
                const pj = day.prevJ[j];
                if (pj < 0) return;
                const prev = sa[pj];
                if (_rcIsBigs(prev) && s === 'wfh') f.bbWfh++;
                if (day.cycle) {
                    let exp = prev;
                    for (let i = 0; i < day.steps && exp; i++) exp = _nextInCycle(exp);
                    const e = _expectedIdxInDayCycle(exp, day.cycle);
                    const dist = _minCycleDist(_dayCycleIndex(s, day.cycle), e, day.cycle.length);
                    f.rotation += dist * dist;
                    if (day.variable && dist >= 2) f.rotBigJumps++;
                }
                if (day.variable && prev === s) f.repeats++;
                if (day.variable && prev === 'wfh' && s === 'wfh') f.wfhRepeat++;
                if (prev === 'wfh' && s === 'wfh') f.wfhRepeatAll++;
            });
            if (inScope(day) && day.isFri) {
                st.forEach((s, j) => {
                    if (!_rcIsBigs(s)) return;
                    const pj = day.prevJ[j];
                    if (pj < 0) { if (!isWeekend(prevWorkday(day.date))) f.friAfterPto++; return; }
                    const prev = sa[pj];
                    if (!(prev === 'cyto' || _rcIsBigs(prev))) f.friNoMchBefore++;
                });
            }
        }
        if (t > 1) {
            let m = days[t - 2].mch[plan[t - 2]] & days[t - 1].mch[plan[t - 1]] & day.mch[plan[t]];
            while (m) { m &= m - 1; f.streak++; }
        }
    }
    if (lastChangeT >= 0 && fromT >= 0) f.spreadWorkdays = Math.max(0, lastChangeT - fromT);
    f.peopleAffected = affected.size;
    Object.values(tdev).forEach(d => { f.tmplWfhDev += d.w * d.w; f.tmplHunDev += d.h * d.h; f.tmplDesirDev += d.s * d.s; });
    const ch = (ctx.changers || []).map(String);
    Object.keys(tdev).forEach(pid => {
        const s = tdev[pid].s;
        if (ch.includes(String(pid))) { if (s > 0) f.changerGain += s * s; }
        else if (s < 0) f.othersLoss += s * s;
        const b = tdev[pid].b;
        if (ch.includes(String(pid))) { if (b > 0) f.changerGainB += b * b; }
        else if (b < 0) f.othersLossB += b * b;
    });

    // Fairness: D(t) = λ·D(t−1) + worked − share, penalty Σ_counted D².
    const fairFor = lam => {
        const out = [0, 0, 0, 0];
        for (let k = 0; k < nP * 4; k++) {
            let acc = 0;
            for (let t = 0; t < T; t++) {
                acc = acc * lam + days[t].vec[plan[t]][k] - days[t].share[k];
                if (days[t].counted) out[k % 4] += acc * acc;
            }
        }
        return out;
    };
    const f95 = fairFor(RC_FAIR_DECAY);
    [f.fair_cyto, f.fair_bigs, f.fair_huntley, f.fair_wfh] = f95;
    const f90 = fairFor(0.9), f98 = fairFor(0.98);
    f.fair90_wfh = f90[3]; f.fair98_wfh = f98[3];
    const wsum = a => a[0] * 0.6 + a[1] * 0.6 + a[2] + a[3] * 2;
    f.fair90_all = wsum(f90); f.fair98_all = wsum(f98);

    // Friday Bigs per academic year.
    const F = Float64Array.from(prob.fri.F0);
    for (let t = 0; t < T; t++) {
        const h = days[t].friHolder[plan[t]];
        if (h >= 0) F[days[t].fy + h]++;
    }
    for (let i = 0; i < F.length; i++) { const dv = F[i] - prob.fri.S[i]; f.fri += dv * dv; }

    // Window spreads (max − min of worked − fair share).
    const spread = key => {
        const v = Object.values(cnt).filter(c => c.exp > 0).map(key);
        return v.length ? Math.max(...v) - Math.min(...v) : 0;
    };
    f.wfhSpread = spread(c => c.wfh - c.expW);
    f.huntSpread = spread(c => c.huntley - c.expH);
    f.desirSpread = spread(c => c.score - c.exp);
    for (const k in f) f[k] = Math.round(f[k] * 1000) / 1000;
    return f;
}

// Weighted objective from features — must equal _rcOptimize's total().
function _tWeighted(f, W) {
    return W.bigsBeforeMultiPto * f.ptoMulti + W.bigsBeforeSinglePto * f.ptoSingle
        + W.bigsBeforeWfh * f.bbWfh
        + W.fair.cyto * f.fair_cyto + W.fair.bigs * f.fair_bigs
        + W.fair.huntley * f.fair_huntley + W.fair.wfh * f.fair_wfh
        + W.fridayBigs * f.fri + W.rotation * f.rotation + W.mchStreak * f.streak
        + W.stability * f.stability + (W.templateDrift || 0) * f.templateDrift
        + (W.tmplDesir || 0) * f.tmplDesirDev + (W.wfhRepeat || 0) * f.wfhRepeatAll
        + (W.cytoBeforePto || 0) * f.cytoBeforePto;
}

const TUNE_BASE_W = JSON.parse(JSON.stringify(RC_WEIGHTS));

// The recompute every scenario so far was generated with (pre-tuning live
// weights and behavior). _tSetup replays background recomputes with it so
// scenarios rebuild exactly as the admin saw them, whatever the live
// weights are now.
const TUNE_LEGACY_W = {
    bigsBeforeMultiPto: 1000, bigsBeforeWfh: 300, bigsBeforeSinglePto: 60,
    fair: { cyto: 0.6, bigs: 0.6, huntley: 1.0, wfh: 2.0 },
    fridayBigs: 1.0, rotation: 1.0, mchStreak: 4.0, stability: 0.02,
    templateDrift: 0, tmplDesir: 0, wfhRepeat: 0, cytoBeforePto: 0, sameServiceRepeat: 0,
    rotationJump: 0, friBigsNoMchBefore: 0, friBigsAfterPto: 0, requesterGain: 0, othersLoss: 0,
};
async function _tLegacyRecompute(fromDate, horizonDays) {
    const saved = JSON.parse(JSON.stringify(RC_WEIGHTS));
    for (const k in RC_WEIGHTS) delete RC_WEIGHTS[k];
    Object.assign(RC_WEIGHTS, JSON.parse(JSON.stringify(TUNE_LEGACY_W)));
    try {
        await recomputeFutureSchedule({}, { fromDate, horizonDays, dayBeforeFix: false, stableWorkdays: Infinity, keepSeam: true });
    } finally {
        for (const k in RC_WEIGHTS) delete RC_WEIGHTS[k];
        Object.assign(RC_WEIGHTS, saved);
    }
}
function _tSetW(over) {
    const w = JSON.parse(JSON.stringify(TUNE_BASE_W));
    for (const k in over) {
        if (k === 'fairScale') { for (const c in w.fair) w.fair[c] *= over[k]; }
        else if (k.startsWith('fair.')) w.fair[k.slice(5)] = over[k];
        else w[k] = over[k];
    }
    for (const k in RC_WEIGHTS) delete RC_WEIGHTS[k];
    Object.assign(RC_WEIGHTS, w);
}

// Weight variants that produce the candidate pool.
const TUNE_VARIANTS = [
    ['current', {}],
    ['fair×0.2', { fairScale: 0.2 }], ['fair×5', { fairScale: 5 }],
    ['wfhFair×0.2', { 'fair.wfh': 0.4 }], ['wfhFair×5', { 'fair.wfh': 10 }],
    ['fri×0', { fridayBigs: 0 }], ['fri×5', { fridayBigs: 5 }],
    ['rot×0.3', { rotation: 0.3 }], ['rot×4', { rotation: 4 }],
    ['streak×0', { mchStreak: 0 }], ['streak×4', { mchStreak: 16 }],
    ['stab×25', { stability: 0.5 }], ['stab×100', { stability: 2 }],
    ['tmpl1', { templateDrift: 1 }], ['tmpl4', { templateDrift: 4 }],
    ['tmpl1+stab', { templateDrift: 1, stability: 0.5 }],
    ['bbPtoSingle×0.3', { bigsBeforeSinglePto: 18 }],
    ['leadIn1', {}, 1], ['leadIn10', {}, 10],
];

// Build one situation. spec: { id, seed, kind, bg }
async function tuneSituation(spec) {
    const { r, from, pins, desc, marks, before } = await _tSetup(spec);
    const fromKey = fmt(from);
    return _tCandidates(spec, r, from, fromKey, pins, desc, marks, before);
}

// Recreate a situation from its spec (deterministic: same seed, same
// schedule) and apply the change. Leaves the app state post-change.
async function _tSetup(spec) {
    _tLegacy = !(spec.v >= 2);
    const r = _tRng(spec.seed);
    const ids = pathologists.map(p => p.id);
    const pick = arr => arr[Math.floor(r() * arr.length)];
    await _tReset();
    const T0 = new Date(today);

    // Background: other people's PTO, already settled by a recompute, so
    // "before" is a realistic already-optimized schedule.
    let bgNote = [];
    if (spec.bg) {
        for (let i = 0; i < 3; i++) {
            const pid = pick(ids);
            const s = _tNth(T0, 3 + Math.floor(r() * 45));
            const len = pick([1, 1, 2, 3, 5]);
            await _tPto(pid, s, addDays(s, len - 1));
            bgNote.push(pid);
        }
        await _tLegacyRecompute(T0, 150);
        clearDayCache();
    }

    // The change.
    let from = _tNth(T0, 8 + Math.floor(r() * 25));
    const who = pick(ids);
    const changers = [who];   // who asked for the change (PTO, request, cancellation)
    const pins = {};
    let desc = '', marks = {};   // marks[dayKey][pid] = 'pto' | 'pin' | 'back'
    const mark = (d, pid, m) => { const k = fmt(d); (marks[k] = marks[k] || {})[pid] = m; };
    const name = pid => pathologists.find(p => p.id === pid).name.replace(/^Dr\. \S+ /, '');
    const dname = d => DOW[d.getDay()] + ' ' + MONTHS_SHORT[d.getMonth()] + ' ' + d.getDate();
    const ptoRange = (pid, s, e) => { for (let d = new Date(s); d <= e; d = addDays(d, 1)) if (_tIsWd(d)) mark(d, pid, 'pto'); };
    let before = null;
    const snapBefore = () => { before = _tSnapshot(_tBack(from, TUNE_SHOW_BEFORE + 12), addDays(from, TUNE_HORIZON + 10)); };

    switch (spec.kind) {
        case 'pto1': {
            snapBefore();
            await _tPto(who, from, from); ptoRange(who, from, from);
            desc = name(who) + ' takes PTO ' + dname(from);
            break;
        }
        case 'ptoFri': {
            while (from.getDay() !== 5 || !_tIsWd(from)) from = nextWorkday(from);
            snapBefore();
            await _tPto(who, from, from); ptoRange(who, from, from);
            desc = name(who) + ' takes PTO Friday ' + dname(from);
            break;
        }
        case 'ptoThuFri': case 'ptoFriMon': {
            const dow = spec.kind === 'ptoThuFri' ? 4 : 5;
            while (from.getDay() !== dow || !_tIsWd(from)) from = nextWorkday(from);
            const end = spec.kind === 'ptoThuFri' ? addDays(from, 1) : addDays(from, 3);
            snapBefore();
            await _tPto(who, from, end); ptoRange(who, from, end);
            desc = name(who) + ' takes PTO ' + dname(from) + ' – ' + dname(end);
            break;
        }
        case 'ptoWeek': case 'pto2Week': {
            while (from.getDay() !== 1) from = addDays(from, 1);
            const end = addDays(from, spec.kind === 'ptoWeek' ? 4 : 11);
            snapBefore();
            await _tPto(who, from, end); ptoRange(who, from, end);
            desc = name(who) + ' takes PTO ' + dname(from) + ' – ' + dname(end);
            break;
        }
        case 'ptoTwo': {
            const who2 = pick(ids.filter(x => x !== who));
            changers.push(who2);
            const wd = d => { let x = new Date(d); while (!_tIsWd(x)) x = addDays(x, -1); return x; };
            const e1 = wd(addDays(from, 2 + Math.floor(r() * 3)));
            const s2 = nextWorkday(from), e2 = wd(addDays(s2, 1 + Math.floor(r() * 3)));
            snapBefore();
            await _tPto(who, from, e1); ptoRange(who, from, e1);
            await _tPto(who2, s2, e2); ptoRange(who2, s2, e2);
            desc = name(who) + ' PTO ' + dname(from) + ' – ' + dname(e1) + ', and ' + name(who2) + ' PTO ' + dname(s2) + ' – ' + dname(e2);
            break;
        }
        case 'ptoHoliday': {
            // A week of PTO over Thanksgiving or Christmas.
            const hol = pick([new Date(2026, 10, 23), new Date(2026, 11, 21), new Date(2026, 11, 28)]);
            from = hol;
            const end = addDays(hol, 4);
            snapBefore();
            await _tPto(who, from, end); ptoRange(who, from, end);
            desc = name(who) + ' takes PTO the holiday week ' + dname(from) + ' – ' + dname(end);
            break;
        }
        case 'lockWfh': case 'lockHuntley': {
            const sid = spec.kind === 'lockWfh' ? 'wfh' : 'huntley';
            let guard = 0;
            while ((_tSvc(from, who) === sid || !SERVICE_BY_ID[_tSvc(from, who)]) && guard++ < 10) from = nextWorkday(from);
            snapBefore();
            await _tLock(who, from, sid); mark(from, who, 'pin');
            pins[fmt(from)] = { [who]: sid };
            desc = name(who) + ' requests ' + SERVICE_BY_ID[sid].name + ' on ' + dname(from) + ' (was ' + SERVICE_BY_ID[before[fmt(from)][who]].name + ')';
            break;
        }
        case 'lockWeek': {
            while (from.getDay() !== 1) from = addDays(from, 1);
            const sid = pick(['huntley', 'cyto', 'bigs']);
            snapBefore();
            for (let d = new Date(from); d <= addDays(from, 4); d = addDays(d, 1)) {
                if (!_tIsWd(d)) continue;
                await _tLock(who, d, sid); mark(d, who, 'pin');
                pins[fmt(d)] = { [who]: sid };
            }
            desc = name(who) + ' requests ' + SERVICE_BY_ID[sid].name + ' all week of ' + dname(from);
            break;
        }
        case 'ptoRemove': {
            // Existing 3-day PTO (already settled), then it's cancelled.
            const end = addDays(from, 2);
            const key = await _tPto(who, from, end);
            await _tLegacyRecompute(T0, 150);
            clearDayCache();
            snapBefore();
            await db.ref('scheduler/vacations/' + key).remove();
            clearDayCache();
            for (let d = new Date(from); d <= end; d = addDays(d, 1)) if (_tIsWd(d)) mark(d, who, 'back');
            desc = name(who) + ' cancels PTO ' + dname(from) + ' – ' + dname(end) + ' (now working those days)';
            break;
        }
    }
    clearDayCache();
    _tFrom = from;
    return { r, from, pins, desc, marks, before, changers };
}

function _tCandidates(spec, r, from, fromKey, pins, desc, marks, before) {
    // Candidate outcomes.
    const refProb = (() => { _tSetW({}); return _tProblem(from, pins, RC_LEAD_IN_WORKDAYS); })();
    const ctx = { before, fromKey };
    const cands = [];
    const seen = new Map();
    const add = (label, map) => {
        const plan = _tPlanIdx(refProb, map);
        if (!plan) return;
        const sig = plan.join(',');
        if (seen.has(sig)) { seen.get(sig).labels.push(label); return; }
        const c = { labels: [label], map: _tPlanMap(refProb, plan), plan: plan };
        seen.set(sig, c);
        cands.push(c);
    };
    for (const [label, over, lead] of TUNE_VARIANTS) {
        _tSetW(over);
        const prob = _tProblem(from, pins, lead === undefined ? RC_LEAD_IN_WORKDAYS : lead);
        add(label, _tPlanMap(prob, _tSolve(prob)));
    }
    _tSetW({});
    // "Just apply this change" (no recompute): what renders right now.
    add('noRecompute', Object.fromEntries(refProb.days.filter(d => d.variable).map(d => [d.key, d.baseline])));
    // Local perturbations of the current optimum: swap two free people on
    // one day near the change.
    const cur = cands[0];
    if (cur) {
        const vIdx = refProb.days.map((d, t) => t).filter(t => refProb.days[t].variable);
        for (let i = 0; i < 4; i++) {
            const t = vIdx[Math.min(vIdx.length - 1, Math.floor(r() * Math.min(15, vIdx.length)))];
            const day = refProb.days[t];
            const st = day.states[cur.plan[t]];
            const a = Math.floor(r() * st.length), b = Math.floor(r() * st.length);
            if (a === b) continue;
            const sw = st.slice(); [sw[a], sw[b]] = [sw[b], sw[a]];
            const map = Object.assign({}, cur.map);
            const m = {}; sw.forEach((s, j) => { m[day.pids[j]] = s; });
            map[day.key] = m;
            add('swap', map);
        }
    }

    // Features + self-check against the optimizer's own total().
    let maxErr = 0;
    cands.forEach(c => {
        c.f = _tFeatures(refProb, c.plan, ctx);
        refProb.evaluatePlan = c.plan;
        const tot = _rcOptimize(refProb);
        delete refProb.evaluatePlan;
        maxErr = Math.max(maxErr, Math.abs(tot - _tWeighted(c.f, RC_WEIGHTS)) / Math.max(1, tot));
    });

    // Display range: a few workdays before the change → TUNE_SHOW_AFTER after.
    const showFrom = _tBack(from, TUNE_SHOW_BEFORE);
    const showDays = [];
    for (let d = new Date(showFrom), i = 0; i < TUNE_SHOW_BEFORE + TUNE_SHOW_AFTER; i++, d = nextWorkday(d)) showDays.push(fmt(d));
    // Services as displayed for each candidate (PTO etc. from the post-change render).
    const after = _tSnapshot(showFrom, addDays(from, TUNE_HORIZON + 10));
    const render = map => showDays.map(k => pathologists.map(p => {
        const v = map[k] && map[k][p.id] !== undefined ? map[k][p.id] : after[k][p.id];
        return v;
    }));
    // Changes beyond the shown range (so the page can say "and N more").
    const beyond = map => {
        let n = 0;
        for (const k in map) {
            if (showDays.indexOf(k) >= 0 || k < showDays[0]) continue;
            for (const pid in map[k]) if (before[k] && before[k][pid] !== map[k][pid] && SERVICE_BY_ID[before[k][pid]]) n++;
        }
        return n;
    };
    const holidays = showDays.filter(k => false);
    return {
        id: spec.id, kind: spec.kind, desc: desc, from: fromKey,
        people: pathologists.map(p => ({ id: p.id, name: p.name.replace(/^Dr\. /, '') })),
        days: showDays,
        fridays: showDays.map(k => parseDate(k).getDay() === 5),
        mondayAfterBreak: showDays.map((k, i) => i > 0 && (parseDate(k) - parseDate(showDays[i - 1])) > 86400000 * 1.5),
        before: showDays.map(k => pathologists.map(p => before[k] ? before[k][p.id] : null)),
        marks: marks,
        selfCheckErr: maxErr,
        cands: cands.map(c => ({ labels: c.labels, f: c.f, grid: render(c.map), beyond: beyond(c.map) })),
    };
}

// ── Edit mode: the admin builds two weeks by hand ──────────────────────
//
// The window is two calendar weeks (Mon–Fri ×2) with the change inside it;
// the days just before and after are fixed context, and the plan must hand
// back to the existing schedule after the window — as a real recompute over
// a short horizon would.

function _tEditWindow(from) {
    let start = new Date(from);
    while (start.getDay() !== 1) start = addDays(start, -1);
    if (from.getDay() === 1 || from.getDay() === 2) start = addDays(start, -7);
    const win = [];
    for (let d = new Date(start); d <= addDays(start, 11); d = addDays(d, 1)) if (_tIsWd(d)) win.push(d);
    const ctx = [], after = [];
    let d = prevWorkday(win[0]);
    for (let i = 0; i < 5; i++) { ctx.unshift(d); d = prevWorkday(d); }
    d = nextWorkday(win[win.length - 1]);
    for (let i = 0; i < 5; i++) { after.push(d); d = nextWorkday(d); }
    return { win, ctx, after };
}

// Workdays re-planned past the edit window. The admin can't edit them;
// their plan is taken to continue its own rotation there (_tContinue), and
// the optimizer's alternatives may use them freely, so neither side is
// forced back onto the pre-change schedule at the window's edge.
const TUNE_EDIT_EXT = 20;

function _tEditProblem(win, pins, changers, before) {
    const lockPins = _pinsFromServiceLocks();
    const merged = {};
    for (const k in lockPins) merged[k] = Object.assign({}, lockPins[k]);
    for (const k in pins) merged[k] = Object.assign(merged[k] || {}, pins[k]);
    const days = win.slice();
    let d = win[win.length - 1];
    for (let i = 0; i < TUNE_EDIT_EXT; i++) { d = nextWorkday(d); days.push(d); }
    const prob = _rcBuildProblem(days, merged);
    prob.changers = (changers || []).map(id => pathologists.findIndex(p => String(p.id) === String(id)));
    // Desirability "ahead/behind" relative to the pre-change schedule; a
    // person working a day they didn't before (cancelled PTO) is compared
    // against nothing (0).
    if (before) prob.days.forEach(day => { if (day.counted) _rcSetDesirRef(day, before[day.key] || {}); });
    const wk = new Set(win.map(fmt));
    prob.days.forEach(day => { day.inWin = wk.has(day.key); });
    // Solved like a recompute from the change day (_tSolve → _rcSolve).
    // The admin's own plan continues its rotation past the window
    // (_tContinue), and features skip the seam with the fixed last day.
    const fk = fmt(_tFrom);
    prob.fromT = prob.days.findIndex(day => day.variable && day.key >= fk);
    return prob;
}

// Extend a plan past the edit window by continuing each pathologist's
// rotation from the previous day (rotation + day-before rules, ties to the
// pre-change schedule).
function _tContinue(prob, plan) {
    const out = plan.slice();
    prob.days.forEach((day, t) => {
        if (!day.variable || day.inWin || t === 0) return;
        const n = day.states.length;
        let best = 0, bc = Infinity;
        for (let s = 0; s < n; s++) {
            const c = day.pair[out[t - 1] * n + s] + day.unaryFixed[s] + (s === day.baseIdx ? 0 : 1e-3);
            if (c < bc) { bc = c; best = s; }
        }
        out[t] = best;
    });
    return out;
}

async function tuneEditSituation(spec) {
    _tSetW({});
    const { from, pins, desc, marks, before, changers } = await _tSetup(spec);
    const W = _tEditWindow(from);
    const prob = _tEditProblem(W.win, pins, changers, before);
    const algo = _tPlanMap(prob, _tSolve(prob));
    // spec.startW (fit.js weights): pre-fill the editor with the optimizer's
    // plan under those weights, so the admin only fixes what's wrong.
    let pre = null;
    if (spec.startW) {
        _tSetW(tuneWeightsFromFit(spec.startW));
        const p2 = _tEditProblem(W.win, pins, changers, before);
        pre = _tPlanMap(p2, _tSolve(p2));
        _tSetW({});
    }
    const all = W.ctx.concat(W.win, W.after);
    const keys = all.map(fmt);
    const shown = _tSnapshot(all[0], all[all.length - 1]);
    const ids = pathologists.map(p => p.id);
    // Allowed arrangements per window day, as {pid: sid} maps (the editor
    // validates against these — the optimizer's structural rules).
    const allowed = {};
    prob.days.forEach(day => {
        if (!day.variable || !day.inWin) return;
        allowed[day.key] = day.states.map(st => day.pids.map(String).map((pid, j) => pid + ':' + st[j]).join(','));
    });
    // Recent history: last 20 workdays before the window, as shown.
    const hist = {};
    ids.forEach(id => { hist[id] = { wfh: 0, huntley: 0, bigs: 0, cyto: 0, friBigs: 0, pto: 0 }; });
    prob.days.filter(d => !d.variable && d.date < W.win[0]).forEach(day => {
        ids.forEach(id => {
            const s = day.baseline[id];
            const h = hist[id];
            if (s === undefined) { h.pto++; return; }
            if (s === 'cytobigs') { h.cyto++; h.bigs++; } else if (h[s] !== undefined) h[s]++;
            if (day.date.getDay() === 5 && _rcIsBigs(s)) h.friBigs++;
        });
    });
    return {
        id: spec.id, spec: spec, kind: spec.kind, desc: desc, from: fmt(from),
        people: pathologists.map(p => ({ id: p.id, name: p.name.replace(/^Dr\. /, '') })),
        days: keys, nCtx: W.ctx.length, nWin: W.win.length,
        fridays: all.map(d => d.getDay() === 5),
        breakBefore: all.map((d, i) => i > 0 && (d - all[i - 1]) > 86400000 * 1.5),
        before: keys.map(k => ids.map(id => before[k] ? before[k][id] : null)),
        start: keys.map(k => ids.map(id => pre && pre[k] && pre[k][id] !== undefined ? pre[k][id] : shown[k][id])),
        raw: keys.map(k => ids.map(id => shown[k][id])),
        prefilled: !!pre,
        algo: keys.map(k => ids.map(id => algo[k] && algo[k][id] !== undefined ? algo[k][id] : shown[k][id])),
        default: keys.map(k => ids.map(id => defaultServiceId(id, parseDate(k)))),
        allowed: allowed,
        marks: marks, hist: hist,
    };
}

// Score the admin's finished two weeks against alternatives: the
// optimizer's plan (current weights and variants), what was shown, and
// every one-day re-arrangement of the admin's plan. Each alternative is an
// observation "admin's plan ≥ alternative".
async function tuneEvalEdit(spec, userMap) {
    _tSetW({});
    const { from, pins, before, changers } = await _tSetup(spec);
    const W = _tEditWindow(from);
    const ctx = { before, fromKey: fmt(from), changers };
    const refProb = _tEditProblem(W.win, pins, changers, before);
    let user = _tPlanIdx(refProb, userMap, true);
    if (!user) {
        const bad = refProb.days.filter(d => d.variable && userMap[d.key] &&
            d.states.findIndex(st => st.every((s, j) => s === userMap[d.key][d.pids[j]])) < 0).map(d => d.key);
        return { error: 'not an allowed arrangement on ' + bad.join(', ') };
    }
    user = _tContinue(refProb, user);
    const uf = _tFeatures(refProb, user, ctx);
    const alts = [];
    const seen = new Set([user.join(',')]);
    const add = (label, plan, kind) => {
        const sig = plan.join(',');
        if (seen.has(sig)) return;
        seen.add(sig);
        alts.push({ label, kind, f: _tFeatures(refProb, plan, ctx) });
    };
    for (const [label, over] of TUNE_VARIANTS) {
        if (label.startsWith('leadIn')) continue;
        _tSetW(over);
        const prob = _tEditProblem(W.win, pins, changers, before);
        const p = _tPlanIdx(refProb, _tPlanMap(prob, _tSolve(prob)));
        if (p) add(label, p, label === 'current' ? 'algo' : 'variant');
    }
    _tSetW({});
    add('shown', refProb.days.map(d => Math.max(0, d.baseIdx)), 'shown');
    if (spec.startW) {
        _tSetW(tuneWeightsFromFit(spec.startW));
        const p2 = _tEditProblem(W.win, pins, changers, before);
        const p = _tPlanIdx(refProb, _tPlanMap(p2, _tSolve(p2)));
        _tSetW({});
        if (p) add('prefill', p, 'algo');
    }
    refProb.days.forEach((day, t) => {
        if (!day.variable || !day.inWin) return;
        for (let s = 0; s < day.states.length; s++) {
            if (s === user[t]) continue;
            const p = _tContinue(refProb, Object.assign(user.slice(), { [t]: s }));
            add('1day ' + day.key, p, 'neighbor');
        }
    });
    return { user: uf, alts };
}

// fit.js weights (flat feature names) → _tSetW overrides. Terms the
// optimizer doesn't implement yet are ignored.
function tuneWeightsFromFit(w) {
    const map = {
        ptoMulti: 'bigsBeforeMultiPto', ptoSingle: 'bigsBeforeSinglePto', bbWfh: 'bigsBeforeWfh',
        fair_cyto: 'fair.cyto', fair_bigs: 'fair.bigs', fair_huntley: 'fair.huntley', fair_wfh: 'fair.wfh',
        fri: 'fridayBigs', rotation: 'rotation', streak: 'mchStreak', stability: 'stability',
        templateDrift: 'templateDrift', tmplDesirDev: 'tmplDesir', wfhRepeat: 'wfhRepeat', cytoBeforePto: 'cytoBeforePto',
        repeats: 'sameServiceRepeat', rotBigJumps: 'rotationJump',
        friNoMchBefore: 'friBigsNoMchBefore', friAfterPto: 'friBigsAfterPto',
        changerGain: 'requesterGain', othersLoss: 'othersLoss',
    };
    const o = {};
    for (const k in map) if (w[k] !== undefined) o[map[k]] = w[k];
    return o;
}

// Cells of the admin's two weeks the optimizer gets different under each
// weight set (fit.js-style flat names). Sets up the scenario once.
async function tuneScoreWeights(spec, plan, weightSets) {
    _tSetW({});
    const { from, pins, changers, before } = await _tSetup(spec);
    const W = _tEditWindow(from);
    const out = [];
    for (const w of weightSets) {
        _tSetW(w ? tuneWeightsFromFit(w) : {});
        const prob = _tEditProblem(W.win, pins, changers, before);
        const m = _tPlanMap(prob, _tSolve(prob));
        let d = 0;
        for (const k in plan) for (const p in plan[k]) if (m[k] && m[k][p] !== plan[k][p]) d++;
        out.push(d);
    }
    _tSetW({});
    return out;
}
