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

// Only the director and gross room add procedures, so only they have a
// list of their own; everyone else sees the standard names and colors.
function currentProcOptions() {
    if (typeof canEditProcedures === 'function' && !canEditProcedures()) return defaultProcOptions();
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
// Laid out like the Add procedure panel: the options as the panel's tiles
// (same colors), in panel order. Drag a tile to reorder (press and hold on
// a phone); click one to edit its name, color, suboptions, or hide/delete
// it in the box under the grid. Changes save automatically.
let _poDraft = null;          // the list being edited
let _poSel = null;            // index of the option open in the editor
let _poConfirm = null;        // 'del' | 'reset' | null — inline confirmation

function _poColorSwatch(color, parentColor) {
    const eff = color === 'parent' ? (parentColor || 'loc') : color;
    if (eff === 'loc' || !eff) return '<span class="po-sw po-sw-loc" aria-hidden="true"></span>';
    if (eff && eff[0] === '#') return `<span class="po-sw" style="background:${eff}" aria-hidden="true"></span>`;
    return `<span class="po-sw" style="background:var(--proc-${eff})" aria-hidden="true"></span>`;
}
function _poColorLabel(color) {
    if (color === 'parent') return 'Same as parent';
    if (color && color[0] === '#') return 'Custom ' + color;
    const c = PROC_COLOR_CHOICES.find(x => x.key === color);
    return c ? c.label : color;
}

function renderProcOptionsSettings() {
    const section = document.getElementById('procOptionsSection');
    const list = document.getElementById('procOptList');
    if (!section || !list) return;
    const allowed = loggedInPathId !== null && canEditProcedures();
    section.style.display = allowed ? '' : 'none';
    if (!allowed) return;
    // applySettings() calls this on every schedule redraw: leave the editor
    // alone when the list hasn't changed, and while a drag or typing is in
    // progress (it catches up on the next call).
    const cur = currentProcOptions();
    if (_poDraft && list.querySelector('.po-grid')) {
        if (JSON.stringify(_normalizeProcOptions(cur)) === JSON.stringify(_normalizeProcOptions(_poDraft))) return;
        const ae = document.activeElement;
        if (_poDrag.st || (ae && list.contains(ae) && ae.tagName === 'INPUT')) return;
    }
    _poDraft = JSON.parse(JSON.stringify(cur));
    if (_poSel !== null && _poSel >= _poDraft.length) _poSel = null;
    _poRender();
}

const _PO_GRIP = '<span class="po-grip" aria-hidden="true"><svg viewBox="0 0 8 12" width="8" height="12"><circle cx="2" cy="2" r="1.1"/><circle cx="6" cy="2" r="1.1"/><circle cx="2" cy="6" r="1.1"/><circle cx="6" cy="6" r="1.1"/><circle cx="2" cy="10" r="1.1"/><circle cx="6" cy="10" r="1.1"/></svg></span>';

function _poTileHtml(o, i) {
    const pa = procStyleAttrs(_procResolve(o.color, null));
    const sel = i === _poSel;
    const meta = [];
    if (o.subs.length) meta.push(o.subs.length + (o.subs.length === 1 ? ' suboption' : ' suboptions'));
    if (o.hidden) meta.push('Hidden');
    return `<button type="button" class="proc-type-btn po-tile ${pa.cls}${sel ? ' selected' : ''}${o.hidden ? ' is-hidden' : ''}"${pa.style}
                data-i="${i}" aria-pressed="${sel}" title="Drag to reorder · click to edit">
              <span class="po-tile-name">${o.name.trim() ? escapeHtml(o.name) : '<i>Unnamed</i>'}</span>
              ${meta.length ? `<span class="po-tile-meta">${meta.join(' · ')}</span>` : ''}
              ${_PO_GRIP}
            </button>`;
}

function _poEditorHtml(i) {
    const o = _poDraft[i];
    if (!o) return '';
    const subs = o.subs.map((s, j) => `
        <div class="po-sub" data-i="${i}" data-j="${j}">
          <span class="po-sub-grip" title="Drag to reorder">${_PO_GRIP}</span>
          <button type="button" class="po-color" data-act="color" title="Color: ${escapeHtml(_poColorLabel(s.color))}">${_poColorSwatch(s.color, o.color)}</button>
          <input type="text" class="po-name" data-field="name" maxlength="60" value="${escapeHtml(s.name)}" placeholder="Suboption name" aria-label="Suboption name">
          <button type="button" class="po-icon po-del" data-act="del" aria-label="Delete suboption" title="Delete suboption">&times;</button>
        </div>`).join('');
    const what = o.name.trim() ? '“' + escapeHtml(o.name.trim()) + '”' : 'this option';
    const subNote = o.subs.length ? ` and its ${o.subs.length} suboption${o.subs.length === 1 ? '' : 's'}` : '';
    const confirmHtml = _poConfirm === 'del' ? `
        <div class="po-confirm">
          <span>Delete ${what}${subNote}? Procedures already on the schedule keep their names.</span>
          <button type="button" class="po-btn po-btn-danger" data-act="delyes">Delete</button>
          <button type="button" class="po-btn" data-act="delno">Keep</button>
        </div>` : '';
    return `
      <div class="po-editor" data-i="${i}">
        <div class="po-ed-row" data-i="${i}">
          <button type="button" class="po-color" data-act="color" title="Color: ${escapeHtml(_poColorLabel(o.color))}">${_poColorSwatch(o.color)}</button>
          <input type="text" class="po-name" data-field="name" maxlength="60" value="${escapeHtml(o.name)}" placeholder="Option name" aria-label="Option name">
          <button type="button" class="po-btn" data-act="hide">${o.hidden ? 'Show in panel' : 'Hide from panel'}</button>
          <button type="button" class="po-btn po-btn-danger" data-act="del">Delete</button>
        </div>
        ${confirmHtml}
        <div class="po-ed-label">Suboptions</div>
        ${o.subs.length ? `<div class="po-sub-list">${subs}</div>` : '<div class="po-ed-empty">None — the panel shows this option on its own.</div>'}
        <button type="button" class="po-add-sub" data-act="addsub" data-i="${i}">+ Add suboption</button>
      </div>`;
}

function _poRender() {
    const list = document.getElementById('procOptList');
    if (!list) return;
    const resetHtml = _poConfirm === 'reset' ? `
        <div class="po-confirm">
          <span>Restore the built-in list? Your custom options, colors and order will be removed.</span>
          <button type="button" class="po-btn po-btn-danger" data-act="resetyes">Restore defaults</button>
          <button type="button" class="po-btn" data-act="resetno">Keep my list</button>
        </div>` : '';
    list.innerHTML = `
        <div class="proc-type-grid po-grid">
          ${_poDraft.map(_poTileHtml).join('')}
          <button type="button" class="po-add-tile" data-act="add">+ Add option</button>
        </div>
        ${_poSel !== null ? _poEditorHtml(_poSel) : ''}
        ${resetHtml}`;
}

// Which option/suboption a control belongs to.
function _poTarget(el) {
    const row = el.closest('[data-i]');
    if (!row) return null;
    const i = parseInt(row.dataset.i, 10);
    const j = row.dataset.j !== undefined ? parseInt(row.dataset.j, 10) : null;
    const opt = _poDraft[i];
    if (!opt) return null;
    return { i, j, opt, item: j === null ? opt : opt.subs[j], row };
}

function _poCommit(rerender) {
    if (rerender) _poRender();
    saveProcOptions(_poDraft);
}

// Move an option (sub === null) or a suboption from one index to another;
// the open editor follows the option it was showing.
function _poMove(i, sub, from, to) {
    const arr = sub === null ? _poDraft : _poDraft[i].subs;
    if (from === to || to < 0 || to >= arr.length) return;
    const [x] = arr.splice(from, 1);
    arr.splice(to, 0, x);
    if (sub === null && _poSel !== null) {
        if (_poSel === from) _poSel = to;
        else if (from < _poSel && to >= _poSel) _poSel--;
        else if (from > _poSel && to <= _poSel) _poSel++;
    }
    _poCommit(true);
}

// ── Drag to reorder ── pointer events, so it works with a mouse (drag
// right away) and on touch (press and hold, then drag; a quick swipe still
// scrolls the page). Tiles drag anywhere; suboption rows by their grip.
const _poDrag = { st: null };
function _poDragCleanup() {
    const d = _poDrag.st;
    if (!d) return;
    clearTimeout(d.timer);
    if (d.ghost) d.ghost.remove();
    if (d.el) d.el.classList.remove('po-dragging');
    document.body.classList.remove('po-drag-active');
    _poDrag.st = null;
    // The placeholder may have moved in the page: redraw from the list
    // (a completed drop has already updated the list).
    if (d.active) _poRender();
}
function _poDragActivate() {
    const d = _poDrag.st;
    if (!d || d.active) return;
    d.active = true;
    const r = d.el.getBoundingClientRect();
    d.dx = d.x - r.left; d.dy = d.y - r.top;
    const g = d.el.cloneNode(true);
    g.classList.add('po-ghost');
    g.classList.remove('po-dragging');
    g.style.width = r.width + 'px';
    g.style.height = r.height + 'px';
    // Tile tints are see-through; lay the tint over solid paper so the
    // lifted tile doesn't look faded over the page.
    const bg = getComputedStyle(d.el).backgroundColor;
    g.style.background = `linear-gradient(${bg}, ${bg}), var(--paper)`;
    document.body.appendChild(g);
    d.ghost = g;
    d.el.classList.add('po-dragging');
    document.body.classList.add('po-drag-active');
    _poDragMove(d.x, d.y);
}
function _poDragMove(x, y) {
    const d = _poDrag.st;
    d.ghost.style.left = (x - d.dx) + 'px';
    d.ghost.style.top = (y - d.dy) + 'px';
    const list = document.getElementById('procOptList');
    const items = d.sub === null
        ? [...list.querySelectorAll('.po-tile')]
        : [...list.querySelectorAll(`.po-sub[data-i="${d.i}"]`)];
    // Nearest item to the pointer; before/after by which half it's in
    // (left/right in the two-column grid, top/bottom in the sub list). The
    // dragged item's faded placeholder moves there, so the others make room
    // and show where it will land.
    let best = null, bestDist = Infinity;
    items.forEach(el => {
        const r = el.getBoundingClientRect();
        const cx = Math.max(r.left, Math.min(x, r.right)), cy = Math.max(r.top, Math.min(y, r.bottom));
        const dist = Math.hypot(x - cx, y - cy);
        if (dist < bestDist) { bestDist = dist; best = el; }
    });
    if (best && best !== d.el) {
        const r = best.getBoundingClientRect();
        const after = d.sub === null ? x > r.left + r.width / 2 : y > r.top + r.height / 2;
        const ref = after ? best.nextSibling : best;
        if (ref !== d.el) best.parentNode.insertBefore(d.el, ref);
    }
    d.drop = items.slice().sort((p, q) => (p.compareDocumentPosition(q) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1).indexOf(d.el);
}

(function wireProcOptionsEditor() {
    const list = document.getElementById('procOptList');
    if (!list) return;

    list.addEventListener('pointerdown', e => {
        if (e.button !== 0 || _poDrag.st) return;
        const tile = e.target.closest('.po-tile');
        const grip = e.target.closest('.po-sub-grip');
        const el = tile || (grip && grip.closest('.po-sub'));
        if (!el) return;
        const d = {
            el, x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse',
            i: parseInt(el.dataset.i, 10),
            sub: tile ? null : parseInt(el.dataset.j, 10),
            active: false, timer: null, ghost: null, drop: null,
        };
        d.from = d.sub === null ? d.i : d.sub;
        _poDrag.st = d;
        if (d.touch) d.timer = setTimeout(_poDragActivate, 280);
    });
    document.addEventListener('pointermove', e => {
        const d = _poDrag.st;
        if (!d) return;
        const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
        if (!d.active) {
            // Touch: moving before the hold completes = scrolling.
            if (d.touch) { if (moved > 8) _poDragCleanup(); return; }
            if (moved < 5) return;
            _poDragActivate();
        }
        _poDragMove(e.clientX, e.clientY);
    });
    document.addEventListener('pointerup', () => {
        const d = _poDrag.st;
        if (!d) return;
        const was = d.active, drop = d.drop;
        _poDragCleanup();
        if (!was) return;
        _poDrag.suppressClick = true;
        setTimeout(() => { _poDrag.suppressClick = false; }, 0);
        if (drop !== null) _poMove(d.i, d.sub, d.from, drop);
    });
    document.addEventListener('pointercancel', _poDragCleanup);
    // Once a touch drag is going, the finger moves the tile, not the page.
    list.addEventListener('touchmove', e => { if (_poDrag.st && _poDrag.st.active) e.preventDefault(); }, { passive: false });
    list.addEventListener('contextmenu', e => { if (_poDrag.st) e.preventDefault(); });

    // Keyboard: Alt + arrow keys move the focused tile.
    list.addEventListener('keydown', e => {
        const tile = e.target.closest('.po-tile');
        if (!tile || !e.altKey) return;
        const step = { ArrowLeft: -1, ArrowUp: -2, ArrowRight: 1, ArrowDown: 2 }[e.key];
        if (!step) return;
        e.preventDefault();
        const from = parseInt(tile.dataset.i, 10);
        const to = Math.max(0, Math.min(_poDraft.length - 1, from + step));
        _poMove(from, null, from, to);
        const t = list.querySelector(`.po-tile[data-i="${to}"]`);
        if (t) t.focus();
    });

    // Typing: update the name (and its tile), no re-render.
    list.addEventListener('input', e => {
        const input = e.target.closest('.po-name');
        if (!input) return;
        const t = _poTarget(input);
        if (!t || !t.item) return;
        t.item.name = input.value;
        if (t.j === null) {
            const nm = list.querySelector(`.po-tile[data-i="${t.i}"] .po-tile-name`);
            if (nm) nm.innerHTML = input.value.trim() ? escapeHtml(input.value) : '<i>Unnamed</i>';
        }
        _poCommit(false);
    });

    list.addEventListener('click', e => {
        if (_poDrag.suppressClick) return;
        const tile = e.target.closest('.po-tile');
        if (tile) {
            const i = parseInt(tile.dataset.i, 10);
            _poSel = _poSel === i ? null : i;
            _poConfirm = null;
            _poRender();
            // Keyboard (Enter/Space, detail 0): keep focus on the redrawn tile.
            const again = list.querySelector(`.po-tile[data-i="${i}"]`);
            if (again && e.detail === 0) again.focus();
            const ed = list.querySelector('.po-editor');
            if (ed && ed.scrollIntoView) ed.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            return;
        }
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'add') {
            _poDraft.push({ name: '', color: 'loc', hidden: false, subs: [] });
            _poSel = _poDraft.length - 1;
            _poConfirm = null;
            _poCommit(true);
            const inp = list.querySelector('.po-ed-row .po-name');
            if (inp) inp.focus();
            return;
        }
        if (act === 'resetyes') {
            _poDraft = defaultProcOptions();
            _poSel = null; _poConfirm = null;
            saveProcOptions(_poDraft, true);
            _poRender();
            return;
        }
        if (act === 'resetno' || act === 'delno') { _poConfirm = null; _poRender(); return; }
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
        if (act === 'del' && t.j !== null) {
            t.opt.subs.splice(t.j, 1);
            _poCommit(true);
        } else if (act === 'del') {
            _poConfirm = 'del';
            _poRender();
        } else if (act === 'delyes') {
            _poDraft.splice(t.i, 1);
            _poSel = null; _poConfirm = null;
            _poCommit(true);
        } else if (act === 'hide') {
            t.opt.hidden = !t.opt.hidden;
            _poCommit(true);
        } else if (act === 'color') {
            _poOpenColorPop(btn, t);
        }
    });

    const resetBtn = document.getElementById('procOptReset');
    if (resetBtn) resetBtn.addEventListener('click', () => {
        _poConfirm = 'reset';
        _poRender();
        const c = list.querySelector('.po-confirm');
        if (c && c.scrollIntoView) c.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
