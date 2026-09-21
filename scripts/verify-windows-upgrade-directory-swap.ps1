param(
  [Parameter(Mandatory = $true)]
  [string]$MakensisPath,

  [string]$InstallerInclude = (Join-Path $PSScriptRoot "..\apps\desktop\resources\installer.nsh")
)

# Native regression for a parent installer pinning its child's rename source.
# Uses the production macros with disposable payloads; never uses a live install.
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$compiler = (Resolve-Path -LiteralPath $MakensisPath).Path
$include = (Resolve-Path -LiteralPath $InstallerInclude).Path
$fixture = Join-Path $PSScriptRoot "fixtures\windows-upgrade-directory-swap.nsi"
$root = Join-Path ([IO.Path]::GetTempPath()) "tritonai-upgrade-regression-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $root | Out-Null
$uninstaller = Join-Path $root "fixture-uninstaller.exe"
$passed = $false

function Invoke-FixtureProcess([string]$Executable) {
  $process = Start-Process -FilePath $Executable -ArgumentList "/S" -PassThru
  if (-not $process.WaitForExit(30000)) {
    $process.Kill()
    throw "Fixture timed out: $Executable"
  }
  if ($process.ExitCode -ne 0) {
    throw "Fixture exited with code $($process.ExitCode): $Executable"
  }
}

function Build-Fixture([string]$Output, [string]$InstallDirectory, [switch]$UninstallerWriter) {
  $arguments = @(
    "/V2",
    "/DOUTPUT_EXE=$Output",
    "/DTEST_ROOT=$InstallDirectory",
    "/DUNINSTALLER_OUT_FILE=$uninstaller",
    "/DUPGRADE_INCLUDE=$include"
  )
  if ($UninstallerWriter) { $arguments += "/DBUILD_UNINSTALLER" }
  & $compiler @arguments $fixture
  if ($LASTEXITCODE -ne 0) { throw "NSIS fixture compilation failed: $LASTEXITCODE" }
}

try {
  $writer = Join-Path $root "write-uninstaller.exe"
  Build-Fixture -Output $writer -InstallDirectory (Join-Path $root "unused") -UninstallerWriter
  Invoke-FixtureProcess $writer

  foreach ($case in @("legacy", "completed", "interrupted")) {
    $installDirectory = Join-Path $root "$case\app"
    New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $installDirectory "TritonAI Upgrade Fixture.exe"), "old")
    Copy-Item -LiteralPath $uninstaller -Destination (Join-Path $installDirectory "Uninstall.exe")
    if ($case -eq "completed") {
      [IO.File]::WriteAllText((Join-Path $installDirectory ".tritonai-install-complete"), "1.0.0")
    }
    if ($case -eq "interrupted") {
      Move-Item -LiteralPath $installDirectory -Destination "$installDirectory.old"
      New-Item -ItemType Directory -Path $installDirectory | Out-Null
      [IO.File]::WriteAllText((Join-Path $installDirectory "partial.txt"), "partial")
    }
    $setup = Join-Path $root "$case.exe"
    Build-Fixture -Output $setup -InstallDirectory $installDirectory
    Invoke-FixtureProcess $setup
    $payload = [IO.File]::ReadAllText((Join-Path $installDirectory "TritonAI Upgrade Fixture.exe"))
    $marker = [IO.File]::ReadAllText((Join-Path $installDirectory ".tritonai-install-complete"))
    if ($payload -ne "new" -or $marker -ne "1.0.1" -or
        (Test-Path -LiteralPath "$installDirectory.old") -or
        (Test-Path -LiteralPath (Join-Path $installDirectory "partial.txt"))) {
      throw "Upgrade left invalid payload, completion marker, or rollback state for $case."
    }
    Write-Host "PASS: $case upgrade releases the parent directory handle and completes replacement."
  }
  $passed = $true
} finally {
  if ($passed) {
    Remove-Item -LiteralPath $root -Recurse -Force
  } else {
    Write-Warning "Failed fixture preserved at $root"
  }
}
