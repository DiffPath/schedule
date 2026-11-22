// ════════════════════════════════════════════════════════════════════════
// DELNOR — the sign-up sheet
// ════════════════════════════════════════════════════════════════════════
//
// Loads after schedule.js (uses its globals: db, regListener, isAdmin,
// isDelnor, fmt, parseDate, addDays, isWeekend, getFederalHoliday, today,
// escapeHtml, showToast, MONTHS, MONTHS_SHORT) and before
// case-distribution.js, which reads who is signed up.
//
// Delnor's own pathologists cover Delnor and sign out cases from our region,
// nothing else. From DELNOR_START each working day has DELNOR_SLOTS slots;
// the Delnor login (and the director) fills them from Delnor's roster. The
// sheet is a month view with nothing else on it. The Cases page reads it:
// about a quarter of the day's case minutes, from the case types allowed to
// go to Delnor, split among whoever is signed up (see cdDelnorWorkers).
//
// Firebase:
//   scheduler/delnor/roster/<rid>            { name, epic? }  Delnor's pathologists
//                                            epic: what the AutoHotkey script
//                                            types in Epic (blank = last name)
//   scheduler/delnor/slots/<YYYY-MM-DD>/<n>  rid              n = 1..DELNOR_SLOTS

const DELNOR_START = '2026-11-30';
const DELNOR_SLOTS = 3;
let delnorRoster = {};
let delnorSlots = {};
let delnorReady = false;
let _dnMonth = null;          // first of the month the sheet shows
let _dnAddFor = null;         // { dk, n } — the slot the add panel fills

regListener('scheduler/delnor', snap => {
    const v = snap.exists() ? snap.val() : {};
    delnorRoster = v.roster || {};
    delnorSlots = v.slots || {};
    delnorReady = true;
    if (_dnPageActive()) renderDelnorPage();
    if (typeof cdDelnorChanged === 'function') cdDelnorChanged();
});

function _dnPageActive() {
    const app = document.getElementById('app');
    return !!app && app.getAttribute('data-page') === 'delnor';
}

// ── What the rest of the app reads ──────────────────────────────────────
// A working day on or after the start: it has slots.
function delnorIsSlotDay(date) {
    return fmt(date) >= DELNOR_START && !isWeekend(date) && !getFederalHoliday(date);
}

function delnorLastName(name) {
    return String(name || '').replace(/^Dr\.?\s*/i, '').trim().split(/\s+/).pop() || String(name || '');
}

// Who is signed up on a day: [{ rid, name, epic }], in slot order, no repeats.
function delnorOnDay(date) {
    if (!date || !delnorIsSlotDay(date)) return [];
    const day = delnorSlots[fmt(date)] || {};
    const seen = new Set();
    const out = [];
    for (let n = 1; n <= DELNOR_SLOTS; n++) {
        const rid = day[n];
        if (!rid || seen.has(rid) || !delnorRoster[rid]) continue;
        seen.add(rid);
        out.push({ rid, name: delnorRoster[rid].name, epic: delnorRoster[rid].epic || '' });
    }
    return out;
}

// The roster A–Z by last name: [{ rid, name, epic }].
function delnorRosterList() {
    return Object.entries(delnorRoster)
        .map(([rid, r]) => ({ rid, name: r.name || '', epic: r.epic || '' }))
        .sort((a, b) => delnorLastName(a.name).localeCompare(delnorLastName(b.name)) || a.name.localeCompare(b.name));
}

// ── The page ────────────────────────────────────────────────────────────
function _dnCanEdit() { return isDelnor() || isAdmin(); }

// The month on show is this month (the label's "off today" dot is off).
function _dnIsThisMonth() {
    return !!_dnMonth && _dnMonth.getFullYear() === today.getFullYear() && _dnMonth.getMonth() === today.getMonth();
}

function _dnMonthLabel(m) {
    return `${MONTHS[m.getMonth()]} <span class="year">${m.getFullYear()}</span>`;
}

