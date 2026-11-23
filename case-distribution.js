// ════════════════════════════════════════════════════════════════════════
// CASE DISTRIBUTION — split the day's Epic case list across pathologists
// ════════════════════════════════════════════════════════════════════════
//
// Loads after schedule.js (uses its globals: db, pathologists, isAdmin,
// getDayAssignments, ptoAllotmentFor, getAcademicYearOfDate,
// getFiscalYearRange, isWeekend, getFederalHoliday, fmt, parseDate, addDays,
// escapeHtml, showToast, SERVICES, SERVICE_BY_ID, academicYearLabel, today,
// nextWorkday, loggedInPathId).
//
// Director only for now. The director copies the cells of the Epic case
// list from Excel and pastes them here. The export has one row per case:
//   Case | Case Type | Protocols | Case Charges | Assigned Users | #Slides
// Protocols lists the specimens one per line; Case Charges lists each billed
// item as "Name, 88305G [description] : units". Every line is a part: its
// minutes come from the matching case type (first unit + each additional
// unit), or from its CPT code when no case type matches. The case's minutes
// are then nudged by #Slides against the slides typical for its parts.
//
// Routing: a case type may name services — first choice and backup (breast
// cores → Breast bx/WFH, else Huntley). Those cases go to whoever is on the
// service, up to an even day's work; everything else (and a service's cases
// beyond that) is shared so each pathologist's minutes for the day come out
// equal, in proportion to their daily share (FTE, adjusted for PTO). Case
// types can also be limited to certain readers (bone marrows).
//
// The pasted list stays in this browser's memory and is never saved —
// Firebase only holds the settings and per-pathologist minute totals:
//   scheduler/caseDist/types/<id>     { name, match, minutes, addMinutes, slides, basis,
//                                       readers{pid:true}, services{sid:1|2} }
//                                     services: 1 = first choice, 2 = backup
//                                     slides: typical per unit; missing = not adjusted
//   scheduler/caseDist/fte/<pathId>   0.1 – 1.0 (missing = 1.0)
//   scheduler/caseDist/epic/<pathId>  what the AutoHotkey script types in Epic's assign
//                                     window, when not the last name (the default)
//   scheduler/caseDist/settings       { defaultMinutes, slideEffect, fnaCellBlockMinutes }
//   scheduler/caseDist/seeded         starter case-type version written (CD_SEED_VERSION)
//   scheduler/caseDist/ledger/<YYYY-MM-DD>/<batchId>
//                                     { minutes{pid}, expected{pid}, cases{pid}, at, by, sig }
//                                     sig: which case numbers (cdListSig), so the
//                                     same list handed over again replaces its record

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
const CD_ACC_RE = /^[A-Z]{1,5}-?\d{2,4}-\d{1,8}$/i;   // e.g. XXS26-04233, XXF26-00692
// One Case Charges line: "Colon polyp, 88305G [AP SURGICAL PATH LEVEL IV] : 2",
// also "CD20 QL, 88341G2 [...] : 1" and "Block, 88305 (CPT®) [...] : 1".
const CD_CHARGE_RE = /^(.*?),?\s*(\d{5})[A-Z]?\d?(?:\.[A-Z0-9]+)?\s*(?:\([^)]*\))?\s*(?:\[[^\]]*\])?\s*:\s*(\d+)\s*$/i;

let cdTypes = {};
let cdFte = {};
let cdEpic = {};
let cdSettings = {};
let cdLedger = {};
let cdMix = null;              // scheduler/caseDist/specimenMix — see cdMixFromText()
let cdLoaded = false;
let _cdRef = null;
let _cdSplitInputs = '';       // what the split depends on, as last loaded

let cdTab = 'day';            // 'day' | 'types' | 'people'
let cdSearch = '';             // the Day tab's "Find a case" text
let cdDate = null;             // the day the cases are for (cdDefaultDate, kept current by cdSyncDay)
let cdTable = null;            // { rows: [[cell]], hasHeader } — the paste, memory only
let cdRawText = '';            // the pasted text, restored when the paste box is rebuilt
let cdCols = null;             // { id, type, extra } column indexes (-1 = none)
let cdCases = [];              // built from cdTable; see cdBuildCases()
let cdRecordedKey = null;      // ledger batch written for the current distribution
let cdRecordedDirty = false;   // reassigned since it was recorded

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
        cdMix = v.specimenMix || null;
        cdLoaded = true;
        // Re-split the list only when what splits it changed (case types,
        // FTE, defaults) — not for a record being written (Record's own
        // write would otherwise re-split the list it just recorded). Noted
        // before anything below returns: a list split right here (the
        // script's, below) must not count the next record as a change.
        const sig = JSON.stringify([cdTypes, cdFte, cdSettings], (k, val) => (k === 'codes' ? undefined : val));
        const changed = sig !== _cdSplitInputs;
        _cdSplitInputs = sig;
        if (v.seeded !== CD_SEED_VERSION && isAdmin()) { cdSeedTypes(v.types, v.seeded); return; }
        // A list the AutoHotkey script handed over before the settings loaded.
        if (cdPendingAuto !== null) { cdAutoRun(cdPendingAuto); return; }
        if (cdTable && changed) cdBuildCases();
        if (cdPageActive()) renderCasesPage();
    }, err => console.error('Firebase caseDist error:', err));
}

