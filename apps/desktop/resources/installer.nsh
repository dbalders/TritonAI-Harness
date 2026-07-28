# electron-builder includes this file before common.nsh, where it later defines
# APP_EXECUTABLE_FILENAME as "${PRODUCT_FILENAME}.exe". Mirror that definition
# here so macros and early-parsed callbacks use one executable name.
!define TRITONAI_APP_EXECUTABLE_FILENAME "${PRODUCT_FILENAME}.exe"
!define TRITONAI_INSTALL_COMPLETE_MARKER ".tritonai-install-complete"

!macro customCheckAppRunning
  retryCloseInstalledApp:
    DetailPrint "Checking for running ${PRODUCT_NAME} app..."
    System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("TRITONAI_NSIS_TARGET_EXECUTABLE", "$INSTDIR\${TRITONAI_APP_EXECUTABLE_FILENAME}").r1'
    ${if} $1 == 0
      StrCpy $0 1
    ${else}
      nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$target = [Environment]::GetEnvironmentVariable('TRITONAI_NSIS_TARGET_EXECUTABLE', 'Process'); if ([string]::IsNullOrEmpty($$target)) { exit 2 }; try { $$matches = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object { $$_.ExecutablePath -and [string]::Equals($$_.ExecutablePath, $$target, [System.StringComparison]::OrdinalIgnoreCase) }) } catch { exit 2 }; if ($$matches.Count -gt 0) { exit 0 } else { exit 1 }"`
      Pop $0
      ${if} $0 == 1
        StrCpy $0 0
        Goto processCheckComplete
      ${endif}
    ${endif}

    ${if} $0 == 0
      ${if} ${isUpdated}
        Sleep 1300
        Goto stopInstalledApp
      ${endif}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK stopInstalledApp
      Quit

      stopInstalledApp:
      DetailPrint "$(appClosing)"
      nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$target = [Environment]::GetEnvironmentVariable('TRITONAI_NSIS_TARGET_EXECUTABLE', 'Process'); if ([string]::IsNullOrEmpty($$target)) { exit 1 }; $$procs = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object { $$_.ExecutablePath -and [string]::Equals($$_.ExecutablePath, $$target, [System.StringComparison]::OrdinalIgnoreCase) }); foreach ($$proc in $$procs) { try { Stop-Process -Id $$proc.ProcessId -ErrorAction Stop } catch {} }; Start-Sleep -Milliseconds 1000; $$remaining = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object { $$_.ExecutablePath -and [string]::Equals($$_.ExecutablePath, $$target, [System.StringComparison]::OrdinalIgnoreCase) }); foreach ($$proc in $$remaining) { try { Stop-Process -Id $$proc.ProcessId -Force -ErrorAction Stop } catch {} }; Start-Sleep -Milliseconds 500; $$remaining = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object { $$_.ExecutablePath -and [string]::Equals($$_.ExecutablePath, $$target, [System.StringComparison]::OrdinalIgnoreCase) }); if ($$remaining.Count -gt 0) { exit 1 } else { exit 0 }"`
      Pop $0
    ${endif}

    processCheckComplete:
    System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("TRITONAI_NSIS_TARGET_EXECUTABLE", "").r1'
    ${if} $0 != 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "The installed ${PRODUCT_NAME} app is still running and could not be closed automatically. Close it from Task Manager and click Retry to continue." /SD IDCANCEL IDRETRY retryCloseInstalledApp
      Quit
    ${endif}
!macroend

# electron-builder's default update path moves every installed file into a
# temporary backup before extracting the new app. The unpacked WSL backend has
# tens of thousands of files, so a transient scanner lock can make that backup
# both slow and fragile. Keep the rollback directory beside $INSTDIR instead:
# renaming the directory is an atomic, same-volume metadata operation.
!macro customRemoveFiles
  SetOutPath "$TEMP"

  ${if} ${isUpdated}
    ${if} ${FileExists} "$INSTDIR.old\*.*"
      DetailPrint "Removing stale ${PRODUCT_NAME} upgrade backup..."
      RMDir /r /REBOOTOK "$INSTDIR.old"
    ${endif}

    ${if} ${FileExists} "$INSTDIR.old\*.*"
      Abort "Cannot remove the stale upgrade backup at $INSTDIR.old. Restart Windows and run the installer again."
    ${endif}

    ClearErrors
    Rename "$INSTDIR" "$INSTDIR.old"
    ${if} ${Errors}
      Abort "Cannot move the existing ${PRODUCT_NAME} installation to $INSTDIR.old. Close programs that may be scanning the folder and try again."
    ${endif}

    ${ifNot} ${FileExists} "$INSTDIR.old\${TRITONAI_APP_EXECUTABLE_FILENAME}"
      Abort "The ${PRODUCT_NAME} upgrade backup was not created correctly at $INSTDIR.old."
    ${endif}
  ${else}
    RMDir /r /REBOOTOK "$INSTDIR.old"
    RMDir /r "$INSTDIR"
  ${endif}