// One slot: a type-ahead box over Delnor's roster. Type a few letters (or
// open the list) and pick; only roster names are accepted, so a typo can't
// turn into someone new. Tab settles the slot and goes to the next working
// day. Read-only accounts just see the name.
function _dnSlotHtml(dk, n, day) {
    const rid = day[n] || '';
    const person = rid && delnorRoster[rid];
    if (!_dnCanEdit()) {
        return `<div class="dn-slot${person ? ' is-filled' : ''}">${person ? escapeHtml(person.name) : 'Open'}</div>`;
    }
    const label = `Slot ${n}, ${_cfDayShort(parseDate(dk))}`;
    return `<input type="text" class="dn-slot dn-input${person ? ' is-filled' : ''}" data-dn-day="${dk}" data-dn-slot="${n}" data-rid="${person ? escapeHtml(rid) : ''}"
        value="${person ? escapeHtml(person.name) : ''}" placeholder="Open" role="combobox" aria-autocomplete="list" aria-expanded="false"
        aria-controls="dnSuggest" autocomplete="off" spellcheck="false" aria-label="${escapeHtml(label)}">`;
}

// ── Type-ahead ──────────────────────────────────────────────────────────
// "Dr. Ana Lopez-Whitfield" → "ana lopez whitfield".
function _dnNorm(s) {
    return String(s || '').toLowerCase().replace(/^dr\.?\s*/, '').replace(/[^a-z0-9'\s-]/g, ' ').replace(/[\s-]+/g, ' ').trim();
}

// Roster names for typed text: every typed word starts a word of the name,
// in any order ("sm", "jane s", "dr smith", "whit"). Blank: everyone.
function _dnMatches(text, exclude) {
    const q = _dnNorm(text).split(' ').filter(Boolean);
    return delnorRosterList().filter(r => !exclude.has(r.rid)).filter(r => {
        const words = _dnNorm(r.name).split(' ');
        return q.every(t => words.some(w => w.startsWith(t)));
    });
}

// Who else is already in this day's other slots (as shown, saved or not).
function _dnTakenFor(input) {
    return new Set([...document.querySelectorAll(`#dnRoot .dn-input[data-dn-day="${input.dataset.dnDay}"]`)]
        .filter(x => x !== input).map(x => x.dataset.rid).filter(Boolean));
}

const _dnSug = { input: null, items: [], hi: -1, note: '' };

function _dnSuggestEl() {
    let el = document.getElementById('dnSuggest');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'dnSuggest';
    el.className = 'dn-suggest';
    el.setAttribute('role', 'listbox');
    el.hidden = true;
    document.body.appendChild(el);
    // mousedown, not click: the box keeps its focus while you pick.
    el.addEventListener('mousedown', e => {
        e.preventDefault();
        const it = e.target.closest('[data-i]');
        if (it) _dnChoose(Number(it.dataset.i), false);
    });
    return el;
}

// The list under a slot: matching names, then Clear (when filled) and Add.
function _dnShowSuggest(input) {
    _dnSug.input = input;
    const typed = input.dataset.typed ? input.value : '';
    const people = _dnMatches(typed, _dnTakenFor(input));
    _dnSug.items = [...people.map(r => ({ kind: 'person', rid: r.rid, name: r.name })),
        ...(input.dataset.rid ? [{ kind: 'clear' }] : []), { kind: 'add' }];
    // One name left for what was typed: it's the one Tab or Enter takes.
    if (typed.trim() && people.length === 1) _dnSug.hi = 0;
    else if (_dnSug.hi >= _dnSug.items.length) _dnSug.hi = -1;
    _dnDrawSuggest();
}

function _dnDrawSuggest() {
    const el = _dnSuggestEl(), input = _dnSug.input;
    if (!input) return;
    const typed = input.dataset.typed ? input.value.trim() : '';
    const people = _dnSug.items.filter(it => it.kind === 'person').length;
    let firstExtra = true;
    el.innerHTML = _dnSug.items.map((it, i) => {
        const label = it.kind === 'person' ? escapeHtml(it.name) : it.kind === 'clear' ? 'Clear this slot' : 'Add a pathologist…';
        const extra = it.kind !== 'person';
        const cls = 'dn-opt' + (i === _dnSug.hi ? ' is-hi' : '') + (extra ? ' dn-opt-extra' : '') + (extra && firstExtra ? ' dn-opt-first-extra' : '');
        if (extra) firstExtra = false;
        return `<div class="${cls}" role="option" id="dnOpt${i}" data-i="${i}" aria-selected="${i === _dnSug.hi}">${label}</div>`;
    }).join('') + (_dnSug.note ? `<div class="dn-opt-note">${escapeHtml(_dnSug.note)}</div>`
        : typed && !people ? '<div class="dn-opt-note">No Delnor pathologist matches</div>' : '');
    el.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (_dnSug.hi >= 0) input.setAttribute('aria-activedescendant', 'dnOpt' + _dnSug.hi); else input.removeAttribute('aria-activedescendant');
    // Under the box (above it, near the bottom of the window).
    const r = input.getBoundingClientRect();
    el.style.width = Math.max(r.width, 220) + 'px';
    el.style.left = Math.min(r.left, innerWidth - Math.max(r.width, 220) - 8) + 'px';
    const h = el.offsetHeight;
    el.style.top = (r.bottom + 4 + h > innerHeight - 8 ? Math.max(8, r.top - 4 - h) : r.bottom + 4) + 'px';
}

function _dnCloseSuggest() {
    const el = document.getElementById('dnSuggest');
    if (el) el.hidden = true;
    if (_dnSug.input) { _dnSug.input.setAttribute('aria-expanded', 'false'); _dnSug.input.removeAttribute('aria-activedescendant'); }
    _dnSug.input = null; _dnSug.items = []; _dnSug.hi = -1; _dnSug.note = '';
}

// Put a name (or nobody) in a slot, show it, and save it.
function _dnAccept(input, rid) {
    rid = rid || '';
    input.value = rid && delnorRoster[rid] ? delnorRoster[rid].name : '';
    input.dataset.typed = '';
    input.classList.toggle('is-filled', !!rid);
    if ((input.dataset.rid || '') !== rid) {
        input.dataset.rid = rid;
        _dnSetSlot(input.dataset.dnDay, Number(input.dataset.dnSlot), rid);
        _dnRecount(input.dataset.dnDay);
    }
}

// The day's "2/3", from what the boxes show.
function _dnRecount(dk) {
    const filled = [...document.querySelectorAll(`#dnRoot .dn-input[data-dn-day="${dk}"]`)].filter(x => x.dataset.rid).length;
    const c = document.querySelector(`#dnRoot .dn-day[data-date="${dk}"] .dn-count`);
    if (c) { c.textContent = `${filled}/${DELNOR_SLOTS}`; c.classList.toggle('is-full', filled === DELNOR_SLOTS); }
}

// What the box settles on: { rid } ('' = nobody), or null when the text
// matches no one or more than one name (nothing is guessed).
function _dnResolve(input) {
    if (!input.dataset.typed) return { rid: input.dataset.rid || '' };
    const text = input.value.trim();
    if (!text) return { rid: '' };
    const hiItem = _dnSug.input === input && _dnSug.hi >= 0 ? _dnSug.items[_dnSug.hi] : null;
    if (hiItem && hiItem.kind === 'person') return { rid: hiItem.rid };
    const list = _dnMatches(text, _dnTakenFor(input));
    const exact = list.find(r => _dnNorm(r.name) === _dnNorm(text));
    if (exact) return { rid: exact.rid };
    if (list.length === 1) return { rid: list[0].rid };
    return null;
}

// A list item picked (mouse or Enter). Keyboard picks of a name move on.
function _dnChoose(i, moveOn) {
    const input = _dnSug.input, it = _dnSug.items[i];
    if (!input || !it) return;
    if (it.kind === 'add') {
        const dk = input.dataset.dnDay, n = Number(input.dataset.dnSlot);
        _dnCloseSuggest();
        input.value = input.dataset.rid && delnorRoster[input.dataset.rid] ? delnorRoster[input.dataset.rid].name : '';
        input.dataset.typed = '';
        input.blur();
        _dnOpenAdd(dk, n);
        return;
    }
    _dnAccept(input, it.kind === 'person' ? it.rid : '');
    _dnCloseSuggest();
    if (moveOn) _dnMoveDay(input, 1); else _dnShowSuggest(input);
}

// Tab / Shift+Tab: the next (previous) working day's first open slot — or
// its first slot when the day is full — across into the next month too.
function _dnMoveDay(input, dir) {
    const days = [...new Set([...document.querySelectorAll('#dnRoot .dn-input')].map(i => i.dataset.dnDay))];
    const at = days.indexOf(input.dataset.dnDay);
    const focusDay = dk => {
        const ins = [...document.querySelectorAll(`#dnRoot .dn-input[data-dn-day="${dk}"]`)];
        const t = ins.find(i => !i.dataset.rid) || ins[0];
        if (t) t.focus();
    };
    if (days[at + dir]) { focusDay(days[at + dir]); return; }
    // Off the end of the month: turn the page and carry on there.
    input.blur();
    _dnCloseSuggest();
    _dnMonth = new Date(_dnMonth.getFullYear(), _dnMonth.getMonth() + dir, 1);
    document.getElementById('dnRoot')._dnHtml = null;
    renderDelnorPage();
    const next = [...new Set([...document.querySelectorAll('#dnRoot .dn-input')].map(i => i.dataset.dnDay))];
    if (next.length) focusDay(dir > 0 ? next[0] : next[next.length - 1]);
}

function _dnMonthHtml(month) {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    // Weeks Monday–Friday, from the week holding the month's first weekday.
    const dow = first.getDay();
    let d = dow === 0 ? addDays(first, 1) : dow === 6 ? addDays(first, 2) : addDays(first, 1 - dow);
    const cells = [];
    while (true) {
        for (let i = 0; i < 5; i++) {
            const day = addDays(d, i);
            const dk = fmt(day);
            const inMonth = day.getMonth() === month.getMonth();
            const slotDay = inMonth && delnorIsSlotDay(day);
            const isToday = fmt(today) === dk;
            const holiday = inMonth && getFederalHoliday(day);
            const slots = slotDay ? (delnorSlots[dk] || {}) : null;
            const filled = slots ? Object.values(slots).filter(rid => rid && delnorRoster[rid]).length : 0;
            cells.push(`<div class="dn-day${inMonth ? '' : ' is-out'}${slotDay ? '' : ' no-slots'}${isToday ? ' is-today' : ''}" data-date="${dk}">
                <div class="dn-day-head"><span class="dn-num">${day.getDate()}<span class="dn-wd"> · ${escapeHtml(_cfDayShort(day))}</span></span>${slotDay ? `<span class="dn-count${filled === DELNOR_SLOTS ? ' is-full' : ''}">${filled}/${DELNOR_SLOTS}</span>` : (holiday ? `<span class="dn-note">${escapeHtml(holiday)}</span>` : '')}</div>
                ${slotDay ? `<div class="dn-slots">${Array.from({ length: DELNOR_SLOTS }, (_, k) => _dnSlotHtml(dk, k + 1, slots)).join('')}</div>` : ''}
              </div>`);
        }
        d = addDays(d, 7);
        if (d.getMonth() !== month.getMonth() && d > first) break;
    }
    const dows = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map(x => `<div class="dn-dow">${x}</div>`).join('');
    return `<div class="dn-grid" style="--dn-weeks:${cells.length / 5}">${dows}${cells.join('')}</div>`;
}

function renderDelnorPage() {
    const root = document.getElementById('dnRoot');
    if (!root) return;
    if (!(isDelnor() || isAdmin())) { _dnSetRoot(root, ''); return; }
    if (!_dnMonth) {
        const start = parseDate(DELNOR_START);
        const from = today > start ? today : start;
        _dnMonth = new Date(from.getFullYear(), from.getMonth(), 1);
    }
    // Don't redraw under an open picker or a field being typed in.
    const active = document.activeElement;
    if (active && root.contains(active) && active.matches('select, input')) return;
    const html = `<header class="tl-header">
          <h2 class="tl-title">Delnor sign-up</h2>
          <div class="cf-nav dn-nav">
            <button class="nav-btn" type="button" data-dn-month="-1" title="Previous month" aria-label="Previous month">‹</button>
            <button class="current-period${_dnIsThisMonth() ? '' : ' off-today'}" type="button" data-dn-month="0" title="This month">${_dnMonthLabel(_dnMonth)}</button>
            <button class="nav-btn" type="button" data-dn-month="1" title="Next month" aria-label="Next month">›</button>
          </div>
          <div class="cd-head-right">
            ${_dnCanEdit() ? '<div class="requests-page-bar"><div class="req-new-group cd-list-group"><button type="button" class="req-new-btn" id="dnRosterBtn">Delnor pathologists</button></div></div>' : ''}
          </div>
        </header>
        ${!delnorReady ? '<div class="cd-empty">Loading…</div>' : _dnMonthHtml(_dnMonth)}`;
    _dnSetRoot(root, html);
}

function _dnSetRoot(root, html) {
    if (root._dnHtml === html) return;
    root.innerHTML = html;
    root._dnHtml = html;
}

function _dnSetSlot(dk, n, rid) {
    return db.ref(`scheduler/delnor/slots/${dk}/${n}`).set(rid || null)
        .catch(err => showToast('Could not save: ' + err.message, { type: 'error' }));
}

// ── Panels (the app's panel style) ──────────────────────────────────────
function _dnPanel(id, title, sub, bodyHtml, actionsHtml) {
    let back = document.getElementById(id);
    if (!back) {
        back = document.createElement('div');
        back.className = 'modal-back';
        back.id = id;
        document.body.appendChild(back);
        back.addEventListener('click', e => { if (e.target === back || e.target.closest('[data-dn-close]')) back.classList.remove('open'); });
        back.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); back.classList.remove('open'); } });
    }
    back.innerHTML = `<div class="modal dn-modal" role="dialog" aria-label="${escapeHtml(title)}">
        <button type="button" class="modal-close-x" data-dn-close aria-label="Close" title="Close">&times;</button>
        <h3>${escapeHtml(title)}</h3>
        ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ''}
        ${bodyHtml}
        <div class="modal-actions">${actionsHtml}</div>
      </div>`;
    back.classList.add('open');
    return back;
}

