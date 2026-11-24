// ════════════════════════════════════════════════════════════════════════
// CASE DISTRIBUTION — what the day's case split needs (the Assign page)
// ════════════════════════════════════════════════════════════════════════
//
// Loads after schedule.js (uses its globals: db, pathologists, isAdmin,
// getDayAssignments, ptoAllotmentFor, getAcademicYearOfDate,
// getFiscalYearRange, isWeekend, getFederalHoliday, fmt, parseDate, addDays,
// escapeHtml, showToast, SERVICES, SERVICE_BY_ID, academicYearLabel, today,
// nextWorkday, loggedInPathId).
//
// Case lists hold case numbers, which hospital IT counts as PHI (Nov 2026),
// so the day's list is split in the Case Assignment workbook — Excel on the
// web, on the hospital's Office 365 (tools/excel/split-cases.ts) — and never
// comes here. This page (director only) keeps what the split needs and
// publishes it for the workbook (cdPublish → scheduler/caseDist/publish,
// read through the caseApi function); the workbook sends back only
// per-pathologist totals (the ledger).
//
// The rules (ported line for line into the workbook script; change both):
// each specimen's minutes come from its case type (first unit + each
// additional unit), or from its CPT code when no type matches, nudged by
// #Slides against the typical count. A case type may name services — first
// choice and backup (breast cores → Breast bx/WFH, else Huntley); those
// cases go to whoever is on the service, up to an even day's work; the rest
// is shared so each pathologist's minutes come out equal for their daily
// share (FTE, adjusted for PTO). Types can be limited to certain readers
// (bone marrows); Delnor takes about a quarter on its sign-up days.
//
// Firebase (no patient data):
//   scheduler/caseDist/types/<id>     { name, match, group, minutes, addMinutes, slides, codes,
//                                       basis, readers{pid:true}, services{sid:1|2}, delnor }
//                                     services: 1 = first choice, 2 = backup
//                                     slides: typical per unit; missing = not adjusted
//   scheduler/caseDist/fte/<pathId>   0.1 – 1.0 (missing = 1.0)
//   scheduler/caseDist/epic/<pathId>  what the case assignment automation types in
//                                     Epic's assign window, when not the last name
//   scheduler/caseDist/settings       { defaultMinutes, slideEffect, fnaCellBlockMinutes }
//   scheduler/caseDist/seeded         starter case-type version written (CD_SEED_VERSION)
//   scheduler/caseDist/ledger/<YYYY-MM-DD>/<batchId>
//                                     { minutes{pid}, expected{pid}, cases{pid}, at, by }
//                                     one list's totals, written by the workbook
//   scheduler/caseDist/publish        the team per day, types, settings (cdPublish)

