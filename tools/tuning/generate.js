// Generate A/B preference scenarios for trainer.html.
//
//   node generate.js [--round 1] [--situations 40] [--pairs 60] [--seed 1]
//                    [--weights fitted-weights.json]
//
// Runs page-gen.js inside schedule-mock.html (headless Chrome via
// puppeteer-core — kept out of the repo; point NODE_PATH at a scratch
// node_modules that has it), then picks the pairs where plausible weight
// settings disagree most, i.e. where an answer teaches the most.
// Writes scenarios-r<round>.js (window.SCENARIOS = [...]).

const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { FEATURES, sampleWeights, utility } = require('./model');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const ROUND = parseInt(arg('round', '1'), 10);
const NSIT = parseInt(arg('situations', '40'), 10);
const NPAIRS = parseInt(arg('pairs', '60'), 10);
const SEED = parseInt(arg('seed', String(ROUND * 1000)), 10);
const WEIGHTS = arg('weights', null);
const ROOT = path.resolve(__dirname, '..', '..').replace(/\\/g, '/');

const KINDS = ['pto1', 'ptoFri', 'ptoThuFri', 'ptoFriMon', 'ptoWeek', 'pto2Week', 'ptoTwo',
    'ptoHoliday', 'lockWfh', 'lockHuntley', 'lockWeek', 'ptoRemove',
    'pto1', 'ptoFriMon', 'ptoWeek', 'lockWfh'];

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

async function buildSituations() {
    const profile = path.join(require('os').tmpdir(), 'sched-tune-prof-' + process.pid);
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
        headless: 'new', userDataDir: profile, protocolTimeout: 0,
    });
    try {
        const page = await browser.newPage();
        page.on('pageerror', e => console.error('PAGEERROR', e.message));
        await page.goto('file:///' + ROOT + '/schedule-mock.html');
        await page.waitForSelector('#loginPath');
        await page.evaluate(() => {
            const sel = document.getElementById('loginPath');
            sel.value = [...sel.options].find(o => /Moravek/.test(o.textContent)).value;
            sel.dispatchEvent(new Event('change'));
            document.getElementById('loginPassword').value = 'demo';
        });
        await page.click('#loginSubmit');
        await new Promise(r => setTimeout(r, 1200));
        await page.addScriptTag({ path: path.join(__dirname, 'page-gen.js') });
        const out = [];
        for (let i = 0; i < NSIT; i++) {
            const spec = { id: 'r' + ROUND + 's' + i, seed: SEED + i * 7919, kind: KINDS[i % KINDS.length], bg: i % 2 === 1, v: 2 };
            const t0 = Date.now();
            const s = await page.evaluate(sp => tuneSituation(sp), spec);
            console.error(`${spec.id} ${spec.kind}${spec.bg ? '+bg' : ''}: ${s.cands.length} outcomes, selfCheck ${s.selfCheckErr.toExponential(1)}, ${Date.now() - t0}ms — ${s.desc}`);
            if (s.selfCheckErr > 1e-4) throw new Error('feature self-check failed for ' + spec.id);
            out.push(s);
        }
        return out;
    } finally {
        await browser.close();
        fs.rmSync(profile, { recursive: true, force: true });
    }
}

function visibleDiff(a, b) {
    let n = 0;
    a.grid.forEach((row, i) => row.forEach((v, j) => { if (v !== b.grid[i][j]) n++; }));
    return n;
}

