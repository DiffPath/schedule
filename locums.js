// ════════════════════════════════════════════════════════════════════════
// LOCUMS — doctors who only read cases
// ════════════════════════════════════════════════════════════════════════
//
// Loads after schedule.js and delnor.js (uses db, regListener, isAdmin,
// fmt, parseDate, addDays, isWeekend, getFederalHoliday, escapeHtml,
// showToast, MONTHS_SHORT, DOW, renderAll, openDayDetail) and before
// case-distribution.js, which reads who is working.
//
// A locum covers for a stretch of days (director, Nov 2026). They work a
// service like everyone else — usually McHenry Bigs, and Cyto/Gross on
// Fridays (Friday Bigs carries breast conference) — but never call,
// consults, conferences or tumor boards, and no PTO. So they live apart
// from the pathologists list: their own roster and date ranges ("stints"),
// added from the day editor. On a locum's days the regulars cover the other
// services (regularServiceSet in schedule.js; recompute plans around them),
// the schedule shows the locum's row with their service, and the Assign
// page routes cases to them by that service (cdLocumWorkers), evened within
// each day only.
//
// Firebase:
//   scheduler/locums/roster/<lid>        { name, epic? }    epic: what the AutoHotkey
//                                                           script types in Epic (blank = last name)
//   scheduler/locums/stints/<sid>        { lid, start, end, svc?, friSvc? }
//                                        YYYY-MM-DD, inclusive; weekends and holidays inside
//                                        don't count. svc: usual service (default bigs);
//                                        friSvc: Fridays (default cyto); 'none' = cases only
//   scheduler/locums/days/<YYYY-MM-DD>/<lid>   service id or 'none' — one day changed

let locumRoster = {};
let locumStints = {};
let locumDays = {};

// A locum's usual service and Friday service when a stretch doesn't say.
const LOCUM_DEFAULT_SVC = 'bigs';
const LOCUM_DEFAULT_FRI_SVC = 'cyto';
const LOCUM_NO_SVC = 'none';

regListener('scheduler/locums', snap => {
    const v = snap.exists() ? snap.val() : {};
    locumRoster = v.roster || {};
    locumStints = v.stints || {};
    locumDays = v.days || {};
    // The regulars' services depend on the locums' (schedule.js caches days).
    if (typeof clearDayCache === 'function') clearDayCache();
    if (typeof cdDelnorChanged === 'function') cdDelnorChanged();   // re-splits when the day's people change
    if (typeof renderAll === 'function' && pathologistsReady && vacationsReady) renderAll();
    const back = document.getElementById('locumBack');
    if (back && back.classList.contains('open') && _locumDate && !_locumRenaming) openLocumPanel(_locumDate, true);
});

// ── What the rest of the app reads ──────────────────────────────────────
function locumLastName(name) {
    return String(name || '').replace(/^Dr\.?\s*/i, '').trim().split(/\s+/).pop() || String(name || '');
}

