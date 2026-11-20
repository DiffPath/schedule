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
// service; everything else is shared so each pathologist's minutes for the
// day come out equal, in proportion to their daily share (FTE, adjusted for
// PTO). Case types can also be limited to certain readers (bone marrows).
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
const CD_SEED_VERSION = 7;
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
    { name: 'Colon resection', match: 'colon resection; colectomy; hemicolectomy', minutes: 15, addMinutes: 8, slides: 11.5, services: [['bigs', 1]],
        basis: 'Benign colectomy 3 pts (11–20 min); billed 88309 (tumor) counts 40' },
    { name: 'Small bowel resection', match: 'small bowel', minutes: 15, addMinutes: 8, slides: 5, services: [['bigs', 1]],
        basis: 'Benign small bowel resection 3 pts (11–20 min); billed 88309 counts 40' },
    { name: 'Prostate biopsy', match: 'prostate biopsy; prostate needle', minutes: 15, addMinutes: 2.5, slides: 5,
        basis: '1 container 3 pts (11–20 min) · 2–6: 5 pts (21–30) · >6: 8 pts (31–50)' },
    { name: 'Breast core biopsy', match: 'breast core', minutes: 15, addMinutes: 15, slides: 12, services: [['wfh', 1], ['huntley', 2]],
        basis: 'Needle core biopsy 3 pts (11–20 min) per container' },
    { name: 'Sentinel / lymph node', match: 'sentinel node; lymph node', minutes: 15, addMinutes: 8, slides: 3.5,
        basis: 'Sentinel node, H&E + levels 3 pts (11–20 min)' },
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
        basis: 'Needle biopsy 3 pts (11–20 min)' },
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
        basis: 'Sterilisation 1 pt (1–5 min)' },
    { name: 'Lipoma / soft tissue', match: 'lipoma; soft tissue', minutes: 3, addMinutes: 3, slides: 2,
        basis: 'Excision for benign disease 1 pt (1–5 min)' },
    { name: 'Nasal contents / septum', match: 'nasal contents; nasal septum', minutes: 3, addMinutes: 3, slides: 1,
        basis: 'Nasal polyps 1 pt (1–5 min) per side' },
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
    { name: 'Tendon / ganglion / disc', match: 'tendon; tenosynovium; ganglion; ganglion cyst; disc', minutes: 3, addMinutes: 3, slides: 1,
        basis: 'Benign soft tissue 1 pt (1–5 min)' },
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
    { name: 'Scrotum / hydrocele / foreskin', match: 'scrotum; hydrocele; foreskin; testis, biopsy', minutes: 3, addMinutes: 3, slides: 3,
        basis: 'Simple benign specimen 1 pt (1–5 min)' },
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
    { name: 'Ovary / adnexa', match: 'ovary and fallopian tube; ovary; ovarian cyst; adnexa', minutes: 8, addMinutes: 8, slides: 4,
        basis: 'Ovary / ovarian cyst, benign 2 pts (6–10 min); billed 88309 counts 40' },
    { name: 'Lung biopsy (bronchoscopic)', match: 'lung bronchoscopic biopsy; bronchial, biopsy; transbronchial', minutes: 15, addMinutes: 8, slides: 13,
        basis: 'Bronchial / transbronchial biopsy 3 pts (11–20 min)' },
    { name: 'Lung wedge', match: 'lung wegde; lung wedge', minutes: 25, addMinutes: 8, slides: 4.5, services: [['bigs', 1]],
        basis: 'Lung wedge resection 5 pts (21–30 min)' },
    { name: 'Lung lobectomy', match: 'lung lobectomy; pneumonectomy', minutes: 40, addMinutes: 10, slides: 5, services: [['bigs', 1]],
        basis: 'Lung resection for tumour 8 pts (31–50 min)' },
    { name: 'Pleura', match: 'pleural peel; pleura, biopsy; pleura', minutes: 8, addMinutes: 3, slides: 3,
        basis: 'Pleural biopsy / decortication 2 pts (6–10 min)' },
    { name: 'Mediastinum / thymus', match: 'mediastinum; thymus', minutes: 15, addMinutes: 8, slides: 7.5,
        basis: 'Mediastinal biopsy / thymus 3 pts (11–20 min)' },
    { name: 'Parathyroid', match: 'parathyroid', minutes: 8, addMinutes: 3, slides: 3.5,
        basis: 'Parathyroid 2 pts (6–10 min)' },
    { name: 'Sinus / turbinate / nose', match: 'ethmoid; turbinates; turbinate; sinus, curettage; nasal shavings; nose, biopsy', minutes: 3, addMinutes: 3, slides: 3,
        basis: 'Nasal / sinus tissue, benign 1 pt (1–5 min)' },
    { name: 'Larynx / pharynx / trachea biopsy', match: 'larynx, biopsy; vocal cord biopsy; trachea, biopsy; oropharynx, biopsy; pharynx; uvula', minutes: 8, addMinutes: 3, slides: 3,
        basis: 'Laryngeal / pharyngeal biopsy 2 pts (6–10 min)' },
    { name: 'Salivary gland', match: 'parotid; submandibular gland', minutes: 15, addMinutes: 8, slides: 4,
        basis: 'Salivary gland biopsy / excision 3 pts (11–20 min)' },
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
    { name: 'Skin / soft tissue, named site', match: 'scalp; lip; cheek; areola; umbilicus; perineum; supraclavicular; plantar wart; abdominoplasty', minutes: 3, addMinutes: 3, slides: 3,
        basis: 'Skin / benign soft tissue 1 pt (1–5 min)' },
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
    { name: 'Resection for tumor, other', match: 'stomach tumor; radical resection; resection for tumor; retroperitoneal mass', minutes: 40, addMinutes: 10, slides: 23.5, services: [['bigs', 1]],
        basis: 'Resection for tumour 8 pts (31–50 min)' },
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
    6: ['Extra block / clot section', 'H&E level (cytology)', 'Bone biopsy', 'Bone fragments', 'Digit amputation', 'Digit amputation, traumatic', 'Limb amputation', 'Tendon / ganglion / disc', 'Arterial plaque', 'Thrombus / hematoma', 'Prostate TURP', 'Radical prostatectomy', 'Vas deferens', 'Bladder biopsy', 'Testis tumor', 'Scrotum / hydrocele / foreskin', 'Ureter / urethra', 'Urine cytology', 'Abscess / aspirate (cytology)', 'Synovial fluid crystals', 'Hysterectomy', 'Fibroid (myomectomy)', 'Cervical LEEP / cone', 'Cervix / vagina / vulva biopsy', 'Ovary / adnexa', 'Lung biopsy (bronchoscopic)', 'Lung wedge', 'Lung lobectomy', 'Pleura', 'Mediastinum / thymus', 'Parathyroid', 'Sinus / turbinate / nose', 'Larynx / pharynx / trachea biopsy', 'Salivary gland', 'Hemorrhoids', 'Liver biopsy, medical', 'Liver biopsy, lesion', 'Colostomy / stoma', 'Omentum', 'Spleen', 'Adrenal gland', 'Pilonidal sinus', 'Skin / soft tissue, named site', 'Breast reconstruction', 'Breast biopsy (not core)', 'Brain biopsy', 'Brain / dura / pituitary tumor', 'Dura, non-tumor', 'Resection for tumor, other'],
    7: ['Pericardium'],
};
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
let cdLoaded = false;
let _cdRef = null;
let _cdSplitInputs = '';       // what the split depends on, as last loaded

