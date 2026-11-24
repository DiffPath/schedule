# Case Assignment workbook (Excel on the web)

Case lists hold case numbers, which hospital IT counts as PHI, so the day's list is split here, in a
workbook on the hospital's Office 365, and never goes to the scheduling app. The app only publishes
who's working, their services and the case types, and receives each pathologist's totals.

| File | What it is |
|---|---|
| `Case Assignment.xlsx` | The empty workbook: sheets Cases, Assignments, Specimen mix, Settings, List (hidden). No data, no key. |
| `split-cases.ts` | Office Script behind the **Split cases** button. Same rules as the app had (ported from `case-distribution.js`). |
| `specimen-mix.ts` | Office Script behind the **Tally specimen mix** button. |
| `../../functions/case-api.js` | The `caseApi` Cloud Function both scripts call. |

## One-time setup

1. **Key and endpoint** (from the repo folder, Firebase CLI signed in):
   ```
   firebase functions:secrets:set CASE_API_KEY
   firebase deploy --only functions:caseApi
   ```
   Type any long random text as the key when asked, and keep it for step 4.
2. **Upload** `Case Assignment.xlsx` to your OneDrive or a SharePoint folder and open it in the browser.
3. **Scripts:** Automate → New Script → replace the code with `split-cases.ts` → rename it *Split cases* →
   Save → in the script's **…** menu choose *Add in workbook* (puts a button on the sheet). Repeat with
   `specimen-mix.ts` as *Tally specimen mix*.
4. **Settings sheet:** B1 is the endpoint address (check it matches the URL the deploy printed for
   `caseApi`); type the key into B2.
5. **Automation** (`tools/autohotkey/assign-cases.ahk`, kept on the PC): `EXCEL_WINDOW` must be part of the
   workbook tab's title ("Case Assignment"); optionally set `EXCEL_URL` to the workbook's link so it opens
   when it isn't already.

## Every day

- **Ctrl+Shift+1** in Epic: export → paste into Cases → *you click Split cases* → the automation copies the
  result and assigns in Epic.
- By hand: paste Epic's case log at `Cases!A1`, click **Split cases**, read **Assignments**.
- To move a case: pick a different pathologist in its row, click **Split cases** again.
- The app must have been opened by the director within the last ~10 working days (it publishes the team
  then); the script says so if not.