function locumInitials(name) {
    const words = String(name || '').replace(/^Dr\.?\s*/i, '').trim().split(/\s+/).filter(Boolean);
    return ((words[0] || '?')[0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}

// The roster A–Z by last name: [{ lid, name, epic }].
function locumRosterList() {
    return Object.entries(locumRoster)
        .map(([lid, r]) => ({ lid, name: (r && r.name) || '', epic: (r && r.epic) || '' }))
        .sort((a, b) => locumLastName(a.name).localeCompare(locumLastName(b.name)) || a.name.localeCompare(b.name));
}

// Locums working a day: [{ lid, name, epic, sid, start, end }], A–Z. Only
// working days (weekends and holidays inside a stretch are off).
function locumsOnDay(date) {
    if (!date || isWeekend(date) || getFederalHoliday(date)) return [];
    const dk = fmt(date);
    const seen = new Set(), out = [];
    Object.entries(locumStints).forEach(([sid, s]) => {
        if (!s || !s.lid || !locumRoster[s.lid] || seen.has(s.lid)) return;
        if (dk < s.start || dk > s.end) return;
        seen.add(s.lid);
        out.push({ lid: s.lid, name: locumRoster[s.lid].name || '', epic: locumRoster[s.lid].epic || '', sid, start: s.start, end: s.end,
            svc: _locumServiceId(s, s.lid, date) });
    });
    return out.sort((a, b) => locumLastName(a.name).localeCompare(locumLastName(b.name)));
}

// A locum's service on a day: the day's change if any (unless usualOnly),
// else the stretch's Friday or usual service. 'none' = cases only.
function _locumServiceId(stint, lid, date, usualOnly) {
    const day = usualOnly ? null : locumDays[fmt(date)];
    const set = day && day[lid];
    const ok = id => id === LOCUM_NO_SVC || SERVICES.some(x => x.id === id);
    if (set && ok(set)) return set;
    const fri = date.getDay() === 5;
    const id = fri ? (stint.friSvc || LOCUM_DEFAULT_FRI_SVC) : (stint.svc || LOCUM_DEFAULT_SVC);
    return ok(id) ? id : LOCUM_NO_SVC;
}

// The services the day's locums hold, e.g. ['bigs'] — what the regulars
// don't cover that day.
function locumServicesOn(date) {
    return locumsOnDay(date).map(l => l.svc).filter(id => id && id !== LOCUM_NO_SVC);
}

// The schedule's locum rows for a day (week, day and month views), in indigo.
function locumRowsHtml(date) {
    return locumsOnDay(date).map(l => {
        const svc = l.svc !== LOCUM_NO_SVC ? SERVICE_BY_ID[l.svc] : null;
        return `<div class="wd-row locum-row" title="${escapeHtml(l.name)} — locum${svc ? ', ' + escapeHtml(svc.name) : ', cases only'}"${svc ? ` style="--sc:var(${svc.cssVar})"` : ''}>
            <span class="pid">${escapeHtml(locumInitials(l.name))}</span>
            <span class="svc">${svc ? `<span class="swatch"></span>${escapeHtml(svc.short)}` : 'Locum'}</span>
            <span class="locum-mark">Locum</span>
          </div>`;
    }).join('');
}

// The services a locum can be given, for the pickers.
function _locumSvcOptions(selected, withDefault) {
    return (withDefault ? `<option value="">${escapeHtml(withDefault)}</option>` : '')
        + SERVICES.map(s => `<option value="${s.id}"${s.id === selected ? ' selected' : ''}>${escapeHtml(s.name)}</option>`).join('')
        + `<option value="${LOCUM_NO_SVC}"${selected === LOCUM_NO_SVC ? ' selected' : ''}>No service (cases only)</option>`;
}

// The day editor's rows for the day's locums.
function locumDetailRowsHtml(date) {
    const edit = isAdmin() && !isWeekend(date) && !getFederalHoliday(date);
    return locumsOnDay(date).map(l => {
        const svc = l.svc !== LOCUM_NO_SVC ? SERVICE_BY_ID[l.svc] : null;
        const changed = !!(locumDays[fmt(date)] && locumDays[fmt(date)][l.lid]);
        if (edit) {
            return `<div class="day-detail-row day-edit-row locum-detail-row" style="--c:var(--locum); --c-bg:var(--locum-bg)" title="Locum — no call, consults or conferences">
          <div class="ddot"></div>
          <div class="dname"><button type="button" class="locum-name-btn" data-locum-rename="${escapeHtml(l.lid)}" title="Rename ${escapeHtml(l.name)}">${escapeHtml(l.name)}<svg class="locum-pencil" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.5 2.5l3 3L6 13H3v-3z"/></svg></button> <span class="doc-pill locum-pill">Locum</span></div>
          <select class="locum-day-svc" data-locum-day="${escapeHtml(l.lid)}" aria-label="${escapeHtml(l.name)}'s service">${_locumSvcOptions(changed ? l.svc : '', 'Usual (' + _locumUsualLabel(locumStints[l.sid], date) + ')')}</select>
          <span class="locum-dates">${escapeHtml(_locumRange(l.start, l.end))}</span>
        </div>`;
        }
        return `<div class="day-detail-row locum-detail-row" style="--c:var(--locum); --c-bg:var(--locum-bg)" title="Locum — no call, consults or conferences">
          <div class="ddot"></div>
          <div class="dname">${escapeHtml(l.name)} <span class="doc-pill locum-pill">Locum</span></div>
          <div class="dservice">${svc ? `<span class="swatch" style="background:var(${svc.cssVar})"></span>${escapeHtml(svc.name)}` : 'Cases only'} · ${escapeHtml(_locumRange(l.start, l.end))}</div>
        </div>`;
    }).join('');
}

// "M Bigs", the stretch's own service for that weekday.
function _locumUsualLabel(stint, date) {
    const id = _locumServiceId(stint || {}, '', date, true);
    return id === LOCUM_NO_SVC ? 'cases only' : SERVICE_BY_ID[id].short;
}

// The director changes a locum's service for one day (blank = back to the
// usual). The regulars' services follow, so a re-plan is offered.
function _locumSetDayService(lid, date, value) {
    const dk = fmt(date);
    db.ref(`scheduler/locums/days/${dk}/${lid}`).set(value || null)
        .then(() => {
            if (typeof openDayDetail === 'function') openDayDetail(date);
            if (typeof maybeOfferRecompute === 'function') {
                const who = locumRoster[lid] ? locumRoster[lid].name : 'The locum';
                const what = !value ? 'back on their usual service' : value === LOCUM_NO_SVC ? 'on no service' : 'on ' + SERVICE_BY_ID[value].name;
                maybeOfferRecompute({}, { fromDate: date, message: `${who} is ${what} that day. The others' services were planned around the old one — re-plan them from that day using the rotation rules? (Without it, two people may share a station.)` });
            }
        })
        .catch(err => showToast('Could not save: ' + err.message, { type: 'error' }));
}

// The locum's name in the day editor opens Rename (in the Locums panel).
document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-locum-rename]');
    if (!b || !isAdmin() || !activeDayDate) return;
    if (typeof _dayEditOkToLeave === 'function' && !_dayEditOkToLeave()) return;
    document.getElementById('dayModalBack').classList.remove('open');
    openLocumPanel(activeDayDate);
    openLocumRename(b.dataset.locumRename);
});

