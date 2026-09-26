// Fit optimizer weights to exported trainer answers.
//
//   node fit.js answers.json [more-answers.json ...] [--out fitted-weights.json]
//
// Model: an answer v ∈ {2, 1, 0, −1, −2} (2 = A much better) is explained
// by z = (U(B) − U(A)) / τ, U = Σ w·feature (lower is better). Clear
// answers are logistic observations (weight 2 for "much", 1 for "slightly");
// "about the same" counts half each way, which pulls |z| toward 0.
// Weights are learned in log-space with an L2 pull toward the current
// RC_WEIGHTS (candidates toward ~0), so a thin set of answers can't swing
// them wildly. The stated rules (FIXED) are never learned, and rotation is
// held at 1 as the unit everything else is measured in — otherwise easy
// comparisons (a one-day tweak that breaks the rotation) inflate the scale
// without limit.

const fs = require('fs');
const path = require('path');
const model = require('./model');
const { CURRENT, CANDIDATES, FEATURES, utility } = model;
const FIXED = model.FIXED.concat(['rotation']);

const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] || '').startsWith('--'));
const modelIdx = process.argv.indexOf('--model');
const FORCE = modelIdx > 0 ? process.argv[modelIdx + 1] : null;   // e.g. --model "note rules"
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : path.join(__dirname, 'fitted-weights.json');
if (!files.length) { console.error('usage: node fit.js answers.json [...]'); process.exit(1); }

const answers = [];
files.forEach(f => JSON.parse(fs.readFileSync(f, 'utf8')).forEach(a => answers.push(a)));
const seenQ = new Set();
const data = answers.filter(a => { if (seenQ.has(a.qid)) return false; seenQ.add(a.qid); return true; });
console.log(`${data.length} answers (${data.filter(a => a.v > 0).length} A, ${data.filter(a => a.v < 0).length} B, ${data.filter(a => a.v === 0).length} same)\n`);

const sigma = x => 1 / (1 + Math.exp(-x));
const softplus = x => x > 30 ? x : Math.log1p(Math.exp(x));

// A model = which features are learned, and their prior centre.
function makeModel(name, learn, extraFixed) {
    const prior = {};
    learn.forEach(k => { prior[k] = CURRENT[k] > 0 ? CURRENT[k] : (CANDIDATES[k] ? CANDIDATES[k][0] * 0.05 : 1e-3); });
    return { name, learn, prior, fixed: Object.assign({}, ...FIXED.map(k => ({ [k]: CURRENT[k] })), extraFixed || {}) };
}

// Prior strength (per log-unit²): existing weights are pulled harder than
// candidates, which start near zero.
const LAMBDA_EXISTING = 0.4, LAMBDA_CAND = 0.05;

function weightsOf(model, theta) {
    const w = Object.assign({}, model.fixed);
    model.learn.forEach((k, i) => { w[k] = Math.exp(theta[i]); });
    return w;
}
// Loss and its analytic gradient in (θ = log w for learned features, log τ).
// z = (c + Σ_i w_i Δ_i) / τ with Δ = f(B) − f(A) and c the fixed terms.
function lossGrad(model, x, rows) {
    const nL = model.learn.length;
    const w = model.learn.map((k, i) => Math.exp(x[i]));
    const tau = Math.exp(x[nL]);
    const g = new Array(nL + 1).fill(0);
    let L = 0;
    rows.forEach(a => {
        if (!a._d) {
            a._d = new Map();
        }
        let key = a._d.get(model.name);
        if (!key) {
            key = {
                d: model.learn.map(k => (a.B.f[k] || 0) - (a.A.f[k] || 0)),
                c: Object.keys(model.fixed).reduce((s, k) => s + model.fixed[k] * ((a.B.f[k] || 0) - (a.A.f[k] || 0)), 0),
            };
            a._d.set(model.name, key);
        }
        let u = key.c;
        for (let i = 0; i < nL; i++) u += w[i] * key.d[i];
        const z = u / tau;
        let dz;
        if (a.v === 0) { L += 0.5 * (softplus(-z) + softplus(z)); dz = 0.5 * (sigma(z) - sigma(-z)); }
        else if (a.v > 0) { L += a.v * softplus(-z); dz = -a.v * sigma(-z); }
        else { L += -a.v * softplus(z); dz = -a.v * sigma(z); }
        for (let i = 0; i < nL; i++) g[i] += dz * w[i] * key.d[i] / tau;
        g[nL] += dz * -z;
    });
    model.learn.forEach((k, i) => {
        const lam = CURRENT[k] > 0 ? LAMBDA_EXISTING : LAMBDA_CAND;
        const d = x[i] - Math.log(model.prior[k]);
        L += lam * d * d;
        g[i] += 2 * lam * d;
    });
    return { L, g };
}

