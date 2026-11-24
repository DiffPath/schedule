// ════════════════════════════════════════════════════════════════════════
// Tally specimen mix — Office Script for the "Case Assignment" workbook
// ════════════════════════════════════════════════════════════════════════
//
// Paste Epic's AP case report (Case · Case Type · Protocols · Case Charges ·
// Assigned Users …) at "Specimen mix"!A1 and click "Tally specimen mix".
// Each case counts once, under its main specimen (the heaviest case type);
// any cytology or FNA case counts as Cytology. Only the counts — per
// pathologist, per case type — go to the app's Specimen mix card (Assign →
// Pathologists); the report is cleared from the sheet afterwards.
// Same rules as the app's cdMixFromText (case-distribution.js).

interface MixType { id: string; name: string; match: string; minutes: number; }
interface MixPerson { id: string; name: string; last: string; }
interface MixDay { types: MixType[]; people: MixPerson[]; constants: { chargeRe: string; stainRe: string; addonRe: string; accRe: string }; }
interface MixEntry { name: string; pid?: number; n: number; types: { [typeKey: string]: number }; }

function mixPhrases(t: MixType): string[] {
    return String(t.match || t.name || '').split(/[;\n]/).map(s => s.trim().toLowerCase()).filter(s => s.length > 0);
}
function mixEscape(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function mixNorm(s: string): string { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

// The pasted report → counts per reader per case type.
function tallyMix(raw: string[][], day: MixDay): { cases: number; years: string; people: { [key: string]: MixEntry } } {
    const chargeRe = new RegExp(day.constants.chargeRe, 'i');
    const stainRe = new RegExp(day.constants.stainRe), addonRe = new RegExp(day.constants.addonRe);
    const accRe = new RegExp(day.constants.accRe, 'i');
    const cache = new Map<string, MixType | null>();
    const match = (text: string): MixType | null => {
        const t = mixNorm(text);
        const hit = cache.get(t);
        if (hit !== undefined) return hit;
        const found: { type: MixType | null; len: number } = { type: null, len: 0 };
        day.types.forEach(type => mixPhrases(type).forEach(ph => {
            if (ph.length <= found.len) return;
            if (new RegExp('(^|[^a-z0-9])' + mixEscape(ph) + '($|[^a-z0-9])').test(t)) { found.type = type; found.len = ph.length; }
        }));
        cache.set(t, found.type);
        return found.type;
    };
    const rows = raw.map(r => r.map(c => String(c === undefined || c === null ? '' : c).replace(/\r\n?/g, '\n')));
    const hi = rows.findIndex(r => r.some(c => /^case$/i.test(c.trim())) && r.some(c => /assigned/i.test(c)));
    if (hi < 0) throw new Error('No header row with Case and Assigned Users: paste the whole AP case report at A1.');
    const head = rows[hi].map(c => c.trim().toLowerCase());
    const col = (re: RegExp) => head.findIndex(c => re.test(c));
    const ci = { id: col(/^case$/), cat: col(/^case type/), proto: col(/protocol/), charge: col(/charge/), who: col(/assigned/) };
    if (ci.id < 0 || ci.who < 0 || (ci.proto < 0 && ci.charge < 0)) throw new Error('The report needs Case, Assigned Users and Protocols or Case Charges columns.');
    const lines = (r: string[], i: number): string[] => (i >= 0 && r[i]) ? r[i].split('\n').map(l => l.trim()).filter(l => l.length > 0) : [];
    const ours = new Map<string, { key: string; pid?: number; name: string }>();
    day.people.forEach(p => {
        if (/^d:/.test(p.id)) return;
        const isLocum = /^l:/.test(p.id);
        ours.set(p.last.toLowerCase(), isLocum ? { key: 'l' + p.id.slice(2), name: p.name } : { key: 'p' + p.id, pid: Number(p.id), name: 'Dr. ' + p.last });
    });
    const people: { [key: string]: MixEntry } = {};
    const years = new Set<string>(), seen = new Set<string>();
    rows.slice(hi + 1).forEach(r => {
        const id = String(r[ci.id] || '').split('\n')[0].trim().toUpperCase();
        if (!accRe.test(id) || seen.has(id)) return;
        const ls = lines(r, ci.who);
        const l = ls.find(x => /staff pathologist/i.test(x)) || ls[0];
        const last = l ? l.split(',')[0].trim() : '';
        if (!last) return;
        const who = ours.get(last.toLowerCase()) || { key: 'x' + last.toLowerCase().replace(/[^a-z0-9]/g, ''), name: 'Dr. ' + last };
        seen.add(id);
        const yy = id.match(/^[A-Z]+-?(\d{2})-/);
        if (yy) years.add('20' + yy[1]);
        let key: string;
        if (ci.cat >= 0 && /cytolog|fine needle|\bfna\b/i.test(String(r[ci.cat] || ''))) key = '_cyto';
        else {
            const names: string[] = [];
            lines(r, ci.charge).forEach(cl => {
                const m = cl.match(chargeRe);
                if (m && (stainRe.test(m[2]) || addonRe.test(m[2]))) return;
                names.push(m ? (m[1].trim() || cl) : cl);
            });
            lines(r, ci.proto).forEach(pl => { if (!names.some(n => mixNorm(n) === mixNorm(pl))) names.push(pl); });
            const best: { type: MixType | null; w: number } = { type: null, w: -1 };
            names.forEach(n => { const t = match(n); const w = t ? Number(t.minutes) || 0 : -1; if (t && w > best.w) { best.type = t; best.w = w; } });
            key = best.type ? best.type.id : '_none';
        }
        if (!people[who.key]) {
            const e: MixEntry = { name: who.name, n: 0, types: {} };
            if (who.pid !== undefined) e.pid = who.pid;
            people[who.key] = e;
        }
        const p = people[who.key];
        p.n++;
        p.types[key] = (p.types[key] || 0) + 1;
    });
    if (!seen.size) throw new Error('No cases found in the pasted report.');
    return { cases: seen.size, years: Array.from(years).sort().join(', '), people };
}

async function main(workbook: ExcelScript.Workbook) {
    const ws = workbook.getWorksheet('Specimen mix');
    const settings = workbook.getWorksheet('Settings');
    if (!ws || !settings) throw new Error('The workbook needs "Specimen mix" and "Settings" sheets.');
    const v = settings.getRange('B1:B2').getTexts();
    const url = String(v[0][0] || '').trim(), key = String(v[1][0] || '').trim();
    if (!url || !key) throw new Error('Settings!B1 (caseApi address) and B2 (key) must be filled in.');
    const used = ws.getUsedRange(true);
    if (!used) throw new Error('Paste the AP case report at "Specimen mix"!A1 first.');

    const res = await fetch(url + '?op=day', { headers: { 'X-Key': key } });
    if (!res.ok) throw new Error('caseApi: ' + res.status + ' ' + (await res.text()));
    const day: MixDay = await res.json();
    const mix = tallyMix(used.getTexts(), day);

    const post = await fetch(url + '?op=mix', {
        method: 'POST', headers: { 'X-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(mix),
    });
    if (!post.ok) throw new Error('caseApi mix: ' + post.status + ' ' + (await post.text()));
    ws.getRange().clear(ExcelScript.ClearApplyTo.contents);
    const msg = 'Specimen mix sent to the app: ' + mix.cases + ' cases (' + mix.years + ') · ' + new Date().toLocaleString();
    ws.getRange('A1').setValue(msg);
    console.log(msg);
}