// Starter estimates — minutes of sign-out time for the first unit and each
// additional unit (container, core, margin). Source: Royal College of
// Pathologists, "Guidelines on staffing and workload for histopathology and
// cytopathology departments" (G107, 4th ed., 2015), Appendix 3. It gives
// each specimen type a microscopy time band, measured "from picking up the
// slide and request form to completing the report":
//   1 pt = 1–5 min · 2 = 6–10 · 3 = 11–20 · 5 = 21–30 · 8 = 31–50 · 12 = >50
// Each type here uses its band's midpoint (3, 8, 15, 25, 40, 60 min), and the
// guideline scores each container separately unless it says otherwise.
//
// `slides` is the typical slide count per unit, fitted to 13,305 cases from
// the Oct 2026 Epic AP case report: each case's #Slides as the sum of its
// parts' units × slides, fitted on the log scale so a type's typical case
// sits at factor 1 (lightly pulled toward the median of single-specimen
// cases). Stains are left out — one slide per stain unit came off each
// case's count, since new cases arrive unstained. Body fluid 2 + cell
// block 1 are set so a fluid is always 3 slides (the director's rule).
// FNA and needle-core cases with a cell block were left out of the fit:
// many had ~10 unstained slides cut (they cluster ~10 higher), which new
// cases won't. Needle core is set to 3 from those cut without them. A case with the typical
// count keeps the G107 minutes; see cdSlideFactor(). Bone marrows have none
// and aren't adjusted.
const CD_SEED_VERSION = 12;
const CD_STARTER_TYPES = [
    // Readers are matched by name when the starter list is written;
    // services are [serviceId, 1 = first choice | 2 = backup].
    { name: 'Bone marrow', match: 'bone marrow; marrow', minutes: 65, addMinutes: 15, readers: [/Moravek/i, /Raouf/i],
        basis: 'Trephine 8 pts (31–50 min) + 5 pts (21–30) for a report combining aspirate/flow' },
    { name: 'Mastectomy', match: 'mastectomy', minutes: 40, addMinutes: 10, slides: 21, services: [['bigs', 1]],
        basis: 'Mastectomy for malignancy 8 pts (31–50 min)' },
    { name: 'Breast lumpectomy / excision', match: 'lumpectomy; breast excision; re-excision', minutes: 40, addMinutes: 10, slides: 12.5, services: [['bigs', 1]],
        basis: 'Wide local excision 8 pts (31–50 min)' },
    { name: 'Kidney (nephrectomy)', match: 'kidney; nephrectomy', minutes: 40, addMinutes: 10, slides: 7.5, services: [['bigs', 1]],
        basis: 'Nephrectomy, neoplastic 8 pts (31–50 min)' },
    { name: 'Thyroid resection', match: 'thyroid', minutes: 25, addMinutes: 15, slides: 10.5, services: [['bigs', 1]],
        basis: 'Thyroidectomy for presumed neoplasm 5 pts (21–30 min)' },
    { name: 'Colon resection', match: 'colon resection; colectomy; hemicolectomy', minutes: 15, addMinutes: 8, slides: 8, services: [['bigs', 1]],
        basis: 'Benign colectomy 3 pts (11–20 min); billed 88309 (tumor) counts 40' },
    { name: 'Colon resection, malignant', match: 'colon resection, malignant; colectomy, malignant; hemicolectomy, malignant', minutes: 40, addMinutes: 10, slides: 31, services: [['bigs', 1]],
        basis: 'Colorectal cancer resection 8 pts (31–50 min); billed 88309, a median 31 slides (AP report 2026)' },
    { name: 'Small bowel resection', match: 'small bowel', minutes: 15, addMinutes: 8, slides: 5, services: [['bigs', 1]],
        basis: 'Benign small bowel resection 3 pts (11–20 min); billed 88309 counts 40' },
    { name: 'Prostate biopsy', match: 'prostate biopsy; prostate needle', minutes: 15, addMinutes: 2.5, slides: 5,
        basis: '1 container 3 pts (11–20 min) · 2–6: 5 pts (21–30) · >6: 8 pts (31–50)' },
    { name: 'Breast core biopsy', match: 'breast core', minutes: 15, addMinutes: 15, slides: 12, services: [['wfh', 1], ['huntley', 2]],
        basis: 'Needle core biopsy 3 pts (11–20 min) per container' },
    { name: 'Lymph node', match: 'lymph node', minutes: 15, addMinutes: 8, slides: 3,
        basis: 'Lymph node, H&E + levels 3 pts (11–20 min); billed 88305' },
    { name: 'Sentinel node / dissection / lymphoma', match: 'sentinel node; sentinel lymph node; lymph node dissection; lymph node for lymphoma', minutes: 25, addMinutes: 8, slides: 7,
        basis: 'Sentinel node, node dissection or ?lymphoma 5 pts (21–30 min); billed 88307' },
    { name: 'Placenta', match: 'placenta', minutes: 15, addMinutes: 15, slides: 4.5,
        basis: 'Placenta 3 pts (11–20 min)' },
    { name: 'Bladder TURBT', match: 'transurethral resection; turbt', minutes: 15, addMinutes: 8, slides: 4.5,
        basis: 'TURBT 3 pts (11–20 min)' },
    { name: 'Oral / tongue biopsy', match: 'tongue; mouth, biopsy', minutes: 15, addMinutes: 8, slides: 3.5,
        basis: 'Oral mucosal biopsy, ?dysplasia 3 pts (11–20 min)' },
    { name: 'Femoral head', match: 'femoral head', minutes: 15, addMinutes: 8, slides: 3,
        basis: 'Bone resection, benign 3 pts (11–20 min)' },
    { name: 'Sleeve gastrectomy (stomach, portion)', match: 'stomach, portion; sleeve', minutes: 12, addMinutes: 8, slides: 2,
        basis: 'Gastrectomy, benign 3 pts (11–20 min) — low end, usually 2 slides' },
    { name: 'FNA', match: 'fna; fine needle; thyroid fna', minutes: 15, addMinutes: 15, slides: 5.5, services: [['cyto', 1]],
        basis: 'FNA of solid organ or mass 3 pts (11–20 min) per site' },
    { name: 'Needle core biopsy (cytology)', match: 'needle core biopsy', minutes: 15, addMinutes: 15, slides: 3, services: [['cyto', 1]],
        basis: 'Needle biopsy 3 pts (11–20 min); billed 88305 through its “Cell Block (NWR)” charge (the core has no charge line of its own)' },
    { name: 'Body fluid', match: 'body fluid; fluid; pericardial fluid; pleural fluid; peritoneal fluid', minutes: 15, addMinutes: 8, slides: 2, services: [['cyto', 1]],
        basis: 'Pleural/ascitic/pericardial fluid 3 pts (11–20 min)' },
    { name: 'Bronchial washing / brushing', match: 'bronchial washing; washing; brushing', minutes: 15, addMinutes: 8, slides: 1.5, services: [['cyto', 1]],
        basis: 'Endoscopic brushings and washings 3 pts (11–20 min)' },
    { name: 'Breast margin', match: 'breast margin; margin', minutes: 8, addMinutes: 8, slides: 6.5,
        basis: 'Cavity wall shave 2 pts (6–10 min) per container' },
    { name: 'Breast reduction', match: 'breast reduction', minutes: 8, addMinutes: 8, slides: 3,
        basis: 'Reduction mammoplasty 2 pts (6–10 min) per side' },
    { name: 'Endometrial curettings', match: 'endometrial; endometrium', minutes: 8, addMinutes: 8, slides: 3.5,
        basis: 'Endometrial biopsy/curettage 2 pts (6–10 min)' },
    { name: 'Products of conception', match: 'products of conception; uterine contents', minutes: 8, addMinutes: 8, slides: 3,
        basis: 'POC 2 pts (6–10 min)' },
    { name: 'Temporal artery biopsy', match: 'temporal artery', minutes: 8, addMinutes: 8, slides: 6,
        basis: 'Temporal artery biopsy 2 pts (6–10 min)' },
    { name: 'Heart valve', match: 'aortic leaflets; valve', minutes: 8, addMinutes: 8, slides: 1,
        basis: 'Cardiac valve 2 pts (6–10 min)' },
    { name: 'GI biopsy / polyp', match: 'stomach, biopsy; gastric polyp; duodenal, biopsy; esophagus, biopsy; ge junction; ileum biopsy; terminal ileum; colon biopsy; colon random; rectum, biopsy; colon polyp; rectal polyp; small bowel biopsy; biopsy,duodenum; biopsy, duodenum; jejunum biopsy', minutes: 3, addMinutes: 3, slides: 3,
        basis: 'Mucosal biopsy 1 pot 1 pt (1–5 min) · 2–5 pots 3 pts (11–20) · polyp 1 pt' },
    { name: 'Skin biopsy', match: 'skin', minutes: 3, addMinutes: 3, slides: 4,
        basis: 'Punch/shave biopsy 1 pt (1–5 min) per container' },
    { name: 'Biopsy (H&E levels)', match: 'biopsy h&e 3 levels', minutes: 3, addMinutes: 3, slides: 5,
        basis: 'Small biopsy 1 pt (1–5 min)' },
    { name: 'Gallbladder', match: 'gallbladder', minutes: 3, addMinutes: 3, slides: 2,
        basis: 'Gallbladder 1 pt (1–5 min)' },
    { name: 'Appendix', match: 'appendix', minutes: 3, addMinutes: 3, slides: 2.5,
        basis: 'Appendix 1 pt (1–5 min)' },
    { name: 'Fallopian tubes', match: 'fallopian tube', minutes: 3, addMinutes: 3, slides: 3,
        basis: 'Sterilisation 1 pt (1–5 min); billed 88302' },
    { name: 'Fallopian tube, ectopic', match: 'fallopian tube, ectopic; ectopic pregnancy', minutes: 8, addMinutes: 3, slides: 5.5,
        basis: 'Ectopic pregnancy 2 pts (6–10 min); billed 88305, a median 5.5 slides (AP report 2026)' },
    { name: 'Lipoma / soft tissue', match: 'lipoma; soft tissue', minutes: 3, addMinutes: 3, slides: 2,
        basis: 'Excision for benign disease 1 pt (1–5 min)' },
    { name: 'Nasal contents', match: 'nasal contents', minutes: 3, addMinutes: 3, slides: 1,
        basis: 'Nasal polyps 1 pt (1–5 min) per side; billed 88305' },
    { name: 'Nasal septum', match: 'nasal septum', minutes: 3, addMinutes: 3, slides: 1,
        basis: 'Septum 1 pt (1–5 min); billed 88304 — 1 slide, like nasal contents' },
    { name: 'Adenoids / tonsils', match: 'adenoids; tonsil; tonsils', minutes: 3, addMinutes: 3, slides: 1.5,
        basis: 'Benign tonsils 1 pt (1–5 min) per side' },
    { name: 'Hernia sac', match: 'hernia sac', minutes: 3, addMinutes: 3, slides: 1.5,
        basis: 'Simple benign specimen 1 pt (1–5 min)' },
    { name: 'Two blocks specimen', match: 'two blocks specimen', minutes: 3, addMinutes: 3, slides: 2,
        basis: 'Simple benign specimen 1 pt (1–5 min)' },
    { name: 'Gross only / stones', match: 'gross only; kidney stone; ureteral stone; bladder stone; foreign body; teeth; kidney biopsy', minutes: 1, addMinutes: 0, slides: 0,
        basis: 'No microscopy' },
    { name: 'Cell block', match: 'cell block', minutes: 0, addMinutes: 0, slides: 1, services: [['cyto', 1]],
        basis: 'Included in the cytology specimen’s points' },
    { name: 'ThinPrep slide (non-gyn)', match: 'thinprep (non-gyn)', minutes: 0, addMinutes: 0, slides: 1, services: [['cyto', 1]],
        basis: 'Included in the specimen’s points' },
    // Added Nov 2026 from the Nov 19 Epic AP case report (13,698 cases):
    // every specimen name no type above recognized, grouped by G107 entry.
    // Slides are each type's median in that report (a case's H&E slides less
    // the usual for its other specimens, per unit); add-on lines (an extra
    // block, an H&E level) count 1 slide, and brain tumours use the 88307
    // usual (only 2 cases). Large resections go to Bigs, cytology to Cyto.
    { name: 'Extra block / clot section', match: 'block', minutes: 0, addMinutes: 0, slides: 1,
        basis: 'Included in the specimen’s points (G107 scores the specimen, not its blocks)' },
    { name: 'H&E level (cytology)', match: 'h&e level', minutes: 0, addMinutes: 0, slides: 1,
        basis: 'Included in the cytology specimen’s points' },
    { name: 'Bone biopsy', match: 'bone biopsy', minutes: 15, addMinutes: 8, slides: 3,
        basis: 'Bone biopsy (decalcified) 3 pts (11–20 min)' },
    { name: 'Bone fragments', match: 'bone fragment; bone fragment(s); rib; mandible', minutes: 3, addMinutes: 3, slides: 1,
        basis: 'Bone, benign / incidental 1 pt (1–5 min)' },
    { name: 'Digit amputation', match: 'toe(s), amputation; finger(s), amputation; toe amputation', minutes: 8, addMinutes: 8, slides: 3,
        basis: 'Digit amputation (osteomyelitis/vascular) 2 pts (6–10 min)' },
    { name: 'Digit amputation, traumatic', match: 'finger(s), amputation, traumatic', minutes: 3, addMinutes: 3, slides: 2,
        basis: 'Traumatic amputation 1 pt (1–5 min)' },
    { name: 'Limb amputation', match: 'leg amputation; foot amputation', minutes: 15, addMinutes: 8, slides: 9, services: [['bigs', 1]],
        basis: 'Limb amputation, non-neoplastic 3 pts (11–20 min)' },
    { name: 'Tendon / ganglion / disc', match: 'tendon; ganglion; ganglion cyst; disc', minutes: 3, addMinutes: 3, slides: 1,
        basis: 'Benign soft tissue 1 pt (1–5 min); billed 88304' },
    { name: 'Tenosynovium', match: 'tenosynovium', minutes: 3, addMinutes: 3, slides: 2,
        basis: 'Benign soft tissue 1 pt (1–5 min); billed 88305' },
    { name: 'Arterial plaque', match: 'carotid artery, plaque; artery, plaque; plaque', minutes: 3, addMinutes: 3, slides: 1,
        basis: 'Endarterectomy / atheroma 1 pt (1–5 min)' },
    { name: 'Thrombus / hematoma', match: 'thrombus; hematoma; subdural', minutes: 3, addMinutes: 3, slides: 2,
        basis: 'Simple benign specimen 1 pt (1–5 min)' },
    { name: 'Prostate TURP', match: 'prostate tur; prostate, tur; turp', minutes: 15, addMinutes: 8, slides: 10,
        basis: 'TURP chips 3 pts (11–20 min)' },
    { name: 'Radical prostatectomy', match: 'radical prostatectomy; prostate, radical', minutes: 40, addMinutes: 10, slides: 41, services: [['bigs', 1]],
        basis: 'Radical prostatectomy 8 pts (31–50 min)' },
    { name: 'Vas deferens', match: 'vas deferens', minutes: 3, addMinutes: 3, slides: 1,
        basis: 'Sterilisation 1 pt (1–5 min)' },
    { name: 'Bladder biopsy', match: 'bladder, biopsy; bladder biopsy', minutes: 8, addMinutes: 3, slides: 3,
        basis: 'Bladder biopsy 2 pts (6–10 min)' },
    { name: 'Testis tumor', match: 'testicle tumor; testis tumor; orchiectomy', minutes: 40, addMinutes: 10, slides: 9, services: [['bigs', 1]],
        basis: 'Orchidectomy for tumour 8 pts (31–50 min)' },
    { name: 'Scrotum / foreskin', match: 'scrotum; foreskin', minutes: 3, addMinutes: 3, slides: 1.5,
        basis: 'Simple benign specimen 1 pt (1–5 min); billed 88304' },
    { name: 'Hydrocele', match: 'hydrocele', minutes: 3, addMinutes: 3, slides: 2.5,
        basis: 'Simple benign specimen 1 pt (1–5 min); billed 88302' },
    { name: 'Testis biopsy', match: 'testis, biopsy; testicular biopsy', minutes: 3, addMinutes: 3, slides: 12,
        basis: 'Simple specimen 1 pt (1–5 min); billed 88305, 12 slides (AP report 2026, 1 case)' },
    { name: 'Ureter / urethra', match: 'ureter; urethra', minutes: 3, addMinutes: 3, slides: 6.5,
        basis: 'Benign tubular organ segment 1 pt (1–5 min)' },
    { name: 'Urine cytology', match: 'urine cytology; urine', minutes: 8, addMinutes: 8, slides: 2, services: [['cyto', 1]],
        basis: 'Urine cytology 2 pts (6–10 min)' },
    { name: 'Abscess / aspirate (cytology)', match: 'abscess', minutes: 15, addMinutes: 8, slides: 2, services: [['cyto', 1]],
        basis: 'Non-gynae aspirate 3 pts (11–20 min)' },
    { name: 'Synovial fluid crystals', match: 'crystals', minutes: 3, addMinutes: 3, slides: 1,
        basis: 'Crystal examination 1 pt (1–5 min)' },
    { name: 'Hysterectomy', match: 'uterus, bilateral; uterus, cervix, bilateral; uterus and cervix; uterus, prolapse; hysterectomy', minutes: 15, addMinutes: 8, slides: 12, services: [['bigs', 1]],
        basis: 'Hysterectomy, benign 3 pts (11–20 min); billed 88309 (tumour) counts 40' },
    { name: 'Fibroid (myomectomy)', match: 'uterus, fibroid; fibroid; myomectomy', minutes: 8, addMinutes: 3, slides: 6,
        basis: 'Leiomyoma 2 pts (6–10 min)' },
    { name: 'Cervical LEEP / cone', match: 'cervical leep; leep; cone biopsy', minutes: 15, addMinutes: 8, slides: 6,
        basis: 'Cervical loop excision / cone 3 pts (11–20 min)' },
    { name: 'Cervix / vagina / vulva biopsy', match: 'cervical, biopsy; endocervical curettings; endocervical; cervical polyp; vaginal mucosa; vagina, biopsy; vulva, biopsy', minutes: 8, addMinutes: 3, slides: 3,
        basis: 'Cervical / vulval biopsy, ?dysplasia 2 pts (6–10 min)' },
    { name: 'Ovary / adnexa', match: 'ovary; adnexa', minutes: 8, addMinutes: 8, slides: 3.5,
        basis: 'Ovary 2 pts (6–10 min); billed 88307 (a median 3.5 slides — no more than ovary + tube); 88309 counts 40' },
    { name: 'Ovary + tube / ovarian cyst', match: 'ovary and fallopian tube; ovarian cyst', minutes: 8, addMinutes: 8, slides: 5,
        basis: 'Ovary / ovarian cyst, benign 2 pts (6–10 min); billed 88305' },
    { name: 'Lung biopsy (bronchoscopic)', match: 'lung bronchoscopic biopsy; bronchial, biopsy; transbronchial', minutes: 15, addMinutes: 8, slides: 13,
        basis: 'Bronchial / transbronchial biopsy 3 pts (11–20 min)' },
    { name: 'Lung wedge', match: 'lung wegde; lung wedge', minutes: 25, addMinutes: 8, slides: 4.5, services: [['bigs', 1]],
        basis: 'Lung wedge resection 5 pts (21–30 min)' },
    { name: 'Lung lobectomy', match: 'lung lobectomy; pneumonectomy', minutes: 40, addMinutes: 10, slides: 5, services: [['bigs', 1]],
        basis: 'Lung resection for tumour 8 pts (31–50 min)' },
    { name: 'Pleura', match: 'pleural peel; pleura, biopsy; pleura', minutes: 8, addMinutes: 3, slides: 3,
        basis: 'Pleural biopsy / decortication 2 pts (6–10 min)' },
    { name: 'Mediastinum', match: 'mediastinum', minutes: 15, addMinutes: 8, slides: 7.5,
        basis: 'Mediastinal biopsy 3 pts (11–20 min); billed 88304' },
    { name: 'Thymus', match: 'thymus', minutes: 25, addMinutes: 8, slides: 14,
        basis: 'Thymus 5 pts (21–30 min); billed 88307, 14 slides (AP report 2026, 1 case)' },
    { name: 'Parathyroid', match: 'parathyroid', minutes: 8, addMinutes: 3, slides: 3.5,
        basis: 'Parathyroid 2 pts (6–10 min)' },
    { name: 'Ethmoid / nose biopsy', match: 'ethmoid; nose, biopsy', minutes: 3, addMinutes: 3, slides: 3,
        basis: 'Nasal / sinus tissue, benign 1 pt (1–5 min); billed 88305' },
    { name: 'Turbinates / sinus curettage', match: 'turbinates; turbinate; sinus, curettage; nasal shavings', minutes: 3, addMinutes: 3, slides: 1.5,
        basis: 'Nasal / sinus tissue, benign 1 pt (1–5 min); billed 88304' },
    { name: 'Larynx / trachea / uvula biopsy', match: 'larynx, biopsy; vocal cord biopsy; trachea, biopsy; oropharynx, biopsy; uvula', minutes: 8, addMinutes: 3, slides: 3,
        basis: 'Laryngeal / pharyngeal biopsy 2 pts (6–10 min); billed 88305' },
    { name: 'Pharynx', match: 'pharynx', minutes: 8, addMinutes: 3, slides: 1.5,
        basis: 'Pharyngeal tissue 2 pts (6–10 min); billed 88304' },
    { name: 'Salivary gland biopsy', match: 'submandibular gland; salivary gland, biopsy', minutes: 15, addMinutes: 8, slides: 4,
        basis: 'Salivary gland biopsy 3 pts (11–20 min); billed 88305' },
    { name: 'Parotid gland', match: 'parotid; parotid gland', minutes: 25, addMinutes: 8, slides: 4,
        basis: 'Parotidectomy 5 pts (21–30 min); billed 88307' },
    { name: 'Hemorrhoids', match: 'hemorrhoids; hemorrhoid', minutes: 3, addMinutes: 3, slides: 1,
        basis: 'Haemorrhoids 1 pt (1–5 min)' },
    { name: 'Liver biopsy, medical', match: 'liver biopsy, random; liver biopsy', minutes: 25, addMinutes: 8, slides: 3,
        basis: 'Liver biopsy, medical (with special stains) 5 pts (21–30 min)' },
    { name: 'Liver biopsy, lesion', match: 'liver biopsy, lesion', minutes: 15, addMinutes: 8, slides: 6.5,
        basis: 'Liver biopsy, targeted lesion 3 pts (11–20 min)' },
    { name: 'Colostomy / stoma', match: 'colostomy; stoma', minutes: 3, addMinutes: 3, slides: 5.5,
        basis: 'Stoma reversal, benign 1 pt (1–5 min)' },
    { name: 'Omentum', match: 'omentum', minutes: 8, addMinutes: 3, slides: 2.5,
        basis: 'Omental biopsy 2 pts (6–10 min)' },
    { name: 'Spleen', match: 'spleen; splenectomy', minutes: 15, addMinutes: 8, slides: 6.5,
        basis: 'Splenectomy 3 pts (11–20 min)' },
    { name: 'Adrenal gland', match: 'adrenal', minutes: 25, addMinutes: 8, slides: 7, services: [['bigs', 1]],
        basis: 'Adrenalectomy 5 pts (21–30 min)' },
    { name: 'Pilonidal sinus', match: 'pilonidal', minutes: 3, addMinutes: 3, slides: 2,
        basis: 'Pilonidal sinus 1 pt (1–5 min)' },
    { name: 'Skin / soft tissue, named site', match: 'scalp; lip; areola; umbilicus; perineum; supraclavicular', minutes: 3, addMinutes: 3, slides: 3,
        basis: 'Skin / benign soft tissue 1 pt (1–5 min); billed 88304' },
    { name: 'Abdominoplasty', match: 'abdominoplasty; panniculectomy', minutes: 3, addMinutes: 3, slides: 3,
        basis: 'Skin / benign soft tissue 1 pt (1–5 min); billed 88302' },
    { name: 'Cheek / plantar wart', match: 'cheek; plantar wart', minutes: 3, addMinutes: 3, slides: 3,
        basis: 'Skin / benign soft tissue 1 pt (1–5 min); billed 88305' },
    { name: 'Breast reconstruction', match: 'breast reconstruction; capsule', minutes: 3, addMinutes: 3, slides: 3,
        basis: 'Breast capsule / benign tissue 1 pt (1–5 min)' },
    { name: 'Breast biopsy (not core)', match: 'breast biopsy', minutes: 15, addMinutes: 15, slides: 5, services: [['wfh', 1], ['huntley', 2]],
        basis: 'Breast biopsy 3 pts (11–20 min), routed like the cores' },
    { name: 'Brain biopsy', match: 'brain, biopsy; brain biopsy', minutes: 25, addMinutes: 8, slides: 7,
        basis: 'Brain biopsy 5 pts (21–30 min)' },
    { name: 'Brain / dura / pituitary tumor', match: 'brain, for tumor resection; dura matter, tumor resection; pituitary, tumor; pituitary', minutes: 25, addMinutes: 8, slides: 7,
        basis: 'Neurosurgical tumour resection 5 pts (21–30 min)' },
    { name: 'Dura, non-tumor', match: 'dura matter, other than tumor resection', minutes: 3, addMinutes: 3, slides: 1,
        basis: 'Simple benign specimen 1 pt (1–5 min)' },
    { name: 'Resection for tumor, other', match: 'stomach tumor; radical resection; resection for tumor', minutes: 40, addMinutes: 10, slides: 23.5, services: [['bigs', 1]],
        basis: 'Resection for tumour 8 pts (31–50 min); billed 88309' },
    { name: 'Retroperitoneal mass', match: 'retroperitoneal mass', minutes: 25, addMinutes: 8, slides: 7, services: [['bigs', 1]],
        basis: 'Mass excision 5 pts (21–30 min); billed 88307' },
    // Pericardial tissue (6 cases in the Nov 19 report, all 88304 surgical;
    // fluids come as "Body fluid", which also claims "pericardial fluid").
    { name: 'Pericardium', match: 'pericardial; pericardium', minutes: 3, addMinutes: 3, slides: 3,
        basis: 'Pericardium, benign 1 pt (1–5 min)' },
];
// Phrases added to a customized list's types of these names on upgrade.
// Small bowel and kidney biopsies were matching the resections (and going to
// Bigs); "Tonsils" didn't match "tonsil" (whole words).
const CD_MATCH_ADDITIONS = {
    'FNA': ['thyroid fna'],
    'GI biopsy / polyp': ['small bowel biopsy', 'biopsy,duodenum', 'biopsy, duodenum', 'jejunum biopsy'],
    'Adenoids / tonsils': ['tonsils'],
    'Gross only / stones': ['bladder stone', 'foreign body', 'teeth', 'kidney biopsy'],
    'Products of conception': ['uterine contents'],
    // Ahead of the Pericardium type: a fluid named by its site stays a fluid.
    'Body fluid': ['pericardial fluid', 'pleural fluid', 'peritoneal fluid'],
    'Oral / tongue biopsy': ['mouth, biopsy'],
};
// Starter types added in a seed version: a customized list gets them on
// upgrade (unless it already has a type of that name).
const CD_ADDED_TYPES = {
    6: ['Extra block / clot section', 'H&E level (cytology)', 'Bone biopsy', 'Bone fragments', 'Digit amputation', 'Digit amputation, traumatic', 'Limb amputation', 'Tendon / ganglion / disc', 'Arterial plaque', 'Thrombus / hematoma', 'Prostate TURP', 'Radical prostatectomy', 'Vas deferens', 'Bladder biopsy', 'Testis tumor', 'Scrotum / foreskin', 'Ureter / urethra', 'Urine cytology', 'Abscess / aspirate (cytology)', 'Synovial fluid crystals', 'Hysterectomy', 'Fibroid (myomectomy)', 'Cervical LEEP / cone', 'Cervix / vagina / vulva biopsy', 'Ovary / adnexa', 'Lung biopsy (bronchoscopic)', 'Lung wedge', 'Lung lobectomy', 'Pleura', 'Mediastinum', 'Parathyroid', 'Ethmoid / nose biopsy', 'Larynx / trachea / uvula biopsy', 'Salivary gland biopsy', 'Hemorrhoids', 'Liver biopsy, medical', 'Liver biopsy, lesion', 'Colostomy / stoma', 'Omentum', 'Spleen', 'Adrenal gland', 'Pilonidal sinus', 'Skin / soft tissue, named site', 'Breast reconstruction', 'Breast biopsy (not core)', 'Brain biopsy', 'Brain / dura / pituitary tumor', 'Dura, non-tumor', 'Resection for tumor, other'],
    7: ['Pericardium'],
    // A list that only now gains Ovary / adnexa (from 6) also needs its other half.
    9: ['Ovary + tube / ovarian cyst'],
    11: ['Fallopian tube, ectopic'],
    10: ['Thymus', 'Parotid gland', 'Turbinates / sinus curettage', 'Pharynx', 'Tenosynovium', 'Hydrocele', 'Testis biopsy', 'Abdominoplasty', 'Cheek / plantar wart', 'Retroperitoneal mass'],
};
// Types split in two (seed version 9, from the 2026 AP report: the halves
// bill differently and, for colon and nodes, take far more slides). On
// upgrade the old row becomes "keep" — renamed, narrower words, its code —
// and "add" is created with the old row's services, readers and Delnor
// setting. Minutes and slides change only where still the old starter's;
// an edited value also goes to the new half where it wasn't meant to differ.
// Seed version 10 split the small mixed-code rows the same way, so every
// row carries one billing code.
const CD_SPLITS = [
    { v: 9, from: 'Colon resection', keep: 'Colon resection', add: ['Colon resection, malignant'], was: { minutes: 15, addMinutes: 8, slides: 11.5 } },
    { v: 9, from: 'Sentinel / lymph node', keep: 'Lymph node', add: ['Sentinel node / dissection / lymphoma'], was: { minutes: 15, addMinutes: 8, slides: 3.5 } },
    { v: 9, from: 'Nasal contents / septum', keep: 'Nasal contents', add: ['Nasal septum'], was: { minutes: 3, addMinutes: 3, slides: 1 } },
    { v: 9, from: 'Ovary / adnexa', keep: 'Ovary / adnexa', add: ['Ovary + tube / ovarian cyst'], was: { minutes: 8, addMinutes: 8, slides: 4 } },
    { v: 10, from: 'Mediastinum / thymus', keep: 'Mediastinum', add: ['Thymus'], was: { minutes: 15, addMinutes: 8, slides: 7.5 } },
    { v: 10, from: 'Salivary gland', keep: 'Salivary gland biopsy', add: ['Parotid gland'], was: { minutes: 15, addMinutes: 8, slides: 4 } },
    { v: 10, from: 'Sinus / turbinate / nose', keep: 'Ethmoid / nose biopsy', add: ['Turbinates / sinus curettage'], was: { minutes: 3, addMinutes: 3, slides: 3 } },
    { v: 10, from: 'Larynx / pharynx / trachea biopsy', keep: 'Larynx / trachea / uvula biopsy', add: ['Pharynx'], was: { minutes: 8, addMinutes: 3, slides: 3 } },
    { v: 10, from: 'Tendon / ganglion / disc', keep: 'Tendon / ganglion / disc', add: ['Tenosynovium'], was: { minutes: 3, addMinutes: 3, slides: 1 } },
    { v: 10, from: 'Scrotum / hydrocele / foreskin', keep: 'Scrotum / foreskin', add: ['Hydrocele', 'Testis biopsy'], was: { minutes: 3, addMinutes: 3, slides: 3 } },
    { v: 10, from: 'Skin / soft tissue, named site', keep: 'Skin / soft tissue, named site', add: ['Abdominoplasty', 'Cheek / plantar wart'], was: { minutes: 3, addMinutes: 3, slides: 3 } },
    { v: 10, from: 'Resection for tumor, other', keep: 'Resection for tumor, other', add: ['Retroperitoneal mass'], was: { minutes: 40, addMinutes: 10, slides: 23.5 } },
    // v11: ectopics bill 88305 (CPT Level IV), sterilizations 88302 (Level II).
    { v: 11, from: 'Fallopian tubes', keep: 'Fallopian tubes', add: ['Fallopian tube, ectopic'], was: { minutes: 3, addMinutes: 3, slides: 3 } },
];
// Starter codes changed after they were seeded: [version, type, old, new] —
// a row still showing the old codes gets the new ones.
const CD_CODE_UPDATES = [
    [12, 'FNA', '88173', '88173, 88177'],
];
// Types dropped from the list on upgrade — their lines are priced by CPT
// code (decal and Diff-Quik 0 min; special stains as stains).
const CD_REMOVED_TYPES = ['Decalcification', 'Rapid adequacy slides (Diff-Quik)', 'Special stain'];
// Names from earlier starter lists; a list made only of these, with no
// services set, was never customized and is replaced by the list above.
const CD_OLD_STARTER_NAMES = ['Bone marrow', 'Large resection', 'Lymph node / lymphoma work-up',
    'Consult (outside slides)', 'Prostate biopsy', 'FNA', 'Breast core biopsy', 'Non-gyn cytology',
    'Placenta', 'Skin biopsy', 'Small specimen', 'GI biopsy', 'Pap test',
    'Mastectomy', 'Breast lumpectomy / excision', 'Kidney (nephrectomy)', 'Colon resection',
    'Thyroid resection', 'Small bowel resection', 'Bladder TURBT', 'Needle core biopsy (cytology)',
    'Temporal artery biopsy', 'Sentinel / lymph node', 'Body fluid', 'Bronchial washing / brushing',
    'Oral / tongue biopsy', 'Endometrial curettings', 'Breast reduction',
    'Sleeve gastrectomy (stomach, portion)', 'GI biopsy / polyp', 'Breast margin', 'Cell block',
    'Products of conception', 'Appendix', 'Gallbladder', 'Fallopian tubes', 'Lipoma / soft tissue',
    'Two blocks specimen', 'Nasal contents / septum', 'Femoral head', 'Heart valve',
    'Rapid adequacy slides (Diff-Quik)', 'ThinPrep slide (non-gyn)', 'Extra levels', 'Special stain',
    'Adenoids / tonsils', 'Hernia sac', 'Gross only / stones', 'Decalcification'];