document.addEventListener('change', e => {
    const sel = e.target.closest && e.target.closest('.locum-day-svc');
    if (sel && isAdmin() && activeDayDate) _locumSetDayService(sel.dataset.locumDay, activeDayDate, sel.value);
});

// "Dec 1–12", "Nov 30 – Dec 4", "Dec 3".
function _locumRange(start, end) {
    const a = parseDate(start), b = parseDate(end);
    const d = x => MONTHS_SHORT[x.getMonth()] + ' ' + x.getDate();
    if (start === end) return d(a);
    if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) return d(a) + '–' + b.getDate();
    return d(a) + ' – ' + d(b);
}

// ── The panel (the app's panel style) ───────────────────────────────────
// From the day editor: the day's locums (take one off this day, or their
// whole stretch) and adding a locum for a range of days.
let _locumDate = null;
let _locumRenaming = null;     // the locum whose name is being changed in the panel

function openLocumPanel(date, keepForm) {
    if (!isAdmin()) return;
    _locumDate = date;
    _locumRenaming = null;
    const dk = fmt(date);
    let back = document.getElementById('locumBack');
    if (!back) {
        back = document.createElement('div');
        back.className = 'modal-back';
        back.id = 'locumBack';
        document.body.appendChild(back);
        back.addEventListener('click', e => {
            if (e.target === back || e.target.closest('[data-lc-close]')) { back.classList.remove('open'); return; }
            const b = e.target.closest('[data-lc-remove]');
            if (b) _locumRemove(b.dataset.lcRemove, b.dataset.lcScope, fmt(_locumDate));
            const rn = e.target.closest('[data-lc-rename]');
            if (rn) openLocumRename(rn.dataset.lcRename);
            if (e.target.closest('[data-lc-back]')) openLocumPanel(_locumDate);
            if (e.target.closest('#locumRenameSave')) _locumSaveRename();
            if (e.target.closest('#locumWhoRename')) openLocumRename(document.getElementById('locumWho').value);
        });
        back.addEventListener('keydown', e => {
            if (e.key === 'Escape') { e.stopPropagation(); back.classList.remove('open'); }
            if (e.key === 'Enter' && _locumRenaming && e.target.matches('input')) _locumSaveRename();
        });
        back.addEventListener('change', e => { if (e.target.id === 'locumWho') _locumSyncWho(); });
    }
    // Keep what was typed when the roster updates under an open panel.
    const prev = keepForm && back.classList.contains('open') ? {
        who: (document.getElementById('locumWho') || {}).value, name: (document.getElementById('locumName') || {}).value,
        epic: (document.getElementById('locumEpic') || {}).value, from: (document.getElementById('locumFrom') || {}).value,
        to: (document.getElementById('locumTo') || {}).value,
        svc: (document.getElementById('locumSvc') || {}).value, fri: (document.getElementById('locumFriSvc') || {}).value,
    } : null;
    const here = locumsOnDay(date);
    const roster = locumRosterList();
    const herePart = here.length ? `<div class="lc-here">${here.map(l => `
          <div class="lc-here-row">
            <span class="ch-tag ch-tag-locum">${escapeHtml('Dr. ' + locumLastName(l.name))}</span>
            <span class="lc-here-when">${escapeHtml(_locumRange(l.start, l.end))}</span>
            <button type="button" class="cd-btn cd-btn-sm" data-lc-rename="${escapeHtml(l.lid)}">Rename</button>
            <button type="button" class="cd-btn cd-btn-sm" data-lc-remove="${escapeHtml(l.sid)}" data-lc-scope="day">Remove this day</button>
            ${l.start !== l.end ? `<button type="button" class="cd-btn cd-btn-sm cd-del" data-lc-remove="${escapeHtml(l.sid)}" data-lc-scope="all">Remove ${escapeHtml(_locumRange(l.start, l.end))}</button>` : ''}
          </div>`).join('')}</div>` : '';
    back.innerHTML = `<div class="modal lc-modal" role="dialog" aria-labelledby="locumTitle">
        <button type="button" class="modal-close-x" data-lc-close aria-label="Close" title="Close">&times;</button>
        <h3 id="locumTitle">Locums</h3>
        <div class="sub">${escapeHtml(DOW[date.getDay()] + ', ' + MONTHS_SHORT[date.getMonth()] + ' ' + date.getDate())} · Locums work a service like everyone else, but take no call, consults, conferences or tumor boards.</div>
        ${herePart}
        <div class="lc-form">
          <label for="locumWho">Locum</label>
          <div class="lc-who">
            <select id="locumWho">
              ${roster.map(r => `<option value="${escapeHtml(r.lid)}">${escapeHtml(r.name)}</option>`).join('')}
              <option value="">New locum…</option>
            </select>
            <button type="button" class="cd-btn cd-btn-sm" id="locumWhoRename">Rename</button>
          </div>
          <div class="lc-new">
            <label for="locumName">Name</label>
            <input type="text" id="locumName" placeholder="e.g. Dr. Jane Smith" autocomplete="off">
            <label for="locumEpic">Typed in Epic <span class="label-optional">(blank: their last name)</span></label>
            <input type="text" id="locumEpic" autocomplete="off" spellcheck="false">
          </div>
          <div class="lc-dates">
            <label for="locumFrom">From<input type="date" id="locumFrom" value="${dk}"></label>
            <label for="locumTo">To<input type="date" id="locumTo" value="${dk}"></label>
          </div>
          <p class="lc-hint">Weekends and holidays in between are off.</p>
          <div class="lc-dates">
            <label for="locumSvc">Service<select id="locumSvc">${_locumSvcOptions(LOCUM_DEFAULT_SVC)}</select></label>
            <label for="locumFriSvc">Fridays<select id="locumFriSvc">${_locumSvcOptions(LOCUM_DEFAULT_FRI_SVC)}</select></label>
          </div>
          <p class="lc-hint">Everyone else covers the other services those days. Change a single day from that day's editor.</p>
        </div>
        <div class="modal-actions">
          <button type="button" data-lc-close>Close</button>
          <button type="button" class="primary" id="locumAdd">Add locum</button>
        </div>
      </div>`;
    if (prev) {
        const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
        set('locumWho', prev.who); set('locumName', prev.name); set('locumEpic', prev.epic); set('locumFrom', prev.from); set('locumTo', prev.to);
        set('locumSvc', prev.svc); set('locumFriSvc', prev.fri);
    } else if (!roster.length) document.getElementById('locumWho').value = '';
    _locumSyncWho();
    document.getElementById('locumAdd').onclick = _locumAdd;
    back.classList.add('open');
}

