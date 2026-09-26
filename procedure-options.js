// ════════════════════════════════════════════════════════════════════════
// PROCEDURE OPTIONS — each user's own list for the Add procedure panel
// ════════════════════════════════════════════════════════════════════════
//
// Loads after schedule.js (uses its globals: db, loggedInPathId,
// PROCEDURE_TYPES, PROCEDURE_VARIANTS, getProcedureCategory, escapeHtml,
// showToast, isReadOnlyGuest, isLakeForest, renderMain).
//
// A list is an array of options:
//   { name, color, hidden?, subs: [{ name, color }] }
// color:
//   'loc'                  — by location: HH purple, MH blue (the old default)
//   'eus' 'ebus' 'surgical' 'fs' 'hh' 'mh' — the built-in procedure colors
//   '#rrggbb'              — any custom color
//   'parent'               — (suboptions only) same as the parent option
//
// Stored per user at scheduler/procedureOptions/<user id> so it follows them
// across devices (cached in localStorage too). No stored list = the built-in
// defaults, so new built-in options still reach users who never customized.
// Colors apply to the Add procedure panel and to the procedure pills that
// user sees on the schedule; a procedure whose name isn't in the list keeps
// the built-in name/location coloring.

const PROC_COLOR_KEYS = ['eus', 'ebus', 'surgical', 'fs', 'hh', 'mh'];
const PROC_COLOR_CHOICES = [
    { key: 'loc', label: 'By location (HH purple · MH blue)' },
    { key: 'eus', label: 'Orange' },
    { key: 'ebus', label: 'Green' },
    { key: 'surgical', label: 'Red' },
    { key: 'fs', label: 'Gold' },
    { key: 'hh', label: 'Purple' },
    { key: 'mh', label: 'Blue' },
];
const PROC_OPTIONS_CACHE_PREFIX = 'procOptions_';

let procOptions = null;            // this user's list, or null = defaults
let _procOptionsRef = null;        // live Firebase ref for the signed-in user
let _procOptionsUser = null;

// The built-in list (PROCEDURE_TYPES + PROCEDURE_VARIANTS) in list form.
function defaultProcOptions() {
    return PROCEDURE_TYPES.map(name => {
        const cat = getProcedureCategory(null, name);
        return {
            name,
            color: PROC_COLOR_KEYS.includes(cat) ? cat : 'loc',
            subs: (PROCEDURE_VARIANTS[name] || []).map(v => ({ name: v, color: 'parent' })),
        };
    });
}

function currentProcOptions() {
    return procOptions || defaultProcOptions();
}

