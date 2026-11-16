// Mock only (loaded by mock-firebase.js; never by schedule.html).
//
// Fills a fresh mock database with about eleven weeks of realistic activity,
// so Changes, Requests and Conflicts have plenty to show: pathologists file
// requests, the director approves (with recomputes), denies (with and without
// reasons), edits days, moves call weeks and marks Lake Forest sendouts.
// Everything goes through the app's own code (approveRequest, logChange, the
// same writes as the day editor), so before/after, the calendar and the
// conflicts all agree. Timestamps are back-dated by stepping Date.now()
// through the past while each action runs.
//
// Runs once, on the first sign-in after a fresh start or "Reset demo data",
// and marks scheduler/demoActivity when done. Add ?plain to the address to
// skip it and keep the small demo.
(function () {
    'use strict';
    if (/[?&]plain\b/.test(location.search)) return;

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const ready = () => {
        try {
            return loggedInPathId !== null && loggedInPathId !== undefined
                && pathologistsReady && vacationsReady && changesReady && requestsReady
                && pathologists.length >= 4;
        } catch (_) { return false; }
    };

    // window.__mockActivity: 'waiting' (fresh, builds on sign-in),
    // 'building', or 'done' — so test tools can wait for it.
    let flag = null;
    db.ref('scheduler/demoActivity').on('value', snap => {
        flag = snap.exists() ? snap.val() : false;
        if (!window.__mockActivity || window.__mockActivity === 'done') window.__mockActivity = flag ? 'done' : 'waiting';
    });

    (async function waitForSignIn() {
        while (!(ready() && flag !== null)) await sleep(250);
        if (flag) { window.__mockActivity = 'done'; return; }
        window.__mockActivity = 'building';
        await sleep(400);
        try { await build(); } catch (e) { console.error('[mock-activity] stopped early:', e); }
        window.__mockActivity = 'done';
    })();

    async function build() {
        const realId = loggedInPathId;
        const realNow = Date.now;
        const realConfirm = window.confirm;
        const realToast = window.showToast;
        const NOW = realNow();
        const veil = document.createElement('div');
        veil.style.cssText = 'position:fixed;inset:0;z-index:2147483600;display:grid;place-items:center;background:rgba(244,247,251,.92);'
            + 'font:500 15px/1.5 "IBM Plex Sans",system-ui,sans-serif;color:#1b2430;text-align:center;padding:24px';
        veil.innerHTML = '<div><div style="font:500 24px/1.2 Newsreader,Georgia,serif;margin-bottom:6px">Building sample activity…</div>'
            + 'Eleven weeks of requests, approvals, edits and conflicts for the demo.</div>';
        document.body.appendChild(veil);

        // Back-dated time: `daysAgo` before now, at a working hour.
        const at = (daysAgo, hour) => {
            const d = new Date(NOW - daysAgo * 864e5);
            if (daysAgo >= 1) d.setHours(hour || 10, (daysAgo * 37) % 60, 0, 0);
            return Math.min(d.getTime(), NOW - 60e3);
        };
        const setTime = (daysAgo, hour) => { const t = at(daysAgo, hour); Date.now = () => t; return t; };
        const as = id => { loggedInPathId = id; };
        window.confirm = () => true;     // e.g. "approve PTO during call anyway?"
        window.showToast = () => {};

        // ── dates ──
        const isWork = d => !isWeekend(d) && !getFederalHoliday(d);
        const wd = n => { let d = new Date(today), k = 0; while (k < n) { d = addDays(d, 1); if (isWork(d)) k++; } return d; };
        const nextW = d => { d = addDays(d, 1); while (!isWork(d)) d = addDays(d, 1); return d; };
        const prevW = d => { d = addDays(d, -1); while (!isWork(d)) d = addDays(d, -1); return d; };
        const svc = (pid, d) => { const a = getDayAssignments(d)[pid]; return a && a.type !== 'pto' && a.service ? a.service.id : null; };
        const findDay = (from, ok) => { let d = wd(from); for (let i = 0; i < 80 && !ok(d); i++) d = nextW(d); return d; };
        const freeDays = (pid, from, n) => {
            for (let s = wd(from), i = 0; i < 120; i++, s = nextW(s)) {
                const days = [s]; while (days.length < n) days.push(nextW(days[days.length - 1]));
                if (days.every(d => !isOnPto(pid, d) && onCallIdForDay(d) !== pid)) return days;
            }
            return null;
        };
        const callWeek = (pid, fromDays, not) => {
            for (let d = addDays(today, fromDays); d < addDays(today, 260); d = addDays(d, 7)) {
                const cs = getCallCycleStart(d);
                if (onCallIdForCycle(cs) === pid && !(not || []).some(x => x && fmt(x) === fmt(cs))) return cs;
            }
            return null;
        };

        // ── actions, the way the app writes them ──
        const file = async (daysAgo, requesterId, type, payload, note, extra) => {
            setTime(daysAgo, 9);
            const ref = db.ref('scheduler/requests').push(Object.assign({ requesterId, type, status: 'pending', createdAt: Date.now(), payload, note: note || null }, extra || {}));
            return ref.key || (await ref).key;
        };
        const approve = async (daysAgo, key, choice) => {
            if (!key) return;
            setTime(daysAgo, 14); as(1);
            await approveRequest(key, choice || { recompute: false });
        };
        const deny = async (daysAgo, key, reason) => {
            if (!key) return;
            setTime(daysAgo, 15); as(1);
            await db.ref('scheduler/requests/' + key).update({ status: 'denied', decisionAt: Date.now(), decisionBy: 1, decisionNote: reason || null });
        };
        const dayEdit = async (daysAgo, d, asg) => {
            setTime(daysAgo, 11); as(1);
            const k = fmt(d);
            const before = {};
            Object.keys(asg).forEach(p => { before[p] = svc(Number(p), d); });
            await db.ref('scheduler/serviceOverrides/' + k).set(Object.assign({}, serviceOverrides[k] || {}, asg));
            await logChange({ kind: 'service', type: 'service_set', date: k, scope: 'day', assignments: asg, cleared: [], before, summary: 'Services set for ' + k });
        };
        const directPto = async (daysAgo, pid, days) => {
            setTime(daysAgo, 10); as(1);
            const s = fmt(days[0]), e = fmt(days[days.length - 1]);
            const ref = db.ref('scheduler/vacations').push({ pathologistId: pid, start: s, end: e });
            await ref;
            await logChange({ kind: 'pto', type: 'pto_add', forPathId: pid, startDate: s, endDate: e, summary: `${_pathName(pid)} — PTO added on ${_chgFmtRange(s, e)}` });
            return ref.key || (await ref).key;
        };
        const setCall = async (daysAgo, cs, pid) => {
            setTime(daysAgo, 13); as(1);
            await db.ref('scheduler/onCallOverrides/' + fmt(cs)).set(pid);
            await logChange({ kind: 'oncall', type: 'oncall_set', forPathId: pid, date: fmt(cs), scope: 'week', summary: `${_pathName(pid)} on call — week of ${_callFmtWeek(cs)}` });
        };
        const sendoutDay = async (daysAgo, d) => {
            setTime(daysAgo, 12); as(1);
            await db.ref('scheduler/lfSendoutDays/' + fmt(d)).set(true);
            await logChange({ kind: 'lf_sendout', type: 'lf_set', date: fmt(d), scope: 'day', summary: 'Lake Forest sendout added' });
        };
        const step = async (name, fn) => { try { await fn(); } catch (e) { console.warn('[mock-activity] skipped "' + name + '":', e); } };

        const R = 4, J = 3, M = 2;   // Raouf, Rehman, Mujeeb; Moravek (1) directs
        let mujeebPtoDays = null, mujeebVacKey = null, rehmanPto = null;

        await step('Mujeeb PTO by the director', async () => {
            mujeebPtoDays = freeDays(M, 34, 3);
            mujeebVacKey = await directPto(78, M, mujeebPtoDays);
        });
        await step('Raouf PTO, approved with a recompute', async () => {
            const days = freeDays(R, 27, 3);
            const k = await file(63, R, 'pto_add', { start: fmt(days[0]), end: fmt(days[2]) }, 'Family wedding.');
            await approve(61, k, { recompute: true, horizonDays: 60 });
        });
        await step('Mujeeb PTO, denied with a reason', async () => {
            const days = freeDays(M, 48, 5);
            const k = await file(46, M, 'pto_add', { start: fmt(days[0]), end: fmt(days[4]) });
            await deny(44, k, 'Dr. Rehman is already out that week. Could you move it a week later?');
        });
        await step('Day edit: Raouf and Mujeeb trade a day', async () => {
            const d = findDay(8, x => svc(R, x) && svc(M, x) && svc(R, x) !== svc(M, x));
            await dayEdit(34, d, { [R]: svc(M, d), [M]: svc(R, d) });
        });
        await step('Rehman PTO, approved with a recompute', async () => {
            rehmanPto = freeDays(J, 14, 3);
            const k = await file(28, J, 'pto_add', { start: fmt(rehmanPto[0]), end: fmt(rehmanPto[2]) }, 'Kids’ school break.');
            await approve(26, k, { recompute: true, horizonDays: 60 });
        });
        await step('Rehman put on call over his PTO (conflict)', async () => {
            if (rehmanPto) await setCall(20, getCallCycleStart(rehmanPto[1]), J);
        });
        await step('Mujeeb service change, approved', async () => {
            const d = findDay(6, x => svc(M, x) && svc(M, x) !== 'wfh');
            const k = await file(15, M, 'service_change', { date: fmt(d), serviceId: 'wfh', scope: 'day' }, 'Waiting on a delivery at home.');
            await approve(13, k);
        });
        await step('Sendout day set by the director', async () => {
            await sendoutDay(12, findDay(9, x => !lfSendoutDays[fmt(x)]));
        });
        await step('Mujeeb and Rehman trade call weeks', async () => {
            const a = callWeek(M, 21), b = callWeek(J, 28, [a]);
            if (!a || !b) return;
            const k = await file(11, M, 'oncall_swap', { aStart: fmt(a), bStart: fmt(b), aHolder: M, bHolder: J });
            await approve(9, k);
        });
        await step('Mujeeb service lock, approved', async () => {
            const d = findDay(11, x => svc(M, x) && svc(M, x) !== 'huntley');
            const k = await file(8, M, 'service_lock', { date: fmt(d), serviceId: 'huntley' });
            await approve(7, k);
        });
        await step('Raouf service change, denied without a reason', async () => {
            const d = findDay(4, x => svc(R, x) && svc(R, x) !== 'wfh');
            const k = await file(7, R, 'service_change', { date: fmt(d), serviceId: 'wfh', scope: 'day' });
            await deny(6, k, '');
        });
        await step('Lake Forest sendout request, approved', async () => {
            const d = findDay(12, x => !lfSendoutDays[fmt(x)]);
            const k = await file(6, LAKE_FOREST_ID, 'lf_sendout', { date: fmt(d), scope: 'day', action: 'add' });
            await approve(5, k);
        });
        await step('Day edit leaves Bigs unstaffed (conflict)', async () => {
            const d = findDay(7, x => pathologists.some(p => svc(p.id, x) === 'bigs'));
            const onBigs = pathologists.find(p => svc(p.id, d) === 'bigs');
            if (onBigs) await dayEdit(4, d, { [onBigs.id]: 'huntley' });
        });
        await step('Day edits that cancel out', async () => {
            const d = findDay(5, x => svc(R, x) && svc(J, x) && svc(R, x) !== svc(J, x));
            const r0 = svc(R, d), j0 = svc(J, d);
            await dayEdit(3, d, { [R]: j0, [J]: r0 });
            await dayEdit(3, d, { [R]: r0, [J]: j0 });
        });
        await step('Mujeeb on Bigs the day before his PTO (conflict, accepted)', async () => {
            if (!mujeebPtoDays) return;
            const d = prevW(mujeebPtoDays[0]);
            const m0 = svc(M, d);
            const other = pathologists.find(p => p.id !== M && svc(p.id, d) === 'bigs');
            await dayEdit(2, d, other ? { [M]: 'bigs', [other.id]: m0 } : { [M]: 'bigs' });
            setTime(2, 16); as(1);
            const c = getConflicts().find(x => x.kind === 'soft' && x.pathId === M);
            if (c) {
                await db.ref('scheduler/conflictAcks/' + c.key).set({
                    kind: c.kind, date: c.dateStr, end: c.endStr, label: c.label, detail: c.detail,
                    by: 1, byName: _pathName(1), at: Date.now(),
                });
            }
        });
        await step('Raouf and Rehman trade call weeks', async () => {
            const a = callWeek(R, 14), b = callWeek(J, 21, [a]);
            if (!a || !b) return;
            const k = await file(3, R, 'oncall_swap', { aStart: fmt(a), bStart: fmt(b), aHolder: R, bHolder: J }, 'Swapping for my conference week.');
            await approve(1, k);
        });
        await step('Rehman service lock, denied with a reason', async () => {
            const d = findDay(16, x => svc(J, x) && svc(J, x) !== 'huntley');
            const k = await file(2, J, 'service_lock', { date: fmt(d), serviceId: 'huntley' });
            await deny(1, k, 'Huntley is covered that day. Let’s keep the rotation.');
        });

        // More of the director's own edits, spread over the weeks.
        const swap = async (daysAgo, a, b, from) => {
            const d = findDay(from, x => svc(a, x) && svc(b, x) && svc(a, x) !== svc(b, x));
            await dayEdit(daysAgo, d, { [a]: svc(b, d), [b]: svc(a, d) });
        };
        await step('Day edits across the team', async () => {
            await swap(70, 1, J, 20);
            await swap(55, M, J, 26);
            await swap(41, R, 1, 12);
            await swap(18, J, M, 10);
            await swap(9.5, R, M, 13);
            await swap(1.5, 1, R, 6);
        });
        await step('Moravek PTO', async () => { const days = freeDays(1, 22, 2); if (days) await directPto(52, 1, days); });
        await step('Raouf PTO added, later removed', async () => {
            const days = freeDays(R, 38, 2);
            if (!days) return;
            const key = await directPto(58, R, days);
            setTime(10, 10); as(1);
            await db.ref('scheduler/vacations/' + key).remove();
            await logChange({ kind: 'pto', type: 'pto_remove', forPathId: R, startDate: fmt(days[0]), endDate: fmt(days[1]),
                summary: `${_pathName(R)} — PTO removed on ${_chgFmtRange(fmt(days[0]), fmt(days[1]))}` });
        });
        await step('Raouf locked on Huntley by the director', async () => {
            const d = findDay(15, x => svc(R, x) && svc(R, x) !== 'huntley');
            setTime(8.5, 11); as(1);
            await db.ref().update({ ['scheduler/serviceOverrides/' + fmt(d) + '/' + R]: 'huntley', ['scheduler/serviceLocks/' + fmt(d) + '/' + R]: 'huntley' });
            await logChange({ kind: 'service', type: 'service_lock', forPathId: R, date: fmt(d), serviceId: 'huntley', summary: `${_pathName(R)} locked on Huntley` });
        });
        await step('Mujeeb given a call week', async () => {
            const cs = callWeek(R, 49) || callWeek(J, 49);
            if (cs) await setCall(38, cs, M);
        });
        await step('A sendout day removed', async () => {
            const k = Object.keys(lfSendoutDays || {}).sort()[0];
            if (!k) return;
            setTime(4.5, 12); as(1);
            await db.ref('scheduler/lfSendoutDays/' + k).remove();
            await logChange({ kind: 'lf_sendout', type: 'lf_clear', date: k, scope: 'day', summary: 'Lake Forest sendout removed' });
        });

        // Still waiting: a spread of pending requests.
        await step('Pending requests', async () => {
            const rp = freeDays(R, 42, 5);
            if (rp) await file(2, R, 'pto_add', { start: fmt(rp[0]), end: fmt(rp[4]) }, 'Conference in Boston.');
            const rd = findDay(9, x => svc(R, x) && svc(R, x) !== 'huntley');
            await file(1, R, 'service_change', { date: fmt(rd), serviceId: 'huntley', scope: 'day' });
            if (mujeebVacKey && mujeebPtoDays) {
                await file(1, M, 'pto_remove', { vacationKey: mujeebVacKey, start: fmt(mujeebPtoDays[0]), end: fmt(mujeebPtoDays[2]) }, 'Trip cancelled.');
            }
            const jp = freeDays(J, 24, 2);
            if (jp) await file(0.3, J, 'pto_add', { start: fmt(jp[0]), end: fmt(jp[1]) });
            const md = findDay(3, x => svc(M, x) && svc(M, x) !== 'cyto');
            await file(0.2, M, 'service_lock', { date: fmt(md), serviceId: 'cyto' });
            const a = callWeek(J, 35), b = callWeek(R, 42, [a]);
            if (a && b) await file(0.5, J, 'oncall_swap', { aStart: fmt(a), bStart: fmt(b), aHolder: J, bHolder: R });
            const ld = findDay(14, x => !lfSendoutDays[fmt(x)]);
            await file(0.6, LAKE_FOREST_ID, 'lf_sendout', { date: fmt(ld), scope: 'day', action: 'add' });
            const s = addDays(today, 30), e = addDays(today, 60);
            await file(0.8, 1, 'lf_dates_request', { start: fmt(s), end: fmt(e) }, null, { targetId: LAKE_FOREST_ID });
        });

        // Who has reviewed what, so each person sees a different amount new.
        Date.now = realNow;
        // (Days since each last reviewed. Raouf's alert shows several kinds.)
        const seen = { 1: 3, 2: 9, 3: 2, 4: 12, [LAKE_FOREST_ID]: 6 };
        const up = {};
        Object.keys(seen).forEach(id => {
            const t = at(seen[id], 17);
            up['scheduler/userSeen/' + id + '/changes'] = t;
            up['scheduler/userSeen/' + id + '/requests'] = t;
            ['changes', 'requests'].forEach(f => { try { _seenLocalSet(f, id, t); } catch (_) { /* no storage */ } });
        });
        up['scheduler/demoActivity'] = NOW;
        await db.ref().update(up);

        // Back to the person who signed in.
        window.confirm = realConfirm;
        window.showToast = realToast;
        as(realId);
        document.querySelectorAll('.modal-back.open').forEach(m => m.classList.remove('open'));
        try { renderAll(); } catch (_) { /* page not ready */ }
        const page = document.getElementById('app').getAttribute('data-page');
        if (typeof window.__setPage === 'function' && page) window.__setPage(page);
        ['updateNavRequestsIndicator', 'updateNavChangesIndicator', 'updateNavConflictsIndicator'].forEach(f => {
            try { if (typeof window[f] === 'function') window[f](); } catch (_) { /* fine */ }
        });
        veil.remove();
        try { _chAlertSnooze = 0; _chMaybeAlert(); } catch (_) { /* fine */ }
    }
})();
