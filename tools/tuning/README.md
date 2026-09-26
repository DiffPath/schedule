# Recompute weight tuning

The scheduler's optimizer (`recompute.js`) chooses between arrangements by adding up weighted costs (`RC_WEIGHTS`). This folder learns those weights from A/B choices made by a human scheduler. None of these files is loaded by the app.

**Preferred: build it yourself (`editor.html`).**
Each scenario gives two editable weeks with one change inside them. You make them exactly what you would publish, then click **Export** and save `edits-r<round>.json` here. Then:
- `node edit.js ingest edits-r1.json --out pairs-edit-r1.json` turns each finished schedule into "mine beats this" observations. The alternatives are the algorithm's plan, variants of it, and every one-day re-arrangement of yours.
- `node fit.js answers-r1.json pairs-edit-r1.json` fits the weights. The A/B answers and the hand-built schedules can be combined.
- `node edit.js check edits-r1.json fitted-weights.json` reports how many cells the optimizer (with current vs. fitted weights) gets different from your schedules. This is the real test.
- `node edit.js gen --round 4 --weights fitted-weights.json` builds the next batch, pre-filled with the optimizer's plan under those weights, so the admin only fixes what's wrong.
- `node search.js edits-r1.json edits-r3.json [--grid | --n 80 | --extra '[{…}]']` scores weight settings directly on the real test: cells of the hand-built schedules the optimizer gets different. Scores are leave-one-scenario-out. **This is what chose the live `RC_WEIGHTS`.** fit.js is only a starting point, because its pairwise comparisons are too easy to tell models apart.

Scenarios rebuild exactly from their seeds. Background recomputes replay the pre-tuning algorithm (`TUNE_LEGACY_W` in page-gen.js), so tuning the live weights never changes what the admin was shown.

**A/B questions (`trainer.html`):**

1. **Answer:** open `trainer.html` in a browser (double-click it). Each question shows one change and two ways the schedule could absorb it; pick the better one. Answers autosave in the browser. When you're done, click **Export answers** and save the file here as `answers-r<round>.json`.
2. **Fit:** run `node fit.js answers-r1.json [answers-r2.json …]`. It reports:
   - how often the current weights agree with the answers,
   - which candidate terms help, such as `templateDrift` (pull back toward the default rotation),
   - the fitted weights,
   - the answers no weighting explains, with their notes.

   It writes `fitted-weights.json`.
3. **Next round:** run `node generate.js --round 2 --weights fitted-weights.json`. This builds new pairs where the fitted weights are least certain.

`generate.js` drives `schedule-mock.html` in headless Chrome, and needs `puppeteer-core` on `NODE_PATH`. It is kept out of the repo, so install it in any scratch folder.

| File | Role |
|---|---|
| `page-gen.js` | Runs inside the mock app. Builds situations, candidate outcomes and raw features. Self-check: the features, weighted by `RC_WEIGHTS`, reproduce the optimizer's own objective. |
| `model.js` | The feature list, current weights, and candidate terms. |
