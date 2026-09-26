// ════════════════════════════════════════════════════════════════════════
// OUTLOOK MEETINGS — each pathologist's own published Outlook calendar
// ════════════════════════════════════════════════════════════════════════
//
// Loads after schedule.js (uses its globals: db, loggedInPathId,
// outlookMeetings, escapeHtml, showToast, renderMain, view, pathologistsReady,
// vacationsReady).
//
// The pathologist pastes their "Publish a calendar" ICS link in Settings.
// The connectOutlookCalendar Cloud Function (functions/) checks it, stores
// it encrypted, and syncs every 15 minutes into
//   scheduler/outlookMeetings/<pathId>  { 'YYYY-MM-DD': [ meeting, ... ] }
// Only the signed-in pathologist's own path is loaded, so nobody else's
// meetings reach this browser. Status (count, last sync, error) is read from
// scheduler/outlookFeeds/<pathId>; its `enc` field is the encrypted link.

let outlookFeedStatus = null;      // this user's feed node, or null = not connected
let _outlookUser = null;
let _outlookMeetingsRef = null;
let _outlookFeedRef = null;
let _outlookBusy = false;

// Only pathologist accounts (numeric ids) have a calendar.
function outlookSignedIn(uid) {
    outlookSignedOut();
    if (typeof uid !== 'number') return;
    _outlookUser = String(uid);
    _outlookMeetingsRef = db.ref('scheduler/outlookMeetings/' + _outlookUser);
    _outlookMeetingsRef.on('value', snap => {
        outlookMeetings = snap.exists() ? snap.val() : {};
        if (pathologistsReady && vacationsReady && (view === 'week' || view === 'day')) renderMain();
    }, err => console.error('Firebase outlookMeetings error:', err));
    _outlookFeedRef = db.ref('scheduler/outlookFeeds/' + _outlookUser);
    _outlookFeedRef.on('value', snap => {
        outlookFeedStatus = snap.exists() ? snap.val() : null;
        renderOutlookSettings();
    }, err => console.error('Firebase outlookFeeds error:', err));
}

function outlookSignedOut() {
    if (_outlookMeetingsRef) { try { _outlookMeetingsRef.off(); } catch (_) { } }
    if (_outlookFeedRef) { try { _outlookFeedRef.off(); } catch (_) { } }
    _outlookMeetingsRef = _outlookFeedRef = null;
    _outlookUser = null;
    outlookMeetings = {};
    outlookFeedStatus = null;
}

// "5 min ago" / "3 hr ago" / a date, for the sync status line.
function _outlookAgo(ms) {
    if (!ms) return 'never';
    const min = Math.round((Date.now() - ms) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + ' min ago';
    if (min < 48 * 60) return Math.round(min / 60) + ' hr ago';
    return new Date(ms).toLocaleDateString();
}

function renderOutlookSettings() {
    const section = document.getElementById('outlookSection');
    if (!section) return;
    const allowed = typeof loggedInPathId === 'number';
    section.style.display = allowed ? '' : 'none';
    if (!allowed) return;

    const s = outlookFeedStatus;
    const connected = !!(s && s.enc);
    const statusEl = document.getElementById('outlookStatus');
    if (statusEl) {
        let html;
        if (!connected) {
            html = '<span class="ol-dot"></span>Not connected';
        } else if (s.lastError) {
            html = `<span class="ol-dot ol-dot-err"></span>Last sync failed (${escapeHtml(_outlookAgo(s.lastRun))}): ${escapeHtml(s.lastError)}`
                + (s.lastChange ? ` · showing meetings from ${escapeHtml(_outlookAgo(s.lastChange))}` : '');
        } else {
            const n = typeof s.count === 'number' ? s.count : 0;
            html = `<span class="ol-dot ol-dot-ok"></span>Connected · ${n} meeting${n === 1 ? '' : 's'} · checked ${escapeHtml(_outlookAgo(s.lastRun))}`;
        }
        statusEl.innerHTML = html;
    }
    const connectBtn = document.getElementById('outlookConnectBtn');
    if (connectBtn) connectBtn.textContent = _outlookBusy ? 'Checking…' : (connected ? 'Replace link' : 'Connect');
    if (connectBtn) connectBtn.disabled = _outlookBusy;
    const discBtn = document.getElementById('outlookDisconnectBtn');
    if (discBtn) {
        discBtn.style.display = connected ? '' : 'none';
        discBtn.disabled = _outlookBusy;
    }
}

async function _outlookCall(name, data) {
    const fn = firebase.functions().httpsCallable(name);
    return (await fn(data || {})).data;
}

async function connectOutlookCalendar() {
    const input = document.getElementById('outlookUrlInput');
    const url = input ? input.value.trim() : '';
    if (!url) { showToast('Paste your Outlook calendar link first.', { type: 'error' }); return; }
    _outlookBusy = true;
    renderOutlookSettings();
    try {
        const res = await _outlookCall('connectOutlookCalendar', { url });
        if (input) input.value = '';
        showToast(`Outlook calendar connected — ${res.count} meetings.`);
    } catch (err) {
        showToast(err.message || 'Couldn\'t connect that calendar.', { type: 'error' });
    } finally {
        _outlookBusy = false;
        renderOutlookSettings();
    }
}

async function disconnectOutlookCalendar() {
    _outlookBusy = true;
    renderOutlookSettings();
    try {
        await _outlookCall('disconnectOutlookCalendar');
        showToast('Outlook calendar disconnected.');
    } catch (err) {
        showToast(err.message || 'Couldn\'t disconnect.', { type: 'error' });
    } finally {
        _outlookBusy = false;
        renderOutlookSettings();
    }
}

(function wireOutlookSettings() {
    const c = document.getElementById('outlookConnectBtn');
    if (c) c.addEventListener('click', connectOutlookCalendar);
    const d = document.getElementById('outlookDisconnectBtn');
    if (d) d.addEventListener('click', disconnectOutlookCalendar);
    const input = document.getElementById('outlookUrlInput');
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') connectOutlookCalendar(); });
})();
