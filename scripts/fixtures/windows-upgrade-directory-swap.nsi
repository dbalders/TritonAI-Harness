Unicode true
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
Name "TritonAI upgrade regression fixture"
OutFile "${OUTPUT_EXE}"
InstallDir "${TEST_ROOT}"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!define PRODUCT_FILENAME "TritonAI Upgrade Fixture"
!define PRODUCT_NAME "TritonAI Upgrade Fixture"
!define UNINSTALL_FILENAME "Uninstall.exe"
!define VERSION "1.0.1"
!define isUpdated '"1" == "1"'
!include "${UPGRADE_INCLUDE}"
Function .onInit
!ifdef BUILD_UNINSTALLER
  WriteUninstaller "${UNINSTALLER_OUT_FILE}"
  SetErrorLevel 0
  Quit
!else
  # Reproduce electron-builder's parent setup current directory.
  SetOutPath "$INSTDIR"
  !insertmacro customInit
!endif
FunctionEnd
Section
!ifndef BUILD_UNINSTALLER
  InitPluginsDir
  CopyFiles /SILENT "$INSTDIR\${UNINSTALL_FILENAME}" "$PLUGINSDIR\child-uninstaller.exe"
  ExecWait '"$PLUGINSDIR\child-uninstaller.exe" /S --updated _?=$INSTDIR' $R0
  ${if} $R0 != 0
    SetErrorLevel $R0
    Quit
  ${endif}
  ${ifNot} ${FileExists} "$INSTDIR.old\${TRITONAI_APP_EXECUTABLE_FILENAME}"
    SetErrorLevel 10
    Quit
  ${endif}
  SetOutPath "$INSTDIR"
  FileOpen $0 "$INSTDIR\${TRITONAI_APP_EXECUTABLE_FILENAME}" w
  FileWrite $0 "new"
  FileClose $0
  File /oname=Uninstall.exe "${UNINSTALLER_OUT_FILE}"
  !insertmacro customInstall
!endif
SectionEnd
!ifdef BUILD_UNINSTALLER
Function un.onInit
  SetOutPath "$INSTDIR"
FunctionEnd
Section Uninstall
  !insertmacro customRemoveFiles
SectionEnd
!endif