// Medicare RVUs by CPT code — [work RVU, professional (-26) total RVU, the
// facility total for codes billed professional-only] — from the CMS 2026
// National Physician Fee Schedule Relative Value File, October release
// (RVU26D, released 08/26/2026), pathology codes only. The Case types table
// shows the work RVU of each type's billing codes.
const CD_RVU = {
    '85060': [0.44, 0.57], '85097': [0.92, 1.17], '88104': [0.55, 0.80], '88106': [0.36, 0.53],
    '88108': [0.43, 0.64], '88112': [0.55, 0.78], '88120': [1.17, 1.63], '88121': [0.98, 1.36],
    '88125': [0.25, 0.38], '88141': [0.25, 0.72], '88160': [0.49, 0.72], '88161': [0.49, 0.72],
    '88162': [0.74, 1.10], '88172': [0.67, 0.99], '88173': [1.36, 1.96], '88177': [0.41, 0.61],
    '88182': [0.75, 1.05], '88184': [0.00, 2.43], '88185': [0.00, 0.69], '88187': [0.72, 1.05],
    '88188': [1.17, 1.75], '88189': [1.66, 2.37], '88291': [0.51, 0.99], '88300': [0.08, 0.13],
    '88302': [0.13, 0.20], '88304': [0.21, 0.31], '88305': [0.73, 1.05], '88307': [1.55, 2.29],
    '88309': [2.73, 4.03], '88311': [0.23, 0.34], '88312': [0.53, 0.75], '88313': [0.23, 0.34],
    '88314': [0.44, 0.56], '88319': [0.52, 0.76], '88321': [1.59, 2.02], '88323': [1.78, 2.49],
    '88325': [2.78, 3.37], '88329': [0.65, 0.84], '88331': [1.16, 1.73], '88332': [0.58, 0.87],
    '88333': [1.17, 1.72], '88334': [0.71, 1.05], '88341': [0.55, 0.80], '88342': [0.68, 0.98],
    '88344': [0.75, 1.08], '88346': [0.72, 1.00], '88348': [1.47, 2.16], '88350': [0.58, 0.82],
    '88355': [1.80, 2.35], '88356': [2.73, 3.37], '88358': [0.93, 1.38], '88360': [0.83, 1.17],
    '88361': [0.93, 1.21], '88362': [2.12, 3.15], '88363': [0.36, 0.46], '88364': [0.68, 0.95],
    '88365': [0.86, 1.21], '88366': [1.21, 1.73], '88367': [0.71, 0.93], '88368': [0.86, 1.20],
    '88369': [0.68, 0.96], '88371': [0.36, 0.54], '88372': [0.36, 0.53], '88373': [0.57, 0.71],
    '88374': [0.91, 1.18], '88375': [0.89, 1.35], '88377': [1.37, 1.82], '88380': [1.11, 1.45],
    '88381': [0.52, 0.66], '88387': [0.60, 0.76], '89060': [0.36, 0.53],
};