// Add one of Delnor's pathologists (and put them in the slot it came from).
function _dnOpenAdd(dk, n) {
    _dnAddFor = dk ? { dk, n } : null;
    const back = _dnPanel('dnAddBack', 'Add a Delnor pathologist',
        _dnAddFor ? `For ${_cfDayShort(parseDate(dk))}, slot ${n}.` : 'They can then be picked in any slot.',
        `<label for="dnAddName">Name</label>
         <input type="text" id="dnAddName" placeholder="e.g. Dr. Jane Smith" autocomplete="off">
         <label for="dnAddEpic">Typed in Epic <span class="label-optional">(blank: their last name)</span></label>
         <input type="text" id="dnAddEpic" autocomplete="off" spellcheck="false">`,
        '<button type="button" data-dn-close>Cancel</button><button type="button" class="primary" id="dnAddSave">Add</button>');
    const save = () => {
        const name = document.getElementById('dnAddName').value.replace(/\s+/g, ' ').trim();
        const epic = document.getElementById('dnAddEpic').value.replace(/\s+/g, ' ').trim();
        if (!name) { showToast('Enter a name.', { type: 'error' }); return; }
        const dupe = delnorRosterList().find(r => r.name.toLowerCase() === name.toLowerCase());
        const ref = dupe ? null : db.ref('scheduler/delnor/roster').push();
        const rid = dupe ? dupe.rid : ref.key;
        const write = dupe ? Promise.resolve() : ref.set(epic ? { name, epic } : { name });
        write.then(() => (_dnAddFor ? _dnSetSlot(_dnAddFor.dk, _dnAddFor.n, rid) : null))
            .then(() => { back.classList.remove('open'); })
            .catch(err => showToast('Could not save: ' + err.message, { type: 'error' }));
    };
    document.getElementById('dnAddSave').onclick = save;
    back.querySelectorAll('input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') save(); }));
    setTimeout(() => document.getElementById('dnAddName').focus(), 0);
}