// Adam.
function fit(model, rows) {
    const n = model.learn.length + 1;
    const x = model.learn.map(k => Math.log(model.prior[k])).concat([Math.log(5)]);
    const m = new Array(n).fill(0), s = new Array(n).fill(0);
    const lr = 0.05, b1 = 0.9, b2 = 0.999;
    let L = 0;
    for (let it = 1; it <= 1500; it++) {
        const r = lossGrad(model, x, rows);
        const g = r.g;
        L = r.L;
        for (let i = 0; i < n; i++) {
            m[i] = b1 * m[i] + (1 - b1) * g[i];
            s[i] = b2 * s[i] + (1 - b2) * g[i] * g[i];
            x[i] -= lr * (m[i] / (1 - Math.pow(b1, it))) / (Math.sqrt(s[i] / (1 - Math.pow(b2, it))) + 1e-8);
        }
    }
    return { w: weightsOf(model, x.slice(0, -1)), tau: Math.exp(x[n - 1]), loss: L };
}

// How well weights w explain rows: agreement on clear answers, mean log-loss.
function score(w, tau, rows) {
    let agree = 0, clear = 0, ll = 0;
    rows.forEach(a => {
        const z = (utility(w, a.B.f) - utility(w, a.A.f)) / tau;
        const p = Math.min(1 - 1e-9, Math.max(1e-9, sigma(z)));   // P(A better)
        if (a.v !== 0) { clear++; if ((z > 0) === (a.v > 0)) agree++; ll += -Math.log(a.v > 0 ? p : 1 - p); }
        else ll += -0.5 * (Math.log(p) + Math.log(1 - p));
    });
    return { agree, clear, ll: ll / rows.length };
}

// Leave-one-scenario-out predictive score (an A/B answer is its own
// scenario; a hand-built schedule's observations share one group).
const groupOf = a => a.group || a.qid;
const GROUPS = [...new Set(data.map(groupOf))];
function loo(model) {
    let agree = 0, clear = 0, ll = 0;
    GROUPS.forEach(g => {
        const held = data.filter(a => groupOf(a) === g);
        const r = fit(model, data.filter(a => groupOf(a) !== g));
        const s = score(r.w, r.tau, held);
        agree += s.agree; clear += s.clear; ll += s.ll * held.length;
    });
    return { agree, clear, ll: ll / data.length };
}

const LEARN_CURRENT = Object.keys(CURRENT).filter(k => !FIXED.includes(k) && CURRENT[k] > 0);
const ALL_CAND = Object.keys(CANDIDATES);
const models = [
    makeModel('current terms only', LEARN_CURRENT),
    makeModel('current + all candidates', LEARN_CURRENT.concat(ALL_CAND)),
];
models.push(makeModel('current + note rules', LEARN_CURRENT.concat(['wfhRepeat', 'tmplDesirDev', 'cytoBeforePto'])));
models.push(makeModel('current + note rules v2', LEARN_CURRENT.concat(['wfhRepeat', 'cytoBeforePto', 'othersLoss', 'changerGain', 'friAfterPto', 'friNoMchBefore'])));
// One model per candidate, to see which single addition helps most.
ALL_CAND.forEach(k => models.push(makeModel('current + ' + k, LEARN_CURRENT.concat([k]))));