// Each starter case type's billing codes: the CPT codes its specimens were
// billed under on the AP case report of Nov 19 2026 (every code on at least
// 1 in 10 of its specimens, commonest first). Editable per type.
const CD_TYPE_CODES = {
    'Abscess / aspirate (cytology)': '88108',
    'Adenoids / tonsils': '88304',
    'Adrenal gland': '88307',
    Appendix: '88304',
    'Arterial plaque': '88304',
    'Biopsy (H&E levels)': '88305',
    'Bladder TURBT': '88307',
    'Bladder biopsy': '88305',
    'Body fluid': '88108',
    'Bone biopsy': '88305',
    'Bone fragments': '88304',
    'Bone marrow': '88305, 85097',
    'Brain / dura / pituitary tumor': '88307',
    'Brain biopsy': '88307',
    'Breast biopsy (not core)': '88305',
    'Breast core biopsy': '88305',
    'Breast lumpectomy / excision': '88307',
    'Breast margin': '88307',
    'Breast reconstruction': '88305',
    'Breast reduction': '88305',
    'Bronchial washing / brushing': '88104',
    'Cell block': '88305',
    'Cervical LEEP / cone': '88307',
    'Cervix / vagina / vulva biopsy': '88305',
    'Colon resection': '88307',
    'Colon resection, malignant': '88309',
    'Colostomy / stoma': '88304',
    'Digit amputation, traumatic': '88302',
    'Digit amputation': '88305',
    'Dura, non-tumor': '88305',
    'Endometrial curettings': '88305',
    'Extra block / clot section': '88305, 88311',
    // FNA: the read (88173) and the on-site adequacy looks — coders bill each
    // look as 88177 and later change the first to 88172.
    FNA: '88173, 88177',
    'Needle core biopsy (cytology)': '88305',
    'Fallopian tubes': '88302',
    'Fallopian tube, ectopic': '88305',
    'Femoral head': '88304',
    'Fibroid (myomectomy)': '88305',
    'GI biopsy / polyp': '88305',
    Gallbladder: '88304',
    'Gross only / stones': '88300',
    'H&E level (cytology)': '88305',
    'Heart valve': '88305',
    Hemorrhoids: '88304',
    'Hernia sac': '88302',
    Hysterectomy: '88307',
    'Kidney (nephrectomy)': '88307',
    'Larynx / trachea / uvula biopsy': '88305',
    Pharynx: '88304',
    'Limb amputation': '88307',
    'Lipoma / soft tissue': '88304',
    'Liver biopsy, lesion': '88307',
    'Liver biopsy, medical': '88307',
    'Lung biopsy (bronchoscopic)': '88305',
    'Lung lobectomy': '88309',
    'Lung wedge': '88307',
    Mastectomy: '88307',
    Mediastinum: '88304',
    Thymus: '88307',
    'Nasal contents': '88305',
    'Nasal septum': '88304',
    Omentum: '88305',
    'Oral / tongue biopsy': '88305',
    'Ovary / adnexa': '88307',
    'Ovary + tube / ovarian cyst': '88305',
    Parathyroid: '88305',
    Pericardium: '88304',
    'Pilonidal sinus': '88304',
    Placenta: '88307',
    Pleura: '88305',
    'Products of conception': '88305',
    'Prostate TURP': '88305',
    'Prostate biopsy': '88305',
    'Radical prostatectomy': '88309',
    'Resection for tumor, other': '88309',
    'Retroperitoneal mass': '88307',
    'Salivary gland biopsy': '88305',
    'Parotid gland': '88307',
    'Scrotum / foreskin': '88304',
    Hydrocele: '88302',
    'Testis biopsy': '88305',
    'Lymph node': '88305',
    'Sentinel node / dissection / lymphoma': '88307',
    'Ethmoid / nose biopsy': '88305',
    'Turbinates / sinus curettage': '88304',
    'Skin / soft tissue, named site': '88304',
    Abdominoplasty: '88302',
    'Cheek / plantar wart': '88305',
    'Skin biopsy': '88305',
    'Sleeve gastrectomy (stomach, portion)': '88307',
    'Small bowel resection': '88307',
    Spleen: '88305',
    'Synovial fluid crystals': '89060',
    'Temporal artery biopsy': '88305',
    'Tendon / ganglion / disc': '88304',
    Tenosynovium: '88305',
    'Testis tumor': '88309',
    'ThinPrep slide (non-gyn)': '88112',
    'Thrombus / hematoma': '88304',
    'Thyroid resection': '88307',
    'Two blocks specimen': '88304',
    'Ureter / urethra': '88304',
    'Urine cytology': '88108, 88112',
    'Vas deferens': '88302',
};

// Fallback for a part no case type recognizes: [first unit, each additional]
// minutes by CPT code (the export's "88305G" / "88305G.PROSTATE" → 88305),
// using the same G107 bands for the specimens each code usually covers.
// Stains, decalcification, on-site adequacy and frozen sections add no
// sign-out time; immunostains add a little (sentinel node with IHC is 5 pts
// against 3 without).
const CD_CPT_MINUTES = {
    '88300': [1, 0], '88302': [3, 3], '88304': [3, 3], '88305': [8, 3],
    '88307': [25, 8], '88309': [40, 10],
    '88311': [0, 0], '88312': [0, 0], '88313': [0, 0], '88319': [0, 0],
    '88341': [2, 2], '88342': [5, 2], '88344': [5, 2], '88360': [5, 3], '88361': [5, 3],
    '88346': [15, 5], '88350': [5, 3],
    '88104': [8, 8], '88106': [8, 8], '88108': [15, 8], '88112': [0, 0], '88160': [8, 8],
    '88141': [8, 8],
    '88172': [0, 0], '88177': [0, 0], '88333': [0, 0], '88334': [0, 0],
    '88173': [15, 15], '88331': [0, 0], '88332': [0, 0],
    '88321': [15, 8], '88323': [25, 10], '88325': [25, 10],
    '88187': [8, 0], '88188': [15, 0], '88189': [25, 0], '85097': [15, 0],
    // In situ hybridization, priced like the IHC codes: an initial probe
    // like a first stain, each additional like an added one, quantitative
    // (HER2 SISH) like quantitative IHC.
    '88365': [5, 2], '88364': [2, 2], '88366': [5, 2], '88369': [2, 2],
    '88367': [5, 3], '88368': [5, 3], '88373': [5, 3], '88374': [5, 3], '88377': [5, 3],
    // Peripheral smear: read within the bone marrow report (G107 scores the
    // combined marrow report). Synovial crystals: a 1-pt (1–5 min) look.
    '85060': [0, 0], '89060': [3, 3],
};
// A part billed at this level counts at least this many minutes for its
// first unit, whatever its case type says (88309 = resection for tumor,
// G107 8 pts) — so a cancer colectomy isn't scored as a benign one.
const CD_CPT_FLOOR = { '88309': 40 };
const CD_DEFAULT_MINUTES = 8;

// Typical slides per unit for a part no case type matches, by CPT code
// (fitted with the case types above). Stains don't count — see CD_STAIN_RE.
const CD_CPT_SLIDES = {
    '88108': 1.5, '88112': 2, '88172': 1, '88173': 5.5, '88177': 1, '88300': 0, '88302': 1,
    '88304': 1.5, '88305': 4.5, '88307': 7, '88309': 23.5, '88311': 0, '88332': 1.5,
    '88334': 1, '89060': 1.5,
};
const CD_DEFAULT_SLIDES = 1.5;
// Stain and ISH charges (IHC, special stains, ISH) are always priced by
// their CPT code — their names can contain specimen words ("Thyroid
// Transcription Factor-1" is a stain, not a thyroidectomy). They're left
// out of the slide comparison: cases are distributed before stains are
// ordered, so a stain line's slides come off #Slides and add nothing to
// the typical count.
const CD_STAIN_RE = /^(8831[2-9]|8834[1-4]|8836[0-9]|8837[0-7])$/;
// Add-on procedures are priced by their code too, whatever words their line
// has ("Decal Block", "Touch Prep with frozen", "Frozen section, H&E"):
// decalcification, on-site adequacy, frozen sections / touch preps and the
// smear read within a marrow — none adds sign-out time of its own.
const CD_ADDON_RE = /^(88311|88172|88177|8833[1-4]|85060)$/;
// Slides lengthen a case only a little, and each extra slide less than the
// one before — much of the time is the report. Minutes scale by
// (slides ÷ typical slides) ^ effect, kept within CD_SLIDE_RANGE. The
// default 0.25 makes twice the typical slides +19%, four times +41%, half
// −16%; over the Oct 2026 case report total minutes move by under 1%.
const CD_SLIDE_EFFECT = 0.25;
const CD_SLIDE_RANGE = [0.75, 1.5];
// An FNA with a cell block is the harder work-up: it moves from the G107
// FNA band (3 pts, 11–20 min) to the next one (5 pts, 21–30 min), +10 min
// at the midpoints. The FNA and cell block are whatever case types the
// phrases "fna" and "cell block" match.
const CD_FNA_CELL_BLOCK_MINUTES = 10;
// Share of a pathologist's running surplus/deficit worked off per batch, so
// a day the routing couldn't balance evens out over the next few.
const CD_CARRY = 0.5;
const CD_ACC_RE = /^[A-Z]{1,5}-?\d{2,4}-\d{1,8}$/i;   // e.g. XXS26-00000 (letters, year, number)
// One Case Charges line: "Colon polyp, 88305G [AP SURGICAL PATH LEVEL IV] : 2",
// also "CD20 QL, 88341G2 [...] : 1" and "Block, 88305 (CPT®) [...] : 1".
const CD_CHARGE_RE = /^(.*?),?\s*(\d{5})[A-Z]?\d?(?:\.[A-Z0-9]+)?\s*(?:\([^)]*\))?\s*(?:\[[^\]]*\])?\s*:\s*(\d+)\s*$/i;

let cdTypes = {};
let cdFte = {};
let cdEpic = {};
let cdSettings = {};
let cdLedger = {};
let cdPublished = null;        // scheduler/caseDist/publish — what the workbook reads (cdPublish)
let cdLoaded = false;
let _cdRef = null;

// Case lists hold case numbers (PHI, per hospital IT, Nov 2026), so they're
// split in the Case Assignment workbook (Excel on the web, Office 365):
// tools/excel/. This page keeps what the split needs — case types, FTE,
// what's typed in Epic — publishes it (cdPublish) and shows the running
// totals the workbook sends back. No case list ever comes here.
let cdTab = 'people';          // 'people' | 'types'

// ── Firebase ─────────────────────────────────────────────────────────────
// Attached the first time the director opens the page, detached on sign-out.
function cdEnsureListener() {
    if (_cdRef) return;
    _cdRef = db.ref('scheduler/caseDist');
    _cdRef.on('value', snap => {
        const v = snap.exists() ? snap.val() : {};
        cdTypes = v.types || {};
        cdFte = v.fte || {};
        cdEpic = v.epic || {};
        cdSettings = v.settings || {};
        cdLedger = v.ledger || {};
        cdPublished = v.publish || null;
        cdLoaded = true;
        if (v.seeded !== CD_SEED_VERSION && isAdmin()) { cdSeedTypes(v.types, v.seeded); return; }
        cdForgetCaseHashes();
        cdPublishSoon();
        if (cdPageActive()) renderCasesPage();
    }, err => console.error('Firebase caseDist error:', err));
}

function cdSignedOut() {
    if (_cdRef) { try { _cdRef.off('value'); } catch (_) {} }
    _cdRef = null;
    cdLoaded = false;
    cdTypes = {}; cdFte = {}; cdEpic = {}; cdSettings = {}; cdLedger = {};
    cdPublished = null;
    clearTimeout(_cdPubTimer);
    cdSel.types = cdSel.people = null;
}

// Older ledger records carried "sig", a hash of the list's case numbers (to
// spot the same list pasted twice). The workbook keeps that itself now; take
// the old ones out (director, once per session).
let _cdHashesCleared = false;
function cdForgetCaseHashes() {
    if (_cdHashesCleared || !isAdmin()) return;
    _cdHashesCleared = true;
    const up = {};
    Object.entries(cdLedger).forEach(([dk, batches]) => Object.entries(batches || {}).forEach(([bk, b]) => {
        if (b && b.sig !== undefined) up['scheduler/caseDist/ledger/' + dk + '/' + bk + '/sig'] = null;
    }));
    if (Object.keys(up).length) db.ref().update(up).catch(err => console.error('Could not clear old list hashes:', err));
}

// A starter type as stored: services as { id: tier }, readers matched to
// pathologists by name.
function cdStarterRow(t) {
    const row = { name: t.name, match: t.match, minutes: t.minutes, addMinutes: t.addMinutes, basis: t.basis };
    if (t.slides !== undefined) row.slides = t.slides;
    if (CD_TYPE_CODES[t.name]) row.codes = CD_TYPE_CODES[t.name];
    if (t.services) row.services = Object.fromEntries(t.services);
    if (t.readers) {
        const readers = {};
        t.readers.forEach(re => {
            const p = pathologists.find(x => re.test(x.name || ''));
            if (p) readers[p.id] = true;
        });
        if (Object.keys(readers).length) row.readers = readers;
    }
    return row;
}