(async () => {
    const sits = await buildSituations();
    const r = rng(SEED);
    const center = WEIGHTS ? JSON.parse(fs.readFileSync(path.resolve(WEIGHTS), 'utf8')).weights : null;
    const ensemble = [];
    for (let i = 0; i < 400; i++) ensemble.push(sampleWeights(r, center));

    // Score every pair within each situation.
    const pool = [];
    sits.forEach(s => {
        const c = s.cands;
        for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) {
            const vis = visibleDiff(c[i], c[j]);
            if (vis === 0) continue;
            let prefI = 0;
            ensemble.forEach(w => { if (utility(w, c[i].f) < utility(w, c[j].f)) prefI++; });
            const p = prefI / ensemble.length;
            const involvesCur = c[i].labels.includes('current') || c[j].labels.includes('current');
            // Too many differing cells makes a pair hard to judge.
            const readability = vis > 40 ? 0.6 : 1;
            pool.push({ s, i, j, p, vis, involvesCur, score: p * (1 - p) * readability * (involvesCur ? 1.3 : 1) });
        }
    });

    // Up to 2 informative pairs per situation, then fill by score.
    pool.sort((a, b) => b.score - a.score);
    const chosen = [], perSit = new Map();
    const take = x => { chosen.push(x); perSit.set(x.s.id, (perSit.get(x.s.id) || 0) + 1); };
    // "Keep the local order" vs "snap back to the default rotation" is the
    // key disruption question: reserve a quarter of the pairs for the
    // current optimizer against a template-pulled outcome.
    const isTmpl = c => c.labels.some(l => l.startsWith('tmpl')) && !c.labels.includes('current');
    const tmplPairs = pool.filter(x => x.involvesCur && (isTmpl(x.s.cands[x.i]) || isTmpl(x.s.cands[x.j])) && x.vis <= 60);
    for (const x of tmplPairs) {
        if (chosen.length >= Math.round(NPAIRS / 4)) break;
        if (perSit.get(x.s.id)) continue;
        take(x);
    }
    for (const x of pool) {
        if (chosen.includes(x)) continue;
        if (chosen.length >= NPAIRS - 8) break;
        if ((perSit.get(x.s.id) || 0) >= 2) continue;
        if (x.score < 0.05) continue;
        take(x);
    }
    // Sanity pairs: ones nearly every plausible weighting agrees on.
    const sure = pool.filter(x => (x.p > 0.97 || x.p < 0.03) && x.involvesCur && x.vis <= 30);
    for (let k = 0; k < sure.length && chosen.length < NPAIRS; k += Math.max(1, Math.floor(sure.length / 8))) {
        if (!chosen.includes(sure[k])) { sure[k].sanity = true; take(sure[k]); }
    }
    // Shuffle order; randomize sides.
    for (let i = chosen.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [chosen[i], chosen[j]] = [chosen[j], chosen[i]]; }

    const scenarios = chosen.map((x, n) => {
        const flip = r() < 0.5;
        const A = flip ? x.s.cands[x.j] : x.s.cands[x.i];
        const B = flip ? x.s.cands[x.i] : x.s.cands[x.j];
        const s = x.s;
        return {
            qid: 'r' + ROUND + 'q' + n, sit: s.id, kind: s.kind, desc: s.desc, from: s.from,
            people: s.people, days: s.days, fridays: s.fridays, mondayAfterBreak: s.mondayAfterBreak,
            before: s.before, marks: s.marks,
            A: { grid: A.grid, beyond: A.beyond, labels: A.labels, f: A.f },
            B: { grid: B.grid, beyond: B.beyond, labels: B.labels, f: B.f },
            sanity: !!x.sanity, pEnsembleA: flip ? 1 - x.p : x.p,
        };
    });
    const file = path.join(__dirname, 'scenarios-r' + ROUND + '.js');
    fs.writeFileSync(file, '// Generated by generate.js — round ' + ROUND + '\nwindow.SCENARIOS = window.SCENARIOS || {};\nwindow.SCENARIOS[' + ROUND + '] = '
        + JSON.stringify(scenarios) + ';\n');
    console.error(`wrote ${scenarios.length} pairs (${scenarios.filter(s => s.sanity).length} sanity) to ${file}`);
    console.error('features: ' + FEATURES.join(', '));
})().catch(e => { console.error(e); process.exit(1); });
