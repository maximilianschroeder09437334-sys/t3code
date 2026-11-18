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

!macro t3AppendSetupDiagnostic LINE
  ReadEnvStr $0 "T3CODE_SETUP_DIAGNOSTICS"
  ${If} $0 != ""
    ClearErrors
    FileOpen $1 "$0" a
    ${IfNot} ${Errors}
      FileSeek $1 0 END
      FileWrite $1 "${LINE}$\r$\n"
      FileClose $1
    ${EndIf}
  ${EndIf}
!macroend

# Report a failed old-uninstaller check even when setup is running silently.
# The old uninstaller aborts and restores every file when any install file
# cannot be moved. Silent updates then overwrite the install in place, which
# electron-builder already does when the old uninstaller cannot be launched.
# Interactive setup keeps the visible failure and stops.
!macro t3ReportOldUninstall
  Push $0
  Push $1
  Push $2
  ${If} ${Errors}
    StrCpy $2 "launch_error"
  ${Else}
    StrCpy $2 "$R0"
  ${EndIf}
  !insertmacro t3AppendSetupDiagnostic "old_uninstaller_check=$2"
  ${If} $2 != "0"
    ReadEnvStr $0 "T3CODE_SETUP_DIAGNOSTICS"
    ${If} $0 != ""
      # Record install-folder processes and files another process holds open.
      System::Call 'kernel32::SetEnvironmentVariable(t "T3CODE_INSTALL_DIR", t "$INSTDIR")'
      nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "$$d=$$env:T3CODE_INSTALL_DIR; $$o=$$env:T3CODE_SETUP_DIAGNOSTICS; Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$d, 'OrdinalIgnoreCase') } | ForEach-Object { Add-Content -LiteralPath $$o -Value ('install_process=' + $$_.ProcessId + ' ' + $$_.ExecutablePath) }; Get-ChildItem -LiteralPath $$d -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object { $$f=$$_.FullName; try { [IO.File]::Open($$f, 'Open', 'Read', 'None').Dispose() } catch { Add-Content -LiteralPath $$o -Value ('install_file_busy=' + $$f) } }"`
      Pop $1
      System::Call 'kernel32::SetEnvironmentVariable(t "T3CODE_INSTALL_DIR", p 0)'
    ${EndIf}
    ${If} ${Silent}
      !insertmacro t3AppendSetupDiagnostic "old_uninstaller_fallback=overwrite"
    ${Else}
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $2"
      SetErrorLevel 2
      Quit
    ${EndIf}
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