// Writes the starter case types — the first time, or over an older starter
// list nobody has edited. A customized list is kept: it gets the starter
// slide counts on types that share a starter name and have none, new match
// phrases, and the starter types added since its version (fromVersion).
function cdSeedTypes(existing, fromVersion) {
    const updates = { seeded: CD_SEED_VERSION };
    const old = Object.values(existing || {});
    const untouched = old.every(t => CD_OLD_STARTER_NAMES.includes(t.name) && !t.services
        && (!t.readers || t.name === 'Bone marrow'));
    if (untouched) {
        const types = {};
        CD_STARTER_TYPES.forEach((t, i) => {
            const key = db.ref('scheduler/caseDist/types').push().key || ('t' + i);
            types[key] = cdStarterRow(t);
        });
        updates.types = types;
    } else {
        const have = new Set(old.map(t => cdNorm(t.name)));
        {
            CD_SPLITS.filter(sp => (Number(fromVersion) || 0) < sp.v).forEach(sp => {
                const hit = Object.entries(existing || {}).find(([, t]) => t.name === sp.from);
                if (!hit) return;
                const [id, t] = hit;
                const keep = CD_STARTER_TYPES.find(x => x.name === sp.keep);
                const base = 'types/' + id + '/';
                updates[base + 'name'] = keep.name;
                updates[base + 'match'] = keep.match;
                updates[base + 'codes'] = CD_TYPE_CODES[keep.name];
                updates[base + 'basis'] = keep.basis;
                ['minutes', 'addMinutes', 'slides'].forEach(f => {
                    if (t[f] === undefined || Number(t[f]) === sp.was[f]) updates[base + f] = keep[f];
                });
                have.add(cdNorm(keep.name));
                sp.add.map(n => CD_STARTER_TYPES.find(x => x.name === n)).forEach(add => {
                    if (have.has(cdNorm(add.name))) return;
                    const row = cdStarterRow(add);
                    delete row.services; delete row.readers;
                    // A value the director set on the old row carries over where
                    // the new half wasn't meant to differ from it.
                    ['minutes', 'addMinutes', 'slides'].forEach(f => {
                        if (add[f] === sp.was[f] && t[f] !== undefined && Number(t[f]) !== sp.was[f]) row[f] = t[f];
                    });
                    if (t.services) row.services = t.services;
                    if (t.readers) row.readers = t.readers;
                    if (t.delnor) row.delnor = true;
                    updates['types/' + db.ref('scheduler/caseDist/types').push().key] = row;
                    have.add(cdNorm(add.name));
                });
            });
        }
        for (let v = (Number(fromVersion) || 0) + 1; v <= CD_SEED_VERSION; v++) {
            (CD_ADDED_TYPES[v] || []).forEach(name => {
                const t = CD_STARTER_TYPES.find(x => x.name === name);
                if (!t || have.has(cdNorm(name))) return;
                const key = db.ref('scheduler/caseDist/types').push().key;
                updates['types/' + key] = cdStarterRow(t);
                have.add(cdNorm(name));
            });
        }
        Object.entries(existing || {}).forEach(([id, t]) => {
            const s = CD_STARTER_TYPES.find(x => x.name === t.name);
            if (s && s.slides !== undefined && t.slides === undefined) updates['types/' + id + '/slides'] = s.slides;
            if (t.codes === undefined && CD_TYPE_CODES[t.name]) updates['types/' + id + '/codes'] = CD_TYPE_CODES[t.name];
            CD_CODE_UPDATES.forEach(([v, name, was, now]) => {
                if ((Number(fromVersion) || 0) < v && t.name === name && t.codes === was) updates['types/' + id + '/codes'] = now;
            });
            // "Thyroid FNA" was matching Thyroid resection (longer phrase).
            const phrases = cdPhrases(t);
            const add = (CD_MATCH_ADDITIONS[t.name] || []).filter(p => !phrases.includes(p));
            if (add.length) updates['types/' + id + '/match'] = [String(t.match || '').trim(), ...add].filter(Boolean).join('; ');
            if (CD_REMOVED_TYPES.includes(t.name)) updates['types/' + id] = null;
        });
    }
    db.ref('scheduler/caseDist').update(updates).catch(err => {
        showToast('Could not save the starter case types: ' + err.message, { type: 'error' });
    });
}

function cdPageActive() {
    const app = document.getElementById('app');
    return !!app && app.getAttribute('data-page') === 'cases';
}

// ── Small helpers ────────────────────────────────────────────────────────
function cdFmtMin(m) {
    m = Math.round(m);
    const sign = m < 0 ? '−' : '';
    m = Math.abs(m);
    if (m < 60) return sign + m + ' min';
    const h = Math.floor(m / 60), r = m % 60;
    return sign + h + ' h' + (r ? ' ' + r + ' min' : '');
}

// 3 → "3", 1.5 → "1.5"
function cdNum(m) {
    const r = Math.round(m * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function cdLastName(p) {
    return (p.name || '').replace(/^Dr\.\s*/, '').trim().split(/\s+/).pop() || p.name || '';
}

function cdShortName(p) {
    return 'Dr. ' + cdLastName(p);
}

// What the case assignment automation types for a pathologist in Epic's assign
// window: their whole last name, unless set otherwise on the Pathologists tab.
function cdEpicName(pid) {
    const dp = cdPath(pid);
    if (dp && (dp.delnor || dp.locum)) return String(dp.epic || '').trim() || cdLastName(dp);
    const set = String(cdEpic[pid] || '').trim();
    if (set) return set;
    const p = cdPath(pid);
    return p ? cdLastName(p) : '';
}

// A pathologist — or one of Delnor's ("d:<rid>", from delnor.js's roster),
// as a look-alike record { id, name, color, delnor, rid, epic }.
function cdPath(pid) {
    const s = String(pid);
    if (s.startsWith('d:')) {
        const rid = s.slice(2);
        const r = typeof delnorRoster !== 'undefined' ? delnorRoster[rid] : null;
        return r ? { id: s, name: r.name || '', color: 'var(--delnor)', delnor: true, rid, epic: r.epic || '' } : null;
    }
    if (s.startsWith('l:')) {
        const lid = s.slice(2);
        const r = typeof locumRoster !== 'undefined' ? locumRoster[lid] : null;
        return r ? { id: s, name: r.name || '', color: 'var(--locum)', locum: true, lid, epic: r.epic || '' } : null;
    }
    return pathologists.find(p => String(p.id) === s) || null;
}

// A person's tag: the pathologist's schedule colour, Delnor's teal, a
// locum's indigo.
function cdTag(pid) {
    const p = cdPath(pid);
    if (p && p.delnor) return `<span class="ch-tag ch-tag-delnor" title="Delnor">${escapeHtml(cdShortName(p))}</span>`;
    if (p && p.locum) return `<span class="ch-tag ch-tag-locum" title="Locum">${escapeHtml(cdShortName(p))}</span>`;
    return _pathTagHtml(pid);
}

// Ours by id, then locums, then Delnor's, by name.
function cdPidOrder(a, b) {
    const pa = cdPath(a), pb = cdPath(b);
    const rank = p => (p && p.delnor ? 2 : p && p.locum ? 1 : 0);
    const da = rank(pa), dd = rank(pb);
    if (da !== dd) return da - dd;
    return da ? String(pa.name).localeCompare(String(pb.name)) : (pa ? pa.id : 0) - (pb ? pb.id : 0);
}

function cdDefaultMinutes() {
    const v = Number(cdSettings.defaultMinutes);
    return Number.isFinite(v) && v >= 0 ? v : CD_DEFAULT_MINUTES;
}

// The day the cases are for, in Central time (director, Nov 2026): today
// before 3 pm, the next business day from 3 pm on. A weekend or holiday is
// never the day: a list pulled then is for the next business day. The page
// has no day picker — this alone decides it.
const CD_CUTOFF_HOUR = 15;   // 3 pm
const CD_CENTRAL_TIME = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23',
});
function cdDefaultDate(now = new Date()) {
    const p = {};
    CD_CENTRAL_TIME.formatToParts(now).forEach(x => { p[x.type] = Number(x.value); });
    const d = new Date(p.year, p.month - 1, p.day);
    if (p.hour >= CD_CUTOFF_HOUR || isWeekend(d) || getFederalHoliday(d)) return nextWorkday(d);
    return d;
}

function cdSlideEffect() {
    const v = Number(cdSettings.slideEffect);
    return cdSettings.slideEffect !== undefined && Number.isFinite(v) && v >= 0 ? v : CD_SLIDE_EFFECT;
}

function cdFnaCellBlockMinutes() {
    const v = Number(cdSettings.fnaCellBlockMinutes);
    return cdSettings.fnaCellBlockMinutes !== undefined && Number.isFinite(v) && v >= 0 ? v : CD_FNA_CELL_BLOCK_MINUTES;
}

// The effect as "twice the typical slides adds N%", as the director sets it.
function cdSlideEffectPct(effect) { return Math.round((Math.pow(2, effect) - 1) * 100); }

function cdTypeList() {
    return Object.entries(cdTypes)
        .map(([id, t]) => Object.assign({ id }, t))
        .sort((a, b) => (b.minutes || 0) - (a.minutes || 0)
            || String(a.name || '').localeCompare(String(b.name || '')));
}

// services { sid: 1 | 2 } (legacy true = 1) → [first-choice Set, backup Set],
// or null when the type names no service.
function cdServiceTiers(obj) {
    if (!obj) return null;
    const t1 = new Set(), t2 = new Set();
    Object.entries(obj).forEach(([sid, v]) => {
        if (v === 2) t2.add(sid);
        else if (v) t1.add(sid);
    });
    if (!t1.size && t2.size) return [t2, new Set()];
    return t1.size ? [t1, t2] : null;
}

function cdSvcNames(set) {
    return [...set].map(s => (SERVICE_BY_ID[s] || {}).short || s).join(' / ');
}

function cdSetOf(obj) {
    const keys = obj ? Object.keys(obj).filter(k => obj[k]) : [];
    return keys.length ? new Set(keys.map(String)) : null;
}

// Phrases are separated by semicolons (Epic descriptions contain commas).
function cdPhrases(t) {
    return String(t.match || t.name || '').split(/[;\n]/)
        .map(s => s.trim().toLowerCase()).filter(Boolean);
}

function cdEscapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// The type whose phrase matches the text as whole words; the longest
// phrase wins ("breast core" beats "breast").
function cdMatchType(text) {
    const t = String(text || '').toLowerCase();
    if (!t) return null;
    let best = null, bestLen = 0;
    cdTypeList().forEach(type => {
        cdPhrases(type).forEach(ph => {
            if (ph.length <= bestLen) return;
            const re = new RegExp('(^|[^a-z0-9])' + cdEscapeRe(ph) + '($|[^a-z0-9])');
            if (re.test(t)) { best = type; bestLen = ph.length; }
        });
    });
    return best;
}

// ── FTE and daily share ──────────────────────────────────────────────────
function cdFteOf(pid) {
    const v = Number(cdFte[pid]);
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 1;
}

const _cdWorkdayCache = {};
function cdWorkdaysInFy(fy) {
    if (_cdWorkdayCache[fy]) return _cdWorkdayCache[fy];
    const { start, end } = getFiscalYearRange(fy);
    let n = 0;
    for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
        if (!isWeekend(d) && !getFederalHoliday(d)) n++;
    }
    return (_cdWorkdayCache[fy] = n);
}

// Share of a full-timer's daily load. 1.0 FTE → 1. Part-timers get their
// FTE, scaled up when they take more PTO than the full-timers do, so the
// year still totals FTE × a full-timer's work (capped at a full day).
function cdDailyShare(pid, date) {
    const fte = cdFteOf(pid);
    if (fte >= 1) return 1;
    const fy = getAcademicYearOfDate(date);
    const W = cdWorkdaysInFy(fy);
    const full = pathologists.filter(p => cdFteOf(p.id) >= 1);
    const own = ptoAllotmentFor(pid, fy);
    const ref = full.length
        ? full.reduce((s, p) => s + ptoAllotmentFor(p.id, fy), 0) / full.length
        : own;
    const share = fte * (W - ref) / Math.max(1, W - own);
    return Math.max(0.05, Math.min(1, share));
}

// ── Who is working ───────────────────────────────────────────────────────
// Pathologists on a rotation service that day (PTO, off, off-site and
// freetext assignments don't read cases). The schedule alone decides: to
// change who reads, change the schedule (the director's call, Nov 2026).
function cdScheduled(date) {
    if (!date || isWeekend(date) || getFederalHoliday(date)) return [];
    const day = getDayAssignments(date);
    return pathologists
        .filter(p => day[p.id] && day[p.id].type === 'service' && day[p.id].service)
        .map(p => {
            const svc = day[p.id].service;
            return {
                p,
                svc,
                svcIds: svc.id === 'cytobigs' ? ['cyto', 'bigs'] : [svc.id],
                share: cdDailyShare(p.id, date),
            };
        });
}

// Locums working the day (locums.js): on their service like anyone else
// (usually Bigs, so they get the Bigs cases first — up to an even day),
// a full-timer's share, and no carry-over between days (director, Nov
// 2026). A locum with no service that day just shares the shared cases.
const CD_LOCUM_SVC = { id: 'locum', short: 'Locum', name: 'Locum', cssVar: '--svc-locum' };
function cdLocumWorkers(date) {
    if (!date || typeof locumsOnDay !== 'function') return [];
    return locumsOnDay(date).map(l => {
        const p = cdPath('l:' + l.lid);
        if (!p) return null;
        const svc = l.svc && SERVICE_BY_ID[l.svc] ? SERVICE_BY_ID[l.svc] : CD_LOCUM_SVC;
        return { p, svc, svcIds: [svc.id], share: 1, locum: true };
    }).filter(Boolean);
}

