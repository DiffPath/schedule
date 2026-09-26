// ════════════════════════════════════════════════════════════════════════
// UNDO — Outlook-style "Changed … · Undo" popup + a Recent changes list
// ════════════════════════════════════════════════════════════════════════
//
// Loads after schedule.js / recompute.js / procedure-options.js.
//
// Every database write the app makes goes through db.ref(path).set /
// update / remove / push. This file wraps db.ref so each write under an
// undoable root first records the value it replaces (read synchronously
// from a local mirror kept by listeners on those roots). Writes that land
// within UNDO_GROUP_MS of each other form one change — e.g. a service save
// plus the recompute it triggers — labeled with the change-log summary
// written alongside it.
//
// Undo writes the recorded "before" values back, newest first, so nested
// writes (a whole day, then one slot of it) unwind correctly. If a path was
// changed again since (by someone else, or a later edit) the user is asked
// before it is overwritten. History lasts for the session.

const UNDO_ROOTS = [
    'serviceOverrides', 'serviceLocks', 'vacations', 'requests',
    'onCallOverrides', 'onCallDayOverrides', 'lfSendoutWeeks', 'lfSendoutDays',
    'procedures', 'natalieptoDays', 'conflictAcks', 'ptoAllotments',
    'conferenceLog', 'consultLog',
];
const UNDO_GROUP_MS = 2000;     // writes closer together than this = one change
const UNDO_TOAST_MS = 10000;    // how long the popup stays up
const UNDO_HISTORY_MAX = 30;

const _undoMirror = {};         // root → latest value (from listeners)
let _undoSuspended = false;     // true while an undo is being applied
let _undoOpen = null;           // the change currently collecting writes
let _undoLastWriteAt = 0;
let _undoPendingLabel = null;   // a summary logged just before its writes
let _undoJoinTarget = null;     // change that a follow-up recompute joins
const _undoHistory = [];        // newest first
let _undoSeq = 0;

