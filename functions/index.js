// Outlook → Firebase meeting sync, one calendar per pathologist.
//
// A pathologist pastes their published Outlook calendar link in Settings;
// connectOutlookCalendar stores it ENCRYPTED (the database is readable by
// every signed-in account, and the link alone grants read access to the
// calendar). Every 15 minutes syncOutlookCalendars fetches each feed, keeps
// only title + times (see outlook.js), and replaces that pathologist's
// meetings when anything changed. The app listens to its own user's path,
// so Outlook edits show up without a refresh.
//
//   scheduler/outlookFeeds/<pathId>     { enc, connectedAt, lastRun,
//                                         lastChange, lastError, count, hash }
//   scheduler/outlookMeetings/<pathId>  { 'YYYY-MM-DD': [ meeting, ... ] }
//
// OUTLOOK_FEED_KEY is a base64 32-byte AES key, set once with
//   firebase functions:secrets:set OUTLOOK_FEED_KEY

import { createHash } from 'node:crypto';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { parseOutlookIcs, TIME_ZONE } from './outlook.js';
import { encryptUrl, decryptUrl } from './feed-crypto.js';

initializeApp();

const FEED_KEY = defineSecret('OUTLOOK_FEED_KEY');
const FEEDS_PATH = 'scheduler/outlookFeeds';
const MEETINGS_PATH = 'scheduler/outlookMeetings';
// Published-calendar hosts only: the function fetches whatever URL is
// stored, so don't let it be pointed anywhere else.
const ALLOWED_HOSTS = ['outlook.office365.com', 'outlook.office.com', 'outlook.live.com'];

// ── link encryption (AES-256-GCM) ────────────────────────────────────────
function feedKey() {
    const key = Buffer.from(FEED_KEY.value().trim(), 'base64');
    if (key.length !== 32) throw new Error('OUTLOOK_FEED_KEY must be 32 bytes, base64');
    return key;
}

// ── fetch + write ────────────────────────────────────────────────────────
async function fetchMeetings(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error('Outlook returned HTTP ' + res.status);
    return parseOutlookIcs(await res.text());
}

// Write one pathologist's meetings if they changed; returns the count.
async function storeMeetings(db, pathId, days, prevHash) {
    const hash = createHash('sha256').update(JSON.stringify(days)).digest('hex');
    const count = Object.values(days).reduce((n, list) => n + list.length, 0);
    const now = Date.now();
    const status = { lastRun: now, lastError: null, count };
    if (hash !== prevHash) {
        await db.ref(`${MEETINGS_PATH}/${pathId}`).set(days);
        Object.assign(status, { hash, lastChange: now });
    }
    await db.ref(`${FEEDS_PATH}/${pathId}`).update(status);
    return count;
}

// Signed-in pathologist accounts are p<id>@scheduler.local (see
// authEmailForId in schedule.js); nobody else has a calendar.
function pathIdFromAuth(auth) {
    const m = /^p(\d+)@scheduler\.local$/i.exec((auth && auth.token && auth.token.email) || '');
    if (!m) throw new HttpsError('permission-denied', 'Only pathologist accounts can connect a calendar.');
    return m[1];
}

function checkFeedUrl(raw) {
    let u;
    try { u = new URL(String(raw || '').trim()); } catch (_) {
        throw new HttpsError('invalid-argument', 'That doesn\'t look like a link.');
    }
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.includes(u.hostname.toLowerCase())
        || !/\.ics$/i.test(u.pathname)) {
        throw new HttpsError('invalid-argument',
            'Use the ICS link from Outlook\'s "Publish a calendar" (it starts with https://outlook.office365.com and ends in .ics).');
    }
    return u.toString();
}

// ── callable: connect / disconnect (from Settings) ───────────────────────
export const connectOutlookCalendar = onCall({ secrets: [FEED_KEY], timeoutSeconds: 90, memory: '512MiB' }, async req => {
    const pathId = pathIdFromAuth(req.auth);
    const url = checkFeedUrl(req.data && req.data.url);
    let days;
    try {
        days = await fetchMeetings(url);
    } catch (err) {
        logger.warn(`connect ${pathId}: feed check failed`, err);
        throw new HttpsError('invalid-argument',
            'Couldn\'t read a calendar at that link. Check it was typed exactly, and that the calendar is still published.');
    }
    const db = getDatabase();
    await db.ref(`${FEEDS_PATH}/${pathId}`).set({ enc: encryptUrl(url, feedKey()), connectedAt: Date.now() });
    const count = await storeMeetings(db, pathId, days, null);
    return { count };
});

export const disconnectOutlookCalendar = onCall(async req => {
    const pathId = pathIdFromAuth(req.auth);
    await getDatabase().ref().update({
        [`${FEEDS_PATH}/${pathId}`]: null,
        [`${MEETINGS_PATH}/${pathId}`]: null,
    });
    return { ok: true };
});

// ── scheduled sync ───────────────────────────────────────────────────────
export const syncOutlookCalendars = onSchedule({
    schedule: 'every 15 minutes',
    timeZone: TIME_ZONE,
    secrets: [FEED_KEY],
    timeoutSeconds: 300,
    memory: '512MiB',
    retryCount: 0, // the next run is 15 minutes away anyway
}, async () => {
    const db = getDatabase();
    const feeds = (await db.ref(FEEDS_PATH).once('value')).val() || {};
    const key = feedKey();
    await Promise.all(Object.entries(feeds).map(async ([pathId, feed]) => {
        if (!feed || !feed.enc) return;
        try {
            const days = await fetchMeetings(decryptUrl(feed.enc, key));
            const count = await storeMeetings(db, pathId, days, feed.hash || null);
            logger.info(`sync ${pathId}: ${count} meetings`);
        } catch (err) {
            // Keep the last good copy; a feed hiccup shouldn't wipe meetings.
            logger.error(`sync ${pathId} failed`, err);
            await db.ref(`${FEEDS_PATH}/${pathId}`).update({
                lastRun: Date.now(), lastError: String(err.message || err),
            });
        }
    }));
});