// Delnor's pathologists signed up for the day (delnor.js). Together they
// read about a quarter of the day's case minutes — their shares add up to a
// third of ours — split evenly, and only from the case types allowed to go
// to Delnor (the workbook's split: delnorOK). The director's rule, Nov 2026.
const CD_DELNOR_FRACTION = 0.25;
const CD_DELNOR_SVC = { id: 'delnor', short: 'Delnor', name: 'Delnor', cssVar: '--svc-delnor' };
function cdDelnorWorkers(date) {
    if (!date || typeof delnorOnDay !== 'function') return [];
    const people = delnorOnDay(date).map(r => cdPath('d:' + r.rid)).filter(Boolean);
    if (!people.length) return [];
    const ours = [...cdScheduled(date), ...cdLocumWorkers(date)].reduce((t, w) => t + w.share, 0);
    const total = ours > 0 ? ours * CD_DELNOR_FRACTION / (1 - CD_DELNOR_FRACTION) : 1;
    return people.map(p => ({ p, svc: CD_DELNOR_SVC, svcIds: ['delnor'], share: total / people.length, delnor: true }));
}

// Delnor's sign-ups or the locums changed (delnor.js, locums.js): the
// workbook's copy of the team follows.
function cdDelnorChanged() {
    cdPublishSoon();
    if (cdPageActive()) renderCasesPage();
}

// Running surplus (+) or deficit (−) in minutes this fiscal year, from the
// recorded batches up to and including the distribution date.
function cdBalances(date, skipKey) {
    const { start } = getFiscalYearRange(getAcademicYearOfDate(date));
    const from = fmt(start), to = fmt(date);
    const bal = {}, got = {}, exp = {};
    Object.entries(cdLedger).forEach(([dk, batches]) => {
        if (dk < from || dk > to) return;
        Object.entries(batches || {}).forEach(([bk, b]) => {
            if (bk === skipKey) return;
            Object.entries(b.minutes || {}).forEach(([pid, m]) => { got[pid] = (got[pid] || 0) + m; });
            Object.entries(b.expected || {}).forEach(([pid, m]) => { exp[pid] = (exp[pid] || 0) + m; });
        });
    });
    new Set([...Object.keys(got), ...Object.keys(exp)]).forEach(pid => {
        bal[pid] = (got[pid] || 0) - (exp[pid] || 0);
    });
    return { bal, got, exp };
}

function cdNorm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

const CD_DEAL_TRIES = 40;   // the workbook's Delnor deal: tries (published)

// ── Rendering ────────────────────────────────────────────────────────────
// Laid out like Requests and Conflicts (option A of three mockups, picked
// Nov 2026). A toolbar-height header: the day (‹ › and a date picker), the
// case list's actions (Paste · Export · Record) and the tabs. Day: the list
// on the left in collapsible sections — "Needs a look" first, then one per
// pathologist, each case a ledger line (its case number in their colour ·
// its place in Epic's list · specimens · minutes) that opens to its
// specimens and a pathologist picker; on the right the day's workload, who
// is working, and where this list stands. Case types and Pathologists use
// the same list + panel layout, each line opening to its settings.
const cdSecStore = _tlStore('caseSectionsClosed');
// The open line, per tab. On Day it's "<section>|<case key>": a case can be
// in Needs a look and its pathologist's section, and only the clicked one opens.
const cdSel = { types: null, people: null };

const CD_CHEV = '<svg class="cf-chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function cdTime(ts) {
    return ts ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
}

// One collapsible section, in the timeline pages' markup.
function cdSecHtml(id, labelHtml, count, items, emptyText) {
    const closed = !!cdSecStore.closed[id];
    return `<section class="cf-sec${closed ? ' is-closed' : ''}">
        <h3 class="cf-sec-head"><button type="button" class="cf-sec-toggle" data-cd-sec="${id}" aria-expanded="${!closed}">${CD_CHEV}
          <span class="cf-sec-label">${labelHtml}</span>${count != null ? `<span class="cf-sec-count">${count}</span>` : ''}</button></h3>
        <div class="cf-sec-body"${closed ? ' hidden' : ''}>${items.length ? items.join('') : `<p class="cf-sec-empty">${emptyText || 'Nothing here.'}</p>`}</div>
      </section>`;
}

// One ledger line; the open one (or every one, with open) shows detailFn()
// under it.
function cdLineHtml(tab, key, tagHtml, textHtml, status, detailFn, label, open) {
    const on = open || cdSel[tab] === key;
    return `<div class="cf-item ch-row${on ? ' is-selected' : ''}">
        <button type="button" class="ch-row-main" data-cd-pick="${escapeHtml(key)}" aria-expanded="${on}"${label ? ` aria-label="${escapeHtml(label)}"` : ''}>
          ${tagHtml}<span class="ch-text">${textHtml}</span>${status ? `<span class="ch-status${status.tone ? ' tone-' + status.tone : ''}">${escapeHtml(status.text)}</span>` : ''}
        </button>
        ${on ? `<div class="ch-detail">${detailFn()}</div>` : ''}
      </div>`;
}

// ── Header ──
function cdHeaderHtml() {
    const nTypes = Object.keys(cdTypes).length;
    const tab = (k, label, n) => `<button class="req-tab${cdTab === k ? ' active' : ''}" type="button" data-cd-tab="${k}"><span>${label}</span>${n != null ? `<span class="req-tab-count">${n}</span>` : ''}</button>`;
    return `<header class="tl-header">
        <h2 class="tl-title">Assign</h2>
        <div class="cd-head-right">
          <div class="req-tabs requests-page-tabs" id="cdTabs" role="tablist">
            ${tab('people', 'Pathologists', null)}${tab('types', 'Case types', nTypes)}
          </div>
        </div>
      </header>`;
}

// ── Case types ──
// A table edited in place (the director's ask, Nov 2026): one row per type
// with its columns aligned, in collapsible sections by how it routes, A–Z
// by name unless a column heading says otherwise. The defaults and Add
// case type sit in a strip above; explanations are hover tips.
let cdTypeSort = { key: 'name', dir: 1 };

const CD_TYPE_COLS = [
    { key: 'name', label: 'Case type', sort: true, pad: true, w: 'minmax(150px, 1.3fr)', tip: 'Hover a name for where its minutes come from (RCPath G107 time bands)' },
    { key: 'match', label: 'Recognized by', pad: true, w: 'minmax(140px, 1.7fr)', tip: 'Words in the specimen’s name, separated by ; — whole words; the longest match wins' },
    { key: 'codes', label: 'Billing codes', sort: true, pad: true, w: '112px', tip: 'CPT codes this type is billed under (from the Nov 19 2026 AP report); separate with commas' },
    { key: 'rvu', label: 'Work RVU', sort: true, num: true, pad: true, w: '96px', tip: 'Medicare work RVU of each billing code, in the same order (CMS 2026 fee schedule, October release). Hover for the professional (-26) total' },
    { key: 'minutes', label: 'First', sort: true, num: true, pad: true, w: '68px', tip: 'Minutes for the first unit (container, core, polyp)' },
    { key: 'addMinutes', label: 'Additional', sort: true, num: true, pad: true, w: '84px', tip: 'Minutes for each additional unit' },
    { key: 'slides', label: 'Slides', sort: true, num: true, pad: true, w: '68px', tip: 'Usual slides per unit: more slides take a little longer, fewer a little less (−25% to +50%). Blank: not adjusted' },
    { key: 'services', label: 'Goes to', w: '196px', tip: 'Sent to whoever is on these services. Click a service once for first choice, again for backup (2nd), again to clear' },
    { key: 'readers', label: 'Read by', w: 'calc(var(--cd-readers, 4) * 36px)', tip: 'Only these pathologists read it (bone marrows)' },
    { key: 'delnor', label: 'Delnor', w: '56px', tip: 'May go to Delnor’s pathologists when any are signed up — about a quarter of the day’s case minutes, from these types only' },
];

// A type's billing codes as a list: "88305, 85097" → ['88305', '85097'].
function cdCodeList(t) {
    return String((t && t.codes) || '').toUpperCase().match(/\b\d{4}[0-9A-Z]\b/g) || [];
}
function cdCodeRvu(code) { return CD_RVU[code] || null; }

// Column widths someone dragged (this browser only): { key: px }.
const CD_COLW_KEY = 'cdTypeColWidths';
let cdColW = (() => { try { return JSON.parse(localStorage.getItem(CD_COLW_KEY)) || {}; } catch (_) { return {}; } })();
function cdColTemplate() {
    return CD_TYPE_COLS.map(c => (cdColW[c.key] ? cdColW[c.key] + 'px' : c.w)).join(' ');
}

function cdTypeNum(t, key) {
    if (key === 'rvu') { const r = cdCodeList(t).map(c => cdCodeRvu(c)).filter(Boolean); return r.length ? Math.max(...r.map(x => x[0])) : null; }
    if (key === 'addMinutes') return Number.isFinite(Number(t.addMinutes)) && t.addMinutes !== undefined ? Number(t.addMinutes) : (Number(t.minutes) || 0);
    if (key === 'slides') return t.slides === undefined || t.slides === null || t.slides === '' ? null : Number(t.slides);
    return Number(t.minutes) || 0;
}

function cdTypeOrder(a, b) {
    const byName = String(a.name || '').localeCompare(String(b.name || ''));
    if (cdTypeSort.key === 'name') return cdTypeSort.dir * byName;
    if (cdTypeSort.key === 'codes') {
        const ca = cdCodeList(a).join(' '), cb = cdCodeList(b).join(' ');
        if (!ca !== !cb) return ca ? -1 : 1;           // blanks last either way
        return cdTypeSort.dir * ca.localeCompare(cb) || byName;
    }
    const va = cdTypeNum(a, cdTypeSort.key), vb = cdTypeNum(b, cdTypeSort.key);
    if (cdTypeSort.key === 'rvu' && (va === null) !== (vb === null)) return va === null ? 1 : -1;   // no codes: last
    return cdTypeSort.dir * ((va ?? -1) - (vb ?? -1)) || byName;
}

function cdTypeRow(t) {
    const slides = cdTypeNum(t, 'slides');
    const codes = cdCodeList(t);
    const rv = codes.map(c => ({ c, r: cdCodeRvu(c) }));
    const rvText = rv.map(x => (x.r ? x.r[0].toFixed(2) : '—')).join(', ');
    const rvTip = rv.map(x => (x.r ? `${x.c}: work ${x.r[0].toFixed(2)} · professional total ${x.r[1].toFixed(2)}` : `${x.c}: not in the CMS fee schedule`)).join('\n');
    return `<div class="cd-trow" role="row">
        <input type="text" class="cd-input cd-t-name cd-c-name" id="cdtn-${t.id}" data-cd-field="name" data-cd-type="${t.id}" value="${escapeHtml(t.name || '')}"
            aria-label="Case type name" title="${escapeHtml((t.name || '') + (t.basis ? ' — ' + t.basis : ''))}">
        <input type="text" class="cd-input cd-t-match cd-c-match" data-cd-field="match" data-cd-type="${t.id}" value="${escapeHtml(t.match || '')}"
            placeholder="words in the specimen name; separate with ;" aria-label="Recognized by" title="${escapeHtml(t.match || '')}">
        <input type="text" class="cd-input cd-t-codes cd-c-codes" data-cd-field="codes" data-cd-type="${t.id}" value="${escapeHtml(codes.join(', '))}"
            placeholder="CPT" aria-label="Billing codes" spellcheck="false" autocomplete="off" title="${escapeHtml(codes.join(', '))}">
        <span class="cd-t-rvu cd-c-rvu" title="${escapeHtml(rvTip)}">${rvText}</span>
        <input type="number" class="cd-input cd-t-num cd-c-minutes" data-cd-field="minutes" data-cd-type="${t.id}" min="0" max="600" step="0.5" value="${cdNum(cdTypeNum(t, 'minutes'))}" aria-label="Minutes for the first">
        <input type="number" class="cd-input cd-t-num cd-c-addMinutes" data-cd-field="addMinutes" data-cd-type="${t.id}" min="0" max="600" step="0.5" value="${cdNum(cdTypeNum(t, 'addMinutes'))}" aria-label="Minutes for each additional">
        <input type="number" class="cd-input cd-t-num cd-c-slides" data-cd-field="slides" data-cd-type="${t.id}" min="0" max="500" step="0.5" placeholder="off" value="${slides === null ? '' : cdNum(slides)}" aria-label="Usual slides">
        <span class="cd-t-chips cd-c-services">${cdChips('services', t.id, t.services)}</span>
        <span class="cd-t-chips cd-c-readers">${cdChips('readers', t.id, t.readers)}</span>
        <span class="cd-t-dn cd-c-delnor"><input type="checkbox" class="cd-t-check" data-cd-dn="${t.id}"${t.delnor ? ' checked' : ''} aria-label="May go to Delnor"></span>
      </div>`;
}

