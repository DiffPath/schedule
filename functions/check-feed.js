// Local sanity check: fetch the feed and print what the sync would store.
//   OUTLOOK_ICS_URL=<url> npm run check
import { parseOutlookIcs } from './outlook.js';

const url = process.env.OUTLOOK_ICS_URL;
if (!url) { console.error('Set OUTLOOK_ICS_URL'); process.exit(1); }
const res = await fetch(url);
if (!res.ok) throw new Error('HTTP ' + res.status);
const days = parseOutlookIcs(await res.text());
const keys = Object.keys(days).sort();
const total = keys.reduce((n, k) => n + days[k].length, 0);
console.log(`${total} meetings on ${keys.length} days (${keys[0]} → ${keys[keys.length - 1]})`);
console.log(`JSON size: ${(JSON.stringify(days).length / 1024).toFixed(0)} KB`);
const today = new Date().toISOString().slice(0, 10);
keys.filter(k => k >= today).slice(0, Number(process.env.SHOW_DAYS || 5)).forEach(k => {
    console.log(k);
    days[k].forEach(m => console.log('   ', m.allDay ? 'all day    ' : `${m.start}-${m.end}`, m.title));
});