!macroend

# Recover a backup left by an interrupted installer before starting another
# install. Only the marker written at the end of customInstall proves the new
# app is complete; executable extraction can finish before the rest of the app.
!macro customInit
  ${if} ${FileExists} "$INSTDIR.old\${TRITONAI_APP_EXECUTABLE_FILENAME}"
    SetOutPath "$TEMP"
    ${if} ${FileExists} "$INSTDIR\${TRITONAI_INSTALL_COMPLETE_MARKER}"
      DetailPrint "Removing a completed ${PRODUCT_NAME} upgrade backup..."
      RMDir /r /REBOOTOK "$INSTDIR.old"
      ClearErrors
      ${if} ${FileExists} "$INSTDIR.old\*.*"
        Abort "Cannot remove the previous ${PRODUCT_NAME} upgrade backup at $INSTDIR.old. Restart Windows and run the installer again."
      ${endif}
    ${else}
      DetailPrint "Restoring ${PRODUCT_NAME} after an interrupted upgrade..."
      RMDir /r "$INSTDIR"
      ClearErrors
      Rename "$INSTDIR.old" "$INSTDIR"
      ${if} ${Errors}
        Abort "Cannot restore the previous ${PRODUCT_NAME} installation from $INSTDIR.old."
      ${endif}
    ${endif}
  ${endif}

  # electron-builder normally runs the uninstaller from the version that is
  # already installed. Replace it with this installer's signed uninstaller so
  # the first upgrade from a legacy release also uses the directory-swap path.
  ${if} ${FileExists} "$INSTDIR\${UNINSTALL_FILENAME}"
    InitPluginsDir
    File /oname=$PLUGINSDIR\tritonai-upgrade-uninstaller.exe "${UNINSTALLER_OUT_FILE}"
    ClearErrors
    CopyFiles /SILENT "$PLUGINSDIR\tritonai-upgrade-uninstaller.exe" "$INSTDIR\${UNINSTALL_FILENAME}"
    ${if} ${Errors}
      Abort "Cannot prepare the existing ${PRODUCT_NAME} installation for upgrade."
    ${endif}
  ${endif}
!macroend

# At this point the new application and uninstaller have both been written.
# Backup cleanup is best-effort: a scanner may briefly retain a handle, but the
# completed new installation must remain usable and the next run will retry.
!macro customInstall
  ClearErrors
  FileOpen $0 "$INSTDIR\${TRITONAI_INSTALL_COMPLETE_MARKER}" w
  ${if} ${Errors}
    Abort "Cannot mark the new ${PRODUCT_NAME} installation as complete."
  ${endif}
  FileWrite $0 "${VERSION}"
  ${if} ${Errors}
    FileClose $0
    Delete "$INSTDIR\${TRITONAI_INSTALL_COMPLETE_MARKER}"
    Abort "Cannot mark the new ${PRODUCT_NAME} installation as complete."
  ${endif}
  FileClose $0

  ${if} ${FileExists} "$INSTDIR.old\*.*"
    DetailPrint "Cleaning up the previous ${PRODUCT_NAME} installation..."
    RMDir /r /REBOOTOK "$INSTDIR.old"
    ClearErrors
    ${if} ${FileExists} "$INSTDIR.old\*.*"
      DetailPrint "Upgrade backup cleanup was deferred: $INSTDIR.old"
    ${endif}
  ${endif}
!macroend

!ifndef BUILD_UNINSTALLER
Function .onInstFailed
  SetOutPath "$TEMP"
  # This callback is parsed before electron-builder includes LogicLib.nsh, so
  # use native branching. A completion marker in the current directory proves
  # this attempt failed before swapping directories and must not roll it back.
  IfFileExists "$INSTDIR\${TRITONAI_INSTALL_COMPLETE_MARKER}" restoreComplete 0
  IfFileExists "$INSTDIR.old\${TRITONAI_APP_EXECUTABLE_FILENAME}" 0 restoreComplete
  DetailPrint "The ${PRODUCT_NAME} install failed; restoring the previous installation..."
  RMDir /r "$INSTDIR"
  ClearErrors
  Rename "$INSTDIR.old" "$INSTDIR"
  IfErrors 0 restoreSucceeded
  DetailPrint "Could not restore the previous installation automatically. Its backup remains at $INSTDIR.old."
  Goto restoreComplete

  restoreSucceeded:
  DetailPrint "The previous ${PRODUCT_NAME} installation was restored."

  restoreComplete:
FunctionEnd
!endif