function cdTypesViewHtml() {
    const list = cdTypeList().sort(cdTypeOrder);
    const routed = list.filter(t => cdServiceTiers(t.services));
    const readers = list.filter(t => !cdServiceTiers(t.services) && cdSetOf(t.readers));
    const shared = list.filter(t => !cdServiceTiers(t.services) && !cdSetOf(t.readers));
    const head = `<div class="cd-trow cd-thead" role="row">${CD_TYPE_COLS.map(c => {
        const on = cdTypeSort.key === c.key;
        const inner = !c.sort
            ? `<span class="cd-th"${c.tip ? ` title="${escapeHtml(c.tip)}"` : ''}>${c.label}</span>`
            : `<button type="button" class="cd-th cd-th-sort${on ? ' is-on' : ''}" data-cd-tsort="${c.key}" title="${escapeHtml(c.tip)}"
            aria-sort="${on ? (cdTypeSort.dir > 0 ? 'ascending' : 'descending') : 'none'}">${c.label}<span class="cd-sort-arrow">${on ? (cdTypeSort.dir > 0 ? '▲' : '▼') : '↕'}</span></button>`;
        return `<div class="cd-thc cd-c-${c.key}${c.num ? ' num' : ''}${c.pad ? ' pad' : ''}" role="columnheader">${inner}<span class="cd-grip" data-cd-grip="${c.key}" title="Drag to resize · double-click to reset" aria-hidden="true"></span></div>`;
    }).join('')}</div>`;
    const secs = [
        cdSecHtml('t-routed', 'Sent to a service', routed.length, routed.map(cdTypeRow), 'None'),
        cdSecHtml('t-readers', 'Only some pathologists read', readers.length, readers.map(cdTypeRow), 'None'),
        cdSecHtml('t-shared', 'Shared to even out the day', shared.length, shared.map(cdTypeRow), 'None'),
    ].join('');
    const strip = `<div class="cd-tstrip">
        <label title="A specimen no case type recognizes is estimated from its CPT code; this is for one whose code isn’t known either">No case type
          <input type="number" class="cd-input cd-t-num" id="cdDefaultMin" min="0" max="600" step="0.5" value="${cdNum(cdDefaultMinutes())}"> min</label>
        <label title="How much longer a case with twice its usual slides takes (0 = ignore slides)">Twice the usual slides
          <input type="number" class="cd-input cd-t-num" id="cdSlideEffect" min="0" max="100" step="1" value="${cdSlideEffectPct(cdSlideEffect())}"> % longer</label>
        <label title="Moves an FNA with a cell block from the RCPath 11–20 min band to 21–30 min">FNA with a cell block
          <input type="number" class="cd-input cd-t-num" id="cdFnaCbMin" min="0" max="600" step="0.5" value="${cdNum(cdFnaCellBlockMinutes())}"> min more</label>
        <button type="button" class="cd-btn primary" id="cdAddType">Add case type</button>
      </div>`;
    return `<div class="cf-body cd-full">
        <div class="cf-side">${strip}<div class="cf-list cd-types" role="table" aria-label="Case types" style="--cd-readers:${pathologists.filter(p => typeof p.id === 'number').length};--cd-cols:${cdColTemplate()}">${head}${secs}</div></div>
      </div>`;
}

// ── Publishing for the Excel workbook ───────────────────────────────────
// Case lists hold case numbers (PHI, per hospital IT), so they're split in
// an Excel-on-the-web workbook on the hospital's Office 365, never here.
// The app publishes what the split needs and holds no patient data:
//   scheduler/caseDist/publish = { at, days: { 'YYYY-MM-DD': { team } },
//     types, people, services, settings, constants }
// for today and the next working days. The workbook fetches it through the
// caseApi function (functions/index.js) and sends back only per-person
// totals (the ledger). Any director session keeps
// it current: renderAll → cdPublishSoon.
const CD_PUBLISH_DAYS = 10;
let _cdPubTimer = null;

function cdPublishData() {
    const r6 = x => Math.round(x * 1e6) / 1e6;
    const days = {};
    let d = new Date(today);
    if (isWeekend(d) || getFederalHoliday(d)) d = nextWorkday(d);
    for (let i = 0; i < CD_PUBLISH_DAYS; i++, d = nextWorkday(d)) {
        const team = [...cdScheduled(d), ...cdLocumWorkers(d), ...cdDelnorWorkers(d)].map(w => ({
            id: String(w.p.id), name: w.p.name || '', short: cdShortName(w.p), epic: cdEpicName(w.p.id),
            svcIds: w.svcIds.slice(), svc: w.svc ? (w.svc.short || w.svc.name || w.svc.id) : '',
            share: r6(w.share), locum: !!w.locum, delnor: !!w.delnor,
        }));
        days[fmt(d)] = { team };
    }
    const types = cdTypeList().map(t => ({
        id: t.id, name: t.name || '', match: t.match || '',
        minutes: Number(t.minutes) || 0,
        addMinutes: t.addMinutes === undefined || t.addMinutes === null || t.addMinutes === '' ? null : Number(t.addMinutes),
        slides: t.slides === undefined || t.slides === null || t.slides === '' ? null : Number(t.slides),
        codes: cdCodeList(t), services: t.services || null, readers: t.readers || null, delnor: !!t.delnor,
    }));
    const people = [
        ...pathologists.filter(p => typeof p.id === 'number').map(p => ({ id: String(p.id), name: p.name, last: cdLastName(p) })),
        ...(typeof locumRosterList === 'function' ? locumRosterList() : []).map(r => ({ id: 'l:' + r.lid, name: r.name, last: cdLastName(r) })),
        ...(typeof delnorRosterList === 'function' ? delnorRosterList() : []).map(r => ({ id: 'd:' + r.rid, name: r.name, last: delnorLastName(r.name) })),
    ];
    const services = [...SERVICES, ...OFF_SERVICES, SERVICE_BY_ID.cytobigs, CD_LOCUM_SVC, CD_DELNOR_SVC].filter(Boolean)
        .map(s => ({ id: s.id, short: s.short || s.name || s.id }));
    return {
        days, types, people, services,
        settings: { defaultMinutes: cdDefaultMinutes(), slideEffect: cdSlideEffect(), fnaCellBlockMinutes: cdFnaCellBlockMinutes() },
        constants: {
            cptMinutes: CD_CPT_MINUTES, cptFloor: CD_CPT_FLOOR, cptSlides: CD_CPT_SLIDES, defaultSlides: CD_DEFAULT_SLIDES,
            rvu: CD_RVU, stainRe: CD_STAIN_RE.source, addonRe: CD_ADDON_RE.source, chargeRe: CD_CHARGE_RE.source,
            accRe: CD_ACC_RE.source, slideRange: CD_SLIDE_RANGE, carry: CD_CARRY, delnorFraction: CD_DELNOR_FRACTION,
            dealTries: CD_DEAL_TRIES, cutoffHour: CD_CUTOFF_HOUR,
        },
    };
}

// Write it when it changed (a director session only; debounced).
function cdPublishSoon() {
    if (typeof isAdmin !== 'function' || !isAdmin()) return;
    cdEnsureListener();
    clearTimeout(_cdPubTimer);
    _cdPubTimer = setTimeout(cdPublish, 1500);
}
function cdPublish() {
    if (!isAdmin() || !cdLoaded || !pathologistsReady || !vacationsReady) return;
    if (typeof delnorReady !== 'undefined' && !delnorReady) return;
    let data;
    try { data = JSON.parse(JSON.stringify(cdPublishData())); }
    catch (err) { console.error('Could not build the workbook data:', err); return; }
    // Firebase hands lists back as objects and drops empty values, so compare
    // a fingerprint of what was sent, not the stored copy.
    const json = JSON.stringify(data);
    let h = 2166136261;
    for (let i = 0; i < json.length; i++) { h ^= json.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    data.sig = h.toString(36) + '-' + json.length;
    if (cdPublished && cdPublished.sig === data.sig) return;
    data.at = Date.now();
    db.ref('scheduler/caseDist/publish').set(data).catch(err => console.error('Could not publish for the workbook:', err));
}

// ── Pathologists ──
// When the workbook last had something from here, and sent something back.
function cdWorkbookCard() {
    const t = ts => { const d = new Date(ts); return MONTHS_SHORT[d.getMonth()] + ' ' + d.getDate() + ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
    let last = null;
    Object.entries(cdLedger).forEach(([dk, batches]) => Object.values(batches || {}).forEach(b => {
        if (b && b.at && (!last || b.at > last.at)) last = { dk, at: b.at, n: Object.values(b.cases || {}).reduce((s, x) => s + (Number(x) || 0), 0) };
    }));
    const days = cdPublished && cdPublished.days ? Object.keys(cdPublished.days).sort() : [];
    const day = k => _cfDayShort(parseDate(k));
    return `<section class="cd-card"><h3 class="cd-card-h">Case Assignment workbook</h3>
        <div class="cd-form cd-wb">
          <label>Team sent</label><span>${cdPublished && cdPublished.at ? escapeHtml(t(cdPublished.at)) + (days.length ? ' · ' + escapeHtml(day(days[0]) + ' – ' + day(days[days.length - 1])) : '') : 'Not yet'}</span>
          <label>Last list</label><span>${last ? escapeHtml(day(last.dk)) + ' · ' + last.n + ' cases · ' + escapeHtml(t(last.at)) : 'None yet'}</span>
        </div></section>`;
}

function cdPeopleViewHtml() {
    const date = cdDefaultDate();
    const fy = getAcademicYearOfDate(date);
    const { got, exp } = cdBalances(date);
    const people = pathologists.filter(p => typeof p.id === 'number');
    const balOf = p => (got[p.id] || 0) - (exp[p.id] || 0);
    const balTxt = b => Math.abs(b) < 1 ? 'even' : (b > 0 ? cdFmtMin(b) + ' ahead' : cdFmtMin(-b) + ' behind');
    const detail = p => () => `<div class="cd-form">
        <label for="cdf-${p.id}">FTE</label>
        <span><input type="number" class="cd-input cd-input-fte" id="cdf-${p.id}" data-cd-fte="${p.id}" min="0.1" max="1" step="0.05" value="${cdFteOf(p.id)}"> <span class="cd-muted">daily share ${cdDailyShare(p.id, date).toFixed(2)}</span></span>
        <label for="cde-${p.id}">Typed in Epic</label>
        <input type="text" class="cd-input cd-input-epic" id="cde-${p.id}" data-cd-epic="${p.id}" value="${escapeHtml(cdEpic[p.id] || '')}" placeholder="${escapeHtml(cdLastName(p))}" spellcheck="false" autocomplete="off">
        <label>PTO days ${escapeHtml(academicYearLabel(fy))}</label><span>${ptoAllotmentFor(p.id, fy)}</span>
        <label>This year</label><span>${escapeHtml(cdFmtMin(got[p.id] || 0))} assigned · fair share ${escapeHtml(cdFmtMin(exp[p.id] || 0))}</span>
      </div>`;
    const lines = people.map(p => cdLineHtml('people', String(p.id), _pathTagHtml(p.id),
        `<b>FTE ${cdNum(cdFteOf(p.id))}</b><span class="ch-dates"> · types “${escapeHtml(cdEpicName(p.id))}” in Epic</span>`,
        { text: balTxt(balOf(p)), tone: '' }, detail(p), cdShortName(p)));
    const max = Math.max(30, ...people.map(p => Math.abs(balOf(p)))) * 1.1;
    const panel = `<div class="cd-panel">
        <section class="cd-card">
          <h3 class="cd-card-h">Ahead / behind <span>${escapeHtml(academicYearLabel(fy))}</span></h3>
          <div class="cd-load cd-load-bal">
            ${people.map(p => {
                const b = balOf(p), w = Math.abs(b) / max * 50;
                return `${_pathTagHtml(p.id)}<div class="cd-bar"><span class="cd-bar-fill" style="margin-left:${b < 0 ? 50 - w : 50}%;width:${w.toFixed(1)}%;--c:${p.color};"></span><span class="cd-bar-target" style="left:50%;"></span></div>
                  <span class="cd-load-num">${b > 0 ? '+' : ''}${escapeHtml(cdFmtMin(b))}</span><span></span>`;
            }).join('')}
          </div>
        </section>
        ${cdWorkbookCard()}
        <section class="cd-card"><p class="cd-help-text">A full-time pathologist has a daily share of 1. A part-timer’s share is their FTE, raised when they take more PTO than the full-timers so the year still comes to FTE × a full-timer’s work (never more than a full day). Half of anyone’s lead or lag is worked off with each new list. “Typed in Epic” is what the case assignment automation types in Epic’s case assignment window. Blank means the last name.</p></section>
      </div>`;
    const dnLines = (typeof delnorRosterList === 'function' ? delnorRosterList() : []).map(r => cdLineHtml('people', 'd:' + r.rid, cdTag('d:' + r.rid),
        `<b>Delnor</b><span class="ch-dates"> · types “${escapeHtml(cdEpicName('d:' + r.rid))}” in Epic</span>`, null,
        () => `<div class="cd-form">
            <label>Name</label><span>${escapeHtml(r.name)} <span class="cd-muted">(names are kept on the Delnor sign-up page)</span></span>
            <label for="cdde-${r.rid}">Typed in Epic</label>
            <input type="text" class="cd-input cd-input-epic" id="cdde-${r.rid}" data-dn-epic="${r.rid}" value="${escapeHtml(r.epic || '')}" placeholder="${escapeHtml(delnorLastName(r.name))}" spellcheck="false" autocomplete="off">
          </div>`, r.name));
    const lcLines = (typeof locumRosterList === 'function' ? locumRosterList() : []).map(r => cdLineHtml('people', 'l:' + r.lid, cdTag('l:' + r.lid),
        `<b>Locum</b><span class="ch-dates"> · types “${escapeHtml(cdEpicName('l:' + r.lid))}” in Epic</span>`, null,
        () => `<div class="cd-form">
            <label for="cdln-${r.lid}">Name</label>
            <input type="text" class="cd-input cd-input-epic" id="cdln-${r.lid}" data-lc-name="${r.lid}" value="${escapeHtml(r.name)}" autocomplete="off">
            <label for="cdle-${r.lid}">Typed in Epic</label>
            <input type="text" class="cd-input cd-input-epic" id="cdle-${r.lid}" data-lc-epic="${r.lid}" value="${escapeHtml(r.epic || '')}" placeholder="${escapeHtml(cdLastName(r))}" spellcheck="false" autocomplete="off">
          </div>`, r.name));
    return `<div class="cf-body"><div class="cf-side"><div class="cf-list" aria-label="Pathologists">${cdSecHtml('people', 'Pathologists', people.length, lines)}${lcLines.length ? cdSecHtml('people-locum', 'Locums', lcLines.length, lcLines) : ''}${dnLines.length ? cdSecHtml('people-delnor', 'Delnor pathologists', dnLines.length, dnLines) : ''}</div></div>
        <section class="cf-cal" aria-label="Ahead or behind">${panel}</section></div>`;
}

function renderCasesPage() {
    const root = document.getElementById('cdRoot');
    if (!root) return;
    if (!isAdmin()) { cdSetRoot(root, ''); return; }
    cdEnsureListener();
    if (!cdLoaded) { cdSetRoot(root, cdHeaderHtml() + '<div class="cd-empty">Loading…</div>'); return; }

    // Don't yank an input out from under the director mid-edit; the commit
    // that ends the edit re-renders.
    const active = document.activeElement;
    if (active && root.contains(active) && active.matches('input[type="text"], input[type="number"], textarea')) return;

    const html = cdHeaderHtml() + (cdTab === 'types' ? cdTypesViewHtml() : cdPeopleViewHtml());
    // The app redraws every page whenever schedule data arrives (often, on
    // the live site). Nothing changed → leave the page alone: replacing it
    // anyway swallowed clicks mid-press, flickered hovers and reset scrolls.
    if (root._cdHtml === html) return;
    // Keep the list's and panel's scroll when redrawing the same tab.
    const keep = root.dataset.tab === cdTab;
    const list = root.querySelector('.cf-list'), side = root.querySelector('.cf-cal');
    const ls = keep && list ? list.scrollTop : 0, ss = keep && side ? side.scrollTop : 0;
    root.dataset.tab = cdTab;
    cdSetRoot(root, html);
    const l2 = root.querySelector('.cf-list'), s2 = root.querySelector('.cf-cal');
    if (l2) l2.scrollTop = ls;
    if (s2) s2.scrollTop = ss;
}

function cdSetRoot(root, html) {
    if (root._cdHtml === html) return;
    root.innerHTML = html;
    root._cdHtml = html;
}

// Readers / services chips used on the Case types tab.
function cdChips(kind, typeId, selected) {
    const items = kind === 'readers'
        ? pathologists.filter(p => typeof p.id === 'number').map(p => ({ id: String(p.id), label: p.initials || cdShortName(p), title: cdShortName(p), c: p.color }))
        : SERVICES.map(s => ({ id: s.id, label: s.abbr, title: s.name, c: 'var(' + s.cssVar + ')' }));
    const set = cdSetOf(selected);
    // Services: 1 = first choice (filled), 2 = backup (dashed, "2nd").
    const tier = id => {
        if (!set || !set.has(id)) return 0;
        return kind === 'services' && selected[id] === 2 ? 2 : 1;
    };
    const tip = (it, n) => kind !== 'services' ? it.title
        : it.title + (n === 1 ? ' — first choice · click for backup' : n === 2 ? ' — backup · click to remove' : ' — click to make first choice');
    return `<div class="cd-chips">` + items.map(it => {
        const n = tier(it.id);
        return `
        <button type="button" class="cd-chip${n === 1 ? ' on' : n === 2 ? ' backup' : ''}" style="--c:${it.c};"
            data-cd-chip="${kind}" data-cd-type="${typeId}" data-cd-val="${escapeHtml(it.id)}" data-cd-tier="${n}"
            title="${escapeHtml(tip(it, n))}">${escapeHtml(it.label)}${n === 2 ? '<sup>2nd</sup>' : ''}</button>`;
    }).join('')
        + `<span class="cd-chip-any">${set ? '' : (kind === 'readers' ? 'anyone' : 'any service')}</span></div>`;
}

// From a specimen name, the new type starts at that specimen's CPT estimate.
function cdAddType(fromText, code) {
    const ref = db.ref('scheduler/caseDist/types').push();
    const name = fromText ? fromText.slice(0, 60) : 'New case type';
    const [first, add] = (code && CD_CPT_MINUTES[code]) || [cdDefaultMinutes(), cdDefaultMinutes()];
    const slides = code && CD_CPT_SLIDES[code] !== undefined ? CD_CPT_SLIDES[code] : CD_DEFAULT_SLIDES;
    const row = { name, match: fromText ? cdNorm(fromText).replace(/;/g, ' ') : '', minutes: first, addMinutes: add, slides };
    if (code) row.codes = code;
    ref.set(row)
        .then(() => {
            if (fromText) showToast('Added “' + name + '” at ' + cdNum(first) + ' min — adjust it on the Case types tab.');
            else {
                cdTab = 'types';
                cdSel.types = ref.key;
                renderCasesPage();
                if (cdSecStore.closed['t-shared']) { cdSecStore.set('t-shared', false); renderCasesPage(); }
                const el = document.getElementById('cdtn-' + ref.key);
                if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); el.select(); }
            }
        })
        .catch(err => showToast('Could not add the case type: ' + err.message, { type: 'error' }));
}

