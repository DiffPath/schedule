#Requires AutoHotkey v2.0
#SingleInstance Force
; The hotkeys go through AutoHotkey's keyboard hook: Citrix catches keys
; first otherwise, and the hotkeys never fire.
#UseHook

; ════════════════════════════════════════════════════════════════════════
; Assign the day's cases in Epic, from start to finish.
; ════════════════════════════════════════════════════════════════════════
;
; Before: the schedule is open in the browser, signed in as the director
; (any page), and Epic shows the case list to assign.
;
; Ctrl+Shift+1, with Epic in front — the whole run:
;   1. Exports Epic's case log to EPIC_SAVE_DIR           (ExportFromEpic)
;   2. Opens it in Excel (out of sight) and copies it     (ReadCaseList)
;   3. Hands it to the Cases page, which splits it, records it and
;      exports the assignments to Downloads               (HandToApp)
;   4. Back in Epic, assigns the cases one by one, from the first case of
;      the list down                                      (RunAssignments)
;   The start box in step 4 shows how many cases each pathologist gets:
;   that's the moment to check the split. Cancel there and nothing in Epic
;   is touched.
;
; Ctrl+Shift+2 — skip steps 1–3: pick an assignments file yourself (the
; newest is preselected). Also how to finish a run that stopped: the script
; says which case to select in Epic and carries on from there.
;
; The same two are on the tray icon's menu (the green H): pick one, then
; click on Epic within 3 seconds. For when the hotkeys don't get through.
;
; Esc stops the script at once, at any step (while it's running; the rest
; of the time Esc goes to Epic as usual). Pause pauses while assigning.
; Hands off the keyboard and mouse while it runs.
;
; Every step is written to assign-cases.log beside this script — the place
; to look when something doesn't work (tray menu → Open the log).
;
; Assigning, per case, is what you'd do by hand:
;   Alt+G · types the last name · Down · Alt+G   (assigns the case)
;   Down                                         (selects the next case)
; It never looks a case up: line N of the assignments file is the Nth case
; of Epic's list, so the list mustn't change between step 1 and step 4.
; Each assigned case goes into <file>.done.txt beside the assignments file.

; ── Settings ─────────────────────────────────────────────────────────────
; Step 1: where Epic saves the case log, as Epic sees the folder.
;  - Epic on this computer: an ordinary folder, e.g. "C:\Users\<you>\Documents".
;  - Epic in Citrix (the test setup): this computer's C: drive is \\Client\C$
;    to Epic; the script finds the file at the matching C:\ path here.
EPIC_SAVE_DIR := "\\Client\C$\Users\Mike\Documents"

; Step 1: keep Epic's own file name (Daily_Case_Log_<date>_<time>.xlsx in
; EPIC_SAVE_DIR, which must be Epic's default folder) and pick up the newest
; such file — or type a name over it (true; slow over Citrix, ~3 s).
TYPE_FILE_NAME := false
EXPORT_FILE_PATTERN := "Daily_Case_Log_*.xlsx"

; Step 1: the export's password (typed twice in Epic, and used to open the
; file in Excel) and the export reason typed in Epic.
EXPORT_PASSWORD := "a"
EXPORT_REASON := "4"

; Step 1 waits, in milliseconds.
MENU_WAIT := 700            ; after Alt+3, for the menu
EXPORT_SCREEN_WAIT := 3000  ; after choosing export, for the export screen
FIELD_WAIT := 250           ; between the export screen's fields

