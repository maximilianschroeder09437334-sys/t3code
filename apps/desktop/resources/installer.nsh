!include "StrFunc.nsh"
!ifdef BUILD_UNINSTALLER
  ${UnStrRep}
  !define T3StrRep '${UnStrRep}'
!else
  ${StrRep}
  !define T3StrRep '${StrRep}'
!endif

!macro customAppRunningMessages
  Push $0
  Push $1
  ${If} $IsPowerShellAvailable == 0
    System::Call 'kernel32::SetEnvironmentVariable(t "T3CODE_INSTALL_DIR", t "$INSTDIR")'
    nsExec::ExecToStack `"$PowerShellPath" -NoProfile -NonInteractive -C "Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and [IO.Path]::GetDirectoryName($$_.ExecutablePath) -eq $$env:T3CODE_INSTALL_DIR } | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($$_.ExecutablePath) } | Where-Object { $$_ -in 'T3 Code (Alpha)', 'T3 Code (Beta)', 'T3 Code (Nightly)' } | Select-Object -First 1 | ForEach-Object { [Console]::Write($$_) }"`
    Pop $0
    Pop $1
    System::Call 'kernel32::SetEnvironmentVariable(t "T3CODE_INSTALL_DIR", p 0)'
    ${If} $0 == 0
      ${If} $1 == "T3 Code (Alpha)"
      ${OrIf} $1 == "T3 Code (Beta)"
      ${OrIf} $1 == "T3 Code (Nightly)"
        ${T3StrRep} $appRunningMessage $appRunningMessage "${PRODUCT_NAME}" $1
        ${T3StrRep} $appClosingMessage $appClosingMessage "${PRODUCT_NAME}" $1
        ${T3StrRep} $appCannotBeClosedMessage $appCannotBeClosedMessage "${PRODUCT_NAME}" $1
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
!macroend

# Report a failed old-uninstaller check even when setup is running silently.
# Keep interactive diagnostics, and let /S return to the supervising process.
!macro t3ReportOldUninstall
  Push $0
  Push $1
  Push $2
  ${If} ${Errors}
    StrCpy $2 "launch_error"
  ${Else}
    StrCpy $2 "$R0"
  ${EndIf}
  ReadEnvStr $0 "T3CODE_SETUP_DIAGNOSTICS"
  ${If} $0 != ""
    ClearErrors
    FileOpen $1 "$0" a
    ${IfNot} ${Errors}
      FileWrite $1 "old_uninstaller_check=$2$\r$\n"
      FileClose $1
    ${EndIf}
  ${EndIf}
  ${If} $2 != "0"
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $2" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
  ClearErrors
!macroend

!macro customUnInstallCheck
  !insertmacro t3ReportOldUninstall
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro t3ReportOldUninstall
!macroend

!macro customInstall
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${IfNot} ${FileExists} "$newStartMenuLink"
      !insertmacro createMenuDirectory
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${EndIf}
  !endif
!macroend
