; VPFM installer hooks (included by the Tauri NSIS template).
;
; The FlowMap zh updater runs the newest setup.exe with "/P /UPDATE /R". When that setup is VPFM
; (upgrade path from FlowMap zh), VPFM is not installed yet, but the Tauri template skips the
; Start Menu and desktop shortcuts in update mode, so the user would have no way to open VPFM again.
; Remember whether this is a fresh install and, if so, create the shortcuts even in update mode.
; Keep this file ASCII-only.

Var VpfmFreshInstall

!macro NSIS_HOOK_PREINSTALL
  StrCpy $VpfmFreshInstall 1
  ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $VpfmFreshInstall 0
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $UpdateMode = 1
  ${AndIf} $VpfmFreshInstall = 1
  ${AndIf} $NoShortcutMode <> 1
    ${IfNot} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}
    ${IfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
      CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}
!macroend