; Where the browser saves downloads (the Cases page's export lands here).
DOWNLOADS := EnvGet("USERPROFILE") "\Downloads"

; The schedule's browser window: its title contains this. The schedule must
; be the tab showing in that window.
APP_WINDOW := "Pathology Group Schedule"

; Seconds to wait for Epic's export file (step 1) and the Cases page (step 3).
EPIC_EXPORT_TIMEOUT := 120
APP_TIMEOUT := 60

; Keys that select the first case of Epic's list, e.g. "^{Home}". Blank:
; the start box asks you to click it.
FIRST_CASE_KEYS := ""

; Ask before each of the first N cases (Yes / skip / stop); 0 = never.
CONFIRM_FIRST := 0

; Assign at most this many cases per run, then stop (for trying it out);
; 0 = the whole list. Run the same file again (Ctrl+Shift+2) to go on.
STOP_AFTER := 3

; Waits, in milliseconds. Raise them if Epic is slow and keys get lost.
OPEN_WAIT   := 500   ; after Alt+G, for the assignment window to open
NAME_WAIT   := 100    ; after typing the name, for Epic's matches to show
STEP_WAIT   := 300    ; after the Down arrow that picks the match
ASSIGN_WAIT := 300   ; after the second Alt+G, for the assignment to save
MOVE_WAIT   := 100    ; after the Down arrow to the next case

; Dry run: step 4 walks the file and shows each case without pressing keys.
DRY_RUN := false

; How keys are sent: one at a time, KEY_DELAY ms apart, each held KEY_HOLD
; ms. Citrix drops keys sent all at once; raise these if letters go missing.
KEY_DELAY := 1
KEY_HOLD := 1

; ── Start-up ─────────────────────────────────────────────────────────────
SendMode "Event"
SetKeyDelay KEY_DELAY || 0, KEY_HOLD || 0     ; blank = 0
LOG_FILE := A_ScriptDir "\assign-cases.log"
busy := false        ; a run is going (Esc stops it)
running := false     ; step 4 is assigning (Pause pauses it)
paused := false

A_TrayMenu.Insert("1&", "Run everything (Ctrl+Shift+1)", (*) => StartFromTray(RunEverything))
A_TrayMenu.Insert("2&", "Assign from a file (Ctrl+Shift+2)", (*) => StartFromTray(RunAssignments))
A_TrayMenu.Insert("3&", "Open the log", (*) => FileExist(LOG_FILE) ? Run('notepad.exe "' LOG_FILE '"') : MsgBox("Nothing logged yet.", "Assign cases"))
A_TrayMenu.Insert("4&")
A_IconTip := "Assign cases — Ctrl+Shift+1 / Ctrl+Shift+2"

Trace("Script loaded (AutoHotkey " A_AhkVersion ")" (A_Args.Length && A_Args[1] = "stopped" ? " — restarted after Esc" : ""))
if (A_Args.Length && A_Args[1] = "stopped") {
    ToolTip "Stopped."
    SetTimer () => ToolTip(), -2500
}

; ── Step 1: export Epic's case log ──────────────────────────────────────
; Epic is in front, showing the case list. Its export, by keyboard:
;   Alt+3 · Down ×3 · Enter        (export; the export screen loads)
;   [file name]                    (only with TYPE_FILE_NAME; else Epic's)
;   Tab ×2 · password · Tab · password again · Tab · export reason
;   Tab ×2 · Enter                 (accept)
; Returns the file's path on this computer once Epic has finished it.
ExportFromEpic(epicWin) {
    name := "Daily_Case_Log_" FormatTime(, "yyyyMMdd_HHmmss") ".xlsx"
    epicPath := EPIC_SAVE_DIR "\" name
    localPath := LocalPathOf(epicPath)
    localDir := LocalPathOf(EPIC_SAVE_DIR)
    if !DirExist(localDir)
        throw Error("This computer can't see the export folder:`n" localDir "`n`nCheck EPIC_SAVE_DIR at the top of the script.")
    if !FocusEpic(epicWin)
        throw Error("Epic isn't in front.")
    since := A_Now

    Trace("Step 1: Alt+3")
    Send "!3"
    Sleep MENU_WAIT
    Trace("Step 1: Down x3, Enter — waiting " EXPORT_SCREEN_WAIT " ms for the export screen")
    Send "{Down 3}{Enter}"
    Sleep EXPORT_SCREEN_WAIT
    if TYPE_FILE_NAME {
        Trace("Step 1: file name " epicPath "  (in front: " WinInfo("A") ")")
        Send "^a"                   ; replace the default file name
        SendText epicPath
        Sleep FIELD_WAIT
    } else
        Trace("Step 1: keeping Epic's file name  (in front: " WinInfo("A") ")")
    Trace("Step 1: Tab x2, password, Tab, password, Tab, reason " EXPORT_REASON ", Tab x2, Enter")
    Send "{Tab 2}"
    Sleep FIELD_WAIT
    SendText EXPORT_PASSWORD
    Sleep FIELD_WAIT
    Send "{Tab}"
    Sleep FIELD_WAIT
    SendText EXPORT_PASSWORD
    Sleep FIELD_WAIT
    Send "{Tab}"
    Sleep FIELD_WAIT
    SendText EXPORT_REASON
    Sleep FIELD_WAIT
    Send "{Tab 2}"
    Sleep FIELD_WAIT
    Send "{Enter}"

    if !TYPE_FILE_NAME {
        ; Epic's own name: the newest matching file since the export began.
        Trace("Step 1: waiting up to " EPIC_EXPORT_TIMEOUT " s for a new " EXPORT_FILE_PATTERN " in " localDir)
        localPath := WaitForNewFile(localDir "\" EXPORT_FILE_PATTERN, since, EPIC_EXPORT_TIMEOUT)
        if (localPath = "")
            throw Error("Epic's export didn't appear within " EPIC_EXPORT_TIMEOUT " seconds in:`n" localDir
                . "`n`nIs that Epic's default export folder (EPIC_SAVE_DIR)? If the export screen is still open in Epic, the keys may have landed in the wrong field: raise the waits at the top of the script.")
    } else
        Trace("Step 1: waiting up to " EPIC_EXPORT_TIMEOUT " s for " localPath)
    WaitForFile(localPath, EPIC_EXPORT_TIMEOUT)    ; Epic has finished writing it
    Trace("Step 1: export found: " localPath " (" FileGetSize(localPath) " bytes)")
    return localPath
}

; Epic's path → the same file on this computer: \\Client\C$\x → C:\x.
LocalPathOf(epicPath) {
    return RegExReplace(epicPath, "i)^\\\\Client\\([A-Z])\$", "$1:")
}

; Wait for Epic to finish writing the file: it exists, its size has stopped
; changing, and nothing else has it open.
WaitForFile(path, timeout) {
    deadline := A_TickCount + timeout * 1000
    lastSize := -1
    loop {
        if FileExist(path) {
            size := FileGetSize(path)
            if (size > 0 && size = lastSize && CanOpenAlone(path))
                return path
            lastSize := size
        }
        if (A_TickCount > deadline)
            throw Error("Epic's export didn't appear within " timeout " seconds at:`n" path
                . "`n`nIf the export screen is still open in Epic, the keys may have landed in the wrong field: raise the waits at the top of the script.")
        Sleep 1000
    }
}

CanOpenAlone(path) {
    try {
        f := FileOpen(path, "r -rwd")
        if !f
            return false
        f.Close()
        return true
    }
    return false
}

; ── Step 2: read it ─────────────────────────────────────────────────────
; Epic's export is a password-protected Excel file. Excel opens it out of
; sight with the password, and its cells are copied — the same text as
; selecting them and pressing Ctrl+C, which is what the Cases page expects.
; (Opening it without the password leaves Excel waiting at a hidden
; password prompt.) Text files (CSV / tab-separated) are read as is.
ReadCaseList(path) {
    SplitPath path, , , &ext
    text := (ext = "xlsx" || ext = "xls" || ext = "xlsm") ? CopyFromExcel(path) : FileRead(path)
    if (Trim(text, " `t`r`n") = "")
        throw Error("Epic's export is empty: " path)
    return text
}

CopyFromExcel(path) {
    xl := ComObject("Excel.Application")
    ; Normally a separate Excel of its own. If it ever comes back as an
    ; Excel you have open (workbooks in it), leave that one running.
    ownExcel := (xl.Workbooks.Count = 0)
    if ownExcel
        xl.Visible := false
    xl.DisplayAlerts := false
    wb := ""
    try {
        ; Open(FileName, UpdateLinks, ReadOnly, Format, Password)
        try
            wb := xl.Workbooks.Open(path, 0, true, 1, EXPORT_PASSWORD)
        catch as e
            throw Error("Excel couldn't open Epic's export (is EXPORT_PASSWORD right?):`n" path "`n`n" e.Message)
        A_Clipboard := ""
        wb.Worksheets(1).UsedRange.Copy()
        if !ClipWait(10)
            throw Error("Couldn't copy the cells from " path)
        text := A_Clipboard
        xl.CutCopyMode := false
    } finally {
        try wb.Close(false)
        if ownExcel {
            try xl.Quit()
        } else {
            xl.DisplayAlerts := true
        }
    }
    return text
}

; ── Step 3: hand it to the Cases page ───────────────────────────────────
; The list goes on the clipboard behind a marker line; Ctrl+V in the
; schedule's tab makes the Cases page take it, split it, record it and
; export the assignments to Downloads.
HandToApp(text) {
    appWin := WinExist(APP_WINDOW)
    if !appWin
        throw Error("The schedule isn't open. Open it in the browser, signed in as the director (window title containing `"" APP_WINDOW "`").")
    Trace("Step 3: schedule window: " WinInfo(appWin))
    A_Clipboard := ""
    A_Clipboard := "#PATHSCHED-AUTO`r`n" text
    if !ClipWait(5)
        throw Error("Couldn't put the case list on the clipboard.")
    WinActivate appWin
    if !WinWaitActive(appWin, , 5)
        throw Error("Couldn't bring the schedule's window to the front.")
    ; Keyboard focus into the page, not the address bar (Chrome and Edge).
    try ControlFocus "Chrome_RenderWidgetHostHWND1", appWin
    Sleep 300
    Trace("Step 3: Ctrl+V into the schedule")
    Send "^v"
}

; ── Hotkeys, tray menu, Esc ──────────────────────────────────────────────
; No Alt in the hotkeys (Epic and Citrix use Alt combinations). The script
; waits until the hotkey's keys are let go before sending anything, so Epic
; never gets Ctrl or Shift mixed into its keys.
^+1:: {
    Trace("Ctrl+Shift+1 pressed — in front: " WinInfo("A"))
    ReleaseHotkey()
    StartRun(RunEverything)
}
^+2:: {
    Trace("Ctrl+Shift+2 pressed — in front: " WinInfo("A"))
    ReleaseHotkey()
    StartRun(RunAssignments)
}

ReleaseHotkey() {
    KeyWait "Control"
    KeyWait "Shift"
    KeyWait "1"
    KeyWait "2"
}

; From the tray menu: the menu took the focus, so give the user 3 seconds
; to click on Epic; the run starts with whatever is in front then.
StartFromTray(fn) {
    Loop 3 {
        ToolTip "Click on Epic — starting in " (4 - A_Index) "…"
        Sleep 1000
    }
    ToolTip
    Trace("Started from the tray menu — in front: " WinInfo("A"))
    StartRun(fn)
}

StartRun(fn) {
    global busy
    if busy
        return
    busy := true
    try
        fn()
    catch as e {
        Trace("ERROR: " e.Message " (" e.What ", line " e.Line ")")
        ToolTip
        MsgBox "Something went wrong:`n`n" e.Message, "Assign cases", "Icon!"
    }
    busy := false
    Trace("Run finished")
}

; Esc while a run is going: stop everything now. The script restarts itself
; (ready for the next run) — whatever it was doing ends mid-way, so check
; Epic: an export screen or an assignment window may be left open.
#HotIf busy
Esc:: {
    Trace("Esc — stopped")
    Run '"' A_AhkPath '" /restart "' A_ScriptFullPath '" stopped'
    ExitApp
}
#HotIf
#HotIf running
Pause:: {
    global paused := !paused
    Trace(paused ? "Paused" : "Going on")
    ToolTip paused ? "Paused — press Pause to go on, Esc to stop" : ""
}
#HotIf

; ── Everything ───────────────────────────────────────────────────────────
RunEverything() {
    epicWin := WinExist("A")   ; Epic, in front, showing the list
    Trace("Run everything — Epic window: " WinInfo(epicWin))
    try {
        ToolTip "1/4  Exporting the case list from Epic…  (Esc stops)"
        listFile := ExportFromEpic(epicWin)
        ToolTip "2/4  Reading " listFile "…  (Esc stops)"
        Trace("Step 2: reading " listFile)
        text := ReadCaseList(listFile)
        Trace("Step 2: " StrSplit(RTrim(text, "`r`n"), "`n").Length " lines copied")
        ToolTip "3/4  Handing the list to the Cases page…  (Esc stops)"
        since := A_Now
        HandToApp(text)
        Trace("Step 3: waiting up to " APP_TIMEOUT " s for the assignments in " DOWNLOADS)
        assignFile := WaitForNewFile(DOWNLOADS "\case-assignments-*.tsv", since, APP_TIMEOUT)
        if (assignFile = "")
            throw Error("The Cases page didn't export the assignments within " APP_TIMEOUT " seconds. Look at the page: it says why (for example, a case no one working can read).")
        Trace("Step 3: assignments " assignFile)
    } catch as e {
        Trace("STOPPED: " e.Message)
        ToolTip
        MsgBox e.Message, "Assign cases", "Icon!"
        return
    }
    ToolTip
    if !FocusEpic(epicWin)
        return
    if (FIRST_CASE_KEYS != "") {
        Send FIRST_CASE_KEYS
        Sleep MOVE_WAIT
    }
    RunAssignments(assignFile, epicWin)
}

; ── Step 4: assign ───────────────────────────────────────────────────────

; path: the assignments file (blank = pick one). epicWin: Epic's window
; (blank = the window in front now).
RunAssignments(path := "", epicWin := 0) {
    global running, paused
    if !epicWin
        epicWin := WinExist("A")

    if (path = "")
        path := FileSelect(1, NewestExport(), "Case assignments to enter in Epic", "Case assignments (*.tsv)")
    if (path = "")
        return
    Trace("Step 4: assignments " path " — Epic window: " WinInfo(epicWin))
    try
        cases := LoadCases(path)
    catch as e {
        Trace("Step 4: couldn't read it: " e.Message)
        MsgBox "Couldn't read " path ":`n`n" e.Message, "Assign cases", "Icon!"
        return
    }

    logPath := path ".done.txt"
    done := LoadDone(logPath)
    start := 0
    for i, c in cases
        if !done.Has(c.acc) {
            start := i
            break
        }
    if (start = 0) {
        MsgBox "All " cases.Length " cases in this file are already assigned.", "Assign cases", "Iconi"
        return
    }
    first := cases[start]
    todo := []
    for i, c in cases
        if (i >= start && !done.Has(c.acc))
            todo.Push(c)

    msg := (DRY_RUN ? "DRY RUN — no keys will be pressed.`n`n" : "")
        . todo.Length " of " cases.Length " cases to assign:`n`n" Summary(todo) "`n"
        . (STOP_AFTER > 0 && STOP_AFTER < todo.Length ? "This run assigns the next " STOP_AFTER " cases only, then stops.`n`n" : "")
        . (start = 1
            ? "In Epic, case 1 (" first.acc ") must be selected."
            : "Cases before " start " are done. In Epic, select case " start " (" first.acc ").")
        . "`n`nEsc stops the script; Pause pauses.`n`nStart?"
    if (MsgBox(msg, "Assign cases — " WinTitleOf(epicWin), "OKCancel Iconi") != "OK") {
        Trace("Step 4: cancelled at the start box (" todo.Length " cases)")
        return
    }
    Trace("Step 4: starting at case " start " of " cases.Length)
    if !DRY_RUN && !FocusEpic(epicWin)
        return

    running := true, paused := false
    assigned := 0, skipped := 0, asked := 0, nextUp := 0
    Loop cases.Length - start + 1 {
        i := start + A_Index - 1
        c := cases[i]
        while paused
            Sleep 100
        isLast := (i = cases.Length)

        ; Assigned on an earlier run (a case skipped back then sits between
        ; them): just move past it.
        if done.Has(c.acc) {
            if !DRY_RUN && !isLast {
                if !FocusEpic(epicWin) {
                    nextUp := i
                    break
                }
                NextCase()
            }
            continue
        }

        ToolTip i "/" cases.Length "   " c.acc "  →  " c.name

        if (asked < CONFIRM_FIRST) {
            asked++
            r := MsgBox("Case " i ": " c.acc " → " c.name "`n`nCheck that " c.acc " is the case selected in Epic.`n`n"
                . "Yes = assign it · No = skip it (move to the next case) · Cancel = stop",
                "Assign cases (" i "/" cases.Length ")", "YesNoCancel Icon?")
            if (r = "Cancel") {
                Trace("Step 4: stopped at case " i " (" c.acc ")")
                nextUp := i
                break
            }
            if (r = "No") {
                Trace("Step 4: skipped case " i " (" c.acc ")")
                skipped++
                if !DRY_RUN && !isLast {
                    if !FocusEpic(epicWin) {
                        nextUp := i + 1
                        break
                    }
                    NextCase()
                }
                continue
            }
        }

        if DRY_RUN {
            Sleep 250
            assigned++
            continue
        }
        if !FocusEpic(epicWin) {
            nextUp := i
            break
        }
        try
            AssignCase(c)
        catch as e {
            Trace("Step 4: ERROR at case " i " (" c.acc "): " e.Message)
            MsgBox "Stopped at case " i " (" c.acc "):`n`n" e.Message, "Assign cases", "Icon!"
            nextUp := i
            break
        }
        FileAppend c.acc "`t" c.epic "`t" FormatTime(, "yyyy-MM-dd HH:mm:ss") "`n", logPath, "UTF-8"
        Trace("Step 4: case " i " " c.acc " → " c.epic)
        assigned++
        if !isLast
            NextCase()
        if (STOP_AFTER > 0 && assigned >= STOP_AFTER && !isLast) {
            Trace("Step 4: stopping after " STOP_AFTER " cases (STOP_AFTER)")
            nextUp := i + 1
            break
        }
    }
    running := false
    ToolTip
    Trace("Step 4: done — " assigned " assigned, " skipped " skipped" (nextUp ? ", stopped before case " nextUp : ""))

    msg := (DRY_RUN ? "Dry run finished — nothing was assigned.`n`n" : "")
        . assigned (DRY_RUN ? " checked" : " assigned")
        . (skipped ? ", " skipped " skipped" : "") "."
    if nextUp
        msg .= "`n`nStopped before case " nextUp " (" cases[nextUp].acc ")."
    if !DRY_RUN && (nextUp || skipped)
        msg .= "`n`nTo finish: Ctrl+Shift+2 and the same file; the script tells you which case to select."
    MsgBox(msg, "Assign cases", "Iconi")
}

; One case, already selected in Epic. c.epic is what to type (the last
; name, from the Cases page). Throw to stop the run.
AssignCase(c) {
    Send "!g"
    Sleep OPEN_WAIT
    SendText c.epic
    Sleep NAME_WAIT
    Send "{Down}"
    Sleep STEP_WAIT
    Send "!g"
    Sleep ASSIGN_WAIT
}

; From this case to the next one in Epic's list.
NextCase() {
    Send "{Down}"
    Sleep MOVE_WAIT
}

; ── Helpers ──────────────────────────────────────────────────────────────
; Bring Epic (the window that was in front at the hotkey) back to the front.
FocusEpic(win) {
    if !WinExist(win) {
        MsgBox "The Epic window is gone.", "Assign cases", "Icon!"
        return false
    }
    WinActivate win
    if !WinWaitActive(win, , 3) {
        MsgBox "Couldn't bring Epic to the front.", "Assign cases", "Icon!"
        return false
    }
    return true
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

WinTitleOf(win) {
    try return WinGetTitle(win)
    return "Epic"
}

; The newest file matching pattern modified at or after `since` (A_Now
; format), waiting up to `timeout` seconds; "" when none turns up. A
; browser download only gets its final name once it's complete. If the
; browser asks where to save it, Save is pressed (it offers Downloads).
; (File times are compared as numbers: AutoHotkey refuses to compare a
; number with an empty string.)
WaitForNewFile(pattern, since, timeout) {
    deadline := A_TickCount + timeout * 1000
    since := Number(since)
    loop {
        newest := "", newestTime := 0
        Loop Files pattern {
            t := Number(A_LoopFileTimeModified)
            if (t >= since && t > newestTime)
                newestTime := t, newest := A_LoopFileFullPath
        }
        if (newest != "") {
            Sleep 500     ; let the writer finish
            return newest
        }
        AcceptSaveDialog()
        if (A_TickCount > deadline)
            return ""
        Sleep 500
    }
}

; The browser's "Save As" box for the Cases page's download: press Save.
AcceptSaveDialog() {
    for exe in ["chrome.exe", "msedge.exe"] {
        dlg := WinExist("Save As ahk_class #32770 ahk_exe " exe)
        if !dlg
            continue
        Trace("Step 3: the browser asked where to save — pressing Save")
        WinActivate dlg
        if WinWaitActive(dlg, , 2)
            Send "{Enter}"
        Sleep 1000
        return
    }
}

; The newest assignments file in Downloads, to preselect in the picker.
NewestExport() {
    newest := "", newestTime := 0
    Loop Files DOWNLOADS "\case-assignments-*.tsv" {
        t := Number(A_LoopFileTimeModified)
        if (t > newestTime)
            newestTime := t, newest := A_LoopFileFullPath
    }
    return newest != "" ? newest : DOWNLOADS "\"
}

; The assignments file → [{seq, acc, epic, name}], in file order (= Epic's
; order). Lines whose first field isn't a number (the header, blanks) are
; skipped.
LoadCases(path) {
    cases := []
    for n, line in StrSplit(FileRead(path, "UTF-8"), "`n", "`r") {
        line := LTrim(line, Chr(0xFEFF))      ; the file's byte-order mark
        if (Trim(line) = "")
            continue
        f := StrSplit(line, "`t")
        if !RegExMatch(f[1], "^\s*\d+\s*$")
            continue
        if (f.Length < 4 || Trim(f[2]) = "" || Trim(f[3]) = "")
            throw Error("Line " n " is missing a case number or a name:`n" line)
        seq := Integer(Trim(f[1]))
        if (seq != cases.Length + 1)
            throw Error("Line " n " is case " seq ", expected " (cases.Length + 1) ". The file must list every case in Epic's order.")
        cases.Push({ seq: seq, acc: Trim(f[2]), epic: Trim(f[3]), name: Trim(f[4]) })
    }
    if (cases.Length = 0)
        throw Error("No cases in it. Is this an export from the Cases page?")
    return cases
}

; Case numbers already assigned from this file (the first field of each
; line of the .done.txt log).
LoadDone(logPath) {
    done := Map()
    if FileExist(logPath)
        for line in StrSplit(FileRead(logPath, "UTF-8"), "`n", "`r")
            if (line != "")
                done[StrSplit(line, "`t")[1]] := true
    return done
}

; "Dr. Moravek: 22" lines, for the start box.
Summary(todo) {
    counts := Map()
    for c in todo
        counts[c.name] := (counts.Has(c.name) ? counts[c.name] : 0) + 1
    s := ""
    for name, n in counts
        s .= "     " name ": " n "`n"
    return s
}
