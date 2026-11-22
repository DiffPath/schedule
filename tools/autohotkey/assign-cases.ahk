#Requires AutoHotkey v2.0
#SingleInstance Force
#UseHook        ; catch the hotkeys before Citrix does (otherwise they never fire)

; ════════════════════════════════════════════════════════════════════════
; Assign the day's cases in Epic, from start to finish.
; ════════════════════════════════════════════════════════════════════════
;
; Before you start: the schedule is open in the browser, signed in as the
; director, and Epic is showing the list of cases to assign.
;
; Ctrl+Shift+1 (with Epic in front) runs all four steps:
;   1. Export Epic's case log to an Excel file           ExportFromEpic
;   2. Open that file in a hidden Excel and copy it      CopyFromExcel
;   3. Paste it into the schedule's Assign page, which   HandToApp,
;      splits the cases and copies the result back       WaitForAssignments
;   4. Assign the cases in Epic, one by one              AssignCases
;
; Ctrl+Shift+2 skips steps 1–3: you pick an assignments file and it goes
; straight to step 4. Also how to finish a run that stopped part-way.
;
; Before step 4 a box shows how many cases each pathologist gets. That's
; the moment to check the split: Cancel there and Epic isn't touched.
;
; While it runs: hands off the keyboard and mouse. Esc stops it at once;
; Pause pauses step 4. Every step is written to assign-cases.log, beside
; this script — the place to look when something goes wrong.
;
; How step 4 assigns a case is exactly what you'd do by hand:
;   Alt+G · type the last name · Down · Alt+G     assign the selected case
;   Down                                          move to the next case
; It never searches for a case: line N of the assignments file is the Nth
; case in Epic's list, so the list mustn't change between steps 1 and 4.
; Each case it assigns is noted in <assignments file>.done.txt, so a run
; that stopped carries on where it left off.

; ── Settings ─────────────────────────────────────────────────────────────
; Step 1: the folder Epic saves its export to, as Epic sees it.
;  - Epic on this computer: an ordinary folder, e.g. "C:\Users\<you>\Documents".
;  - Epic in Citrix: this computer's C: drive is \\Client\C$ to Epic; the
;    script finds the file at the matching C:\ path here.
EPIC_SAVE_DIR := "\\Client\C$\Users\Mike\Documents"

; Step 1: false = keep Epic's own file name (EPIC_SAVE_DIR must then be
; Epic's default folder) and pick up the newest Daily_Case_Log file there.
; true = type our own full path over it (works whatever Epic's default
; folder is, but slow over Citrix, ~3 s).
TYPE_FILE_NAME := false
EXPORT_FILE_PATTERN := "Daily_Case_Log_*.xlsx"

; Step 1: the export's password (typed twice in Epic, then used to open the
; file in Excel) and the export reason typed in Epic.
EXPORT_PASSWORD := "a"
EXPORT_REASON := "4"

; Step 1 waits, in milliseconds.
MENU_WAIT := 700            ; after Alt+3, for the menu
EXPORT_SCREEN_WAIT := 3000  ; after choosing export, for the export screen
FIELD_WAIT := 250           ; between the export screen's fields

; Step 3: the schedule's browser window (its title contains this; the
; schedule must be the tab showing in it).
APP_WINDOW := "Pathology Group Schedule"

; Step 3: where the script saves the assignments the Assign page hands back.
; Holds case numbers: keep it on this computer.
ASSIGNMENTS_DIR := A_ScriptDir "\assignments"