function cdSignedOut() {
    if (_cdRef) { try { _cdRef.off('value'); } catch (_) {} }
    _cdRef = null;
    _cdSplitInputs = '';
    cdLoaded = false;
    cdTypes = {}; cdFte = {}; cdEpic = {}; cdSettings = {}; cdLedger = {};
    cdTable = null; cdCols = null; cdCases = []; cdRawText = '';
    cdRecordedKey = null; cdRecordedDirty = false; cdRecordedAt = null;
    cdListFrom = null; cdExportedName = null;
    cdSel.day = cdSel.types = cdSel.people = null;
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

// What the AutoHotkey script types for a pathologist in Epic's assign
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

function cdWorking() {
    return [...cdScheduled(cdDate), ...cdLocumWorkers(cdDate), ...cdDelnorWorkers(cdDate)];
}

// Delnor's pathologists signed up for the day (delnor.js). Together they
// read about a quarter of the day's case minutes — their shares add up to a
// third of ours — split evenly, and only from the case types allowed to go
// to Delnor (cdBuildCases: c.delnorOK). The director's rule, Nov 2026.
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

// Delnor's sign-ups changed (delnor.js): re-split when the day's people did.
let _cdDelnorSig = '';
function cdDelnorSig() {
    return (cdDate ? fmt(cdDate) : '') + '|' + [...cdLocumWorkers(cdDate), ...cdDelnorWorkers(cdDate)].map(w => w.p.id).join(',');
}
function cdDelnorChanged() {
    const sig = cdDelnorSig();
    if (sig !== _cdDelnorSig) {
        _cdDelnorSig = sig;
        if (cdTable) { cdDistribute(); cdSplitChanged(); }
    }
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

// ── Parsing the paste ────────────────────────────────────────────────────
// Excel copies cells as tab-separated text, quoting cells that contain tabs,
// quotes or line breaks. Raw CSV text (no tabs) is read with commas.
function cdParseTable(text) {
    text = String(text || '').replace(/\r\n?/g, '\n');
    const delim = text.indexOf('\t') >= 0 ? '\t' : ',';
    const rows = [];
    let row = [], cell = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQ) {
            if (c === '"') {
                if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
            } else cell += c;
        } else if (c === '"' && cell === '') inQ = true;
        else if (c === delim) { row.push(cell); cell = ''; }
        else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
        else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    // Line breaks inside a cell separate parts — keep them, tidy each line.
    const clean = rows.map(r => r.map(c => c.split('\n')
            .map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')))
        .filter(r => r.some(Boolean));
    const width = clean.reduce((w, r) => Math.max(w, r.length), 0);
    clean.forEach(r => { while (r.length < width) r.push(''); });
    return clean;
}

// A whole exported sheet (the AutoHotkey script copies Epic's file) may
// have a report title or date above the table: start at the header row —
// the first row naming a Case / Accession column with a case number under
// it. Lists without such a row are left as they are.
function cdDropTitleRows(rows) {
    const isHead = r => r.some(c => /^(case|accession)\b/i.test(c));
    const hasAcc = r => r && r.some(c => CD_ACC_RE.test(c.split('\n')[0]));
    for (let i = 0; i < Math.min(rows.length - 1, 10); i++) {
        if (isHead(rows[i]) && hasAcc(rows[i + 1])) return i ? rows.slice(i) : rows;
        if (hasAcc(rows[i])) break;   // data before any header: nothing to drop
    }
    return rows;
}

// A header row has no digits in it while the row below does.
function cdLooksLikeHeader(rows) {
    if (rows.length < 2) return false;
    return !rows[0].some(c => /\d/.test(c)) && rows[1].some(c => /\d/.test(c));
}

function cdHeaders() {
    if (!cdTable) return [];
    const width = cdTable.rows.length ? cdTable.rows[0].length : 0;
    return Array.from({ length: width }, (_, i) => {
        const h = cdTable.hasHeader ? cdTable.rows[0][i] : '';
        return h || ('Column ' + cdColLetter(i));
    });
}

function cdColLetter(i) {
    let s = '';
    for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s;
    return s;
}

function cdDataRows() {
    if (!cdTable) return [];
    return cdTable.hasHeader ? cdTable.rows.slice(1) : cdTable.rows;
}

// Remembered header names first, then header keywords, then content.
function cdGuessCols() {
    const headers = cdHeaders();
    const data = cdDataRows().slice(0, 200);
    const used = new Set();
    const pick = (re, test) => {
        let i = cdTable.hasHeader ? headers.findIndex((h, j) => !used.has(j) && re.test(h)) : -1;
        if (i < 0 && test) {
            i = headers.findIndex((_, j) => !used.has(j) && data.length
                && data.filter(r => test(r[j])).length / data.length >= 0.6);
        }
        if (i >= 0) used.add(i);
        return i;
    };
    const id = pick(/accession|case\s*(#|no\b|num|number|id\b)|^case$/i, c => CD_ACC_RE.test(c));
    const charge = pick(/charge|cpt|billing/i,
        c => c.split('\n').some(l => CD_CHARGE_RE.test(l)));
    const proto = pick(/protocol|specimen|part|procedure|description/i, null);
    const cat = pick(/case\s*type|category/i, null);
    const slides = pick(/slide/i, null);
    return { id, proto, charge, cat, slides };
}

function cdNorm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

// Minutes for one part: its case type, else its CPT code, else the default.
function cdPartMinutes(pt) {
    const units = Math.max(1, pt.units || 1);
    let first, add;
    if (pt.type) {
        first = Number(pt.type.minutes) || 0;
        const a = Number(pt.type.addMinutes);
        add = Number.isFinite(a) ? a : first;
        pt.via = 'type';
    } else if (pt.code && CD_CPT_MINUTES[pt.code]) {
        [first, add] = CD_CPT_MINUTES[pt.code];
        pt.via = 'cpt';
    } else {
        first = add = cdDefaultMinutes();
        pt.via = 'default';
    }
    if (pt.code && CD_CPT_FLOOR[pt.code]) first = Math.max(first, CD_CPT_FLOOR[pt.code]);
    return first + (units - 1) * add;
}

// Typical slides for one part, or null when its case type isn't adjusted
// for slides (no count set, e.g. bone marrow).
function cdPartSlides(pt) {
    const units = Math.max(1, pt.units || 1);
    if (pt.code && CD_STAIN_RE.test(pt.code)) return 0;
    if (pt.type) {
        const s = pt.type.slides;
        if (s === undefined || s === null || s === '' || !Number.isFinite(Number(s))) return null;
        return Number(s) * units;
    }
    const s = pt.code && CD_CPT_SLIDES[pt.code] !== undefined ? CD_CPT_SLIDES[pt.code] : CD_DEFAULT_SLIDES;
    return s * units;
}

// Multiplier on a case's minutes for its slide count against the typical.
function cdSlideFactor(slides, typical) {
    const effect = cdSlideEffect();
    if (!(slides > 0) || !(typical > 0) || !effect) return 1;
    const f = Math.pow(slides / typical, effect);
    return Math.min(CD_SLIDE_RANGE[1], Math.max(CD_SLIDE_RANGE[0], f));
}

// "12", "1,234" → 12 / 1234; anything else → null.
function cdSlideCount(cell) {
    const v = String(cell || '').split('\n')[0].replace(/,/g, '').trim();
    return /^\d+$/.test(v) ? parseInt(v, 10) : null;
}

// One row → its parts. Charge lines carry the CPT code and units; a
// protocol with no charge line of its own (e.g. a needle core biopsy billed
// only as a cell block) still counts once.
function cdRowParts(r) {
    const parts = [];
    const lines = col => (col >= 0 && r[col]) ? r[col].split('\n').map(l => l.trim()).filter(Boolean) : [];
    lines(cdCols.charge).forEach(l => {
        const m = l.match(CD_CHARGE_RE);
        if (m) parts.push({ name: m[1].trim() || l, code: m[2], units: parseInt(m[3], 10) || 1 });
        else parts.push({ name: l, code: null, units: 1 });
    });
    const charged = new Set(parts.map(pt => cdNorm(pt.name)));
    lines(cdCols.proto).forEach(l => {
        if (!charged.has(cdNorm(l))) { parts.push({ name: l, code: null, units: 1 }); charged.add(cdNorm(l)); }
    });
    return parts;
}

// Rows → cases (rows sharing a case number merge). Minutes add up over the
// parts; readers narrow to who can read every part; services come from the
// heaviest part whose case type names one, else from a case type matching
// the Case Type column.
function cdBuildCases() {
    const prevPins = {};
    cdCases.forEach(c => { if (c.pinned !== undefined) prevPins[c.key] = c.pinned; });
    cdCases = [];
    if (!cdTable || !cdCols || (cdCols.proto < 0 && cdCols.charge < 0)) return;

    const fnaType = cdMatchType('fna'), cellBlockType = cdMatchType('cell block');
    const fnaCbMin = fnaType && cellBlockType && fnaType !== cellBlockType ? cdFnaCellBlockMinutes() : 0;

    const groups = new Map();
    cdDataRows().forEach((r, i) => {
        const id = cdCols.id >= 0 ? r[cdCols.id].split('\n')[0] : '';
        const key = id ? 'id:' + id.toUpperCase() : 'row:' + i;
        if (!groups.has(key)) groups.set(key, { key, id: id || '', cat: '', parts: [], slides: null });
        const g = groups.get(key);
        if (cdCols.cat >= 0 && r[cdCols.cat] && !g.cat) g.cat = r[cdCols.cat].replace(/\n/g, ' ');
        // A case split over rows repeats its slide count; keep the largest.
        const s = cdCols.slides >= 0 ? cdSlideCount(r[cdCols.slides]) : null;
        if (s !== null) g.slides = Math.max(g.slides || 0, s);
        g.parts.push(...cdRowParts(r));
    });

    groups.forEach(g => {
        if (!g.parts.length) return;
        let minutes = 0, routed = null;
        let readers = null, typical = 0, stains = 0;
        const narrow = rs => { if (rs) readers = readers ? new Set([...readers].filter(x => rs.has(x))) : rs; };
        g.parts.forEach(pt => {
            pt.type = pt.code && (CD_STAIN_RE.test(pt.code) || CD_ADDON_RE.test(pt.code)) ? null : cdMatchType(pt.name);
            pt.minutes = cdPartMinutes(pt);
            minutes += pt.minutes;
            const ps = cdPartSlides(pt);
            typical = (typical === null || ps === null) ? null : typical + ps;
            if (pt.code && CD_STAIN_RE.test(pt.code)) stains += Math.max(1, pt.units || 1);
            // Routing follows the heaviest specimen whose type names a service
            // (a lumpectomy's six margins outweigh it but carry no service).
            if (pt.type && cdServiceTiers(pt.type.services) && (!routed || pt.minutes > routed.minutes)) routed = pt;
            if (pt.type) narrow(cdSetOf(pt.type.readers));
        });
        const catType = g.cat ? cdMatchType(g.cat) : null;
        if (catType) narrow(cdSetOf(catType.readers));
        const hasType = t => g.parts.some(pt => pt.type && pt.type.id === t.id);
        g.fnaCellBlock = fnaCbMin > 0 && hasType(fnaType) && hasType(cellBlockType) ? fnaCbMin : 0;
        minutes += g.fnaCellBlock;

        // Main specimen first (by its type's first-unit minutes, so a
        // lumpectomy leads its margins); zero-minute items (decal) left out.
        const weight = pt => pt.type ? Number(pt.type.minutes) || 0 : pt.minutes;
        const labels = [];
        g.parts.slice().sort((a, b) => weight(b) - weight(a) || b.minutes - a.minutes).forEach(pt => {
            if (pt.minutes === 0) return;
            const l = pt.type ? pt.type.name : pt.name;
            if (!labels.includes(l)) labels.push(l);
        });
        // Slides nudge the time; a part whose type isn't adjusted (bone
        // marrow) leaves the whole case as is.
        g.typicalSlides = typical;
        g.stainSlides = stains;
        g.heSlides = g.slides === null ? null : Math.max(1, g.slides - stains);
        g.baseMinutes = minutes;
        g.slideFactor = typical === null ? 1 : cdSlideFactor(g.heSlides, typical);
        g.minutes = Math.round(minutes * g.slideFactor * 10) / 10;
        g.label = labels.join(' + ') || g.parts[0].name;
        g.detail = g.parts.map(pt => pt.name + (pt.units > 1 ? ' ×' + pt.units : '')).join(' · ');
        g.unrecognized = g.parts.some(pt => pt.via !== 'type');
        g.readers = readers;
        g.services = (routed && cdServiceTiers(routed.type.services))
            || (catType && cdServiceTiers(catType.services)) || null;
        // Delnor may read it when every specimen with time of its own is of a
        // case type allowed to go to Delnor (stains and add-ons don't count).
        const timed = g.parts.filter(pt => pt.minutes > 0 && !(pt.code && (CD_STAIN_RE.test(pt.code) || CD_ADDON_RE.test(pt.code))));
        g.delnorOK = timed.length > 0 && timed.every(pt => pt.type && pt.type.delnor);
        g.assigned = null;
        g.note = '';
        if (prevPins[g.key] !== undefined) g.pinned = prevPins[g.key];
        cdCases.push(g);
    });
    // Position in the pasted Epic list — the export's line number, and the
    // order the AutoHotkey script walks Epic's list in.
    cdCases.forEach((c, i) => { c.seq = i + 1; });
    cdDistribute();
}

// ── The distribution ─────────────────────────────────────────────────────
// Weighted greedy. Service cases go first, to whoever is on the service,
// while that keeps them within an even day; then everything left, cases
// with the fewest possible readers first, then the longest, each to the
// pathologist whose time — counting part of their running surplus/deficit
// — is lowest relative to their daily share. Cases the director reassigned
// by hand stay put.
function cdDistribute() {
    const working = cdWorking();
    const { bal } = cdBalances(cdDate, cdRecordedKey);
    const load = {};
    // Delnor's pathologists carry nothing over: their part is fresh each day.
    // Delnor's pathologists and locums carry nothing over: fresh each day.
    working.forEach(w => { load[w.p.id] = w.delnor || w.locum ? 0 : CD_CARRY * (bal[w.p.id] || 0); });
    const ours = working.filter(w => !w.delnor), delnor = working.filter(w => w.delnor);

    // Who may read a case: our pathologists, by the case type's readers.
    // (Delnor's take their quarter first, below; they get one of the rest
    // only when none of ours can read it.)
    const readersOf = c => {
        const el = ours.filter(w => !c.readers || c.readers.has(String(w.p.id)));
        if (el.length) return el;
        if (c.delnorOK && delnor.length) return delnor;
        c.note = c.readers ? 'No reader for this case type is working' : 'No one is working';
        return el;
    };
    // Of those, whoever is on the case's service: first choice, else the
    // backup. null when the case has no service, or no one is on it.
    const onService = (c, el) => {
        if (!c.services || !el.length || el[0].delnor) return null;
        const [first, backup] = c.services;
        const on = set => el.filter(w => w.svcIds.some(id => set.has(id)));
        const firstEl = on(first);
        if (firstEl.length) return { el: firstEl, svc: first };
        const backupEl = backup.size ? on(backup) : [];
        if (backupEl.length) return { el: backupEl, svc: backup };
        c.note = 'No one on ' + cdSvcNames(backup.size ? new Set([...first, ...backup]) : first) + ' — shared with all';
        return null;
    };
    const score = (w, c) => (load[w.p.id] + c.minutes) / w.share;
    const lowest = (el, c) => el.reduce((best, w) => (score(w, c) < score(best, c) - 1e-9 ? w : best));
    const give = (c, w) => { c.assigned = w.p.id; load[w.p.id] += c.minutes; };

    cdCases.forEach(c => { c.note = ''; c.shared = ''; c.assigned = null; });
    cdCases.filter(c => c.pinned !== undefined).forEach(c => {
        c.assigned = c.pinned;
        if (c.pinned !== null && load[c.pinned] !== undefined) load[c.pinned] += c.minutes;
    });

    // Delnor first, in two steps (director, Nov 2026). The divisions'
    // workload comes first; evening out Delnor's own pathologists comes
    // second and never changes what the divisions get.
    //  1. Which cases: Delnor, as one division, takes about a quarter of the
    //     day's case minutes, from the cases allowed to go there, largest
    //     first — skipping a case that would overshoot by more than half of
    //     itself. Less only when not enough is allowed.
    //  2. Who reads which: exactly those cases, dealt among Delnor's
    //     pathologists so their work RVUs come out as even as possible
    //     (cdDealDelnor). No case moves to or from ours to even them out.
    if (delnor.length) {
        const target = cdCases.reduce((t, c) => t + c.minutes, 0) * CD_DELNOR_FRACTION;
        let have = delnor.reduce((t, w) => t + load[w.p.id], 0);
        const picked = [];
        cdCases.filter(c => c.pinned === undefined && c.delnorOK)
            .sort((a, b) => b.minutes - a.minutes || a.seq - b.seq)
            .forEach(c => {
                if (have >= target || have + c.minutes / 2 > target) return;
                picked.push(c);
                have += c.minutes;
            });
        cdDealDelnor(picked, delnor).forEach(([c, w]) => give(c, w));
    }

    const todo = cdCases.filter(c => c.pinned === undefined && c.assigned == null)
        .map(c => { const el = readersOf(c); return { c, el, svc: onService(c, el) }; });

    // An even day: where everyone's minutes would land, relative to their
    // daily share, if all of today's cases (of ours) were split evenly.
    const shareSum = ours.reduce((s, w) => s + w.share, 0);
    const ourMinutes = todo.filter(t => t.el.length && !t.el[0].delnor).reduce((s, t) => s + t.c.minutes, 0);
    const evenDay = shareSum ? (ours.reduce((s, w) => s + load[w.p.id], 0) + ourMinutes) / shareSum : 0;

    // Service cases first, largest first, to whoever is on the service —
    // until that would put them over an even day by more than half the
    // case. The rest are shared like any other case, among everyone who may
    // read them (director, Nov 2026: being on Bigs mustn't mean a far
    // heavier day than everyone else's).
    todo.filter(t => t.svc).sort((a, b) => b.c.minutes - a.c.minutes || a.c.seq - b.c.seq).forEach(t => {
        const w = lowest(t.svc.el, t.c);
        if ((load[w.p.id] + t.c.minutes / 2) / w.share <= evenDay) give(t.c, w);
        else t.c.shared = cdShortName(w.p) + ' (' + cdSvcNames(t.svc.svc) + ') already had a full day — shared';
    });

    // Everything else: fewest possible readers first, then the longest, each
    // to whoever has least so far for their share.
    todo.filter(t => t.c.assigned == null && t.el.length)
        .sort((a, b) => (a.el.length - b.el.length) || (b.c.minutes - a.c.minutes))
        .forEach(t => give(t.c, lowest(t.el, t.c)));
    // The Delnor sign-ups this split used: only a real change to them
    // re-splits (cdDelnorChanged), not the first Delnor update after it.
    _cdDelnorSig = cdDelnorSig();
}

// A case's work RVUs: the CPT codes billed on its specimens, × units (stains
// left out — they're ordered after the cases are split); a specimen with no
// charge line counts its case type's first billing code.
function cdCaseRvu(c) {
    return c.parts.reduce((s, pt) => {
        if (pt.code && CD_STAIN_RE.test(pt.code)) return s;
        const code = pt.code || (pt.type ? cdCodeList(pt.type)[0] : null);
        const r = code ? cdCodeRvu(code) : null;
        return s + (r ? r[0] * Math.max(1, pt.units || 1) : 0);
    }, 0);
}

// A small seeded random generator (mulberry32) and a shuffle with it.
function cdRandom(seedText) {
    let a = 2166136261;
    for (let i = 0; i < seedText.length; i++) { a ^= seedText.charCodeAt(i); a = Math.imul(a, 16777619) >>> 0; }
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function cdShuffle(list, rand) {
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    return list;
}

// Deal Delnor's cases among Delnor's pathologists that day, evening out
// their work RVUs (counting any case already set by hand). Many tries of
// "highest RVUs first, each to whoever has least", in a random order, each
// then polished by moving or swapping a case between the most and least
// loaded; the evenest try is kept (then the evenest case counts). The
// randomness is seeded by the list and the day, so no one is favoured by
// roster order, yet the same list deals the same way each time it's split.
// Returns [[case, worker], …].
const CD_DEAL_TRIES = 40;
function cdDealDelnor(cases, people) {
    if (!cases.length) return [];
    if (people.length === 1) return cases.map(c => [c, people[0]]);
    const rvu = new Map(cases.map(c => [c, cdCaseRvu(c)]));
    // A sliver per case, so cases with no RVUs still spread out.
    const weight = c => rvu.get(c) + 0.01;
    const base = people.map(w => cdCases.filter(c => c.pinned !== undefined && String(c.pinned) === String(w.p.id)).reduce((s, c) => s + cdCaseRvu(c), 0));
    const rand = cdRandom(cdListSig() + '|' + fmt(cdDate) + '|' + people.map(w => w.p.id).join(','));
    const spread = xs => Math.max(...xs) - Math.min(...xs);
    let best = null;
    for (let t = 0; t < CD_DEAL_TRIES; t++) {
        const order = cdShuffle(cases.slice(), rand).sort((a, b) => weight(b) - weight(a));   // stable: ties stay shuffled
        const prefer = cdShuffle(people.map((_, i) => i), rand);
        const tot = base.slice(), mine = people.map(() => []);
        order.forEach(c => {
            const i = prefer.reduce((a, b) => (tot[b] < tot[a] - 1e-9 ? b : a));
            mine[i].push(c);
            tot[i] += weight(c);
        });
        // Polish: move one case, or swap two, between the most and least loaded.
        for (let step = 0; step < 200; step++) {
            const hi = tot.indexOf(Math.max(...tot)), lo = tot.indexOf(Math.min(...tot));
            const gap = tot[hi] - tot[lo];
            let bestMove = null, bestLeft = gap - 1e-6;
            mine[hi].forEach(a => {
                const d = weight(a);
                if (Math.abs(gap - 2 * d) < bestLeft) { bestLeft = Math.abs(gap - 2 * d); bestMove = { a, b: null, d }; }
                mine[lo].forEach(b => {
                    const dd = weight(a) - weight(b);
                    if (dd > 0 && Math.abs(gap - 2 * dd) < bestLeft) { bestLeft = Math.abs(gap - 2 * dd); bestMove = { a, b, d: dd }; }
                });
            });
            if (!bestMove) break;
            mine[hi].splice(mine[hi].indexOf(bestMove.a), 1); mine[lo].push(bestMove.a);
            if (bestMove.b) { mine[lo].splice(mine[lo].indexOf(bestMove.b), 1); mine[hi].push(bestMove.b); }
            tot[hi] -= bestMove.d; tot[lo] += bestMove.d;
        }
        const rv = people.map((_, i) => base[i] + mine[i].reduce((s, c) => s + rvu.get(c), 0));
        const score = [spread(rv), spread(mine.map((m, i) => m.length))];
        if (!best || score[0] < best.score[0] - 1e-6 || (Math.abs(score[0] - best.score[0]) <= 1e-6 && score[1] < best.score[1])) {
            best = { score, mine: mine.map(m => m.slice()) };
        }
    }
    const out = [];
    best.mine.forEach((m, i) => m.forEach(c => out.push([c, people[i]])));
    return out;
}

// Per-pathologist totals for the current distribution; `expected` is the
// fair split of today's minutes by daily share.
function cdTotals() {
    const working = cdWorking();
    const total = cdCases.reduce((s, c) => s + c.minutes, 0);
    const shareSum = working.reduce((s, w) => s + w.share, 0) || 1;
    const rows = {};
    working.forEach(w => {
        rows[w.p.id] = { pid: w.p.id, w, minutes: 0, cases: 0, expected: total * w.share / shareSum };
    });
    let unassigned = 0, unassignedMin = 0;
    cdCases.forEach(c => {
        if (c.assigned === null || c.assigned === undefined) { unassigned++; unassignedMin += c.minutes; return; }
        if (!rows[c.assigned]) {
            rows[c.assigned] = { pid: c.assigned, w: null, minutes: 0, cases: 0, expected: 0 };
        }
        rows[c.assigned].minutes += c.minutes;
        rows[c.assigned].cases++;
    });
    return { rows, total, unassigned, unassignedMin };
}

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
const cdSel = { day: null, types: null, people: null };
let cdListFrom = null;       // { how: 'script' | 'paste', at } — where this list came from
let cdRecordedAt = null;     // when this list was last recorded
let cdExportedName = null;   // this list's last AutoHotkey export

const CD_CHEV = '<svg class="cf-chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function cdTime(ts) {
    return ts ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
}

// "Friday, Nov 20" (the year only when it isn't this one).
function cdDayLabel(d) {
    return d.toLocaleDateString('en-US', { weekday: 'long' }) + ', ' + MONTHS_SHORT[d.getMonth()] + ' ' + d.getDate()
        + (d.getFullYear() !== today.getFullYear() ? ', ' + d.getFullYear() : '');
}

// Keep cdDate on the right day — it moves on at 3 pm even with the page
// left open. When it moves, a list already here is split again for
// the new day (who's working, their services and shares). True if it moved.
function cdSyncDay() {
    const d = cdDefaultDate();
    if (cdDate && fmt(d) === fmt(cdDate)) return false;
    const first = !cdDate;
    cdDate = d;
    if (first) return true;
    _cdDelnorSig = cdDelnorSig();
    cdRecordedKey = null; cdRecordedDirty = false; cdRecordedAt = null;
    if (cdTable) { cdDistribute(); cdMatchRecord(); }
    return true;
}

// This exact list already recorded for the day (same case numbers — back on
// its day, or pasted again): pick that record up, so Record updates it
// rather than counting the cases twice. Split as if it weren't there, as
// the first time; if the split now differs, Record offers the update.
function cdMatchRecord(redistribute = true) {
    if (!cdCases.length) return false;
    const sig = cdListSig();
    const same = Object.entries(cdLedger[fmt(cdDate)] || {}).find(([, b]) => b && b.sig === sig);
    if (!same) return false;
    cdRecordedKey = same[0];
    cdRecordedAt = same[1].at || null;
    if (redistribute) cdDistribute();
    const now = cdRecordedBatch().minutes, was = same[1].minutes || {};
    cdRecordedDirty = Object.keys({ ...now, ...was }).some(pid => (now[pid] || 0) !== (was[pid] || 0));
    return true;
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

function cdSvcPill(svc) {
    return svc ? `<span class="cd-svc" style="--c:var(${svc.cssVar});">${escapeHtml(svc.short)}</span>` : '';
}

// A case number as the line's tag, in its pathologist's colour (red: no one).
function cdAccTag(c) {
    const p = c.assigned != null ? cdPath(c.assigned) : null;
    if (p && p.delnor) return `<span class="ch-tag ch-tag-delnor cd-acc-tag">${escapeHtml(c.id || '—')}</span>`;
    if (p && p.locum) return `<span class="ch-tag ch-tag-locum cd-acc-tag">${escapeHtml(c.id || '—')}</span>`;
    const bg = p ? pathBgColor(p.color) : null;
    return p
        ? `<span class="ch-tag ch-tag-path cd-acc-tag" style="--c:${p.color}${bg ? `; --c-bg:${bg}` : ''}">${escapeHtml(c.id || '—')}</span>`
        : `<span class="ch-tag ch-tag-lock cd-acc-tag">${escapeHtml(c.id || '—')}</span>`;
}

// Specimens no case type knew (stains and zero-minute lines aside).
function cdUnknownParts(c) {
    return c.parts.filter(pt => pt.via !== 'type' && !(pt.via === 'cpt' && (pt.minutes === 0 || CD_STAIN_RE.test(pt.code))));
}

// Why a case has its own line in "Needs a look" (its status), or null.
// Specimens no case type knew get one line per specimen instead (below).
function cdLookStatus(c) {
    if (c.assigned == null) return { text: 'Not assigned', tone: 'bad' };
    if (c.note) return { text: 'No one on the service', tone: 'warn' };
    if (c.pinned !== undefined) return { text: 'Set by hand', tone: '' };
    return null;
}

// The specimens no case type knew, one entry per name with the cases
// they're in, most cases first.
function cdUnknownSpecimens() {
    const map = new Map();
    cdCases.forEach(c => cdUnknownParts(c).forEach(pt => {
        const k = cdNorm(pt.name);
        const e = map.get(k) || { key: k, name: pt.name, code: pt.code, via: pt.via, minutes: pt.minutes, cases: [] };
        if (!e.cases.includes(c)) e.cases.push(c);
        map.set(k, e);
    }));
    return [...map.values()].sort((a, b) => b.cases.length - a.cases.length || a.name.localeCompare(b.name));
}

function cdUnknownLine(e) {
    const est = e.via === 'cpt' ? `estimated from CPT ${e.code}` : 'the default estimate';
    const n = e.cases.length;
    return cdLineHtml('day', 'unk|' + e.key, '<span class="ch-tag ch-tag-deny">No case type</span>',
        `<b>${escapeHtml(e.name)}</b><span class="ch-dates"> · ${n} case${n === 1 ? '' : 's'} · ${escapeHtml(cdFmtMin(e.minutes))} each, ${escapeHtml(est)}</span>`,
        null, () => `<div class="cd-unk-cases">${e.cases.sort((a, b) => a.seq - b.seq).map(c => `<span class="cd-unk-case">${cdAccTag(c)}<span class="cd-seq">#${c.seq}</span></span>`).join('')}</div>
          <div class="cd-detail-actions">
            <span>No case type’s words are in “${escapeHtml(e.name)}”, so it counts as ${escapeHtml(cdFmtMin(e.minutes))} (${escapeHtml(est)}).</span>
            <button type="button" class="cd-btn cd-btn-sm" data-cd-addtype="${escapeHtml(e.name)}" data-cd-addcode="${e.code || ''}">Add as a case type</button>
          </div>`,
        `${e.name}: no case type, ${n} case${n === 1 ? '' : 's'}`);
}

function cdCaseText(c) {
    return `<span class="cd-seq">#${c.seq}</span><b>${escapeHtml(c.label)}</b><span class="ch-dates"> · ${escapeHtml(cdFmtMin(c.minutes))}</span>`;
}

function cdCaseLabel(c) {
    const p = c.assigned != null ? cdPath(c.assigned) : null;
    return `Case ${c.seq}, ${c.id}, ${c.label}, ${cdFmtMin(c.minutes)}, ${p ? cdShortName(p) : 'not assigned'}`;
}

// An open case: its specimens, the slide adjustment, and who reads it.
function cdCaseDetail(c) {
    const rows = c.parts.map(pt => {
        const how = pt.via === 'type' ? escapeHtml(pt.type.name)
            : pt.via === 'cpt' ? (CD_STAIN_RE.test(pt.code) ? 'Stain' : `CPT ${escapeHtml(pt.code)}`) : 'No case type';
        return `<tr><td class="ch-t-date">${escapeHtml(pt.name)}</td><td>${how}</td><td>${pt.units > 1 ? pt.units : ''}</td><td class="ch-t-after">${escapeHtml(cdFmtMin(pt.minutes))}</td></tr>`;
    }).join('');
    const extra = [];
    if (c.fnaCellBlock) extra.push(`FNA with a cell block: +${cdNum(c.fnaCellBlock)} min`);
    if (c.slides !== null) {
        extra.push(c.typicalSlides === null ? `${c.heSlides} slides (not adjusted)`
            : `${c.heSlides} slides, usually ${cdNum(c.typicalSlides)}${c.slideFactor !== 1 ? ` → ${c.slideFactor > 1 ? '+' : '−'}${Math.abs(Math.round((c.slideFactor - 1) * 100))}%` : ''}`
              + (c.stainSlides ? ` (${c.stainSlides} stain${c.stainSlides === 1 ? '' : 's'} left out)` : ''));
    }
    const route = c.services
        ? 'Goes to ' + cdSvcNames(c.services[0]) + (c.services[1].size ? ', else ' + cdSvcNames(c.services[1]) : '')
        : c.readers ? 'Read by ' + [...c.readers].map(id => cdPath(id)).filter(Boolean).map(cdShortName).join(' or ')
            : 'Shared to even out the day';
    const routeTxt = route + (c.shared ? ' · ' + c.shared : '') + (c.delnorOK ? ' · Delnor may read it' : '');
    // Our pathologists, then Delnor's signed up that day (and whoever has it).
    const pathOpts = [...pathologists.filter(p => typeof p.id === 'number'), ...cdLocumWorkers(cdDate).map(w => w.p), ...cdDelnorWorkers(cdDate).map(w => w.p)];
    if (c.assigned != null && !pathOpts.some(p => String(p.id) === String(c.assigned)) && cdPath(c.assigned)) pathOpts.push(cdPath(c.assigned));
    const sel = `<select class="cd-assign" data-cd-case="${escapeHtml(c.key)}" aria-label="Pathologist for ${escapeHtml(c.id)}">
        <option value=""${c.assigned == null ? ' selected' : ''}>Not assigned</option>
        ${pathOpts.map(p => `<option value="${escapeHtml(String(p.id))}"${String(c.assigned) === String(p.id) ? ' selected' : ''}>${escapeHtml(cdShortName(p))}${p.delnor ? ' (Delnor)' : p.locum ? ' (Locum)' : ''}</option>`).join('')}
      </select>`;
    const unknown = cdUnknownParts(c);
    return `<table class="ch-table cd-parts"><thead><tr><th>Specimen</th><th>Counted as</th><th>Units</th><th>Minutes</th></tr></thead>
        <tbody>${rows}</tbody></table>
      ${extra.length ? `<p class="cd-detail-note">${extra.map(escapeHtml).join(' · ')} · <b>${escapeHtml(cdFmtMin(c.minutes))}</b> in all</p>` : ''}
      <div class="cd-detail-actions">
        <label class="cd-detail-who">Pathologist ${sel}</label>
        ${c.pinned !== undefined ? `<button type="button" class="cd-btn cd-btn-sm" data-cd-unpin="${escapeHtml(c.key)}" title="Let the app choose again">Undo set by hand</button>` : ''}
        <span>${escapeHtml(routeTxt)}</span>
        ${c.note ? `<span class="cd-flag">${escapeHtml(c.note)}</span>` : ''}
        ${unknown.map(pt => `<button type="button" class="cd-btn cd-btn-sm" data-cd-addtype="${escapeHtml(pt.name)}" data-cd-addcode="${pt.code || ''}">Add “${escapeHtml(pt.name.length > 28 ? pt.name.slice(0, 27) + '…' : pt.name)}” as a case type</button>`).join('')}
      </div>`;
}

// ── Header ──
function cdHeaderHtml() {
    const day = cdTab === 'day';
    const has = cdCases.length > 0;
    const nTypes = Object.keys(cdTypes).length;
    const tab = (k, label, n) => `<button class="req-tab${cdTab === k ? ' active' : ''}" type="button" data-cd-tab="${k}"><span>${label}</span>${n != null ? `<span class="req-tab-count">${n}</span>` : ''}</button>`;
    return `<header class="tl-header">
        <h2 class="tl-title">Assign</h2>
        <div class="cd-head-right">
          ${day ? `<div class="cd-day-nav">
              <span class="current-period cd-day-fixed" id="cdPeriod" title="Today until 3 pm, then the next business day">${escapeHtml(cdDayLabel(cdDate))}</span>
            </div>` : ''}
          <div class="req-tabs requests-page-tabs" id="cdTabs" role="tablist">
            ${tab('day', 'Day', has ? cdCases.length : null)}${tab('types', 'Case types', nTypes)}${tab('people', 'Pathologists', null)}
          </div>
        </div>
      </header>`;
}

// The cases matching the Find a case box, in list order: by case number
// (punctuation and case ignored, so "7003" finds XXS26-07003), or for words
// of three letters or more, by specimen too.
function cdFind(q) {
    const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const nq = norm(q), words = q.trim().toLowerCase();
    if (!nq) return [];
    const byText = /[a-z]{3}/.test(words);
    return cdCases.filter(c => norm(c.id).includes(nq)
        || (byText && (c.label + ' ' + c.detail).toLowerCase().includes(words))).sort((a, b) => a.seq - b.seq);
}

// ── Day ──
function cdDayHtml() {
    const has = cdCases.length > 0;
    const t = cdTotals();
    let list;
    if (!has) {
        list = `<div class="cf-empty cd-paste-zone" tabindex="0" aria-label="Paste the case log here"><span class="split-empty-headline">No case list for ${escapeHtml(cdDayLabel(cdDate))} yet.</span>In Epic, press Ctrl+Shift+1 to run the case assignment automation. Or copy Epic’s case log in Excel (headers included), click here and press Ctrl+V.</div>`;
    } else if (cdSearch.trim()) {
        // Find a case: only the cases that match, each opened.
        const found = cdFind(cdSearch);
        list = found.length
            ? `<div class="cd-found">${found.map(c => cdLineHtml('day', 'find|' + c.key, cdAccTag(c), cdCaseText(c), cdLookStatus(c), () => cdCaseDetail(c), cdCaseLabel(c), true)).join('')}</div>`
            : `<div class="cf-empty"><span class="split-empty-headline">No case matches “${escapeHtml(cdSearch.trim())}”.</span>Search by case number — all of it or just its end, like 7003.</div>`;
    } else {
        const secs = [];
        const look = cdCases.filter(cdLookStatus).sort((a, b) => a.seq - b.seq);
        const unknown = cdUnknownSpecimens();
        if (look.length || unknown.length) {
            secs.push(cdSecHtml('look', 'Needs a look', null, [
                ...look.map(c => cdLineHtml('day', 'look|' + c.key, cdAccTag(c), cdCaseText(c), cdLookStatus(c), () => cdCaseDetail(c), cdCaseLabel(c))),
                ...unknown.map(cdUnknownLine),
            ]));
        }
        const rows = Object.values(t.rows).filter(r => cdPath(r.pid)).sort((a, b) => cdPidOrder(a.pid, b.pid));
        rows.forEach(r => {
            const p = cdPath(r.pid);
            const mine = cdCases.filter(c => String(c.assigned) === String(r.pid)).sort((a, b) => a.seq - b.seq);
            const head = `<span class="cd-sec-path">${cdTag(p.id)}${r.w ? cdSvcPill(r.w.svc) : '<span class="cd-muted">not working</span>'}</span>`;
            secs.push(cdSecHtml('p' + p.id, head, null,
                mine.map(c => cdLineHtml('day', 'p' + p.id + '|' + c.key, cdAccTag(c), cdCaseText(c), null, () => cdCaseDetail(c), cdCaseLabel(c))),
                'No cases'));
        });
        list = secs.join('');
    }
    return `<div class="cf-body">
        <div class="cf-side"><div class="cf-list" aria-label="Assign">${list}</div></div>
        <section class="cf-cal" aria-label="The day"><div class="cd-panel">
          ${has ? `<div class="cd-search-wrap">
              <svg class="cd-search-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.75"/><path d="M10.5 10.5 14 14"/></svg>
              <input type="search" class="cd-search" id="cdSearch" placeholder="Find a case" aria-label="Find a case by its number"
                value="${escapeHtml(cdSearch)}" spellcheck="false" autocomplete="off">
            </div>` : ''}${has ? cdWorkloadCard(t) : ''}${cdWorkingCard()}${has ? cdListCard() : ''}
        </div></section>
      </div>`;
}

function cdWorkloadCard(t) {
    const rows = Object.values(t.rows).filter(r => cdPath(r.pid)).sort((a, b) => cdPidOrder(a.pid, b.pid));
    const max = Math.max(1, ...rows.map(r => Math.max(r.minutes, r.expected))) * 1.04;
    return `<section class="cd-card">
        <h3 class="cd-card-h">Workload <span>${cdCases.length} cases · ${escapeHtml(cdFmtMin(t.total))}</span></h3>
        <div class="cd-load cd-load-day" title="Bar: estimated time · tick: an even share">
          ${rows.map(r => {
              const p = cdPath(r.pid);
              return `<button type="button" class="cd-load-who" data-cd-jump="${p.id}" title="Show ${escapeHtml(cdShortName(p))}’s cases">${cdTag(p.id)}</button>
                <div class="cd-bar"><span class="cd-bar-fill" style="width:${(r.minutes / max * 100).toFixed(1)}%;--c:${p.color};"></span><span class="cd-bar-target" style="left:${(r.expected / max * 100).toFixed(1)}%;"></span></div>
                <span class="cd-load-num">${escapeHtml(cdFmtMin(r.minutes))}</span>`;
          }).join('')}
          ${t.unassigned ? `<span class="ch-tag ch-tag-lock">Not assigned</span><span></span><span class="cd-load-num">${t.unassigned} case${t.unassigned === 1 ? '' : 's'}</span>` : ''}
        </div>
      </section>`;
}

// Who's working: one even tile each — name, and the service on the right.
function cdWorkingCard() {
    const sched = cdScheduled(cdDate);
    const tile = (w, color, cls) => `<span class="cd-person${cls}">
                <span class="cd-dot" style="--c:${color};"></span>
                <span class="cd-person-name">${escapeHtml(cdShortName(w.p))}</span>${cdSvcPill(w.svc)}
              </span>`;
    return `<section class="cd-card">
        <h3 class="cd-card-h">Working</h3>
        <div class="cd-working">${sched.length ? sched.map(w => tile(w, w.p.color, '')).join('') : '<span class="cd-muted">No one is on a service this day.</span>'}${cdLocumWorkers(cdDate).map(w => tile(w, 'var(--locum)', ' cd-person-locum')).join('')}${cdDelnorWorkers(cdDate).map(w => tile(w, 'var(--delnor)', ' cd-person-delnor')).join('')}</div>
      </section>`;
}

function cdListCard() {
    const from = cdListFrom ? (cdListFrom.how === 'script' ? 'Case assignment automation, ' : 'Pasted, ') + cdTime(cdListFrom.at) : 'Pasted';
    const recorded = !cdRecordedKey ? 'Not yet' : cdTime(cdRecordedAt) || 'Yes';
    const problems = cdExportProblems();
    const exportTip = problems.length ? 'Before exporting: ' + problems.join('; ')
        : 'Download the cases for the case assignment automation, in the same order as the Epic list';
    return `<section class="cd-card">
        <h3 class="cd-card-h">This list</h3>
        <div class="cd-facts">
          <span>From</span><b>${escapeHtml(from)}</b>
          <span>Recorded</span><b>${escapeHtml(recorded)}</b>
          <span>Exported</span><b>${escapeHtml(cdExportedName || 'Not yet')}</b>
        </div>
        <div class="cd-card-actions">
          <button type="button" class="cd-btn cd-btn-sm" id="cdExportAhk" title="${escapeHtml(exportTip)}">Export</button>
          <button type="button" class="cd-btn cd-btn-sm" id="cdRedistribute" title="Re-split the cases the app chose (cases set by hand stay)">Redistribute</button>
          <button type="button" class="cd-btn cd-btn-sm" id="cdCopy">Copy for Excel</button>
          <button type="button" class="cd-btn cd-btn-sm" id="cdClear" title="Remove this list, and take its minutes off the running totals (for a list pasted by mistake)">Clear list</button>
        </div>
      </section>`;
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
    { key: 'group', label: 'Specimen type', sort: true, pad: true, w: '150px', tip: 'The broad specimen type it counts as in the Specimen mix (Pathologists tab)' },
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
    if (cdTypeSort.key === 'group') {
        return cdTypeSort.dir * (CD_GROUPS.indexOf(cdTypeGroup(a)) - CD_GROUPS.indexOf(cdTypeGroup(b))) || byName;
    }
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
        <select class="cd-input cd-t-group cd-c-group" data-cd-field="group" data-cd-type="${t.id}" aria-label="Specimen type">${CD_GROUPS.map(g => `<option${g === cdTypeGroup(t) ? ' selected' : ''}>${escapeHtml(g)}</option>`).join('')}</select>
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

// ── Specimen mix ── Each pathologist's cases by broad specimen type, from
// an AP case report (Epic: Case · Case Type · Protocols · Case Charges ·
// Assigned Users) pasted on the Pathologists tab. Each case counts once,
// under its main specimen (the heaviest case type, as the Day tab orders
// them); any cytology or FNA case (by Epic's case type) counts as
// Cytology. Stored as counts per case type, so the groups follow the Case
// types table's "Specimen type" column, edits included.
const CD_GROUPS = ['GI', 'Breast', 'GYN', 'GU', 'Derm', 'Cytology', 'Bone marrow', 'Endocrine', 'Thoracic',
    'Head & neck', 'Bone & soft tissue', 'Lymph node', 'Cardiovascular', 'Neuro', 'Other'];
// A case type's group when none is chosen: from its name and phrases.
const CD_GROUP_GUESS = [
    ['Other', /^resection for tumor/],
    ['Bone marrow', /bone marrow|peripheral smear/],
    ['Cytology', /\bfna\b|fine needle|body fluid|\bfluid|washing|brushing|urine|cytolog|cell block|needle core|cerebrospinal|\bcsf\b|diff.?quik|thinprep/],
    ['Breast', /breast|mastectomy|lumpectomy|areola|nipple/],
    ['Cardiovascular', /temporal artery|carotid|\bartery\b|arterial|aort|valve|leaflet|thromb|\bvein\b|varicose|pericard|heart|cardiac/],
    ['GYN', /endometri|uterus|uterine|fallopian|ovar|adnexa|cervi(x|cal)|leep|vulva|vagina|placenta|products of conception|\bpoc\b|hydatid|myometr|fetus|salping/],
    ['GI', /stomach|gastric|colon|colostomy|ileostomy|\bstoma\b|duoden|esophag|ge junction|\bileum\b|ileal|rect(al|um)|small bowel|appendix|gallbladder|liver|hemorrhoid|\banal\b|anus|pancrea|bile duct|jejun|cecum|sigmoid|polyp/],
    ['Endocrine', /thyroid|parathyroid|adrenal/],
    ['GU', /prostat|bladder|kidney|renal|ureter|urethr|vas deferens|testi(s|cle)|scrot|foreskin|circumcision|hydrocele|penis|spermatocele|epididym/],
    ['Derm', /skin|scalp|pilonidal|wart|abdominoplasty|panniculectomy|\bnail\b|epidermal|sebaceous|perineum/],
    ['Head & neck', /nasal|\bnose\b|sinus|ethmoid|turbinate|tonsil|adenoid|mouth|tongue|\blip\b|larynx|laryng|uvula|pharyn|saliva|parotid|submandibular|\bear\b|gingiva|\boral\b|cheek|vocal|teeth|tooth|mandible|maxilla|neck/],
    ['Thoracic', /lung|bronch|pleura|mediastin|thym|trache/],
    ['Neuro', /\bdura\b|subdural|brain|\bnerve\b|spinal cord|mening|pituitary/],
    ['Lymph node', /lymph node|sentinel|lymphoma/],
    ['Bone & soft tissue', /soft tissue|bone|amputation|femoral head|lipoma|tendon|ganglion|tenosynov|\bdisc\b|joint|synov|hernia|cartilage|muscle|bursa|retroperitoneal|spleen|omentum|abscess|umbilic|\brib\b|hematoma/],
];
function cdGuessGroup(text) {
    const t = String(text || '').toLowerCase();
    const hit = CD_GROUP_GUESS.find(([, re]) => re.test(t));
    return hit ? hit[0] : 'Other';
}
function cdTypeGroup(t) {
    if (!t) return 'Other';
    if (CD_GROUPS.includes(t.group)) return t.group;
    // By its name first; its matching words only when the name says nothing.
    const byName = cdGuessGroup(t.name);
    return byName !== 'Other' || /^(resection for tumor|biopsy \(h|two blocks|extra block)/i.test(t.name || '') ? byName : cdGuessGroup(t.match);
}

// The pasted report → { at, by, cases, years, people: { key: { name, pid?, n, types: { typeId | '_cyto' | '_none': n } } } }
// or null when it isn't one.
function cdMixFromText(text) {
    const rows = cdParseTable(text);
    const hi = rows.findIndex(r => r.some(c => /^case$/i.test(String(c).trim())) && r.some(c => /assigned/i.test(String(c))));
    if (hi < 0) return null;
    const head = rows[hi].map(c => String(c).trim().toLowerCase());
    const col = re => head.findIndex(c => re.test(c));
    const ci = { id: col(/^case$/), cat: col(/^case type/), proto: col(/protocol/), charge: col(/charge/), who: col(/assigned/) };
    if (ci.id < 0 || ci.who < 0 || (ci.proto < 0 && ci.charge < 0)) return null;
    const typeOf = new Map();
    const match = name => { const k = cdNorm(name); if (!typeOf.has(k)) typeOf.set(k, cdMatchType(name)); return typeOf.get(k); };
    const lines = (r, i) => (i >= 0 && r[i]) ? String(r[i]).split('\n').map(l => l.trim()).filter(Boolean) : [];
    // Who read it: the staff pathologist's last name, matched to ours.
    const ours = new Map();
    pathologists.filter(p => typeof p.id === 'number').forEach(p => ours.set(cdLastName(p).toLowerCase(), { key: 'p' + p.id, pid: p.id, name: cdShortName(p) }));
    (typeof locumRosterList === 'function' ? locumRosterList() : []).forEach(r => ours.set(cdLastName(r).toLowerCase(), { key: 'l' + r.lid, name: r.name }));
    const reader = r => {
        const ls = lines(r, ci.who);
        const l = ls.find(x => /staff pathologist/i.test(x)) || ls[0];
        const last = l ? l.split(',')[0].trim() : '';
        if (!last) return null;
        return ours.get(last.toLowerCase()) || { key: 'x' + last.toLowerCase().replace(/[^a-z0-9]/g, ''), name: 'Dr. ' + last };
    };
    const people = {}, years = new Set(), seen = new Set();
    rows.slice(hi + 1).forEach(r => {
        const id = String(r[ci.id] || '').split('\n')[0].trim().toUpperCase();
        if (!CD_ACC_RE.test(id) || seen.has(id)) return;
        const who = reader(r);
        if (!who) return;
        seen.add(id);
        const yy = id.match(/^[A-Z]+-?(\d{2})-/);
        if (yy) years.add('20' + yy[1]);
        let key;
        if (ci.cat >= 0 && /cytolog|fine needle|\bfna\b/i.test(String(r[ci.cat] || ''))) key = '_cyto';
        else {
            // The heaviest specimen (its type's first-unit minutes); stains and add-ons don't count.
            const names = [];
            lines(r, ci.charge).forEach(l => {
                const m = l.match(CD_CHARGE_RE);
                if (m && (CD_STAIN_RE.test(m[2]) || CD_ADDON_RE.test(m[2]))) return;
                names.push(m ? (m[1].trim() || l) : l);
            });
            lines(r, ci.proto).forEach(l => { if (!names.some(n => cdNorm(n) === cdNorm(l))) names.push(l); });
            let best = null, bw = -1;
            names.forEach(n => { const t = match(n); const w = t ? Number(t.minutes) || 0 : -1; if (t && w > bw) { best = t; bw = w; } });
            key = best ? best.id : '_none';
        }
        const p = people[who.key] = people[who.key] || Object.assign({ n: 0, types: {} }, who.pid ? { pid: who.pid } : {}, { name: who.name });
        p.n++;
        p.types[key] = (p.types[key] || 0) + 1;
    });
    if (!seen.size) return null;
    return { at: Date.now(), by: loggedInPathId, cases: seen.size, years: [...years].sort().join(', '), people };
}

function cdMixPaste(text) {
    const mix = cdMixFromText(text);
    if (!mix) {
        showToast('That isn’t an AP case report: in Excel, copy all of the report’s cells (Case, Case Type, Protocols, Case Charges, Assigned Users), then paste here.', { type: 'error' });
        return;
    }
    db.ref('scheduler/caseDist/specimenMix').set(mix)
        .then(() => showToast('Specimen mix updated from ' + mix.cases.toLocaleString() + ' cases.'))
        .catch(err => showToast('Could not save the specimen mix: ' + err.message, { type: 'error' }));
}

// Group counts per person: { key: { name, pid?, n, g: { group: n } } }.
function cdMixGroups() {
    if (!cdMix || !cdMix.people) return null;
    const out = {};
    Object.entries(cdMix.people).forEach(([k, p]) => {
        const g = {};
        Object.entries(p.types || {}).forEach(([t, n]) => {
            const grp = t === '_cyto' ? 'Cytology' : t === '_none' ? 'Other' : cdTypeGroup(cdTypes[t]);
            g[grp] = (g[grp] || 0) + n;
        });
        out[k] = { name: p.name, pid: p.pid, n: p.n || 0, g };
    });
    return out;
}

function cdMixCard() {
    const data = cdMixGroups();
    if (!data) {
        return `<section class="cd-card cd-mix-card"><h3 class="cd-card-h">Specimen mix</h3>
            <p class="cd-help-text">Copy an AP case report in Excel (all its cells) and press Ctrl+V on this tab.</p></section>`;
    }
    const ourKeys = pathologists.filter(p => typeof p.id === 'number' && data['p' + p.id]).map(p => 'p' + p.id);
    const otherKeys = Object.keys(data).filter(k => !ourKeys.includes(k));
    const cols = ourKeys.map(k => ({ key: k, label: data[k].name, color: (pathologists.find(p => p.id === data[k].pid) || {}).color, n: data[k].n, g: data[k].g }));
    if (otherKeys.length) {
        const g = {}; let n = 0;
        otherKeys.forEach(k => { n += data[k].n; Object.entries(data[k].g).forEach(([x, c]) => { g[x] = (g[x] || 0) + c; }); });
        cols.push({ key: 'others', label: 'Others', title: otherKeys.map(k => data[k].name + ' ' + data[k].n.toLocaleString()).join(', '), n, g });
    }
    const total = {};
    cols.forEach(c => Object.entries(c.g).forEach(([x, n]) => { total[x] = (total[x] || 0) + n; }));
    const groups = CD_GROUPS.filter(x => total[x]).sort((a, b) => total[b] - total[a]);
    const pct = (c, x) => c.n ? 100 * (c.g[x] || 0) / c.n : 0;
    const ourCols = cols.filter(c => c.key !== 'others');
    const head = `<tr><th></th>${cols.map(c => `<th scope="col" title="${escapeHtml(c.title || c.label)}">${c.color ? `<span class="cd-mix-dot" style="background:${c.color}"></span>` : ''}${escapeHtml(String(c.label).replace(/^Dr\.\s*/, ''))}</th>`).join('')}</tr>`;
    const body = groups.map(x => {
        const mean = ourCols.length ? ourCols.reduce((s, c) => s + pct(c, x), 0) / ourCols.length : 0;
        return `<tr><th scope="row">${escapeHtml(x)}</th>${cols.map(c => {
            const v = pct(c, x), n = c.g[x] || 0;
            // Above the group's average among ours: tinted, more the further above.
            const lift = c.key !== 'others' && mean > 0 && v > mean * 1.1 ? Math.min(1, (v / mean - 1) / 0.6) : 0;
            return `<td${lift ? ` class="is-high" style="--lift:${(0.08 + lift * 0.2).toFixed(2)}"` : ''} title="${escapeHtml(c.label + ': ' + n.toLocaleString() + ' ' + x + ' case' + (n === 1 ? '' : 's') + ' of ' + c.n.toLocaleString())}">${n ? v.toFixed(1) + '%' : '<span class="cd-mix-zero">·</span>'}</td>`;
        }).join('')}</tr>`;
    }).join('');
    const foot = `<tr class="cd-mix-total"><th scope="row">Cases</th>${cols.map(c => `<td>${c.n.toLocaleString()}</td>`).join('')}</tr>`;
    const when = cdMix.at ? new Date(cdMix.at) : null;
    const sub = (cdMix.cases || 0).toLocaleString() + ' cases' + (cdMix.years ? ' · ' + cdMix.years : '');
    return `<section class="cd-card cd-mix-card">
        <h3 class="cd-card-h">Specimen mix <span title="${escapeHtml('From the AP case report pasted ' + (when ? MONTHS_SHORT[when.getMonth()] + ' ' + when.getDate() + ', ' + when.getFullYear() : '') + '. Each case counts once, by its main specimen; cytology and FNA cases as Cytology. Paste a newer report here to replace it.')}">${escapeHtml(sub)}</span></h3>
        <div class="cd-mix-scroll"><table class="cd-mix"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table></div>
      </section>`;
}

// ── Pathologists ──
function cdPeopleViewHtml() {
    const date = cdDate || cdDefaultDate();
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
        ${cdMixCard()}
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
    cdSyncDay();
    if (!cdLoaded) { cdSetRoot(root, cdHeaderHtml() + '<div class="cd-empty">Loading…</div>'); return; }

    // Don't yank an input out from under the director mid-edit; the commit
    // that ends the edit re-renders.
    const active = document.activeElement;
    if (active && root.contains(active) && active.matches('input[type="text"], input[type="number"], textarea')) return;

    const html = cdHeaderHtml() + (cdTab === 'types' ? cdTypesViewHtml() : cdTab === 'people' ? cdPeopleViewHtml() : cdDayHtml());
    // The app redraws every page whenever schedule data arrives (often, on
    // the live site). Nothing changed → leave the page alone: replacing it
    // anyway swallowed clicks mid-press, flickered hovers and reset scrolls.
    if (root._cdHtml === html) return;
    // Keep the list's and panel's scroll when redrawing the same tab.
    const keep = root.dataset.tab === cdTab;
    const list = root.querySelector('.cf-list'), side = root.querySelector('.cf-cal');
    const ls = keep && list ? list.scrollTop : 0, ss = keep && side ? side.scrollTop : 0;
    root.dataset.tab = cdTab;
    const typing = document.activeElement && document.activeElement.id === 'cdSearch' ? document.activeElement : null;
    const caret = typing ? [typing.selectionStart, typing.selectionEnd] : null;
    cdSetRoot(root, html);
    if (typing) {
        const s = root.querySelector('#cdSearch');
        if (s) { s.focus(); try { s.setSelectionRange(...caret); } catch (_) { /* not a text field */ } }
    }
    const l2 = root.querySelector('.cf-list'), s2 = root.querySelector('.cf-cal');
    if (l2) l2.scrollTop = ls;
    if (s2) s2.scrollTop = ss;
}

function cdSetRoot(root, html) {
    if (root._cdHtml === html) return;
    root.innerHTML = html;
    root._cdHtml = html;
}

// A new list (pasted, or handed over by the script).
function cdUseList(text, how) {
    cdSetPaste(text);
    cdListFrom = text.trim() ? { how, at: Date.now() } : null;
    cdAutoRecord();
    renderCasesPage();
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

// ── Actions ──────────────────────────────────────────────────────────────
function cdSetPaste(text) {
    cdSyncDay();
    cdRawText = text;
    cdSearch = '';
    const rows = cdDropTitleRows(cdParseTable(text));
    cdRecordedKey = null; cdRecordedDirty = false; cdRecordedAt = null; cdExportedName = null;
    cdSel.day = null;
    cdCases = [];
    if (!rows.length) { cdTable = null; cdCols = null; renderCasesPage(); return; }
    cdTable = { rows, hasHeader: cdLooksLikeHeader(rows) };
    cdCols = cdGuessCols();
    cdBuildCases();
    cdMatchRecord();
    renderCasesPage();
}

function cdRecordedBatch() {
    const t = cdTotals();
    const minutes = {}, expected = {}, cases = {};
    Object.values(t.rows).forEach(r => {
        minutes[r.pid] = Math.round(r.minutes);
        expected[r.pid] = Math.round(r.expected * 10) / 10;
        cases[r.pid] = r.cases;
    });
    return { minutes, expected, cases, at: Date.now(), by: loggedInPathId, sig: cdListSig() };
}

// A short fingerprint of the list's case numbers (order aside).
function cdListSig() {
    const ids = cdCases.map(c => String(c.id || c.key).toUpperCase()).sort().join('|');
    let h = 2166136261;
    for (let i = 0; i < ids.length; i++) { h ^= ids.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(36) + '-' + cdCases.length;
}

// The list's minutes go into each pathologist's running total (the ledger)
// on their own (director, Nov 2026): when the list arrives, and again —
// the same record, updated — whenever its split changes.
function cdRecord() {
    if (!cdCases.length) return;
    const dk = fmt(cdDate);
    const ref = cdRecordedKey
        ? db.ref('scheduler/caseDist/ledger/' + dk + '/' + cdRecordedKey)
        : db.ref('scheduler/caseDist/ledger/' + dk).push();
    cdRecordedKey = ref.key;
    cdRecordedDirty = false;
    ref.set(cdRecordedBatch()).then(() => {
        cdRecordedAt = Date.now();
        renderCasesPage();
    }).catch(err => {
        cdRecordedDirty = true;
        showToast('Could not record the list: ' + err.message, { type: 'error' });
    });
}

function cdAutoRecord() {
    if (cdCases.length && (!cdRecordedKey || cdRecordedDirty)) cdRecord();
}

// The split changed (a case moved, Redistribute, new settings): update the
// list's record.
function cdSplitChanged() {
    if (cdRecordedKey) cdRecordedDirty = true;
    cdAutoRecord();
}

// Clear list: the list goes, and its record with it — clearing is for a
// list pasted by mistake.
function cdClearList() {
    const key = cdRecordedKey, dk = fmt(cdDate);
    cdUseList('', 'paste');
    if (!key) return;
    db.ref('scheduler/caseDist/ledger/' + dk + '/' + key).remove()
        .then(() => showToast('Cleared the list and took its minutes off the running totals.'))
        .catch(err => showToast('Could not remove the list’s record: ' + err.message, { type: 'error' }));
}

function cdCopy() {
    const lines = [['Case', 'Case type', 'Specimens', 'Slides', 'Est. minutes', 'Pathologist'].join('\t')];
    const pidOrder = pid => (pid == null) ? 999 : pid;
    cdCases.slice().sort((a, b) => (pidOrder(a.assigned) - pidOrder(b.assigned)) || a.id.localeCompare(b.id))
        .forEach(c => {
            const p = c.assigned != null ? cdPath(c.assigned) : null;
            lines.push([c.id, c.cat, c.detail, c.slides === null ? '' : c.slides, cdNum(c.minutes), p ? cdShortName(p) : 'Not assigned']
                .map(v => String(v).replace(/[\t\n]/g, ' ')).join('\t'));
        });
    const text = lines.join('\n');
    const done = () => showToast('Copied ' + cdCases.length + ' cases — paste into Excel.');
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => cdCopyFallback(text, done));
    } else cdCopyFallback(text, done);
}

// ── AutoHotkey export ────────────────────────────────────────────────────
// A tab-separated file tools/autohotkey/assign-cases.ahk reads, one case per
// line in exactly the order of the pasted Epic list. The script doesn't look
// cases up: it starts on the case selected in Epic and moves down the list,
// so line N must be the Nth case in Epic's list.
//   Seq <tab> Case <tab> EpicUser <tab> Pathologist <tab> Minutes
// EpicUser is what gets typed in Epic's assign window (the last name by
// default). UTF-8 with a BOM (AutoHotkey reads it as UTF-8), Windows line
// endings. The file name carries the day and time, so each export is its
// own run for the script's resume log.
const CD_AHK_COLUMNS = ['Seq', 'Case', 'EpicUser', 'Pathologist', 'Minutes'];

// What would stop the script: cases with no pathologist or no case number.
// [] when the export is good to go.
function cdExportProblems() {
    const problems = [];
    const unassigned = cdCases.filter(c => c.assigned == null).length;
    if (unassigned) problems.push(`${unassigned} case${unassigned === 1 ? ' isn’t' : 's aren’t'} assigned`);
    const noId = cdCases.filter(c => !c.id).length;
    if (noId) problems.push(`${noId} case${noId === 1 ? ' has' : 's have'} no case number`);
    const noName = [...new Set(cdCases.filter(c => c.assigned != null && !cdEpicName(c.assigned)).map(c => c.assigned))];
    if (noName.length) problems.push(`nothing to type in Epic for ${noName.length} pathologist${noName.length === 1 ? '' : 's'} (Pathologists tab)`);
    return problems;
}

function cdAhkText() {
    const clean = v => String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ').trim();
    const lines = [CD_AHK_COLUMNS.join('\t')];
    cdCases.forEach(c => {
        const p = cdPath(c.assigned);
        lines.push([c.seq, c.id, cdEpicName(c.assigned), p ? cdShortName(p) : '', Math.round(c.minutes)].map(clean).join('\t'));
    });
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function cdExportAhk(auto) {
    if (!cdCases.length) return false;
    const problems = cdExportProblems();
    if (problems.length) {
        const s = problems.join('; ');
        showToast((auto ? `Imported ${cdCases.length} cases from the case assignment automation, but can’t export: ` : 'Can’t export yet: ')
            + s.charAt(0).toLowerCase() + s.slice(1) + '.', { type: 'error', duration: auto ? 60000 : undefined });
        return false;
    }
    const now = new Date();
    const hhmm = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
    const name = `case-assignments-${fmt(cdDate)}-${hhmm}.tsv`;
    if (auto) return cdHandBack(name);
    const url = URL.createObjectURL(new Blob([cdAhkText()], { type: 'text/tab-separated-values;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    cdExportedName = name;
    renderCasesPage();
    showToast(`Exported ${cdCases.length} cases to ${name}.`);
    return true;
}

// For the script: the same file's text back on the clipboard, behind a first
// line "CD_BACK_MARK <tab> file name", instead of a download — a download
// lands wherever the browser last saved a file, which the script can't know.
// The script saves it in its own folder. Records the batch once it's handed
// back (these cases are being assigned now).
function cdHandBack(name) {
    const text = CD_BACK_MARK + '\t' + name + '\r\n' + cdAhkText().replace(/^﻿/, '');
    const n = cdCases.length;
    const ok = () => {
        cdExportedName = name + ' (to the case assignment automation)';
        cdRecord();
        renderCasesPage();
        showToast(`Imported ${n} cases from the case assignment automation, recorded them and handed the assignments back. The case assignment automation takes it from here.`);
    };
    const fail = () => showToast(`Imported ${n} cases from the case assignment automation, but couldn’t hand them back on the clipboard. `
        + 'Run the case assignment automation again with this window in front, or Export and use Ctrl+Shift+2.', { type: 'error', duration: 60000 });
    const fallback = () => {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let copied = false;
        try { copied = document.execCommand('copy'); } catch (_) { /* blocked */ }
        ta.remove();
        copied ? ok() : fail();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fallback);
    else fallback();
    return true;
}

// ── Hand-off from the AutoHotkey script ───────────────────────────────────
// The script puts the case list it exported from Epic on the clipboard,
// behind a first line reading CD_AUTO_MARK, brings this tab to the front and
// presses Ctrl+V. On any page, for the director: open Cases, take the list as
// if pasted, split it, hand the assignments back on the clipboard (above)
// and record the batch. When something stops the export (a case no one
// working can read), the page says so and the script times out telling the
// director to look here.
const CD_AUTO_MARK = '#PATHSCHED-AUTO';
const CD_BACK_MARK = '#PATHSCHED-ASSIGNMENTS';
// The page's first answer, at once, so the script stops pasting (it pastes
// again every few seconds while a freshly opened page is still loading):
// RECEIVED = working on it; WAITING = no one is signed in yet, the list is
// held until the director signs in (the script then waits longer).
const CD_ACK_MARK = '#PATHSCHED-RECEIVED';
const CD_WAIT_MARK = '#PATHSCHED-WAITING';
let cdPendingAuto = null;   // a list that arrived before the settings loaded
let _cdSignInWait = null;   // timer: a list waiting for the director to sign in

function cdAnswerScript(mark) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) return Promise.resolve();
    return navigator.clipboard.writeText(mark).catch(() => {});
}

// The script opened the page itself (or you weren't signed in): hold the
// list, and run it once the director has signed in.
function cdAutoAfterSignIn(text) {
    clearInterval(_cdSignInWait);
    showToast('The case assignment automation handed over a case list. Sign in as the director and it carries on.', { duration: 20000 });
    const giveUp = Date.now() + 10 * 60 * 1000;
    _cdSignInWait = setInterval(() => {
        if (Date.now() > giveUp) { clearInterval(_cdSignInWait); return; }
        if (loggedInPathId === null || loggedInPathId === undefined || !pathologists.length) return;
        clearInterval(_cdSignInWait);
        if (!isAdmin()) {
            showToast('Only the director can hand a case list to the Assign page.', { type: 'error' });
            return;
        }
        cdAutoRun(text);
    }, 400);
}

function cdAutoRun(text) {
    if (typeof window.__setPage === 'function' && !cdPageActive()) window.__setPage('cases');
    if (!cdLoaded) { cdPendingAuto = text; cdEnsureListener(); return; }
    cdPendingAuto = null;
    cdTab = 'day';
    renderCasesPage();
    cdSetPaste(text);
    cdListFrom = text.trim() ? { how: 'script', at: Date.now() } : null;
    if (!cdCases.length) {
        showToast('The case assignment automation handed over a case list with no cases in it.', { type: 'error' });
        return;
    }
    // The same list again (a run that stopped, started over): replace its
    // record rather than count the cases twice, and split it as if that
    // record weren't there — as the first time.
    if (cdMatchRecord()) cdRecordedDirty = true;   // the script always re-records
    cdExportAhk(true);
}

document.addEventListener('paste', e => {
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    const body = String(text || '').replace(/^\uFEFF/, '');
    if (!body.startsWith(CD_AUTO_MARK)) return;
    e.preventDefault();
    e.stopPropagation();
    const nl = body.indexOf('\n');
    const list = nl < 0 ? '' : body.slice(nl + 1);
    if (loggedInPathId === null || loggedInPathId === undefined) {
        cdAnswerScript(CD_WAIT_MARK);
        cdAutoAfterSignIn(list);
        return;
    }
    cdAnswerScript(CD_ACK_MARK).then(() => {
        if (typeof isAdmin !== 'function' || !isAdmin()) {
            showToast('Only the director can hand a case list to the Assign page.', { type: 'error' });
            return;
        }
        cdAutoRun(list);
    });
}, true);

// Pasting the case log straight onto the Assign page: copy Epic's export in
// Excel, click the page (anywhere but a text box) and press Ctrl+V. A new
// list replaces the one there. Text with no case numbers in it is turned
// away, so a stray paste can't wipe the list.
document.addEventListener('paste', e => {
    if (e.defaultPrevented || !cdPageActive() || typeof isAdmin !== 'function' || !isAdmin()) return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"], .modal-back.open')) return;
    if (document.querySelector('.modal-back.open')) return;
    // On the Pathologists tab, a pasted AP case report updates the Specimen mix.
    if (cdTab === 'people') {
        const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
        if (!String(text || '').trim()) return;
        e.preventDefault();
        cdMixPaste(text);
        return;
    }
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (!String(text || '').trim()) return;
    e.preventDefault();
    const hasCases = cdParseTable(text).some(r => r.some(cell => CD_ACC_RE.test(String(cell).split('\n')[0].trim())));
    if (!hasCases) {
        showToast('That isn’t a case log — in Excel, copy the cells of Epic’s export, headers included, then paste here.', { type: 'error' });
        return;
    }
    const replacing = cdCases.length > 0;
    cdTab = 'day';
    cdUseList(text, 'paste');
    showToast((replacing ? 'Replaced the list: ' : 'Pasted ') + cdCases.length + ' case' + (cdCases.length === 1 ? '' : 's') + '.');
});

function cdCopyFallback(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); }
    catch (_) { showToast('Copy failed — your browser blocked the clipboard.', { type: 'error' }); }
    ta.remove();
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

// Settings changed (types, FTE) → re-split whatever is pasted.
function cdAfterSettingsChange() {
    if (cdTable) { cdBuildCases(); cdSplitChanged(); }
}

// ── Wiring ───────────────────────────────────────────────────────────────
(function initCaseDistribution() {
    const root = document.getElementById('cdRoot');
    if (!root) return;

    root.addEventListener('change', e => {
        const el = e.target;
        if (el.classList.contains('cd-assign')) {
            const c = cdCases.find(x => x.key === el.dataset.cdCase);
            if (!c) return;
            c.pinned = el.value === '' ? null : (/^d:/.test(el.value) ? el.value : Number(el.value));
            c.assigned = c.pinned;
            cdSplitChanged();
            // Opened in a pathologist's section: follow it to the new one.
            if (cdSel.day && /^p\d+\|/.test(cdSel.day) && cdSel.day.endsWith('|' + c.key)) {
                cdSel.day = c.assigned != null ? 'p' + c.assigned + '|' + c.key : 'look|' + c.key;
            }
            renderCasesPage();
        } else if (el.dataset.cdField) {
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
        if (e.key === 'Escape' && e.target.id === 'cdSearch' && cdSearch) {
            e.preventDefault();
            cdSearch = '';
            renderCasesPage();
        }
    });

    // Find a case: the list filters as you type.
    root.addEventListener('input', e => {
        if (e.target.id !== 'cdSearch') return;
        cdSearch = e.target.value;
        renderCasesPage();
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
        } else if (d.cdJump) {
            // Workload row → that pathologist's section, opened, at the top.
            const id = 'p' + d.cdJump;
            if (cdSecStore.closed[id]) { cdSecStore.set(id, false); renderCasesPage(); }
            const head = root.querySelector(`[data-cd-sec="${id}"]`);
            const list = root.querySelector('.cf-list');
            if (head && list) list.scrollTop = head.closest('.cf-sec').offsetTop - list.offsetTop;
        } else if (d.cdTsort) {
            // Same column flips; a new one starts A–Z, or largest first for numbers.
            const key = d.cdTsort;
            cdTypeSort = cdTypeSort.key === key ? { key, dir: -cdTypeSort.dir } : { key, dir: key === 'name' ? 1 : -1 };
            renderCasesPage();
        } else if (t.id === 'cdExportAhk') cdExportAhk();
        else if (t.id === 'cdCopy') cdCopy();
        else if (t.id === 'cdRedistribute') {
            cdDistribute();
            cdSplitChanged();
            renderCasesPage();
        } else if (t.id === 'cdClear') {
            cdClearList();
        } else if (d.cdUnpin) {
            const c = cdCases.find(x => x.key === d.cdUnpin);
            if (c) delete c.pinned;
            cdDistribute();
            cdSplitChanged();
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