let cdTab = 'day';            // 'day' | 'types' | 'people'
let cdDate = null;             // Date the cases are distributed for
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
        cdLoaded = true;
        if (v.seeded !== CD_SEED_VERSION && isAdmin()) { cdSeedTypes(v.types, v.seeded); return; }
        // A list the AutoHotkey script handed over before the settings loaded.
        if (cdPendingAuto !== null) { cdAutoRun(cdPendingAuto); return; }
        // Re-split the list only when what splits it changed (case types,
        // FTE, defaults) — not for a record being written (Record's own
        // write would otherwise re-split the list it just recorded).
        const sig = JSON.stringify([cdTypes, cdFte, cdSettings]);
        const changed = sig !== _cdSplitInputs;
        _cdSplitInputs = sig;
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
    Object.keys(cdSplits).forEach(k => delete cdSplits[k]);
    const ta = document.getElementById('cdPaste');
    if (ta) ta.value = '';
}

// A starter type as stored: services as { id: tier }, readers matched to
// pathologists by name.
function cdStarterRow(t) {
    const row = { name: t.name, match: t.match, minutes: t.minutes, addMinutes: t.addMinutes, basis: t.basis };
    if (t.slides !== undefined) row.slides = t.slides;
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
    const set = String(cdEpic[pid] || '').trim();
    if (set) return set;
    const p = cdPath(pid);
    return p ? cdLastName(p) : '';
}

function cdPath(pid) {
    return pathologists.find(p => String(p.id) === String(pid)) || null;
}

function cdDefaultMinutes() {
    const v = Number(cdSettings.defaultMinutes);
    return Number.isFinite(v) && v >= 0 ? v : CD_DEFAULT_MINUTES;
}

// Today in Central time, or the next working day from 5 pm on — the list
// pulled in the evening is the next day's work.
function cdDefaultDate(now = new Date()) {
    const p = {};
    new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23',
    }).formatToParts(now).forEach(x => { p[x.type] = Number(x.value); });
    const d = new Date(p.year, p.month - 1, p.day);
    return p.hour >= 17 ? nextWorkday(d) : d;
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

