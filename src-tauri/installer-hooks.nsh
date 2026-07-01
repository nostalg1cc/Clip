; ── Clip — NSIS installer hooks ─────────────────────────────────────────────────
; On uninstall, if the app had Win+V override active, restore the original
; DisabledHotkeys registry value so Windows clipboard history works again.
;
; The Win+V override itself is toggled at runtime via the system tray menu.
; The installer only needs to clean up on uninstall.

!macro NSIS_HOOK_POSTINSTALL
    ; Nothing special needed — the tray menu handles enabling Win+V override.
    DetailPrint "Clip installed. Use the system tray menu to enable Win+V override."
!macroend

!macro NSIS_HOOK_PREUNINSTALL
    ; Restore the original DisabledHotkeys if our app had overridden it.
    ; The app stores its backup in HKCU\Software\Clip.
    ClearErrors
    ReadRegStr $0 HKCU "Software\Clip" "WinVOverride"
    StrCmp $0 "1" 0 skip_restore

    ; Read the backed-up value
    ReadRegStr $1 HKCU "Software\Clip" "DisabledHotkeysBackup"
    StrCmp $1 "__NONE__" delete_key 0
    StrCmp $1 "" delete_key 0

    ; Restore the original value
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" "DisabledHotkeys" "$1"
    Goto cleanup

    delete_key:
        DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" "DisabledHotkeys"

    cleanup:
        ; Clean up our own registry keys
        DeleteRegValue HKCU "Software\Clip" "WinVOverride"
        DeleteRegValue HKCU "Software\Clip" "DisabledHotkeysBackup"
        DeleteRegKey /ifempty HKCU "Software\Clip"

    skip_restore:
!macroend