// Baseline: the current weights as they are (τ fitted only).
const curW = Object.assign({}, CURRENT);
let bestTau = 1, bestLL = Infinity;
for (let lt = -3; lt <= 6; lt += 0.05) {
    const s = score(curW, Math.exp(lt), data);
    if (s.ll < bestLL) { bestLL = s.ll; bestTau = Math.exp(lt); }
}
const base = score(curW, bestTau, data);
console.log(`Current RC_WEIGHTS: agree ${base.agree}/${base.clear} clear answers, log-loss ${base.ll.toFixed(3)}\n`);

const doLoo = GROUPS.length <= 80;
const results = models.map(m => {
    const r = fit(m, data);
    return { m, r, s: score(r.w, r.tau, data), l: null };
});
// Cross-validate the two full models and the three best single additions
// (by in-sample fit) — the rest only for small data sets.
if (doLoo) {
    const singles = results.slice(4).sort((a, b) => a.r.loss - b.r.loss);
    const cv = GROUPS.length <= 30 && data.length <= 200 ? results : results.slice(0, 4).concat(singles.slice(0, 3));
    cv.forEach(x => { x.l = loo(x.m); });
}
console.log('Model                                   in-sample     leave-one-out');
results.forEach(({ m, s, l }) => {
    console.log(m.name.padEnd(40) + `${s.agree}/${s.clear} ${s.ll.toFixed(3)}`.padEnd(14)
        + (l ? `${l.agree}/${l.clear} ${l.ll.toFixed(3)}` : ''));
});

// Pick the model with the best leave-one-out log-loss.
const best = FORCE ? results.find(x => x.m.name.includes(FORCE)) : results.filter(x => !doLoo || x.l).sort((a, b) => (a.l ? a.l.ll : a.s.ll) - (b.l ? b.l.ll : b.s.ll))[0];
console.log(`\nBest: ${best.m.name}  (τ = ${best.r.tau.toFixed(2)})\n`);
console.log('Weight               current      fitted');
FEATURES.forEach(k => {
    const c = CURRENT[k] || 0, f = best.r.w[k] || 0;
    if (!c && f < 1e-3) return;
    console.log(k.padEnd(20) + String(+c.toPrecision(3)).padStart(8) + String(+f.toPrecision(3)).padStart(12)
        + (c ? '   ×' + (f / c).toFixed(2) : '   (new)'));
});

// Answers the fitted model still gets clearly wrong.
console.log('\nAnswers the best model can\'t explain (P < 0.3 for your choice):');
data.forEach(a => {
    if (a.v !== 0 && Math.abs(a.v) < 1) return;   // one-day tweaks: too many to list
    const z = (utility(best.r.w, a.B.f) - utility(best.r.w, a.A.f)) / best.r.tau;
    const pA = sigma(z);
    const p = a.v > 0 ? pA : a.v < 0 ? 1 - pA : 1 - Math.abs(pA - 0.5) * 2;
    if (p >= 0.3) return;
    const diff = FEATURES.map(k => [k, (a.A.f[k] || 0) - (a.B.f[k] || 0)]).filter(([, d]) => Math.abs(d) > 1e-6)
        .map(([k, d]) => k + (d > 0 ? ' A+' : ' B+') + +Math.abs(d).toPrecision(3)).join(', ');
    console.log(`  ${a.qid} [${a.kind}] you: ${a.v}  P=${p.toFixed(2)}  ${a.desc}`);
    console.log(`     A=${a.A.labels.join('/')}  B=${a.B.labels.join('/')}`);
    console.log(`     worse-on: ${diff}`);
    if (a.note) console.log(`     note: ${a.note}`);
});

fs.writeFileSync(OUT, JSON.stringify({ model: best.m.name, tau: best.r.tau, weights: best.r.w, n: data.length }, null, 1));
console.log('\nwrote ' + OUT);