; Ctrl+Shift+2 also offers files from here (the Assign page's Export button
; downloads to the browser's folder).
DOWNLOADS := EnvGet("USERPROFILE") "\Downloads"

; Seconds to wait for Epic's export (step 1) and the Assign page (step 3).
EPIC_EXPORT_TIMEOUT := 120
APP_TIMEOUT := 60

; Step 4: assign at most this many cases per run, then stop (for trying it
; out); 0 = the whole list. Ctrl+Shift+2 with the same file goes on.
STOP_AFTER := 3

; Step 4 waits, in milliseconds. Raise them if Epic is slow and keys get lost.
OPEN_WAIT   := 500   ; after Alt+G, for the assignment window to open
NAME_WAIT   := 100    ; after typing the name, for Epic's matches to show
STEP_WAIT   := 300    ; after the Down arrow that picks the match
ASSIGN_WAIT := 300   ; after the second Alt+G, for the assignment to save
MOVE_WAIT   := 100    ; after the Down arrow to the next case

; How keys are sent: one at a time, KEY_DELAY ms apart, each held KEY_HOLD
; ms. Citrix drops keys sent all at once; raise these if letters go missing.
KEY_DELAY := 1
KEY_HOLD := 1

; ── Start-up ─────────────────────────────────────────────────────────────
SendMode "Event"                    ; one key at a time (see KEY_DELAY)
SetKeyDelay KEY_DELAY, KEY_HOLD
LOG_FILE := A_ScriptDir "\assign-cases.log"
busy := false        ; a run is going (so Esc stops it)
assigning := false   ; step 4 is going (so Pause pauses it)
paused := false

Trace("Script loaded")
if (A_Args.Length && A_Args[1] = "stopped") {     ; restarted by Esc
    ToolTip "Stopped."
    SetTimer () => ToolTip(), -2500
}

; ── Hotkeys ──────────────────────────────────────────────────────────────
; No Alt in the hotkeys: Epic and Citrix use Alt combinations.
^+1:: StartRun(RunEverything)
^+2:: StartRun(AssignFromFile)

; Esc during a run: restart the script, which stops whatever it was doing.
; Check Epic afterwards: an export screen or assignment window may be open.
#HotIf busy
Esc:: {
    Trace("Esc — stopped")
    Run '"' A_AhkPath '" /restart "' A_ScriptFullPath '" stopped'
    ExitApp
}
#HotIf assigning
Pause:: {
    global paused := !paused
    Trace(paused ? "Paused" : "Going on")
    ToolTip paused ? "Paused — press Pause to go on, Esc to stop" : ""
}
#HotIf

; Runs one of the two jobs. Any step that hits a problem throws an Error;
; it ends up here, in the log and in a message box.
StartRun(job) {
    global busy
    if busy
        return
    ; Wait for the hotkey's keys to be let go, so Ctrl or Shift never gets
    ; mixed into the keys the script sends to Epic.
    KeyWait "Control"
    KeyWait "Shift"
    KeyWait "1"
    KeyWait "2"
    busy := true
    Trace("Started — in front: " WinInfo("A"))
    try
        job()
    catch as e {
        Trace("STOPPED: " e.Message)
        ToolTip
        MsgBox e.Message, "Assign cases", "Icon!"
    }
    busy := false
    Trace("Run finished")
}

; Ctrl+Shift+1
RunEverything() {
    epicWin := WinExist("A")        ; Epic: the window in front at the hotkey
    Progress("1/4  Exporting the case list from Epic…")
    excelFile := ExportFromEpic(epicWin)
    Progress("2/4  Reading " excelFile "…")
    caseList := CopyFromExcel(excelFile)
    Progress("3/4  Handing the list to the Assign page…")
    HandToApp(caseList)
    assignFile := WaitForAssignments()
    ToolTip
    AssignCases(assignFile, epicWin)
}

; Ctrl+Shift+2
AssignFromFile() {
    epicWin := WinExist("A")
    path := FileSelect(1, NewestAssignments(), "Case assignments to enter in Epic", "Case assignments (*.tsv)")
    if (path != "")
        AssignCases(path, epicWin)
}

; ── Step 1: export Epic's case log ──────────────────────────────────────
; Returns the Excel file's path on this computer once Epic has written it.
ExportFromEpic(epicWin) {
    folder := LocalPathOf(EPIC_SAVE_DIR)
    if !DirExist(folder)
        throw Error("This computer can't see the export folder:`n" folder "`n`nCheck EPIC_SAVE_DIR at the top of the script.")
    FocusEpic(epicWin)
    started := A_Now
    ourName := "Daily_Case_Log_" FormatTime(, "yyyyMMdd_HHmmss") ".xlsx"

    Send "!3"                       ; Epic's menu
    Sleep MENU_WAIT
    Send "{Down 3}{Enter}"          ; … Export; the export screen loads
    Sleep EXPORT_SCREEN_WAIT
    if TYPE_FILE_NAME {
        Send "^a"                   ; replace Epic's file name with ours
        SendText EPIC_SAVE_DIR "\" ourName
        Sleep FIELD_WAIT
    }
    ; The rest of the export screen, one field at a time. "{Text}" sends
    ; what follows as plain text, not as key names.
    exportScreen := [
        "{Tab 2}", "{Text}" EXPORT_PASSWORD,    ; password
        "{Tab}",   "{Text}" EXPORT_PASSWORD,    ; password again
        "{Tab}",   "{Text}" EXPORT_REASON,      ; export reason
        "{Tab 2}", "{Enter}"                    ; accept
    ]
    for keys in exportScreen {
        Send keys
        Sleep FIELD_WAIT
    }

    return WaitForEpicFile(folder "\" (TYPE_FILE_NAME ? ourName : EXPORT_FILE_PATTERN), started)
}

; Epic's path → the same file on this computer: \\Client\C$\x → C:\x.
LocalPathOf(epicPath) {
    return RegExReplace(epicPath, "i)^\\\\Client\\([A-Z])\$", "$1:")
}

; The newest file matching `pattern` that's newer than `since`, once Epic
; has finished writing it: its size has stopped changing and nothing else
; has it open. Checks once a second.
WaitForEpicFile(pattern, since) {
    deadline := A_TickCount + EPIC_EXPORT_TIMEOUT * 1000
    lastSize := -1
    Trace("Step 1: waiting up to " EPIC_EXPORT_TIMEOUT " s for " pattern)
    loop {
        path := NewestFile([pattern], since)
        if (path != "") {
            size := FileGetSize(path)
            if (size > 0 && size = lastSize && NobodyElseHasOpen(path)) {
                Trace("Step 1: export found: " path " (" size " bytes)")
                return path
            }
            lastSize := size
        }
        if (A_TickCount > deadline)
            throw Error("Epic's export didn't appear within " EPIC_EXPORT_TIMEOUT " seconds:`n" pattern
                . "`n`nIs EPIC_SAVE_DIR Epic's export folder? If the export screen is still open in Epic, the keys may have landed in the wrong field: raise the waits at the top of the script.")
        Sleep 1000
    }
}

NobodyElseHasOpen(path) {
    try {
        FileOpen(path, "r -rwd").Close()    ; -rwd: open it, sharing with no one
        return true
    }
    return false
}

; ── Step 2: copy it out of Excel ─────────────────────────────────────────
; Epic's export is a password-protected Excel file. A hidden Excel opens it
; with the password and copies its cells — the same text you'd get by
; selecting them and pressing Ctrl+C, which is what the Assign page reads.
CopyFromExcel(path) {
    excel := ComObject("Excel.Application")
    ; Normally a new Excel of its own, closed at the end. If it ever turns
    ; out to be an Excel you have open (it has workbooks), leave that one.
    ownExcel := (excel.Workbooks.Count = 0)
    excel.DisplayAlerts := false
    try {
        ; Open(file, update links: no, read-only: yes, format, password)
        try book := excel.Workbooks.Open(path, 0, true, 1, EXPORT_PASSWORD)
        catch as e
            throw Error("Excel couldn't open Epic's export (is EXPORT_PASSWORD right?):`n" path "`n`n" e.Message)
        A_Clipboard := ""
        book.Worksheets(1).UsedRange.Copy()
        if !ClipWait(10)
            throw Error("Couldn't copy the cells from " path)
        text := A_Clipboard
        excel.CutCopyMode := false
    } finally {
        try book.Close(false)
        if ownExcel {
            try excel.Quit()
        } else {
            excel.DisplayAlerts := true
        }
    }
    if (Trim(text, " `t`r`n") = "")
        throw Error("Epic's export is empty: " path)
    return text
}

; ── Step 3: hand it to the Assign page and get the assignments back ─────
; The page and the script talk through the clipboard, each message behind
; a marker line so neither mistakes something else on the clipboard for it.
;   Script → page:  "#PATHSCHED-AUTO", then Epic's case list. Ctrl+V in the
;                   schedule's tab makes the page split and record the cases.
;   Page → script:  "#PATHSCHED-ASSIGNMENTS <tab> file name", then the file.
HandToApp(caseList) {
    appWin := WinExist(APP_WINDOW)
    if !appWin
        throw Error("The schedule isn't open. Open it in the browser, signed in as the director (window title containing `"" APP_WINDOW "`").")
    A_Clipboard := "#PATHSCHED-AUTO`r`n" caseList
    WinActivate appWin
    if !WinWaitActive(appWin, , 5)
        throw Error("Couldn't bring the schedule's window to the front.")
    try ControlFocus "Chrome_RenderWidgetHostHWND1", appWin    ; into the page, not the address bar
    Sleep 300
    Trace("Step 3: Ctrl+V into " WinInfo(appWin))
    Send "^v"
}

; Waits for the page's answer and saves it in ASSIGNMENTS_DIR. Returns the
; file's path. Each run gets a new file, since .done.txt goes by the file.
WaitForAssignments() {
    MARK := "#PATHSCHED-ASSIGNMENTS"
    deadline := A_TickCount + APP_TIMEOUT * 1000
    loop {
        clip := ""
        try clip := A_Clipboard     ; can fail while the browser is writing it
        if (SubStr(clip, 1, StrLen(MARK)) = MARK)
            break
        if (A_TickCount > deadline)
            throw Error("The Assign page didn't hand the assignments back within " APP_TIMEOUT " seconds. Look at the page: it says why (for example, a case no one working can read).")
        Sleep 250
    }
    A_Clipboard := ""               ; case numbers off the clipboard

    parts := StrSplit(clip, "`n", "`r", 2)          ; [marker line, the file]
    name := Trim(StrReplace(parts[1], MARK), " `t")
    if !RegExMatch(name, "^case-assignments-[\w-]+\.tsv$")
        name := "case-assignments-" FormatTime(, "yyyy-MM-dd-HHmm") ".tsv"
    DirCreate ASSIGNMENTS_DIR       ; (nothing happens if it's already there)
    SplitPath name, , , , &stem
    path := ASSIGNMENTS_DIR "\" name
    n := 1
    while FileExist(path)
        path := ASSIGNMENTS_DIR "\" stem " (" (++n) ").tsv"
    FileAppend parts.Length > 1 ? parts[2] : "", path, "UTF-8"
    Trace("Step 3: assignments saved to " path)
    return path
}

; ── Step 4: assign the cases in Epic ─────────────────────────────────────
AssignCases(path, epicWin) {
    global assigning, paused
    cases := LoadCases(path)
    doneLog := path ".done.txt"

    ; Skip the cases already assigned from this file on an earlier run.
    done := LoadDone(doneLog)
    start := 1
    while (start <= cases.Length && done.Has(cases[start].acc))
        start++
    if (start > cases.Length) {
        MsgBox "All " cases.Length " cases in this file are already assigned.", "Assign cases", "Iconi"
        return
    }

    ; The start box: the split, and which case to select in Epic.
    FocusEpic(epicWin)
    toDo := cases.Length - start + 1
    msg := toDo " of " cases.Length " cases to assign:`n`n" CasesPerPathologist(cases, start) "`n"
    if (STOP_AFTER > 0 && STOP_AFTER < toDo)
        msg .= "This run assigns the next " STOP_AFTER " cases only, then stops.`n`n"
    msg .= (start = 1 ? "" : "Cases 1–" (start - 1) " are done. ")
        . "In Epic, select case " start " (" cases[start].acc ")."
        . "`n`nEsc stops the script; Pause pauses.`n`nStart?"
    if (MsgBox(msg, "Assign cases", "OKCancel Iconi") != "OK") {
        Trace("Step 4: cancelled at the start box")
        return
    }
    Trace("Step 4: " path " — starting at case " start " of " cases.Length)

    assigning := true, paused := false
    assigned := 0, problem := ""
    i := start
    while (i <= cases.Length) {
        while paused
            Sleep 100
        c := cases[i]
        ToolTip i "/" cases.Length "   " c.acc "  →  " c.name
        try {
            FocusEpic(epicWin)
            AssignCase(c)
        } catch as e {
            problem := e.Message
            break
        }
        FileAppend c.acc "`t" c.epic "`t" FormatTime(, "yyyy-MM-dd HH:mm:ss") "`n", doneLog, "UTF-8"
        Trace("Step 4: case " i " " c.acc " → " c.epic)
        assigned++
        i++
        if (i > cases.Length)
            break
        NextCase()
        if (STOP_AFTER > 0 && assigned >= STOP_AFTER)
            break
    }
    assigning := false
    ToolTip

    msg := assigned " assigned."
    if (problem != "")
        msg .= "`n`n" problem
    if (i <= cases.Length)
        msg .= "`n`nStopped before case " i " (" cases[i].acc "). To finish: Ctrl+Shift+2 and the same file."
    Trace("Step 4: " StrReplace(msg, "`n`n", " "))
    MsgBox msg, "Assign cases", problem != "" ? "Icon!" : "Iconi"
}

; One case, already selected in Epic. c.epic is what to type (the last name).
AssignCase(c) {
    Send "!g"                       ; open the assignment window
    Sleep OPEN_WAIT
    SendText c.epic                 ; the pathologist's name
    Sleep NAME_WAIT
    Send "{Down}"                   ; pick the match
    Sleep STEP_WAIT
    Send "!g"                       ; assign
    Sleep ASSIGN_WAIT
}

; From this case to the next one in Epic's list.
NextCase() {
    Send "{Down}"
    Sleep MOVE_WAIT
}

; The assignments file → a list of {acc, epic, name}, in Epic's order.
; Its columns: Seq · Case · EpicUser · Pathologist · Minutes. Lines that
; don't start with a number (the header) are skipped.
LoadCases(path) {
    cases := []
    for n, line in StrSplit(FileRead(path, "UTF-8"), "`n", "`r") {
        f := StrSplit(line, "`t", " ")
        if (Trim(line) = "" || !IsInteger(f[1]))
            continue
        if (f.Length < 4 || f[2] = "" || f[3] = "")
            throw Error("Line " n " of " path " is missing a case number or a name:`n" line)
        if (Integer(f[1]) != cases.Length + 1)
            throw Error("Line " n " of " path " is case " f[1] ", expected " (cases.Length + 1) ". The file must list every case in Epic's order.")
        cases.Push({ acc: f[2], epic: f[3], name: f[4] })
    }
    if (cases.Length = 0)
        throw Error("No cases in " path ". Is it an export from the Assign page?")
    return cases
}

; The case numbers already assigned (the first column of the .done.txt).
LoadDone(doneLog) {
    done := Map()
    if FileExist(doneLog)
        for line in StrSplit(FileRead(doneLog, "UTF-8"), "`n", "`r")
            if (line != "")
                done[StrSplit(line, "`t")[1]] := true
    return done
}

; "Dr. Moravek: 22" lines for the start box, from case `start` on.
CasesPerPathologist(cases, start) {
    counts := Map()
    Loop cases.Length - start + 1 {
        name := cases[start + A_Index - 1].name
        counts[name] := counts.Get(name, 0) + 1
    }
    s := ""
    for name, n in counts
        s .= "     " name ": " n "`n"
    return s
}

; ── Small helpers ────────────────────────────────────────────────────────
; Bring Epic (the window in front at the hotkey) back to the front.
FocusEpic(win) {
    if !WinExist(win)
        throw Error("The Epic window is gone.")
    WinActivate win
    if !WinWaitActive(win, , 3)
        throw Error("Couldn't bring Epic to the front.")
}

; The newest file matching any of `patterns`, modified at or after `since`
; (a date-time like A_Now); "" when there's none. File times are compared as
; numbers, YYYYMMDDHHMISS.
NewestFile(patterns, since := 0) {
    newest := "", newestTime := Number(since)
    for pattern in patterns
        Loop Files pattern {
            t := Number(A_LoopFileTimeModified)
            if (t >= newestTime)
                newestTime := t, newest := A_LoopFileFullPath
        }
    return newest
}

; The newest assignments file, to preselect in Ctrl+Shift+2's picker.
NewestAssignments() {
    newest := NewestFile([ASSIGNMENTS_DIR "\case-assignments-*.tsv", DOWNLOADS "\case-assignments-*.tsv"])
    return newest != "" ? newest : ASSIGNMENTS_DIR "\"
}

; A tooltip for the person watching, and a line in the log.
Progress(msg) {
    ToolTip msg "  (Esc stops)"
    Trace(msg)
}

; One line in assign-cases.log.
Trace(msg) {
    try FileAppend FormatTime(, "yyyy-MM-dd HH:mm:ss") "  " msg "`n", LOG_FILE, "UTF-8"
}

; "title | program | window class" of a window, for the log.
WinInfo(win) {
    try return WinGetTitle(win) " | " WinGetProcessName(win) " | " WinGetClass(win)
    return "(no window)"
}