// The roster: rename, what's typed in Epic, remove.
function _dnOpenRoster() {
    const list = delnorRosterList();
    const rows = list.length ? list.map(r => `
        <div class="dn-roster-row" data-rid="${escapeHtml(r.rid)}">
          <input type="text" class="cd-input" data-dn-field="name" value="${escapeHtml(r.name)}" aria-label="Name">
          <input type="text" class="cd-input" data-dn-field="epic" value="${escapeHtml(r.epic)}" placeholder="${escapeHtml(delnorLastName(r.name))}" aria-label="Typed in Epic" spellcheck="false">
          <button type="button" class="cd-btn cd-btn-sm cd-del" data-dn-remove="${escapeHtml(r.rid)}">Remove</button>
        </div>`).join('') : '<p class="cd-muted">No one yet.</p>';
    const back = _dnPanel('dnRosterBack', 'Delnor pathologists',
        'Names, and what the AutoHotkey script types for them in Epic (blank: last name). Removing someone takes them out of upcoming days.',
        `<div class="dn-roster"><div class="dn-roster-row dn-roster-head"><span>Name</span><span>Typed in Epic</span><span></span></div>${rows}</div>`,
        '<button type="button" id="dnRosterAdd">Add a pathologist</button><button type="button" class="primary" data-dn-close>Done</button>');
    back.querySelector('.modal').classList.add('modal-stable');
    document.getElementById('dnRosterAdd').onclick = () => { back.classList.remove('open'); _dnOpenAdd(null); };
    back.querySelectorAll('[data-dn-field]').forEach(inp => inp.addEventListener('change', () => {
        const rid = inp.closest('[data-rid]').dataset.rid;
        const v = inp.value.replace(/\s+/g, ' ').trim();
        if (inp.dataset.dnField === 'name' && !v) { showToast('A name can’t be blank.', { type: 'error' }); return; }
        db.ref(`scheduler/delnor/roster/${rid}/${inp.dataset.dnField}`).set(v || null)
            .catch(err => showToast('Could not save: ' + err.message, { type: 'error' }));
    }));
    back.querySelectorAll('[data-dn-remove]').forEach(btn => btn.addEventListener('click', () => {
        // Two-step: the first click arms the button.
        if (!btn.classList.contains('armed')) {
            btn.classList.add('armed'); btn.textContent = 'Confirm';
            setTimeout(() => { if (btn.isConnected) { btn.classList.remove('armed'); btn.textContent = 'Remove'; } }, 3000);
            return;
        }
        const rid = btn.dataset.dnRemove;
        const updates = { ['roster/' + rid]: null };
        const from = fmt(today);
        Object.entries(delnorSlots).forEach(([dk, day]) => {
            if (dk < from) return;
            Object.entries(day || {}).forEach(([n, v]) => { if (v === rid) updates[`slots/${dk}/${n}`] = null; });
        });
        db.ref('scheduler/delnor').update(updates).then(() => _dnOpenRoster())
            .catch(err => showToast('Could not remove: ' + err.message, { type: 'error' }));
    }));
}