// ── Paths & values ──────────────────────────────────────────────────────
function _undoSplit(path) { return String(path || '').split('/').filter(Boolean); }
function _undoJoin(a, b) { return _undoSplit(a).concat(_undoSplit(b)).join('/'); }
function _undoRootOf(path) {
    const s = _undoSplit(path);
    return s[0] === 'scheduler' && s.length >= 2 && UNDO_ROOTS.includes(s[1]) ? s[1] : null;
}
function _undoClone(v) { return v === undefined ? null : JSON.parse(JSON.stringify(v)); }
// Firebase drops null/empty children; compare values the same way.
function _undoNorm(v) {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'object') return v;
    const out = {};
    Object.keys(v).forEach(k => {
        const n = _undoNorm(v[k]);
        if (n !== null) out[k] = n;
    });
    return Object.keys(out).length ? out : null;
}
function _undoSame(a, b) { return JSON.stringify(_undoNorm(a)) === JSON.stringify(_undoNorm(b)); }
// Current value at a path, from the mirror.
function _undoRead(path) {
    const s = _undoSplit(path);
    let v = _undoMirror[s[1]];
    for (let i = 2; i < s.length; i++) {
        if (v === null || v === undefined || typeof v !== 'object') return null;
        v = v[s[i]];
    }
    return v === undefined ? null : v;
}
function _undoOverlaps(a, b) {
    return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

// ── Recording ───────────────────────────────────────────────────────────
// entries: [[path, nextValue, prevOverride?]]
function _undoCapture(entries) {
    if (_undoSuspended || loggedInPathId === null || loggedInPathId === undefined) return;
    const recs = [];
    entries.forEach(([path, next, prevOverride]) => {
        if (!_undoRootOf(path)) return;
        const p = _undoSplit(path).join('/');
        recs.push({
            path: p,
            prev: prevOverride !== undefined ? prevOverride : _undoClone(_undoRead(p)),
            next: _undoClone(next),
        });
    });
    if (!recs.length) return;
    const procNote = _undoDescribeProcedure(recs);
    const now = Date.now();
    if (_undoJoinTarget && !_undoJoinTarget.undone) {
        // A recompute offered after a change belongs to that change.
        _undoOpen = _undoJoinTarget;
    } else if (!_undoOpen || now - _undoLastWriteAt > UNDO_GROUP_MS) {
        _undoOpen = { id: ++_undoSeq, at: now, recs: [], labels: [], undone: false };
        if (_undoPendingLabel && now - _undoPendingLabel.at <= UNDO_GROUP_MS) {
            _undoOpen.labels.push(_undoPendingLabel.text);
        }
        _undoPendingLabel = null;
        _undoHistory.unshift(_undoOpen);
        if (_undoHistory.length > UNDO_HISTORY_MAX) _undoHistory.length = UNDO_HISTORY_MAX;
    }
    _undoLastWriteAt = now;
    _undoOpen.recs.push(...recs);
    if (procNote && !_undoOpen.labels.includes(procNote)) _undoOpen.labels.push(procNote);
    _undoShowToast(_undoOpen);
}

// Procedures don't go through the change log; describe them from the data:
// "Procedure added — HH - EUS · Mon, Oct 5, 8:00 AM".
function _undoDescribeProcedure(recs) {
    const r = recs.find(x => _undoSplit(x.path)[1] === 'procedures' && _undoSplit(x.path).length === 4);
    if (!r) return null;
    const s = _undoSplit(r.path);
    const p = r.next || r.prev;
    if (!p || typeof p !== 'object') return null;
    const verb = !r.prev ? 'added' : !r.next ? 'deleted' : 'changed';
    let when = '';
    try {
        const d = parseDate(s[2]);
        when = ` · ${DOW[d.getDay()]}, ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}` + (p.time ? ', ' + formatTime12(p.time) : '');
    } catch (_) { }
    return `Procedure ${verb} — ${procLabel(p)}${when}`;
}

// Label changes from the change log (logChange is called around the writes).
function _undoNote(summary) {
    if (_undoSuspended || !summary) return;
    const now = Date.now();
    if (_undoJoinTarget && !_undoJoinTarget.undone) {
        if (!_undoJoinTarget.labels.includes(summary)) _undoJoinTarget.labels.push(summary);
        _undoShowToast(_undoJoinTarget);
    } else if (_undoOpen && now - _undoLastWriteAt <= UNDO_GROUP_MS) {
        if (!_undoOpen.labels.includes(summary)) _undoOpen.labels.push(summary);
        _undoShowToast(_undoOpen);
    } else {
        _undoPendingLabel = { text: summary, at: now };
    }
}

function _undoLabel(ch) {
    if (!ch.labels.length) {
        const roots = [...new Set(ch.recs.map(r => _undoSplit(r.path)[1]))];
        const names = {
            serviceOverrides: 'Services', serviceLocks: 'Locks', vacations: 'PTO', requests: 'Requests',
            onCallOverrides: 'On call', onCallDayOverrides: 'On call', lfSendoutWeeks: 'Lake Forest',
            lfSendoutDays: 'Lake Forest', procedures: 'Procedures', natalieptoDays: 'Natalie PTO',
            conflictAcks: 'Conflicts', ptoAllotments: 'PTO allotments', conferenceLog: 'Conferences',
            consultLog: 'Consults',
        };
        return [...new Set(roots.map(r => names[r] || r))].join(', ') + ' updated';
    }
    return ch.labels[0] + (ch.labels.length > 1 ? ` (+${ch.labels.length - 1} more)` : '');
}

// Wrap db.ref so writes are recorded first.
(function installUndoRecorder() {
    const rawRef = db.ref.bind(db);
    const wrap = (ref, path) => new Proxy(ref, {
        get(t, prop) {
            if (prop === 'set') return v => { _undoCapture([[path, v]]); return t.set(v); };
            if (prop === 'remove') return () => { _undoCapture([[path, null]]); return t.remove(); };
            if (prop === 'update') return obj => {
                _undoCapture(Object.keys(obj || {}).map(k => [_undoJoin(path, k), obj[k]]));
                return t.update(obj);
            };
            if (prop === 'push') return v => {
                if (v === undefined) {
                    const r = t.push();
                    return wrap(r, _undoJoin(path, r.key));
                }
                // New key: nothing was there before.
                const probe = t.push();
                _undoCapture([[_undoJoin(path, probe.key), v, null]]);
                return probe.set(v).then(() => probe);
            };
            const val = t[prop];
            return typeof val === 'function' ? val.bind(t) : val;
        },
    });
    db.ref = path => wrap(rawRef(path), path || '');
    db._rawRef = rawRef;

    // Mirror the undoable roots (listeners start/stop with sign-in).
    UNDO_ROOTS.forEach(root => {
        regListener('scheduler/' + root, snap => {
            _undoMirror[root] = snap.exists() ? snap.val() : null;
        });
    });

    // Label source: the change log.
    const origLog = logChange;
    logChange = function (entry) {
        if (entry && entry.summary) _undoNote(entry.summary);
        return origLog.apply(this, arguments);
    };
    window._undoRawLogChange = origLog;

    // Every change flow ends in maybeOfferRecompute (back-fix, then the
    // optional recompute). Whatever it writes — even after the admin takes
    // their time in the "Recompute?" dialog — is part of the change that
    // led to it, so one Undo reverses both. (The manual Recompute button
    // doesn't go through here and stays a change of its own.)
    const origOffer = maybeOfferRecompute;
    maybeOfferRecompute = async function () {
        const latest = _undoHistory[0];
        const target = latest && !latest.undone && Date.now() - _undoLastWriteAt <= UNDO_GROUP_MS ? latest : null;
        const prevTarget = _undoJoinTarget;
        _undoJoinTarget = target;
        try {
            return await origOffer.apply(this, arguments);
        } finally {
            _undoJoinTarget = prevTarget;
            if (target) _undoLastWriteAt = Date.now();
        }
    };
})();

// ── Undo ────────────────────────────────────────────────────────────────
async function undoChange(id) {
    const ch = _undoHistory.find(c => c.id === id);
    if (!ch || ch.undone) return;
    if (_undoOpen === ch) _undoOpen = null;   // stop collecting into it

    // Changed again since? Check paths with no other recorded path inside
    // or above them (nested ones can't be compared on their own).
    const last = new Map();
    ch.recs.forEach(r => last.set(r.path, r.next));
    const paths = [...last.keys()];
    const changedSince = paths.filter(p =>
        !paths.some(q => q !== p && _undoOverlaps(p, q)) && !_undoSame(_undoRead(p), last.get(p)));
    if (changedSince.length) {
        const ok = confirm(`Some of this was changed again since (${changedSince.length} item${changedSince.length === 1 ? '' : 's'}), `
            + 'by someone else or a later edit. Undo anyway and put everything back the way it was before this change?');
        if (!ok) return;
    }

    // Newest first; batch runs of non-overlapping paths into one update.
    const recs = ch.recs.slice().reverse();
    _undoSuspended = true;
    try {
        let batch = {};
        const flush = async () => {
            if (Object.keys(batch).length) await db._rawRef().update(batch);
            batch = {};
        };
        for (const r of recs) {
            if (Object.keys(batch).some(p => _undoOverlaps(p, r.path))) await flush();
            batch[r.path] = r.prev;
        }
        await flush();
    } catch (err) {
        _undoSuspended = false;
        showToast('Undo failed: ' + (err.message || err), { type: 'error' });
        return;
    } finally {
        _undoSuspended = false;
    }
    ch.undone = true;
    if (typeof clearDayCache === 'function') clearDayCache();
    try {
        window._undoRawLogChange({ kind: 'undo', type: 'undo', summary: 'Undone — ' + _undoLabel(ch) });
    } catch (_) { }
    _undoShowToast(ch, true);
    _undoRenderHistory();
    _undoSyncSidebar();
}

// ── Popup ───────────────────────────────────────────────────────────────
let _undoToastTimer = null;
function _undoEl(id, make) {
    let el = document.getElementById(id);
    if (!el) { el = make(); document.body.appendChild(el); }
    return el;
}
function _undoShowToast(ch, justUndone) {
    const toast = _undoEl('undoToast', () => {
        const d = document.createElement('div');
        d.id = 'undoToast';
        d.className = 'undo-toast';
        d.setAttribute('role', 'status');
        d.setAttribute('aria-live', 'polite');
        return d;
    });
    const label = escapeHtml(_undoLabel(ch));
    toast.innerHTML = justUndone
        ? `<span class="undo-toast-icon is-undo" aria-hidden="true">↶</span>
           <span class="undo-toast-text">Undone — ${label}</span>
           <button type="button" class="undo-toast-x" aria-label="Dismiss" title="Dismiss">&times;</button>`
        : `<span class="undo-toast-icon" aria-hidden="true">✓</span>
           <span class="undo-toast-text">${label}</span>
           <button type="button" class="undo-toast-undo" data-id="${ch.id}">Undo</button>
           <button type="button" class="undo-toast-x" aria-label="Dismiss" title="Dismiss">&times;</button>`;
    toast.classList.add('show');
    _undoHideHistoryBtn();
    clearTimeout(_undoToastTimer);
    _undoToastTimer = setTimeout(_undoHideToast, justUndone ? 4000 : UNDO_TOAST_MS);
}
function _undoHideToast() {
    clearTimeout(_undoToastTimer);
    const t = document.getElementById('undoToast');
    if (t) t.classList.remove('show');
    _undoShowHistoryBtn();
}

// ── Recent changes: sidebar item + panel (once the popup is gone) ──────
// The sidebar item appears after the first change of the session and shows
// how many changes can still be undone.
function _undoSyncSidebar() {
    const btn = document.getElementById('sidebarUndoBtn');
    if (!btn) return;
    btn.style.display = _undoHistory.length ? '' : 'none';
    const n = _undoHistory.filter(c => !c.undone).length;
    const cnt = document.getElementById('sidebarUndoCount');
    if (cnt) { cnt.textContent = n ? String(n) : ''; cnt.style.display = n ? '' : 'none'; }
}
function _undoShowHistoryBtn() { _undoSyncSidebar(); }
function _undoHideHistoryBtn() { _undoSyncSidebar(); }
function _undoAgo(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    const d = new Date(ms);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function _undoRenderHistory() {
    const panel = document.getElementById('undoHistoryPanel');
    if (!panel || !panel.classList.contains('open')) return;
    panel.innerHTML = `
      <div class="undo-panel-head">
        <span class="undo-panel-title">Recent changes</span>
        <button type="button" class="undo-toast-x" data-close="1" aria-label="Close" title="Close">&times;</button>
      </div>
      <div class="undo-panel-list">${_undoHistory.length ? _undoHistory.map(c => `
        <div class="undo-panel-row${c.undone ? ' is-undone' : ''}">
          <div class="undo-panel-text">
            <div class="undo-panel-label">${escapeHtml(_undoLabel(c))}</div>
            <div class="undo-panel-meta">${_undoAgo(c.at)}${c.undone ? ' · undone' : ''}</div>
          </div>
          ${c.undone ? '' : `<button type="button" class="undo-toast-undo" data-id="${c.id}">Undo</button>`}
        </div>`).join('') : '<div class="undo-panel-empty">No changes yet this session.</div>'}
      </div>
      <div class="undo-panel-foot">Changes you made since opening the app. Undo puts things back the way they were before that change.</div>`;
}
function _undoToggleHistory(force) {
    const panel = _undoEl('undoHistoryPanel', () => {
        const d = document.createElement('div');
        d.id = 'undoHistoryPanel';
        d.className = 'undo-panel';
        return d;
    });
    const open = force !== undefined ? force : !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    if (!open) return;
    _undoRenderHistory();
    const btn = document.getElementById('sidebarUndoBtn');
    const r = btn ? btn.getBoundingClientRect() : null;
    const phone = window.innerWidth <= 600 || !r || r.width === 0;
    panel.classList.toggle('as-sheet', phone);
    if (!phone) {
        panel.style.left = Math.round(r.right + 10) + 'px';
        panel.style.bottom = Math.max(12, Math.round(window.innerHeight - r.bottom)) + 'px';
    } else {
        panel.style.left = '';
        panel.style.bottom = '';
    }
}

document.addEventListener('click', async e => {
    const undoBtn = e.target.closest('.undo-toast-undo');
    if (undoBtn) {
        e.stopPropagation();
        await undoChange(parseInt(undoBtn.dataset.id, 10));
        return;
    }
    if (e.target.closest('#undoToast .undo-toast-x')) { _undoHideToast(); return; }
    if (e.target.closest('#sidebarUndoBtn')) {
        // On phones the sidebar is a drawer — close it so the sheet is visible.
        if (window.innerWidth <= 600 && typeof closeMobileSidebar === 'function') closeMobileSidebar();
        _undoToggleHistory();
        return;
    }
    if (e.target.closest('#undoHistoryPanel [data-close]')) { _undoToggleHistory(false); return; }
    const panel = document.getElementById('undoHistoryPanel');
    if (panel && panel.classList.contains('open') && !panel.contains(e.target)) _undoToggleHistory(false);
});

// Keep the sidebar item in step with the history, and start fresh when a
// different user signs in.
let _undoUser = null;
setInterval(() => {
    const u = typeof loggedInPathId === 'undefined' ? null : loggedInPathId;
    if (u !== _undoUser) {
        _undoUser = u;
        _undoHistory.length = 0;
        _undoOpen = null;
        _undoHideToast();
        _undoToggleHistory(false);
        _undoSyncSidebar();
    }
}, 1000);

// Ctrl/Cmd+Z undoes the latest change when not typing in a field.
document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== 'z') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const latest = _undoHistory.find(c => !c.undone);
    if (!latest) return;
    e.preventDefault();
    undoChange(latest.id);
});