// Rename a locum (and what the script types for them in Epic). Everything
// refers to a locum by its id, so the new name shows everywhere at once —
// the schedule, the day editor, the Assign page.
function openLocumRename(lid) {
    const r = locumRoster[lid];
    const back = document.getElementById('locumBack');
    if (!r || !back) return;
    _locumRenaming = lid;
    back.innerHTML = `<div class="modal lc-modal" role="dialog" aria-labelledby="locumRenameTitle">
        <button type="button" class="modal-close-x" data-lc-close aria-label="Close" title="Close">&times;</button>
        <h3 id="locumRenameTitle">Rename locum</h3>
        <div class="sub">The new name shows everywhere — the schedule, the day editor and the Assign page.</div>
        <div class="lc-form">
          <label for="locumRenameName">Name</label>
          <input type="text" id="locumRenameName" value="${escapeHtml(r.name || '')}" placeholder="e.g. Dr. Jane Smith" autocomplete="off">
          <label for="locumRenameEpic">Typed in Epic <span class="label-optional">(blank: their last name)</span></label>
          <input type="text" id="locumRenameEpic" value="${escapeHtml(r.epic || '')}" autocomplete="off" spellcheck="false">
        </div>
        <div class="modal-actions">
          <button type="button" data-lc-back>Back</button>
          <button type="button" class="primary" id="locumRenameSave">Save</button>
        </div>
      </div>`;
    back.classList.add('open');
    setTimeout(() => { const i = document.getElementById('locumRenameName'); if (i) { i.focus(); i.select(); } }, 0);
}

