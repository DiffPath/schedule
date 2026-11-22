// ════════════════════════════════════════════════════════════════════════
// LOCUMS — doctors who only read cases
// ════════════════════════════════════════════════════════════════════════
//
// Loads after schedule.js and delnor.js (uses db, regListener, isAdmin,
// fmt, parseDate, addDays, isWeekend, getFederalHoliday, escapeHtml,
// showToast, MONTHS_SHORT, DOW, renderAll, openDayDetail) and before
// case-distribution.js, which reads who is working.
//
// A locum covers for a stretch of days (director, Nov 2026): cases are sent
// to them, and nothing else — no call, consults, conferences or tumor
// boards, no service in the rotation, no PTO. So they live apart from
// the pathologists list: their own roster and their own date ranges ("stints"),
// added from the day editor. On their working days they show as a "Locum"
// row on the schedule, and the Assign page gives them a full-timer's share
// of the shared cases (never first pick of a service's cases), evened
// within each day only (cdLocumWorkers).
//
// Firebase:
//   scheduler/locums/roster/<lid>   { name, epic? }      epic: what the AutoHotkey
//                                                        script types in Epic (blank = last name)
//   scheduler/locums/stints/<sid>   { lid, start, end }  YYYY-MM-DD, inclusive;
//                                                        weekends and holidays inside don't count

let locumRoster = {};
let locumStints = {};

regListener('scheduler/locums', snap => {
    const v = snap.exists() ? snap.val() : {};
    locumRoster = v.roster || {};
    locumStints = v.stints || {};
    if (typeof cdDelnorChanged === 'function') cdDelnorChanged();   // re-splits when the day's people change
    if (typeof renderAll === 'function' && pathologistsReady && vacationsReady) renderAll();
    const back = document.getElementById('locumBack');
    if (back && back.classList.contains('open') && _locumDate) openLocumPanel(_locumDate, true);
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
        out.push({ lid: s.lid, name: locumRoster[s.lid].name || '', epic: locumRoster[s.lid].epic || '', sid, start: s.start, end: s.end });
    });
    return out.sort((a, b) => locumLastName(a.name).localeCompare(locumLastName(b.name)));
}

// The schedule's "Locum" rows for a day (week, day and month views).
function locumRowsHtml(date) {
    return locumsOnDay(date).map(l => `<div class="wd-row locum-row" title="${escapeHtml(l.name)} — locum (cases only)">
            <span class="pid">${escapeHtml(locumInitials(l.name))}</span>
            <span class="svc">Locum</span>
          </div>`).join('');
}

// The day editor's rows for the day's locums.
function locumDetailRowsHtml(date) {
    return locumsOnDay(date).map(l => `<div class="day-detail-row locum-detail-row" title="Cases only — no call, consults or conferences">
          <div class="ddot" style="background:var(--locum)"></div>
          <div class="dname">${escapeHtml(l.name)}</div>
          <div class="dservice">Locum · ${escapeHtml(_locumRange(l.start, l.end))}</div>
        </div>`).join('');
}

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

function openLocumPanel(date, keepForm) {
    if (!isAdmin()) return;
    _locumDate = date;
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
        });
        back.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); back.classList.remove('open'); } });
        back.addEventListener('change', e => { if (e.target.id === 'locumWho') _locumSyncWho(); });
    }
    // Keep what was typed when the roster updates under an open panel.
    const prev = keepForm && back.classList.contains('open') ? {
        who: (document.getElementById('locumWho') || {}).value, name: (document.getElementById('locumName') || {}).value,
        epic: (document.getElementById('locumEpic') || {}).value, from: (document.getElementById('locumFrom') || {}).value,
        to: (document.getElementById('locumTo') || {}).value,
    } : null;
    const here = locumsOnDay(date);
    const roster = locumRosterList();
    const herePart = here.length ? `<div class="lc-here">${here.map(l => `
          <div class="lc-here-row">
            <span class="ch-tag ch-tag-locum">${escapeHtml('Dr. ' + locumLastName(l.name))}</span>
            <span class="lc-here-when">${escapeHtml(_locumRange(l.start, l.end))}</span>
            <button type="button" class="cd-btn cd-btn-sm" data-lc-remove="${escapeHtml(l.sid)}" data-lc-scope="day">Remove this day</button>
            ${l.start !== l.end ? `<button type="button" class="cd-btn cd-btn-sm cd-del" data-lc-remove="${escapeHtml(l.sid)}" data-lc-scope="all">Remove ${escapeHtml(_locumRange(l.start, l.end))}</button>` : ''}
          </div>`).join('')}</div>` : '';
    back.innerHTML = `<div class="modal lc-modal" role="dialog" aria-labelledby="locumTitle">
        <button type="button" class="modal-close-x" data-lc-close aria-label="Close" title="Close">&times;</button>
        <h3 id="locumTitle">Locums</h3>
        <div class="sub">${escapeHtml(DOW[date.getDay()] + ', ' + MONTHS_SHORT[date.getMonth()] + ' ' + date.getDate())} · Locums only read cases — no call, consults, conferences or tumor boards.</div>
        ${herePart}
        <div class="lc-form">
          <label for="locumWho">Locum</label>
          <select id="locumWho">
            ${roster.map(r => `<option value="${escapeHtml(r.lid)}">${escapeHtml(r.name)}</option>`).join('')}
            <option value="">New locum…</option>
          </select>
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
        </div>
        <div class="modal-actions">
          <button type="button" data-lc-close>Close</button>
          <button type="button" class="primary" id="locumAdd">Add locum</button>
        </div>
      </div>`;
    if (prev) {
        const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
        set('locumWho', prev.who); set('locumName', prev.name); set('locumEpic', prev.epic); set('locumFrom', prev.from); set('locumTo', prev.to);
    } else if (!roster.length) document.getElementById('locumWho').value = '';
    _locumSyncWho();
    document.getElementById('locumAdd').onclick = _locumAdd;
    back.classList.add('open');
}

// "New locum…" shows the name fields.
function _locumSyncWho() {
    const isNew = !document.getElementById('locumWho').value;
    document.querySelector('#locumBack .lc-new').hidden = !isNew;
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
    updates['stints/' + db.ref('scheduler/locums/stints').push().key] = { lid, start: from, end: to };
    db.ref('scheduler/locums').update(updates)
        .then(() => {
            const name = (locumRoster[lid] && locumRoster[lid].name) || (updates['roster/' + lid] || {}).name || 'The locum';
            showToast(`${name}: ${_locumRange(from, to)}.`);
            document.getElementById('locumBack').classList.remove('open');
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