function cdWorking() {
    return cdScheduled(cdDate);
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
// Weighted greedy: cases with the fewest possible readers go first, then
// the longest; each goes to the eligible pathologist whose time — counting
// part of their running surplus/deficit — is lowest relative to their
// daily share. Cases the director reassigned by hand stay put.
function cdDistribute() {
    const working = cdWorking();
    const { bal } = cdBalances(cdDate, cdRecordedKey);
    const load = {};
    working.forEach(w => { load[w.p.id] = CD_CARRY * (bal[w.p.id] || 0); });

    const eligible = c => {
        let el = working.filter(w => !c.readers || c.readers.has(String(w.p.id)));
        if (!el.length) {
            c.note = c.readers ? 'No reader for this case type is working' : 'No one is working';
            return el;
        }
        // First-choice services, then the backup, then everyone.
        if (c.services) {
            const [first, backup] = c.services;
            const on = set => el.filter(w => w.svcIds.some(id => set.has(id)));
            const firstEl = on(first);
            if (firstEl.length) return firstEl;
            const backupEl = backup.size ? on(backup) : [];
            if (backupEl.length) return backupEl;
            c.note = 'No one on ' + cdSvcNames(backup.size ? new Set([...first, ...backup]) : first) + ' — shared with all';
        }
        return el;
    };

    cdCases.forEach(c => { c.note = ''; c.assigned = null; });
    cdCases.filter(c => c.pinned !== undefined).forEach(c => {
        c.assigned = c.pinned;
        if (c.pinned !== null && load[c.pinned] !== undefined) load[c.pinned] += c.minutes;
    });

    const todo = cdCases.filter(c => c.pinned === undefined)
        .map(c => ({ c, el: eligible(c) }))
        .sort((a, b) => (a.el.length - b.el.length) || (b.c.minutes - a.c.minutes));
    todo.forEach(({ c, el }) => {
        if (!el.length) return;
        let best = null, bestScore = Infinity;
        el.forEach(w => {
            const score = (load[w.p.id] + c.minutes) / w.share;
            if (score < bestScore - 1e-9) { bestScore = score; best = w; }
        });
        c.assigned = best.p.id;
        load[best.p.id] += c.minutes;
    });
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

// The next / previous working day.
function cdStepWorkday(d, dir) {
    let x = addDays(d, dir);
    while (isWeekend(x) || getFederalHoliday(x)) x = addDays(x, dir);
    return x;
}

// This list's split on each day it was shown, so coming back to a day
// restores what was there (hand-set cases, and the split that was recorded
// and exported) instead of splitting it afresh. Memory only, like the list.
const cdSplits = {};   // dateKey → { sig, split: { caseKey: { a, p, n } } }

function cdKeepSplit() {
    if (!cdCases.length) return;
    cdSplits[fmt(cdDate)] = { sig: cdListSig(),
        split: Object.fromEntries(cdCases.map(c => [c.key, { a: c.assigned, p: c.pinned, n: c.note }])) };
}

function cdRestoreSplit() {
    const k = cdSplits[fmt(cdDate)];
    if (!k || !cdCases.length || k.sig !== cdListSig()) return false;
    cdCases.forEach(c => {
        const x = k.split[c.key];
        if (!x) return;
        c.assigned = x.a; c.note = x.n || '';
        if (x.p === undefined) delete c.pinned; else c.pinned = x.p;
    });
    return true;
}

function cdSetDate(d) {
    cdKeepSplit();
    cdDate = d;
    cdRecordedKey = null; cdRecordedDirty = false; cdRecordedAt = null;
    if (cdTable) {
        const restored = cdRestoreSplit();
        if (!restored) cdDistribute();
        cdMatchRecord(!restored);
    }
    renderCasesPage();
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

// One ledger line; the open one shows detailFn() under it.
function cdLineHtml(tab, key, tagHtml, textHtml, status, detailFn, label) {
    const on = cdSel[tab] === key;
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
    const bg = p ? pathBgColor(p.color) : null;
    return p
        ? `<span class="ch-tag ch-tag-path cd-acc-tag" style="--c:${p.color}${bg ? `; --c-bg:${bg}` : ''}">${escapeHtml(c.id || '—')}</span>`
        : `<span class="ch-tag ch-tag-lock cd-acc-tag">${escapeHtml(c.id || '—')}</span>`;
}

function cdDiffHtml(d) {
    return `<span class="cd-diff${d > 15 ? ' over' : d < -15 ? ' under' : ''}">${Math.abs(d) < 1 ? 'even' : (d > 0 ? '+' : '') + cdFmtMin(d)}</span>`;
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
    const pathOpts = pathologists.filter(p => typeof p.id === 'number');
    const sel = `<select class="cd-assign" data-cd-case="${escapeHtml(c.key)}" aria-label="Pathologist for ${escapeHtml(c.id)}">
        <option value=""${c.assigned == null ? ' selected' : ''}>Not assigned</option>
        ${pathOpts.map(p => `<option value="${p.id}"${String(c.assigned) === String(p.id) ? ' selected' : ''}>${escapeHtml(cdShortName(p))}</option>`).join('')}
      </select>`;
    const unknown = cdUnknownParts(c);
    return `<table class="ch-table cd-parts"><thead><tr><th>Specimen</th><th>Counted as</th><th>Units</th><th>Minutes</th></tr></thead>
        <tbody>${rows}</tbody></table>
      ${extra.length ? `<p class="cd-detail-note">${extra.map(escapeHtml).join(' · ')} · <b>${escapeHtml(cdFmtMin(c.minutes))}</b> in all</p>` : ''}
      <div class="cd-detail-actions">
        <label class="cd-detail-who">Pathologist ${sel}</label>
        ${c.pinned !== undefined ? `<button type="button" class="cd-btn cd-btn-sm" data-cd-unpin="${escapeHtml(c.key)}" title="Let the app choose again">Undo set by hand</button>` : ''}
        <span>${escapeHtml(route)}</span>
        ${c.note ? `<span class="cd-flag">${escapeHtml(c.note)}</span>` : ''}
        ${unknown.map(pt => `<button type="button" class="cd-btn cd-btn-sm" data-cd-addtype="${escapeHtml(pt.name)}" data-cd-addcode="${pt.code || ''}">Add “${escapeHtml(pt.name.length > 28 ? pt.name.slice(0, 27) + '…' : pt.name)}” as a case type</button>`).join('')}
      </div>`;
}

// ── Header ──
function cdHeaderHtml() {
    const day = cdTab === 'day';
    const has = cdCases.length > 0;
    let recordTxt = 'Record', recordTip = 'Add this list to each pathologist’s running total, so later lists even out';
    if (cdRecordedKey && !cdRecordedDirty) { recordTxt = 'Recorded'; recordTip = 'Recorded at ' + cdTime(cdRecordedAt); }
    else if (cdRecordedKey) { recordTxt = 'Update record'; recordTip = 'The split changed since it was recorded'; }
    const problems = has ? cdExportProblems() : [];
    const exportTip = !has ? 'No case list yet' : problems.length ? 'Before exporting: ' + problems.join('; ')
        : 'Download the cases for the AutoHotkey script, in the same order as the Epic list';
    const nTypes = Object.keys(cdTypes).length;
    const tab = (k, label, n) => `<button class="req-tab${cdTab === k ? ' active' : ''}" type="button" data-cd-tab="${k}"><span>${label}</span>${n != null ? `<span class="req-tab-count">${n}</span>` : ''}</button>`;
    return `<header class="tl-header">
        <h2 class="tl-title">Cases</h2>
        <div class="cd-head-right">
          ${day ? `<div class="cd-day-nav">
              <button class="nav-btn" type="button" data-cd-day="-1" title="Previous working day" aria-label="Previous working day">‹</button>
              <button class="current-period" type="button" id="cdPeriod" title="Pick a day" aria-haspopup="dialog" aria-expanded="false">${escapeHtml(cdDayLabel(cdDate))}</button>
              <button class="nav-btn" type="button" data-cd-day="1" title="Next working day" aria-label="Next working day">›</button>
            </div>
            <div class="requests-page-bar"><div class="req-new-group cd-list-group" role="group" aria-label="Case list">
              <span class="req-new-label">Case list</span>
              <button type="button" class="req-new-btn" id="cdPasteBtn" title="Paste the case list copied from Epic’s export">Paste</button>
              <button type="button" class="req-new-btn" id="cdExportAhk" title="${escapeHtml(exportTip)}"${has ? '' : ' disabled'}>Export</button>
              <button type="button" class="req-new-btn" id="cdRecord" title="${escapeHtml(recordTip)}"${has && !(cdRecordedKey && !cdRecordedDirty) ? '' : ' disabled'}>${recordTxt}</button>
            </div></div>` : ''}
          <div class="req-tabs requests-page-tabs" id="cdTabs" role="tablist">
            ${tab('day', 'Day', has ? cdCases.length : null)}${tab('types', 'Case types', nTypes)}${tab('people', 'Pathologists', null)}
          </div>
        </div>
      </header>`;
}

// ── Day ──
function cdDayHtml() {
    const has = cdCases.length > 0;
    const t = cdTotals();
    let list;
    if (!has) {
        list = `<div class="cf-empty"><span class="split-empty-headline">No case list for ${escapeHtml(cdDayLabel(cdDate))} yet.</span>In Epic, press Ctrl+Shift+1 to run the AutoHotkey script — or export the list from Epic and Paste it here.</div>`;
    } else {
        const secs = [];
        const look = cdCases.filter(cdLookStatus).sort((a, b) => a.seq - b.seq);
        const unknown = cdUnknownSpecimens();
        if (look.length || unknown.length) {
            secs.push(cdSecHtml('look', 'Needs a look', look.length + unknown.length, [
                ...look.map(c => cdLineHtml('day', 'look|' + c.key, cdAccTag(c), cdCaseText(c), cdLookStatus(c), () => cdCaseDetail(c), cdCaseLabel(c))),
                ...unknown.map(cdUnknownLine),
            ]));
        }
        const rows = Object.values(t.rows).filter(r => cdPath(r.pid)).sort((a, b) => cdPath(a.pid).id - cdPath(b.pid).id);
        rows.forEach(r => {
            const p = cdPath(r.pid);
            const mine = cdCases.filter(c => String(c.assigned) === String(r.pid)).sort((a, b) => a.seq - b.seq);
            const head = `<span class="cd-sec-path">${_pathTagHtml(p.id)}${r.w ? cdSvcPill(r.w.svc) : '<span class="cd-muted">not working</span>'}
                <span class="cd-sec-meta">${mine.length} case${mine.length === 1 ? '' : 's'} · ${escapeHtml(cdFmtMin(r.minutes))} ${cdDiffHtml(r.minutes - r.expected)}</span></span>`;
            secs.push(cdSecHtml('p' + p.id, head, null,
                mine.map(c => cdLineHtml('day', 'p' + p.id + '|' + c.key, cdAccTag(c), cdCaseText(c), null, () => cdCaseDetail(c), cdCaseLabel(c))),
                'No cases'));
        });
        list = secs.join('');
    }
    return `<div class="cf-body">
        <div class="cf-side"><div class="cf-list" aria-label="Cases">${list}</div></div>
        <section class="cf-cal" aria-label="The day"><div class="cd-panel">
          ${has ? cdWorkloadCard(t) : ''}${cdWorkingCard()}${has ? cdListCard() : ''}
        </div></section>
      </div>`;
}

function cdWorkloadCard(t) {
    const rows = Object.values(t.rows).filter(r => cdPath(r.pid)).sort((a, b) => cdPath(a.pid).id - cdPath(b.pid).id);
    const max = Math.max(1, ...rows.map(r => Math.max(r.minutes, r.expected))) * 1.04;
    return `<section class="cd-card">
        <h3 class="cd-card-h">Workload <span>${cdCases.length} cases · ${escapeHtml(cdFmtMin(t.total))}</span></h3>
        <div class="cd-load" title="Bar: estimated time · tick: fair share">
          ${rows.map(r => {
              const p = cdPath(r.pid);
              return `<button type="button" class="cd-load-who" data-cd-jump="${p.id}" title="Show ${escapeHtml(cdShortName(p))}’s cases">${_pathTagHtml(p.id)}</button>
                <div class="cd-bar"><span class="cd-bar-fill" style="width:${(r.minutes / max * 100).toFixed(1)}%;--c:${p.color};"></span><span class="cd-bar-target" style="left:${(r.expected / max * 100).toFixed(1)}%;"></span></div>
                <span class="cd-load-num">${escapeHtml(cdFmtMin(r.minutes))}</span>${cdDiffHtml(r.minutes - r.expected)}`;
          }).join('')}
          ${t.unassigned ? `<span class="ch-tag ch-tag-lock">Not assigned</span><span></span><span class="cd-load-num">${t.unassigned} case${t.unassigned === 1 ? '' : 's'}</span><span></span>` : ''}
        </div>
      </section>`;
}

function cdWorkingCard() {
    const sched = cdScheduled(cdDate);
    const { bal } = cdBalances(cdDate, cdRecordedKey);
    return `<section class="cd-card">
        <h3 class="cd-card-h">Working <span>from the schedule</span></h3>
        <div class="cd-working">${sched.length ? sched.map(w => {
            const b = bal[w.p.id] || 0;
            const balTxt = Math.abs(b) < 1 ? 'even' : (b > 0 ? cdFmtMin(b) + ' ahead' : cdFmtMin(-b) + ' behind');
            return `<span class="cd-person">
                <span class="cd-dot" style="--c:${w.p.color};"></span>
                <span class="cd-person-name">${escapeHtml(cdShortName(w.p))}</span>${cdSvcPill(w.svc)}
                <span class="cd-person-meta">${(w.share < 1 ? 'share ' + w.share.toFixed(2) + ' · ' : '') + balTxt}</span>
              </span>`;
        }).join('') : '<span class="cd-muted">No one is on a service this day.</span>'}</div>
      </section>`;
}

function cdListCard() {
    const batches = Object.keys(cdLedger[fmt(cdDate)] || {}).length;
    const from = cdListFrom ? (cdListFrom.how === 'script' ? 'The AutoHotkey script, ' : 'Pasted, ') + cdTime(cdListFrom.at) : 'Pasted';
    const recorded = !cdRecordedKey ? 'Not yet' : cdRecordedDirty ? 'Changed since — Update record' : cdTime(cdRecordedAt) || 'Yes';
    return `<section class="cd-card">
        <h3 class="cd-card-h">This list <span>${batches} recorded for this day</span></h3>
        <div class="cd-facts">
          <span>From</span><b>${escapeHtml(from)}</b>
          <span>Recorded</span><b>${escapeHtml(recorded)}</b>
          <span>Exported</span><b>${escapeHtml(cdExportedName || 'Not yet')}</b>
        </div>
        <div class="cd-card-actions">
          <button type="button" class="cd-btn cd-btn-sm" id="cdRedistribute" title="Re-split the cases the app chose (cases set by hand stay)">Redistribute</button>
          <button type="button" class="cd-btn cd-btn-sm" id="cdCopy">Copy for Excel</button>
          ${cdRecordedKey ? '<button type="button" class="cd-btn cd-btn-sm" id="cdUnrecord">Undo record</button>' : ''}
          <button type="button" class="cd-btn cd-btn-sm" id="cdClear">Clear list</button>
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
    { key: 'name', label: 'Case type', sort: true, tip: 'Hover a name for where its minutes come from (RCPath G107 time bands)' },
    { key: 'match', label: 'Recognized by', tip: 'Words in the specimen’s name, separated by ; — whole words; the longest match wins' },
    { key: 'minutes', label: 'First', sort: true, num: true, tip: 'Minutes for the first unit (container, core, polyp)' },
    { key: 'addMinutes', label: 'Each more', sort: true, num: true, tip: 'Minutes for each additional unit' },
    { key: 'slides', label: 'Slides', sort: true, num: true, tip: 'Usual slides per unit: more slides take a little longer, fewer a little less (−25% to +50%). Blank: not adjusted' },
    { key: 'services', label: 'Goes to', tip: 'Sent to whoever is on these services. Click a service once for first choice, again for backup (2nd), again to clear' },
    { key: 'readers', label: 'Read by', tip: 'Only these pathologists read it (bone marrows)' },
    { key: 'del', label: '' },
];

function cdTypeNum(t, key) {
    if (key === 'addMinutes') return Number.isFinite(Number(t.addMinutes)) && t.addMinutes !== undefined ? Number(t.addMinutes) : (Number(t.minutes) || 0);
    if (key === 'slides') return t.slides === undefined || t.slides === null || t.slides === '' ? null : Number(t.slides);
    return Number(t.minutes) || 0;
}

function cdTypeOrder(a, b) {
    const byName = String(a.name || '').localeCompare(String(b.name || ''));
    if (cdTypeSort.key === 'name') return cdTypeSort.dir * byName;
    const va = cdTypeNum(a, cdTypeSort.key), vb = cdTypeNum(b, cdTypeSort.key);
    return cdTypeSort.dir * ((va ?? -1) - (vb ?? -1)) || byName;
}

function cdTypeRow(t) {
    const slides = cdTypeNum(t, 'slides');
    return `<div class="cd-trow" role="row">
        <input type="text" class="cd-input cd-t-name" id="cdtn-${t.id}" data-cd-field="name" data-cd-type="${t.id}" value="${escapeHtml(t.name || '')}"
            aria-label="Case type name" title="${escapeHtml((t.name || '') + (t.basis ? ' — ' + t.basis : ''))}">
        <input type="text" class="cd-input cd-t-match" data-cd-field="match" data-cd-type="${t.id}" value="${escapeHtml(t.match || '')}"
            placeholder="words in the specimen name; separate with ;" aria-label="Recognized by" title="${escapeHtml(t.match || '')}">
        <input type="number" class="cd-input cd-t-num" data-cd-field="minutes" data-cd-type="${t.id}" min="0" max="600" step="0.5" value="${cdNum(cdTypeNum(t, 'minutes'))}" aria-label="Minutes for the first">
        <input type="number" class="cd-input cd-t-num" data-cd-field="addMinutes" data-cd-type="${t.id}" min="0" max="600" step="0.5" value="${cdNum(cdTypeNum(t, 'addMinutes'))}" aria-label="Minutes for each more">
        <input type="number" class="cd-input cd-t-num" data-cd-field="slides" data-cd-type="${t.id}" min="0" max="500" step="0.5" placeholder="off" value="${slides === null ? '' : cdNum(slides)}" aria-label="Usual slides">
        <span class="cd-t-chips">${cdChips('services', t.id, t.services)}</span>
        <span class="cd-t-chips">${cdChips('readers', t.id, t.readers)}</span>
        <button type="button" class="cd-btn cd-btn-sm cd-del" data-cd-del="${t.id}">Delete</button>
      </div>`;
}

function cdTypesViewHtml() {
    const list = cdTypeList().sort(cdTypeOrder);
    const routed = list.filter(t => cdServiceTiers(t.services));
    const readers = list.filter(t => !cdServiceTiers(t.services) && cdSetOf(t.readers));
    const shared = list.filter(t => !cdServiceTiers(t.services) && !cdSetOf(t.readers));
    const head = `<div class="cd-trow cd-thead" role="row">${CD_TYPE_COLS.map(c => {
        if (!c.sort) return `<span class="cd-th${c.num ? ' num' : ''}"${c.tip ? ` title="${escapeHtml(c.tip)}"` : ''}>${c.label}</span>`;
        const on = cdTypeSort.key === c.key;
        return `<button type="button" class="cd-th cd-th-sort${c.num ? ' num' : ''}${on ? ' is-on' : ''}" data-cd-tsort="${c.key}" title="${escapeHtml(c.tip)}"
            aria-sort="${on ? (cdTypeSort.dir > 0 ? 'ascending' : 'descending') : 'none'}">${c.label}<span class="cd-sort-arrow">${on ? (cdTypeSort.dir > 0 ? '▲' : '▼') : '↕'}</span></button>`;
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
        <div class="cf-side">${strip}<div class="cf-list cd-types" role="table" aria-label="Case types" style="--cd-readers:${pathologists.filter(p => typeof p.id === 'number').length}">${head}${secs}</div></div>
      </div>`;
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
        <section class="cd-card"><p class="cd-help-text">A full-time pathologist has a daily share of 1. A part-timer’s share is their FTE, raised when they take more PTO than the full-timers so the year still comes to FTE × a full-timer’s work (never more than a full day). Half of anyone’s lead or lag is worked off with each new list. “Typed in Epic” is what the AutoHotkey script types in Epic’s case assignment window — blank means the last name.</p></section>
      </div>`;
    return `<div class="cf-body"><div class="cf-side"><div class="cf-list" aria-label="Pathologists">${cdSecHtml('people', 'Pathologists', people.length, lines)}</div></div>
        <section class="cf-cal" aria-label="Ahead or behind">${panel}</section></div>`;
}

function renderCasesPage() {
    const root = document.getElementById('cdRoot');
    if (!root) return;
    if (!isAdmin()) { cdSetRoot(root, ''); return; }
    cdEnsureListener();
    if (!cdDate) cdDate = cdDefaultDate();
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

// The paste panel (in the app's panel style): the list copied from Epic's
// export, kept in this browser only.
function cdOpenPaste() {
    let back = document.getElementById('cdPasteBack');
    if (!back) {
        back = document.createElement('div');
        back.className = 'modal-back';
        back.id = 'cdPasteBack';
        back.innerHTML = `<div class="modal modal-stable cd-paste-modal" role="dialog" aria-labelledby="cdPasteTitle">
            <button type="button" class="modal-close-x" data-cd-paste="cancel" aria-label="Close" title="Close">&times;</button>
            <h3 id="cdPasteTitle">Paste the case list</h3>
            <div class="sub">In Excel, select the cells of Epic’s export (headers included), copy, and paste them here. The list stays in this browser and isn’t saved.</div>
            <div class="modal-scroll"><textarea id="cdPaste" class="cd-paste" spellcheck="false" aria-label="Case list"></textarea></div>
            <div class="modal-actions">
              <button type="button" data-cd-paste="clear">Clear</button>
              <button type="button" data-cd-paste="cancel">Cancel</button>
              <button type="button" class="primary" data-cd-paste="ok">Use this list</button>
            </div>
          </div>`;
        document.body.appendChild(back);
        back.addEventListener('click', e => {
            const b = e.target.closest('[data-cd-paste]');
            if (e.target === back || (b && b.dataset.cdPaste === 'cancel')) { back.classList.remove('open'); return; }
            if (!b) return;
            const ta = document.getElementById('cdPaste');
            if (b.dataset.cdPaste === 'clear') { ta.value = ''; ta.focus(); return; }
            back.classList.remove('open');
            cdUseList(ta.value, 'paste');
        });
        back.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); back.classList.remove('open'); } });
    }
    const ta = document.getElementById('cdPaste');
    ta.value = cdRawText;
    back.classList.add('open');
    setTimeout(() => { ta.focus(); ta.select(); }, 0);
}

// A new list (pasted, or handed over by the script).
function cdUseList(text, how) {
    cdSetPaste(text);
    cdListFrom = text.trim() ? { how, at: Date.now() } : null;
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
    cdRawText = text;
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

function cdRecord(quiet) {
    if (!cdCases.length) return;
    const dk = fmt(cdDate);
    const ref = cdRecordedKey
        ? db.ref('scheduler/caseDist/ledger/' + dk + '/' + cdRecordedKey)
        : db.ref('scheduler/caseDist/ledger/' + dk).push();
    const key = ref.key;
    ref.set(cdRecordedBatch()).then(() => {
        cdRecordedKey = key;
        cdRecordedDirty = false;
        cdRecordedAt = Date.now();
        if (!quiet) showToast('Recorded — these minutes now count toward each pathologist’s total.');
        renderCasesPage();
    }).catch(err => showToast('Could not record: ' + err.message, { type: 'error' }));
}

function cdUnrecord() {
    if (!cdRecordedKey) return;
    const dk = fmt(cdDate);
    db.ref('scheduler/caseDist/ledger/' + dk + '/' + cdRecordedKey).remove().then(() => {
        cdRecordedKey = null;
        cdRecordedDirty = false;
        cdRecordedAt = null;
        showToast('Record removed.');
        renderCasesPage();
    }).catch(err => showToast('Could not remove the record: ' + err.message, { type: 'error' }));
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
        showToast((auto ? `Imported ${cdCases.length} cases from the script, but can’t export: ` : 'Can’t export yet: ')
            + s.charAt(0).toLowerCase() + s.slice(1) + '.', { type: 'error', duration: auto ? 60000 : undefined });
        return false;
    }
    const now = new Date();
    const hhmm = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
    const name = `case-assignments-${fmt(cdDate)}-${hhmm}.tsv`;
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
    showToast(auto
        ? `Imported ${cdCases.length} cases from the script, recorded them and exported ${name}. The script takes it from here.`
        : `Exported ${cdCases.length} cases to ${name}`
            + (cdRecordedKey && !cdRecordedDirty ? '.' : ' — not recorded yet: Record so they count toward the running totals.'));
    return true;
}

// ── Hand-off from the AutoHotkey script ───────────────────────────────────
// The script puts the case list it exported from Epic on the clipboard,
// behind a first line reading CD_AUTO_MARK, brings this tab to the front and
// presses Ctrl+V. On any page, for the director: open Cases, take the list as
// if pasted, split it, export the file the script waits for in Downloads,
// and record the batch (these cases are being assigned now). When something
// stops the export (a case no one working can read), the page says so and
// the script times out telling the director to look here.
const CD_AUTO_MARK = '#PATHSCHED-AUTO';
let cdPendingAuto = null;   // a list that arrived before the settings loaded

function cdAutoRun(text) {
    if (typeof window.__setPage === 'function' && !cdPageActive()) window.__setPage('cases');
    if (!cdLoaded) { cdPendingAuto = text; cdEnsureListener(); return; }
    cdPendingAuto = null;
    cdTab = 'day';
    renderCasesPage();
    const ta = document.getElementById('cdPaste');
    if (ta) ta.value = text;
    cdSetPaste(text);
    cdListFrom = text.trim() ? { how: 'script', at: Date.now() } : null;
    if (!cdCases.length) {
        showToast('The script handed over a case list with no cases in it.', { type: 'error' });
        return;
    }
    // The same list again (a run that stopped, started over): replace its
    // record rather than count the cases twice, and split it as if that
    // record weren't there — as the first time.
    if (cdMatchRecord()) cdRecordedDirty = true;   // the script always re-records
    if (cdExportAhk(true)) cdRecord(true);
}

document.addEventListener('paste', e => {
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    const body = String(text || '').replace(/^\uFEFF/, '');
    if (!body.startsWith(CD_AUTO_MARK)) return;
    e.preventDefault();
    e.stopPropagation();
    if (typeof isAdmin !== 'function' || !isAdmin()) {
        showToast('Only the director can hand a case list to the Cases page.', { type: 'error' });
        return;
    }
    const nl = body.indexOf('\n');
    cdAutoRun(nl < 0 ? '' : body.slice(nl + 1));
}, true);

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
    ref.set({ name, match: fromText ? cdNorm(fromText).replace(/;/g, ' ') : '', minutes: first, addMinutes: add, slides })
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
    if (cdTable) { cdBuildCases(); if (cdRecordedKey) cdRecordedDirty = true; }
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
            c.pinned = el.value === '' ? null : Number(el.value);
            c.assigned = c.pinned;
            if (cdRecordedKey) cdRecordedDirty = true;
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
        } else if (d.cdDay) {
            cdSetDate(cdStepWorkday(cdDate, Number(d.cdDay)));
        } else if (t.id === 'cdPeriod') {
            // The schedule's date picker; days with a recorded list are marked.
            e.stopPropagation();
            toggleMiniCal({ anchor: t, month: cdDate, range: null, pick: day => cdSetDate(day),
                mark: day => (cdLedger[fmt(day)] ? 'mc-rq' : '') });
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
        } else if (t.id === 'cdPasteBtn') cdOpenPaste();
        else if (t.id === 'cdExportAhk') cdExportAhk();
        else if (t.id === 'cdRecord') cdRecord();
        else if (t.id === 'cdUnrecord') cdUnrecord();
        else if (t.id === 'cdCopy') cdCopy();
        else if (t.id === 'cdRedistribute') {
            cdDistribute();
            if (cdRecordedKey) cdRecordedDirty = true;
            renderCasesPage();
        } else if (t.id === 'cdClear') {
            cdUseList('', 'paste');
        } else if (d.cdUnpin) {
            const c = cdCases.find(x => x.key === d.cdUnpin);
            if (c) delete c.pinned;
            cdDistribute();
            if (cdRecordedKey) cdRecordedDirty = true;
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
        } else if (d.cdDel) {
            // Two-step delete: the first click arms the button.
            if (!t.classList.contains('armed')) {
                t.classList.add('armed');
                t.textContent = 'Confirm';
                setTimeout(() => { if (t.isConnected) { t.classList.remove('armed'); t.textContent = 'Delete'; } }, 3000);
                return;
            }
            cdSel.types = null;
            db.ref('scheduler/caseDist/types/' + d.cdDel).remove().then(cdAfterSettingsChange)
                .catch(err => showToast('Could not delete: ' + err.message, { type: 'error' }));
        }
    });
})();