// ── Wiring ──────────────────────────────────────────────────────────────
(function wireDelnorPage() {
    const root = document.getElementById('dnRoot');
    if (!root) return;

    root.addEventListener('focusin', e => {
        const input = e.target.closest('.dn-input');
        if (!input) return;
        input.dataset.typed = '';
        _dnSug.hi = -1; _dnSug.note = '';
        input.select();
        _dnShowSuggest(input);
    });
    root.addEventListener('input', e => {
        const input = e.target.closest('.dn-input');
        if (!input) return;
        input.dataset.typed = '1';
        _dnSug.hi = -1; _dnSug.note = '';
        _dnShowSuggest(input);
    });
    root.addEventListener('keydown', e => {
        const input = e.target.closest('.dn-input');
        if (!input) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (_dnSug.input !== input) _dnShowSuggest(input);
            const n = _dnSug.items.length;
            _dnSug.hi = e.key === 'ArrowDown' ? (_dnSug.hi + 1) % n : (_dnSug.hi <= 0 ? n - 1 : _dnSug.hi - 1);
            _dnSug.note = '';
            _dnDrawSuggest();
        } else if (e.key === 'Escape') {
            // Back to what the slot holds.
            e.preventDefault();
            input.value = input.dataset.rid && delnorRoster[input.dataset.rid] ? delnorRoster[input.dataset.rid].name : '';
            input.dataset.typed = '';
            _dnCloseSuggest();
            input.select();
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            // Enter on Clear / Add does that.
            if (e.key === 'Enter' && _dnSug.input === input && _dnSug.hi >= 0 && _dnSug.items[_dnSug.hi].kind !== 'person') {
                e.preventDefault();
                _dnChoose(_dnSug.hi, false);
                return;
            }
            const r = _dnResolve(input);
            e.preventDefault();
            if (!r) {
                // Several names fit (or none): stay, and say how to pick.
                const many = _dnMatches(input.value, _dnTakenFor(input)).length > 1;
                if (_dnSug.input !== input) _dnShowSuggest(input);
                _dnSug.note = many ? 'Several match — keep typing, or pick one with ↓' : 'No Delnor pathologist matches';
                _dnDrawSuggest();
                return;
            }
            _dnAccept(input, r.rid);
            _dnCloseSuggest();
            _dnMoveDay(input, e.shiftKey ? -1 : 1);
        }
    });
    root.addEventListener('focusout', e => {
        const input = e.target.closest('.dn-input');
        if (!input) return;
        // Leaving a box by mouse: settle it if the text names one person,
        // otherwise put back what it held.
        setTimeout(() => {
            if (document.activeElement === input) return;
            const r = _dnResolve(input);
            if (r) _dnAccept(input, r.rid);
            else {
                input.value = input.dataset.rid && delnorRoster[input.dataset.rid] ? delnorRoster[input.dataset.rid].name : '';
                input.dataset.typed = '';
            }
            if (_dnSug.input === input) _dnCloseSuggest();
            if (!root.contains(document.activeElement)) renderDelnorPage();
        }, 0);
    });
    // The list follows its box when the page moves.
    window.addEventListener('resize', () => { if (_dnSug.input) _dnDrawSuggest(); });
    root.addEventListener('scroll', () => { if (_dnSug.input) _dnDrawSuggest(); }, true);

    root.addEventListener('click', e => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.dnMonth !== undefined) {
            const step = Number(b.dataset.dnMonth);
            _dnMonth = step === 0 ? new Date(today.getFullYear(), today.getMonth(), 1)
                : new Date(_dnMonth.getFullYear(), _dnMonth.getMonth() + step, 1);
            renderDelnorPage();
        } else if (b.id === 'dnRosterBtn') _dnOpenRoster();
    });
})();