// Clean a list read from storage (or built by the editor).
function _normalizeProcOptions(list) {
    if (!Array.isArray(list)) list = list && typeof list === 'object' ? Object.values(list) : [];
    const okColor = (c, sub) => typeof c === 'string'
        && (c === 'loc' || PROC_COLOR_KEYS.includes(c) || /^#[0-9a-f]{6}$/i.test(c) || (sub && c === 'parent'));
    return list.filter(o => o && typeof o.name === 'string').map(o => ({
        name: o.name,
        color: okColor(o.color, false) ? o.color : 'loc',
        hidden: !!o.hidden,
        subs: (Array.isArray(o.subs) ? o.subs : (o.subs ? Object.values(o.subs) : []))
            .filter(s => s && typeof s.name === 'string')
            .map(s => ({ name: s.name, color: okColor(s.color, true) ? s.color : 'parent' })),
    }));
}

// Options the Add procedure panel shows (named, not hidden).
function visibleProcOptions() {
    return currentProcOptions()
        .filter(o => !o.hidden && o.name.trim())
        .map(o => Object.assign({}, o, { subs: o.subs.filter(s => s.name.trim()) }));
}

// Look up a procedure name in the user's list → its color (subs resolved).
function _procColorForName(name) {
    if (!name) return null;
    const n = name.trim().toLowerCase();
    for (const o of currentProcOptions()) {
        if (o.name.trim().toLowerCase() === n) return o.color;
        for (const s of o.subs) {
            if (s.name.trim().toLowerCase() === n) return s.color === 'parent' ? o.color : s.color;
        }
    }
    return null;
}

// Resolve a color key for a location → { cat, color } where cat is the
// proc-cat-* suffix and color the custom hex (cat 'custom') or null.
function _procResolve(color, location) {
    if (color && color[0] === '#') return { cat: 'custom', color };
    if (color === 'loc' || !color) {
        return { cat: location === 'HH' ? 'hh' : location === 'MH' ? 'mh' : 'default', color: null };
    }
    return { cat: color, color: null };
}

// Style for a procedure (pill or panel button): the user's color if the
// name is in their list, else the built-in name/location rules.
function procStyle(location, name) {
    const c = _procColorForName(name);
    if (c === null) return { cat: getProcedureCategory(location, name), color: null };
    return _procResolve(c, location);
}

// Apply a procStyle to an element (swap proc-cat-* class, set --pc).
function applyProcStyle(el, st) {
    el.className = el.className.replace(/\bproc-cat-\S+/g, '').replace(/\s+/g, ' ').trim();
    el.classList.add('proc-cat-' + st.cat);
    if (st.color) el.style.setProperty('--pc', st.color);
    else el.style.removeProperty('--pc');
}

// class + style attribute text for markup strings.
function procStyleAttrs(st) {
    return { cls: 'proc-cat-' + st.cat, style: st.color ? ` style="--pc:${st.color}"` : '' };
}

// ── Storage ──────────────────────────────────────────────────────────────
function _procOptionsCacheKey(uid) { return PROC_OPTIONS_CACHE_PREFIX + uid; }

function procOptionsSignedIn(uid) {
    procOptionsSignedOut();
    _procOptionsUser = String(uid);
    // Instant start from this device's cache; Firebase then takes over.
    try {
        const raw = localStorage.getItem(_procOptionsCacheKey(_procOptionsUser));
        procOptions = raw ? _normalizeProcOptions(JSON.parse(raw)) : null;
    } catch (_) { procOptions = null; }
    _procOptionsRef = db.ref('scheduler/procedureOptions/' + _procOptionsUser);
    _procOptionsRef.on('value', snap => {
        procOptions = snap.exists() ? _normalizeProcOptions(snap.val()) : null;
        try {
            if (procOptions) localStorage.setItem(_procOptionsCacheKey(_procOptionsUser), JSON.stringify(procOptions));
            else localStorage.removeItem(_procOptionsCacheKey(_procOptionsUser));
        } catch (_) { }
        _procOptionsChanged();
    }, err => {
        // No read access (rules) — keep this device's copy.
        console.warn('procedureOptions read failed; using this device\'s copy.', err);
    });
}

function procOptionsSignedOut() {
    if (_procOptionsRef) { try { _procOptionsRef.off(); } catch (_) { } }
    _procOptionsRef = null;
    _procOptionsUser = null;
    procOptions = null;
}

// Save the user's list. Identical to the defaults → clear it, so the user
// keeps following the built-in list.
let _procSaveTimer = null;
function saveProcOptions(list, immediate) {
    const clean = _normalizeProcOptions(list);
    const isDefault = JSON.stringify(_normalizeProcOptions(defaultProcOptions())) === JSON.stringify(clean);
    procOptions = isDefault ? null : clean;
    _procOptionsChanged(true);
    clearTimeout(_procSaveTimer);
    const write = async () => {
        if (!_procOptionsUser) return;
        try {
            if (isDefault) localStorage.removeItem(_procOptionsCacheKey(_procOptionsUser));
            else localStorage.setItem(_procOptionsCacheKey(_procOptionsUser), JSON.stringify(clean));
        } catch (_) { }
        try {
            await db.ref('scheduler/procedureOptions/' + _procOptionsUser).set(isDefault ? null : clean);
        } catch (err) {
            showToast('Saved on this device only — couldn\'t sync your procedure options.', { type: 'error' });
        }
    };
    if (immediate) write(); else _procSaveTimer = setTimeout(write, 500);
}

// Something changed the list: refresh the schedule pills, and the editor
// unless the user is typing in it.
function _procOptionsChanged(fromEditor) {
    try { if (typeof renderMain === 'function') renderMain(); } catch (_) { }
    if (!fromEditor) {
        const list = document.getElementById('procOptList');
        if (!list || !list.contains(document.activeElement)) renderProcOptionsSettings();
    }
}

// ── Settings editor ─────────────────────────────────────────────────────
let _poDraft = null;          // the list being edited
const _poOpen = new Set();    // indices of options with suboptions expanded

function _poColorSwatch(color, parentColor) {
    const eff = color === 'parent' ? parentColor : color;
    if (eff === 'loc') return `<span class="po-sw po-sw-loc" aria-hidden="true"></span>`;
    if (eff && eff[0] === '#') return `<span class="po-sw" style="background:${eff}" aria-hidden="true"></span>`;
    return `<span class="po-sw" style="background:var(--proc-${eff})" aria-hidden="true"></span>`;
}
function _poColorLabel(color) {
    if (color === 'parent') return 'Same as parent';
    if (color && color[0] === '#') return 'Custom ' + color;
    const c = PROC_COLOR_CHOICES.find(x => x.key === color);
    return c ? c.label : color;
}
function _poPreviewPill(name, color) {
    const st = _procResolve(color, 'HH');
    const a = procStyleAttrs(st);
    const label = name.trim() ? 'HH - ' + name.trim() : 'HH - (unnamed)';
    return `<span class="proc-item po-preview ${a.cls}"${a.style}>${escapeHtml(label)}</span>`;
}

function renderProcOptionsSettings() {
    const section = document.getElementById('procOptionsSection');
    const list = document.getElementById('procOptList');
    if (!section || !list) return;
    const allowed = loggedInPathId !== null && !isReadOnlyGuest() && !isLakeForest();
    section.style.display = allowed ? '' : 'none';
    if (!allowed) return;
    _poDraft = JSON.parse(JSON.stringify(currentProcOptions()));
    _poRender();
}

function _poRender() {
    const list = document.getElementById('procOptList');
    if (!list) return;
    const last = _poDraft.length - 1;
    list.innerHTML = _poDraft.map((o, i) => {
        const open = _poOpen.has(i);
        const subs = o.subs.map((s, j) => `
            <div class="po-row po-sub" data-i="${i}" data-j="${j}">
              <div class="po-move">
                <button type="button" data-act="up" ${j === 0 ? 'disabled' : ''} aria-label="Move up" title="Move up">↑</button>
                <button type="button" data-act="down" ${j === o.subs.length - 1 ? 'disabled' : ''} aria-label="Move down" title="Move down">↓</button>
              </div>
              <button type="button" class="po-color" data-act="color" title="Color: ${escapeHtml(_poColorLabel(s.color))}">${_poColorSwatch(s.color, o.color)}</button>
              <input type="text" class="po-name" data-field="name" maxlength="60" value="${escapeHtml(s.name)}" placeholder="Suboption name" aria-label="Suboption name">
              <span class="po-prev">${_poPreviewPill(s.name, s.color === 'parent' ? o.color : s.color)}</span>
              <button type="button" class="po-icon po-del" data-act="del" aria-label="Delete suboption" title="Delete suboption">&times;</button>
            </div>`).join('');
        return `
          <div class="po-item${o.hidden ? ' is-hidden' : ''}">
            <div class="po-row" data-i="${i}">
              <div class="po-move">
                <button type="button" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Move up" title="Move up">↑</button>
                <button type="button" data-act="down" ${i === last ? 'disabled' : ''} aria-label="Move down" title="Move down">↓</button>
              </div>
              <button type="button" class="po-color" data-act="color" title="Color: ${escapeHtml(_poColorLabel(o.color))}">${_poColorSwatch(o.color)}</button>
              <input type="text" class="po-name" data-field="name" maxlength="60" value="${escapeHtml(o.name)}" placeholder="Option name" aria-label="Option name">
              <span class="po-prev">${_poPreviewPill(o.name, o.color)}</span>
              <button type="button" class="po-subs-toggle${open ? ' open' : ''}" data-act="subs" aria-expanded="${open}">${o.subs.length ? o.subs.length + ' sub' : '+ sub'}</button>
              <button type="button" class="po-icon" data-act="hide" title="${o.hidden ? 'Hidden from the Add procedure panel — click to show' : 'Hide from the Add procedure panel'}">${o.hidden ? 'Show' : 'Hide'}</button>
              <button type="button" class="po-icon po-del" data-act="del" aria-label="Delete option" title="Delete option">&times;</button>
            </div>
            ${open ? `<div class="po-subs">${subs}<button type="button" class="po-add-sub" data-act="addsub" data-i="${i}">+ Add suboption</button></div>` : ''}
          </div>`;
    }).join('');
}

// Which option/suboption a control belongs to.
function _poTarget(el) {
    const row = el.closest('[data-i]');
    if (!row) return null;
    const i = parseInt(row.dataset.i, 10);
    const j = row.dataset.j !== undefined ? parseInt(row.dataset.j, 10) : null;
    const opt = _poDraft[i];
    return { i, j, opt, item: j === null ? opt : opt.subs[j], row };
}

function _poCommit(rerender) {
    if (rerender) _poRender();
    saveProcOptions(_poDraft);
}

(function wireProcOptionsEditor() {
    const list = document.getElementById('procOptList');
    if (!list) return;

    // Typing: update the name and that row's preview, no re-render.
    list.addEventListener('input', e => {
        const input = e.target.closest('.po-name');
        if (!input) return;
        const t = _poTarget(input);
        if (!t) return;
        t.item.name = input.value;
        const color = t.j === null ? t.opt.color : (t.item.color === 'parent' ? t.opt.color : t.item.color);
        const prev = t.row.querySelector('.po-prev');
        if (prev) prev.innerHTML = _poPreviewPill(t.item.name, color);
        _poCommit(false);
    });

    list.addEventListener('click', e => {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'addsub') {
            const i = parseInt(btn.dataset.i, 10);
            _poDraft[i].subs.push({ name: '', color: 'parent' });
            _poCommit(true);
            const rows = list.querySelectorAll(`.po-sub[data-i="${i}"] .po-name`);
            if (rows.length) rows[rows.length - 1].focus();
            return;
        }
        const t = _poTarget(btn);
        if (!t) return;
        const arr = t.j === null ? _poDraft : t.opt.subs;
        const k = t.j === null ? t.i : t.j;
        if (act === 'up' || act === 'down') {
            const to = act === 'up' ? k - 1 : k + 1;
            if (to < 0 || to >= arr.length) return;
            [arr[k], arr[to]] = [arr[to], arr[k]];
            if (t.j === null) {
                // Keep expanded state with the moved options.
                const a = _poOpen.has(k), b = _poOpen.has(to);
                _poOpen.delete(k); _poOpen.delete(to);
                if (a) _poOpen.add(to);
                if (b) _poOpen.add(k);
            }
            _poCommit(true);
        } else if (act === 'del') {
            const what = t.item.name.trim() || (t.j === null ? 'this option' : 'this suboption');
            const subNote = t.j === null && t.opt.subs.length ? ` and its ${t.opt.subs.length} suboption${t.opt.subs.length === 1 ? '' : 's'}` : '';
            if (!confirm(`Delete "${what}"${subNote}? Procedures already on the schedule keep their names.`)) return;
            arr.splice(k, 1);
            if (t.j === null) {
                // Shift expanded-state indices past the removed option.
                const next = [..._poOpen].filter(x => x !== k).map(x => (x > k ? x - 1 : x));
                _poOpen.clear();
                next.forEach(x => _poOpen.add(x));
            }
            _poCommit(true);
        } else if (act === 'hide') {
            t.opt.hidden = !t.opt.hidden;
            _poCommit(true);
        } else if (act === 'subs') {
            if (_poOpen.has(t.i)) _poOpen.delete(t.i); else _poOpen.add(t.i);
            _poRender();
        } else if (act === 'color') {
            _poOpenColorPop(btn, t);
        }
    });

    const addBtn = document.getElementById('procOptAdd');
    if (addBtn) addBtn.addEventListener('click', () => {
        _poDraft.push({ name: '', color: 'loc', hidden: false, subs: [] });
        _poCommit(true);
        const inputs = list.querySelectorAll('.po-row:not(.po-sub) .po-name');
        if (inputs.length) inputs[inputs.length - 1].focus();
    });
    const resetBtn = document.getElementById('procOptReset');
    if (resetBtn) resetBtn.addEventListener('click', () => {
        if (!confirm('Restore the built-in procedure options? Your custom options, colors and order will be removed.')) return;
        _poDraft = defaultProcOptions();
        _poOpen.clear();
        saveProcOptions(_poDraft, true);
        _poRender();
    });
})();