// Settings changed (types, FTE, defaults) → the workbook's copy follows.
function cdAfterSettingsChange() {
    cdPublishSoon();
}

// ── Wiring ───────────────────────────────────────────────────────────────
(function initCaseDistribution() {
    const root = document.getElementById('cdRoot');
    if (!root) return;

    root.addEventListener('change', e => {
        const el = e.target;
        if (el.dataset.cdField) {
            const f = el.dataset.cdField;
            let v = el.value;
            if (f === 'minutes' || f === 'addMinutes') {
                v = Math.round(Number(v) * 10) / 10;
                if (!Number.isFinite(v) || v < 0) { showToast('Minutes must be 0 or more.', { type: 'error' }); return; }
            } else if (f === 'slides') {
                // Blank = this type isn't adjusted for slides.
                if (v.trim() === '') v = null;
                else {
                    v = Math.round(Number(v) * 10) / 10;
                    if (!Number.isFinite(v) || v < 0) { showToast('Slides must be 0 or more, or blank.', { type: 'error' }); return; }
                }
            } else if (f === 'codes') {
                const list = String(v).toUpperCase().match(/\b\d{4}[0-9A-Z]\b/g) || [];
                if (v.trim() && !list.length) { showToast('Billing codes are 5-character CPT codes, like 88305.', { type: 'error' }); return; }
                v = [...new Set(list)].join(', ');
                el.value = v;
            } else v = v.replace(/\s+/g, ' ').trim();
            if (f === 'name' && !v) { showToast('A case type needs a name.', { type: 'error' }); return; }
            db.ref('scheduler/caseDist/types/' + el.dataset.cdType + '/' + f).set(v)
                .then(cdAfterSettingsChange)
                .catch(err => showToast('Could not save: ' + err.message, { type: 'error' }));
        } else if (el.id === 'cdDefaultMin') {
            const v = Math.round(Number(el.value) * 10) / 10;
            if (!Number.isFinite(v) || v < 0) { showToast('Minutes must be 0 or more.', { type: 'error' }); return; }
            db.ref('scheduler/caseDist/settings/defaultMinutes').set(v).then(cdAfterSettingsChange).catch(() => {});
        } else if (el.id === 'cdFnaCbMin') {
            const v = Math.round(Number(el.value) * 10) / 10;
            if (!Number.isFinite(v) || v < 0) { showToast('Minutes must be 0 or more.', { type: 'error' }); return; }
            db.ref('scheduler/caseDist/settings/fnaCellBlockMinutes').set(v).then(cdAfterSettingsChange).catch(() => {});
        } else if (el.id === 'cdSlideEffect') {
            const pct = Number(el.value);
            if (!Number.isFinite(pct) || pct < 0 || pct > 100) { showToast('Enter a percentage from 0 to 100.', { type: 'error' }); return; }
            const v = Math.round(Math.log2(1 + pct / 100) * 1000) / 1000;
            db.ref('scheduler/caseDist/settings/slideEffect').set(v).then(cdAfterSettingsChange).catch(() => {});
        } else if (el.dataset.cdDn) {
            db.ref('scheduler/caseDist/types/' + el.dataset.cdDn + '/delnor').set(el.checked ? true : null)
                .then(cdAfterSettingsChange)
                .catch(err => showToast('Could not save: ' + err.message, { type: 'error' }));
        } else if (el.dataset.lcName) {
            const v = el.value.replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
            const problem = typeof locumNameProblem === 'function' ? locumNameProblem(el.dataset.lcName, v) : (v ? '' : 'Enter a name.');
            if (problem) { showToast(problem, { type: 'error' }); el.value = (locumRoster[el.dataset.lcName] || {}).name || ''; return; }
            db.ref('scheduler/locums/roster/' + el.dataset.lcName + '/name').set(v)
                .catch(err => showToast('Could not save: ' + err.message, { type: 'error' }));
        } else if (el.dataset.lcEpic) {
            const v = el.value.replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
            db.ref('scheduler/locums/roster/' + el.dataset.lcEpic + '/epic').set(v || null)
                .catch(err => showToast('Could not save: ' + err.message, { type: 'error' }));
        } else if (el.dataset.dnEpic) {
            const v = el.value.replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
            db.ref('scheduler/delnor/roster/' + el.dataset.dnEpic + '/epic').set(v || null)
                .catch(err => showToast('Could not save: ' + err.message, { type: 'error' }));
        } else if (el.dataset.cdEpic) {
            const v = el.value.replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
            db.ref('scheduler/caseDist/epic/' + el.dataset.cdEpic).set(v || null)
                .catch(err => showToast('Could not save: ' + err.message, { type: 'error' }));
        } else if (el.dataset.cdFte) {
            const v = Number(el.value);
            if (!Number.isFinite(v) || v < 0.1 || v > 1) { showToast('FTE must be between 0.1 and 1.0.', { type: 'error' }); return; }
            db.ref('scheduler/caseDist/fte/' + el.dataset.cdFte).set(Math.round(v * 100) / 100)
                .then(cdAfterSettingsChange).catch(() => {});
        }
    });

    // Saves made while an input had focus skipped the re-render; catch up
    // when focus leaves the page. Not when it moves within it — that would
    // rebuild the page under the click that moved it.
    root.addEventListener('focusout', e => {
        if (!e.target.matches('.cd-input')) return;
        if (e.relatedTarget && root.contains(e.relatedTarget)) return;
        setTimeout(renderCasesPage, 0);
    });

    root.addEventListener('keydown', e => {
        if (e.key === 'Enter' && e.target.matches('.cd-input')) e.target.blur();
    });

    root.addEventListener('click', e => {
        const t = e.target.closest('button');
        if (!t || t.disabled) return;
        const d = t.dataset;
        if (d.cdTab) {
            cdTab = d.cdTab;
            renderCasesPage();
        } else if (d.cdSec) {
            cdSecStore.set(d.cdSec, !cdSecStore.closed[d.cdSec]);
            renderCasesPage();
        } else if (d.cdPick !== undefined) {
            // Clicking the open line closes it again.
            const tab = cdTab;
            cdSel[tab] = cdSel[tab] === d.cdPick ? null : d.cdPick;
            renderCasesPage();
        } else if (d.cdTsort) {
            // Same column flips; a new one starts A–Z, or largest first for numbers.
            const key = d.cdTsort;
            cdTypeSort = cdTypeSort.key === key ? { key, dir: -cdTypeSort.dir } : { key, dir: key === 'name' ? 1 : -1 };
            renderCasesPage();
        } else if (d.cdAddtype !== undefined) cdAddType(d.cdAddtype, d.cdAddcode);
        else if (t.id === 'cdAddType') cdAddType(null);
        else if (d.cdChip) {
            const path = 'scheduler/caseDist/types/' + d.cdType + '/' + d.cdChip + '/' + d.cdVal;
            // Readers toggle; services cycle first choice → backup → off.
            const n = Number(d.cdTier) || 0;
            const next = d.cdChip === 'services'
                ? (n === 0 ? 1 : n === 1 ? 2 : null)
                : (n ? null : true);
            db.ref(path).set(next).then(cdAfterSettingsChange)
                .catch(err => showToast('Could not save: ' + err.message, { type: 'error' }));
        }
    });
})();

// Case types: drag a heading's right edge to resize its column (remembered
// in this browser); double-click the edge to put it back.
(function wireTypeColumns() {
    const root = document.getElementById('cdRoot');
    if (!root) return;
    const apply = table => table.style.setProperty('--cd-cols', cdColTemplate());
    const save = () => { try { localStorage.setItem(CD_COLW_KEY, JSON.stringify(cdColW)); } catch (_) {} };
    let last = { key: null, at: 0 };
    root.addEventListener('pointerdown', e => {
        const grip = e.target.closest('.cd-grip');
        if (!grip || e.button !== 0) return;
        e.preventDefault();
        const table = grip.closest('.cd-types'), cell = grip.parentElement, key = grip.dataset.cdGrip;
        // A second press on the same edge (the browser sends no dblclick
        // here, the first press having started a drag): back to its default.
        if (last.key === key && e.timeStamp - last.at < 450) {
            last = { key: null, at: 0 };
            delete cdColW[key];
            save();
            apply(table);
            return;
        }
        last = { key, at: e.timeStamp };
        const x0 = e.clientX, w0 = cell.getBoundingClientRect().width;
        grip.setPointerCapture(e.pointerId);
        document.body.classList.add('cd-resizing');
        const move = ev => { cdColW[key] = Math.round(Math.max(40, Math.min(900, w0 + ev.clientX - x0))); apply(table); };
        const up = () => {
            grip.removeEventListener('pointermove', move);
            grip.removeEventListener('pointerup', up);
            grip.removeEventListener('pointercancel', up);
            document.body.classList.remove('cd-resizing');
            save();
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up);
        grip.addEventListener('pointercancel', up);
    });
})();
