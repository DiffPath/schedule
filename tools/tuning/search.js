// Tune weights directly on the real test: how many cells of the admin's
// hand-built schedules the optimizer gets different.
//
//   node search.js edits-r1.json edits-r3.json [--n 80] [--center fitted-weights.json] [--out best-weights.json]
//   node search.js … --grid      one term at a time from the centre (GRID below)
//
// Scores the live weights, the centre and n random variations around it on
// every scenario, then picks by leave-one-scenario-out (choose the best set
// on the other scenarios, score it on the held-out one).
const fs = require('fs');
const path = require('path');
const { openApp } = require('./browser');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] || '').startsWith('--'));
const N = parseInt(arg('n', '80'), 10);
const center = JSON.parse(fs.readFileSync(arg('center', path.join(__dirname, 'fitted-weights.json')), 'utf8')).weights;
const OUT = arg('out', path.join(__dirname, 'best-weights.json'));
const edits = [];
files.forEach(f => JSON.parse(fs.readFileSync(f, 'utf8')).forEach(e => { if (e.done) edits.push(e); }));

// Terms searched, with ranges for ones not in the centre.
const EXTRA = {
    wfhRepeat: [1, 30], cytoBeforePto: [0.5, 20], repeats: [0.2, 5], rotBigJumps: [0.5, 10],
    friNoMchBefore: [0.5, 20], friAfterPto: [2, 60],
};
const SCALE = ['ptoSingle', 'fair_cyto', 'fair_bigs', 'fair_huntley', 'fair_wfh', 'fri', 'streak', 'stability', 'wfhRepeat'];
let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const sets = [{ name: 'live', w: null }, { name: 'centre', w: center }];
const GRID = {
    changerGain: [0.1, 0.3, 1, 3], othersLoss: [0.03, 0.1, 0.3, 1], tmplDesirDev: [0.03, 0.1, 0.3],
    friNoMchBefore: [0.1, 0.3, 1], cytoBeforePto: [0.05, 0.15, 0.4], rotBigJumps: [3], repeats: [0.15, 0.3, 0.5],
};
if (arg('extra', null)) JSON.parse(arg('extra')).forEach((o, i) => sets.push({ name: 'extra' + i, w: Object.assign({}, center, o) }));
if (process.argv.includes('--grid')) {
    for (const k in GRID) GRID[k].forEach(v => sets.push({ name: k + '=' + v, w: Object.assign({}, center, { [k]: v }) }));
}
for (let i = 0; i < (process.argv.includes('--grid') ? 0 : N); i++) {
    const w = Object.assign({}, center);
    SCALE.forEach(k => { if (w[k]) w[k] *= Math.exp((rnd() - 0.5) * 2.4); });   // ×0.3 … ×3.3
    const fairAll = Math.exp((rnd() - 0.5) * 3);                                   // shared fairness scale
    ['fair_cyto', 'fair_bigs', 'fair_huntley', 'fair_wfh'].forEach(k => { w[k] *= fairAll; });
    for (const k in EXTRA) {
        if (w[k] && !(k in center)) continue;
        if (rnd() < 0.5) { const [lo, hi] = EXTRA[k]; w[k] = lo * Math.pow(hi / lo, rnd()); }
        else if (!(k in center)) w[k] = 0;
    }
    sets.push({ name: 'v' + i, w });
}

(async () => {
    const { page, close } = await openApp();
    const M = [];   // M[scenario][set] = cells wrong
    try {
        for (const e of edits) {
            const t0 = Date.now();
            M.push(await page.evaluate((sp, plan, ws) => tuneScoreWeights(sp, plan, ws), e.spec, e.plan, sets.map(s => s.w)));
            console.error(`${e.id}: live ${M[M.length - 1][0]}, centre ${M[M.length - 1][1]}, best ${Math.min(...M[M.length - 1])}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
        }
    } finally { await close(); }
    const tot = j => M.reduce((a, r) => a + r[j], 0);
    const exact = j => M.filter(r => r[j] === 0).length;
    const order = sets.map((s, j) => j).sort((a, b) => tot(a) - tot(b));
    // Leave-one-scenario-out.
    let loo = 0, looExact = 0;
    M.forEach((r, i) => {
        let bj = 0, bt = Infinity;
        sets.forEach((s, j) => { const t = tot(j) - r[j]; if (t < bt) { bt = t; bj = j; } });
        loo += r[bj]; if (!r[bj]) looExact++;
    });
    const cells = edits.reduce((a, e) => a + Object.values(e.plan).reduce((b, m) => b + Object.keys(m).length, 0), 0);
    console.log(`\n${edits.length} scenarios, ${cells} cells`);
    console.log(`live weights:      ${tot(0)} wrong, ${exact(0)} exact`);
    console.log(`centre (prefill):  ${tot(1)} wrong, ${exact(1)} exact`);
    console.log(`best in-sample:    ${tot(order[0])} wrong, ${exact(order[0])} exact  (${sets[order[0]].name})`);
    console.log(`best, held out:    ${loo} wrong, ${looExact} exact  (pick on the others, score on each)`);
    console.log('\nTop 5:');
    order.slice(0, 5).forEach(j => console.log(`  ${sets[j].name.padEnd(7)} ${tot(j)} wrong  ` + JSON.stringify(sets[j].w, (k, v) => typeof v === 'number' ? +v.toPrecision(3) : v)));
    console.log('\nPer scenario (live / centre / best):');
    edits.forEach((e, i) => console.log(`  ${e.id.padEnd(6)} ${e.kind.padEnd(12)} ${M[i][0]} / ${M[i][1]} / ${M[i][order[0]]}`));
    fs.writeFileSync(OUT, JSON.stringify({ model: 'search ' + sets[order[0]].name, weights: sets[order[0]].w, wrong: tot(order[0]), cells }, null, 1));
    fs.writeFileSync(OUT.replace(/\.json$/, '-matrix.json'), JSON.stringify({ sets, ids: edits.map(e => e.id), M }));
})().catch(e => { console.error(e); process.exit(1); });