// ── Color popover ───────────────────────────────────────────────────────
function _poOpenColorPop(anchor, t) {
    _poCloseColorPop();
    const isSub = t.j !== null;
    const cur = t.item.color;
    const pop = document.createElement('div');
    pop.className = 'po-color-pop';
    pop.id = 'poColorPop';
    const choices = (isSub ? [{ key: 'parent', label: 'Same as parent' }] : []).concat(PROC_COLOR_CHOICES);
    const custom = cur && cur[0] === '#' ? cur : '#4a7c8c';
    pop.innerHTML = choices.map(c => `
        <button type="button" class="po-pop-opt${cur === c.key ? ' is-current' : ''}" data-color="${c.key}">
          ${_poColorSwatch(c.key, t.opt.color)}<span>${escapeHtml(c.label)}</span>
        </button>`).join('') + `
        <label class="po-pop-opt po-pop-custom${cur && cur[0] === '#' ? ' is-current' : ''}">
          <input type="color" value="${custom}" aria-label="Custom color"><span>Custom color…</span>
        </label>`;
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - pw - 8);
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    pop.style.left = Math.max(8, left) + 'px';
    pop.style.top = top + 'px';

    const set = color => {
        t.item.color = color;
        _poCommit(true);
    };
    pop.addEventListener('click', e => {
        const b = e.target.closest('.po-pop-opt[data-color]');
        if (!b) return;
        set(b.dataset.color);
        _poCloseColorPop();
    });
    const picker = pop.querySelector('input[type="color"]');
    picker.addEventListener('input', () => set(picker.value.toLowerCase()));
    picker.addEventListener('change', () => _poCloseColorPop());
    setTimeout(() => document.addEventListener('mousedown', _poOutside, true), 0);
}
function _poOutside(e) {
    const pop = document.getElementById('poColorPop');
    if (pop && !pop.contains(e.target)) _poCloseColorPop();
}
function _poCloseColorPop() {
    const pop = document.getElementById('poColorPop');
    if (pop) pop.remove();
    document.removeEventListener('mousedown', _poOutside, true);
}
