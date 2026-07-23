!macro customCheckAppRunning
  retryCloseInstalledApp:
    DetailPrint "Checking for running ${PRODUCT_NAME} app..."
    System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("TRITONAI_NSIS_TARGET_EXECUTABLE", "$INSTDIR\${APP_EXECUTABLE_FILENAME}").r1'
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

    ${ifNot} ${FileExists} "$INSTDIR.old\${APP_EXECUTABLE_FILENAME}"
      Abort "The ${PRODUCT_NAME} upgrade backup was not created correctly at $INSTDIR.old."
    ${endif}
  ${else}
    RMDir /r "$INSTDIR"
  ${endif}
!macroend

# Recover a backup left by an interrupted installer before starting another
# install. If the new app is already complete, keep it and retry old-backup
# cleanup; otherwise restore the last complete installation.
!macro customInit
  ${if} ${FileExists} "$INSTDIR.old\${APP_EXECUTABLE_FILENAME}"
    SetOutPath "$TEMP"
    ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      DetailPrint "Removing a completed ${PRODUCT_NAME} upgrade backup..."
      RMDir /r /REBOOTOK "$INSTDIR.old"
      ClearErrors
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
!macroend

# At this point the new application and uninstaller have both been written.
# Backup cleanup is best-effort: a scanner may briefly retain a handle, but the
# completed new installation must remain usable and the next run will retry.
!macro customInstall
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
  ${if} ${FileExists} "$INSTDIR.old\${APP_EXECUTABLE_FILENAME}"
    DetailPrint "The ${PRODUCT_NAME} install failed; restoring the previous installation..."
    RMDir /r "$INSTDIR"
    ClearErrors
    Rename "$INSTDIR.old" "$INSTDIR"
    ${if} ${Errors}
      DetailPrint "Could not restore the previous installation automatically. Its backup remains at $INSTDIR.old."
    ${else}
      DetailPrint "The previous ${PRODUCT_NAME} installation was restored."
    ${endif}
  ${endif}
FunctionEnd
!endif