function _locumSaveRename() {
    const lid = _locumRenaming;
    if (!lid) return;
    const name = document.getElementById('locumRenameName').value.replace(/\s+/g, ' ').trim();
    const epic = document.getElementById('locumRenameEpic').value.replace(/\s+/g, ' ').trim();
    const err = locumNameProblem(lid, name);
    if (err) { showToast(err, { type: 'error' }); return; }
    db.ref('scheduler/locums/roster/' + lid).update({ name, epic: epic || null })
        .then(() => { showToast('Renamed to ' + name + '.'); _locumRenaming = null; openLocumPanel(_locumDate); })
        .catch(e => showToast('Could not save: ' + e.message, { type: 'error' }));
}

// Why a name can't be used for this locum, or '' when it can.
function locumNameProblem(lid, name) {
    if (!name) return 'Enter the locum’s name.';
    const clash = locumRosterList().find(r => r.lid !== lid && r.name.toLowerCase() === name.toLowerCase());
    return clash ? 'Another locum already has that name.' : '';
}

// "New locum…" shows the name fields.
function _locumSyncWho() {
    const isNew = !document.getElementById('locumWho').value;
    document.querySelector('#locumBack .lc-new').hidden = !isNew;
    document.getElementById('locumWhoRename').hidden = isNew;
}

function _locumAdd() {
    let lid = document.getElementById('locumWho').value;
    const from = document.getElementById('locumFrom').value, to = document.getElementById('locumTo').value;
    if (!from || !to) { showToast('Pick the first and last day.', { type: 'error' }); return; }
    if (to < from) { showToast('The last day is before the first.', { type: 'error' }); return; }
    const updates = {};
    if (!lid) {
        const name = document.getElementById('locumName').value.replace(/\s+/g, ' ').trim();
        const epic = document.getElementById('locumEpic').value.replace(/\s+/g, ' ').trim();
        if (!name) { showToast('Enter the locum’s name.', { type: 'error' }); return; }
        const dupe = locumRosterList().find(r => r.name.toLowerCase() === name.toLowerCase());
        if (dupe) lid = dupe.lid;
        else {
            lid = db.ref('scheduler/locums/roster').push().key;
            updates['roster/' + lid] = epic ? { name, epic } : { name };
        }
    }
    updates['stints/' + db.ref('scheduler/locums/stints').push().key] = {
        lid, start: from, end: to,
        svc: document.getElementById('locumSvc').value || LOCUM_DEFAULT_SVC,
        friSvc: document.getElementById('locumFriSvc').value || LOCUM_DEFAULT_FRI_SVC,
    };
    db.ref('scheduler/locums').update(updates)
        .then(() => {
            const name = (locumRoster[lid] && locumRoster[lid].name) || (updates['roster/' + lid] || {}).name || 'The locum';
            showToast(`${name}: ${_locumRange(from, to)}.`);
            document.getElementById('locumBack').classList.remove('open');
            if (typeof maybeOfferRecompute === 'function') {
                const start = parseDate(from);
                maybeOfferRecompute({}, { fromDate: start.getTime() < today.getTime() ? today : start,
                    message: `${name} covers ${_locumRange(from, to)}. The others' services for those days were planned without them — re-plan them around the locum using the rotation rules? (Without it, two people may share a station.)` });
            }
        })
        .catch(err => showToast('Could not save: ' + err.message, { type: 'error' }));
}

// Take a locum off one day (their stretch splits around it) or off the
// whole stretch.
function _locumRemove(sid, scope, dk) {
    const s = locumStints[sid];
    if (!s) return;
    const updates = {};
    if (scope === 'all' || (s.start === dk && s.end === dk)) updates[sid] = null;
    else if (s.start === dk) updates[sid] = { ...s, start: fmt(addDays(parseDate(dk), 1)) };
    else if (s.end === dk) updates[sid] = { ...s, end: fmt(addDays(parseDate(dk), -1)) };
    else {
        updates[sid] = { ...s, end: fmt(addDays(parseDate(dk), -1)) };
        updates[db.ref('scheduler/locums/stints').push().key] = { ...s, start: fmt(addDays(parseDate(dk), 1)) };
    }
    db.ref('scheduler/locums/stints').update(updates)
        .catch(err => showToast('Could not save: ' + err.message, { type: 'error' }));
}

// From the day editor's "Locums" button.
(function wireLocumButton() {
    const btn = document.getElementById('dayAddLocum');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (typeof _dayEditOkToLeave === 'function' && !_dayEditOkToLeave()) return;
        document.getElementById('dayModalBack').classList.remove('open');
        openLocumPanel(activeDayDate);
    });
})();
