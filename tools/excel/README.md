# Case Assignment workbook (Excel on the web)

Case lists hold case numbers, which hospital IT counts as PHI, so the day's list is split here, in a
workbook on the hospital's Office 365, and never goes to the scheduling app. The app only publishes
who's working, their services and the case types, and receives each pathologist's totals.

| File | What it is |
|---|---|
| `Case Assignment.xlsx` | The empty workbook: sheets Cases, Assignments, Settings. No data, no key. |
| `split-cases.ts` | Office Script behind the **Split cases** button. Same rules as the app had (ported from `case-distribution.js`). |
| `../../functions/case-api.js` | The `caseApi` Cloud Function the script calls. |

## One-time setup

1. **Key and endpoint** (from the repo folder, Firebase CLI signed in):
   ```
   firebase functions:secrets:set CASE_API_KEY
   firebase deploy --only functions:caseApi
   ```
   Type any long random text as the key when asked, and keep it for step 4.
2. **Upload** `Case Assignment.xlsx` to your OneDrive or a SharePoint folder and open it in the browser.
3. **Scripts:** Automate → New Script → replace the code with `split-cases.ts` → rename it *Split cases* →
   Save → in the script's **…** menu choose *Add in workbook* (puts a button on the sheet). Copy the code
   from a plain-text editor (Notepad, VS Code); the file is plain ASCII.
4. **Settings sheet:** B1 is the endpoint address (check it matches the URL the deploy printed for
   `caseApi`); type the key into B2.

## Every day

- Export Epic's case log, paste it at `Cases!A1`, click **Split cases**, then assign in Epic from
  **Assignments** ("Typed in Epic" is the name to enter).
- Assignments can't be changed by hand: the split is final. Pasting the same list again gives the same
  split and replaces its record rather than counting it twice.
- If a script does nothing at all, connect to the hospital VPN and try again (the network can block Excel's script runner).
- The app must have been opened by the director within the last ~10 working days (it publishes the team
  then); the script says so if not.

The case assignment automation (AutoHotkey) is tabled at hospital IT's request. If it returns, it can
copy Assignments directly; its copy-back step (`WaitForSplit`) will need updating to match.
