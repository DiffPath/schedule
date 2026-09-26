// Turn a published Outlook calendar (.ics) into the per-day meeting list the
// app renders. Only title + times survive: descriptions, locations, meeting
// links and attendees are dropped here and never reach Firebase.
//
// Output shape, keyed by local (Chicago) date:
//   { '2026-09-28': [ { title, start: '08:00', end: '09:00' },
//                     { title, allDay: true } ], ... }

import ICAL from 'ical.js';

export const TIME_ZONE = 'America/Chicago';
const DAYS_BACK = 60;
const DAYS_AHEAD = 400;
const MAX_TITLE = 200;
// Safety cap on stepping through one series (a daily meeting since 2019 is
// ~2,500 steps just to reach the window).
const MAX_STEPS_PER_SERIES = 20000;

const localParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

// Absolute instant → { day: 'YYYY-MM-DD', time: 'HH:MM' } in Chicago time.
function toLocal(jsDate) {
    const p = {};
    localParts.formatToParts(jsDate).forEach(x => { p[x.type] = x.value; });
    return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

// 'YYYY-MM-DD' + n days, calendar arithmetic only (no time zone involved).
function addDaysKey(dayKey, n) {
    const [y, m, d] = dayKey.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return dt.toISOString().slice(0, 10);
}

function cleanTitle(s) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    if (!t) return '(No title)';
    return t.length > MAX_TITLE ? t.slice(0, MAX_TITLE - 1) + '…' : t;
}

// Outlook keeps meetings the organizer cancelled on attendees' calendars
// with a "Canceled: " title prefix and no STATUS, so check both.
function isCancelled(comp) {
    if (String(comp.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED') return true;
    return /^\s*cancell?ed\s*:/i.test(String(comp.getFirstPropertyValue('summary') || ''));
}

// Place one occurrence onto the day map. Timed events that cross midnight
// are split: partial first day, all-day middle days, partial last day.
function addOccurrence(out, title, startDate, endDate) {
    const push = (day, entry) => { (out[day] || (out[day] = [])).push(entry); };

    if (startDate.isDate) {
        // All-day: DTEND is exclusive. A missing/equal end means one day.
        const first = startDate.toString().slice(0, 10);
        let last = endDate ? addDaysKey(endDate.toString().slice(0, 10), -1) : first;
        if (last < first) last = first;
        for (let day = first; day <= last; day = addDaysKey(day, 1)) {
            push(day, { title, allDay: true });
        }
        return;
    }

    const s = toLocal(startDate.toJSDate());
    const e = endDate ? toLocal(endDate.toJSDate()) : s;
    if (e.day <= s.day) {
        push(s.day, { title, start: s.time, end: e.time < s.time ? s.time : e.time });
        return;
    }
    push(s.day, { title, start: s.time, end: '23:59' });
    for (let day = addDaysKey(s.day, 1); day < e.day; day = addDaysKey(day, 1)) {
        push(day, { title, allDay: true });
    }
    if (e.time !== '00:00') push(e.day, { title, start: '00:00', end: e.time });
}

export function parseOutlookIcs(icsText, now = new Date()) {
    if (!/^\s*BEGIN:VCALENDAR/.test(icsText)) {
        throw new Error('Feed is not an iCalendar file');
    }
    const root = new ICAL.Component(ICAL.parse(icsText));

    // Outlook names zones like "Central Standard Time" and ships their rules
    // as VTIMEZONE blocks; registering them lets toJSDate() resolve correctly.
    root.getAllSubcomponents('vtimezone').forEach(tz => {
        ICAL.TimezoneService.register(tz);
    });

    const today = toLocal(now).day;
    const windowStartDay = addDaysKey(today, -DAYS_BACK);
    const windowEndDay = addDaysKey(today, DAYS_AHEAD);
    const windowStart = ICAL.Time.fromDateString(windowStartDay);
    const windowEnd = ICAL.Time.fromDateString(windowEndDay);

    // Group by UID: the master carries the RRULE, siblings with a
    // RECURRENCE-ID are edited/cancelled single occurrences.
    const byUid = new Map();
    root.getAllSubcomponents('vevent').forEach(ev => {
        const uid = ev.getFirstPropertyValue('uid') || Symbol('no-uid');
        if (!byUid.has(uid)) byUid.set(uid, { master: null, exceptions: [] });
        const g = byUid.get(uid);
        if (ev.hasProperty('recurrence-id')) g.exceptions.push(ev);
        else g.master = ev;
    });

    const out = {};
    const inWindow = t => t.compare(windowStart) >= 0 && t.compare(windowEnd) < 0;

    byUid.forEach(({ master, exceptions }) => {
        if (!master) {
            // Edited occurrences whose series isn't in the feed: treat each
            // as a standalone meeting.
            exceptions.forEach(ex => {
                if (isCancelled(ex)) return;
                const ev = new ICAL.Event(ex);
                if (inWindow(ev.startDate)) addOccurrence(out, cleanTitle(ev.summary), ev.startDate, ev.endDate);
            });
            return;
        }

        const event = new ICAL.Event(master, { exceptions, strictExceptions: true });
        if (!event.isRecurring()) {
            if (!isCancelled(master) && inWindow(event.startDate)) {
                addOccurrence(out, cleanTitle(event.summary), event.startDate, event.endDate);
            }
            return;
        }

        const it = event.iterator();
        let next;
        let n = 0;
        while ((next = it.next()) && n++ < MAX_STEPS_PER_SERIES) {
            if (next.compare(windowEnd) >= 0) break;
            const occ = event.getOccurrenceDetails(next);
            if (isCancelled(occ.item.component)) continue;
            if (!inWindow(occ.startDate)) continue;
            addOccurrence(out, cleanTitle(occ.item.summary), occ.startDate, occ.endDate);
        }
    });

    // Stable order: all-day first, then by start time, then title — so an
    // unchanged calendar always serializes identically.
    Object.values(out).forEach(list => list.sort((a, b) =>
        (a.allDay ? 0 : 1) - (b.allDay ? 0 : 1)
        || String(a.start || '').localeCompare(String(b.start || ''))
        || a.title.localeCompare(b.title)));
    return out;
}
