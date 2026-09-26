// Shared by generate.js and fit.js: the features, the current weights, and
// how plausible alternative weightings are sampled.
//
// Features come from page-gen.js _tFeatures. Lower weighted sum = better.

// Terms the optimizer uses today (RC_WEIGHTS in recompute.js).
const CURRENT = {
    ptoMulti: 1000, bbWfh: 300, ptoSingle: 60,
    fair_cyto: 0.6, fair_bigs: 0.6, fair_huntley: 1.0, fair_wfh: 2.0,
    fri: 1.0, rotation: 1.0, streak: 4.0, stability: 0.02, templateDrift: 0,
};

// Candidate terms the optimizer doesn't have yet, with a plausible range
// for their weight (used to sample the ensemble).
const CANDIDATES = {
    templateDrift: [0.2, 4],     // distance² from the default rotation
    changedVsBefore: [0.05, 2],  // slots changed vs. the schedule before the change
    changedDays: [0.1, 3],       // days touched
    peopleAffected: [0.5, 8],    // pathologists whose schedule moved
    spreadWorkdays: [0.02, 0.5], // how far past the change the edits reach
    leadInChanges: [0.2, 4],     // edits before the change date
    repeats: [0.3, 5],           // same service two workdays running
    rotBigJumps: [0.5, 8],       // rotation jumps of 2 steps
    desirSpread: [0.5, 8],       // max − min "desirability" surplus in window
    wfhSpread: [0.5, 8],
    huntSpread: [0.5, 8],
    // From the admin's round-1 notes.
    cytoBeforePto: [2, 40],      // Cyto/Gross the day before PTO
    wfhRepeat: [1, 20],          // WFH two workdays running
    tmplWfhDev: [0.5, 10],       // WFH vs. what the default rotation gives on days worked
    tmplHunDev: [0.5, 10],
    tmplDesirDev: [0.1, 3],
    // From the admin's round-3 notes.
    othersLoss: [0.2, 5],        // someone who didn't ask loses desirability vs their rotation
    changerGain: [0.2, 5],       // the requester/PTO taker gains desirability vs their rotation
    friAfterPto: [5, 100],       // Friday Bigs the day back from PTO
    friNoMchBefore: [1, 30],     // Friday Bigs holder not at McHenry the day before
};

// Never learned: these are the rules stated outright.
const FIXED = ['ptoMulti', 'bbWfh'];

const FEATURES = [...new Set([...Object.keys(CURRENT), ...Object.keys(CANDIDATES)])];

function utility(w, f) {
    let u = 0;
    for (const k in w) if (w[k]) u += w[k] * (f[k] || 0);
    return u;
}

// A plausible weighting near `center` (default: CURRENT, candidates off).
function sampleWeights(r, center) {
    const c = center || CURRENT;
    const gauss = () => { let u = 0; for (let i = 0; i < 6; i++) u += r(); return (u - 3) / Math.sqrt(0.5); };
    const w = {};
    FEATURES.forEach(k => {
        if (FIXED.includes(k)) { w[k] = CURRENT[k]; return; }
        const base = c[k] || 0;
        if (base > 0) { w[k] = base * Math.exp(gauss() * 0.9); return; }
        if (CANDIDATES[k] && r() < 0.35) {
            const [lo, hi] = CANDIDATES[k];
            w[k] = lo * Math.pow(hi / lo, r());
        } else w[k] = 0;
    });
    return w;
}

module.exports = { CURRENT, CANDIDATES, FIXED, FEATURES, utility, sampleWeights };
