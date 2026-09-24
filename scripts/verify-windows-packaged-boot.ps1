param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [string]$ExpectedPublisherName = "",

  [switch]$AllowUnsigned,

  [string[]]$ExpectedPluginIds = @(),

  [int]$WindowTimeoutSeconds = 45,
  [int]$HealthyRuntimeSeconds = 20
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Use the same pinned NSIS toolset as the package build. Both release and
# nightly already invoke this verifier, so recovery cases are automated too.
$nsisToolFile = [IO.Path]::GetTempFileName()
$previousNsisDir = $env:NSISDIR
try {
  $resolveNsis = @'
const { createRequire } = require('node:module');
const fs = require('node:fs');
const desktopRequire = createRequire(process.argv[1]);
const builderRequire = createRequire(desktopRequire.resolve('electron-builder/package.json'));
builderRequire('app-builder-lib/out/toolsets/windows').getMakeNsisPath()
  .then(tool => fs.writeFileSync(process.argv[2], JSON.stringify(tool)))
  .catch(error => { console.error(error); process.exitCode = 1; });
'@
  & node -e $resolveNsis (Join-Path $PSScriptRoot "..\apps\desktop\package.json") $nsisToolFile
  if ($LASTEXITCODE -ne 0) { throw "Could not resolve the packaging NSIS compiler." }
  $nsisTool = Get-Content -LiteralPath $nsisToolFile -Raw | ConvertFrom-Json
  if ($nsisTool.PSObject.Properties.Name -contains "env") {
    $env:NSISDIR = $nsisTool.env.NSISDIR
  }
  & (Join-Path $PSScriptRoot "verify-windows-upgrade-directory-swap.ps1") -MakensisPath $nsisTool.path
} finally {
  $env:NSISDIR = $previousNsisDir
  Remove-Item -LiteralPath $nsisToolFile -Force
}

if ($AllowUnsigned -and -not [string]::IsNullOrWhiteSpace($ExpectedPublisherName)) {
  throw "Choose exactly one Windows trust mode: ExpectedPublisherName or AllowUnsigned."
}
if (-not $AllowUnsigned -and [string]::IsNullOrWhiteSpace($ExpectedPublisherName)) {
  throw "ExpectedPublisherName is required unless AllowUnsigned is explicitly selected."
}

function Assert-TritonAIArtifactTrust {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ExecutablePath
  )

  $signature = Get-AuthenticodeSignature -LiteralPath $ExecutablePath
  if ($AllowUnsigned) {
    if ($signature.Status -ne "NotSigned") {
      throw "Unsigned release mode expected an unsigned executable, but signature status is $($signature.Status): $ExecutablePath"
    }
    return
  }

  if ($signature.Status -ne "Valid") {
    throw "Executable signature is $($signature.Status), not Valid: $ExecutablePath"
  }
  if ($signature.SignerCertificate.Subject -notlike "*$ExpectedPublisherName*") {
    throw "Executable publisher mismatch: $($signature.SignerCertificate.Subject)"
  }
  if ($null -eq $signature.TimeStamperCertificate) {
    throw "Executable is missing a trusted Authenticode timestamp: $ExecutablePath"
  }
}

function Invoke-TritonAIProcessTreeTermination {
  param(
    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process
  )

  $Process.Refresh()
  if ($Process.HasExited) {
    return
  }

  $taskkillPath = Join-Path $env:SystemRoot "System32\taskkill.exe"
  & $taskkillPath /PID $Process.Id /T /F | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Could not terminate packaged-boot process tree $($Process.Id); taskkill exited with $LASTEXITCODE."
  }
  if (-not $Process.WaitForExit(10000)) {
    throw "Could not confirm packaged-boot process tree $($Process.Id) exited."
  }
}

$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
Assert-TritonAIArtifactTrust -ExecutablePath $resolvedInstaller
$installer = Start-Process -FilePath $resolvedInstaller -ArgumentList "/S" -Wait -PassThru
if ($null -eq $installer -or $installer.ExitCode -ne 0) {
  $exitCode = if ($null -eq $installer) { "unknown" } else { $installer.ExitCode }
  throw "Packaged Harness installer failed with exit code $exitCode."
}

$programsRoot = Join-Path $env:LOCALAPPDATA "Programs"
$appCandidates = @(
  Get-ChildItem -LiteralPath $programsRoot -Filter "TritonAI Harness*.exe" -File -Recurse |
    Where-Object { $_.Name -notlike "Uninstall*" } |
    Sort-Object LastWriteTimeUtc -Descending
)
if ($appCandidates.Count -ne 1) {
  throw "Expected exactly one installed TritonAI Harness executable under $programsRoot; found $($appCandidates.Count)."
}

$appPath = $appCandidates[0].FullName
$completionMarker = Join-Path $appCandidates[0].DirectoryName ".tritonai-install-complete"
if (-not (Test-Path -LiteralPath $completionMarker -PathType Leaf)) {
  throw "Installed Harness is missing its completion marker: $completionMarker"
}

Assert-TritonAIArtifactTrust -ExecutablePath $appPath

# A fresh install never executes the old uninstaller. Exercise that path before
# booting, including the updater's inherited application working directory.
# Previously the parent setup retained that directory handle and prevented the
# child uninstaller from renaming the installation to its rollback directory.
$upgrade = Start-Process -FilePath $resolvedInstaller `
  -ArgumentList "/S", "--updated" `
  -WorkingDirectory $appCandidates[0].DirectoryName -PassThru
if (-not $upgrade.WaitForExit(180000)) {
  Invoke-TritonAIProcessTreeTermination -Process $upgrade
  throw "Packaged Harness upgrade did not finish within 180 seconds."
}
if ($upgrade.ExitCode -ne 0) {
  throw "Packaged Harness upgrade failed with exit code $($upgrade.ExitCode)."
}
if (-not (Test-Path -LiteralPath $appPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $completionMarker -PathType Leaf)) {
  throw "Packaged Harness upgrade did not leave a complete installation."
}
Assert-TritonAIArtifactTrust -ExecutablePath $appPath

$runtimeHome = Join-Path $env:RUNNER_TEMP "tritonai-packaged-boot-$PID"
New-Item -ItemType Directory -Path $runtimeHome -Force | Out-Null
$previousRuntimeHome = $env:TRITONAI_HOME
$previousPluginBootReport = $env:TRITONAI_PLUGIN_BOOT_REPORT_PATH
$env:TRITONAI_HOME = $runtimeHome
$pluginBootReport = Join-Path $runtimeHome "plugins-$([guid]::NewGuid().ToString('N')).json"
$env:TRITONAI_PLUGIN_BOOT_REPORT_PATH = $pluginBootReport
$app = $null
$appStdout = Join-Path $runtimeHome "app-stdout.log"
$appStderr = Join-Path $runtimeHome "app-stderr.log"

# The runtime home is deleted in finally, so print what the app left behind
# when it exits early; otherwise the failure is only an exit code.
function Write-TritonAIBootDiagnostics {
  $files = @($appStdout, $appStderr) + @(
    Get-ChildItem -LiteralPath $runtimeHome -Recurse -File -Filter *.log -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -ne $appStdout -and $_.FullName -ne $appStderr } |
      ForEach-Object { $_.FullName }
  )
  foreach ($file in $files) {
    if (Test-Path -LiteralPath $file -PathType Leaf) {
      Write-Host "::group::$file"
      Get-Content -LiteralPath $file -Tail 200 | Write-Host
      Write-Host "::endgroup::"
    }
  }
}

try {
  $app = Start-Process -FilePath $appPath -PassThru `
    -RedirectStandardOutput $appStdout -RedirectStandardError $appStderr
  $deadline = (Get-Date).AddSeconds($WindowTimeoutSeconds)
  $windowVisible = $false

  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $app.Refresh()
    if ($app.HasExited) {
      Write-TritonAIBootDiagnostics
      throw "Installed Harness exited before opening a window (exit code $($app.ExitCode))."
    }
    if ($app.MainWindowHandle -ne 0) {
      $windowVisible = $true
      break
    }
  }

  if (-not $windowVisible) {
    throw "Installed Harness did not open a visible window within $WindowTimeoutSeconds seconds."
  }

  Start-Sleep -Seconds $HealthyRuntimeSeconds
  $app.Refresh()
  if ($app.HasExited) {
    Write-TritonAIBootDiagnostics
    throw "Installed Harness exited during the $HealthyRuntimeSeconds-second packaged runtime probe (exit code $($app.ExitCode))."
  }

  $logRoots = @(
    foreach ($relativePath in @("userdata\logs", "nightly\userdata\logs")) {
      $candidate = Join-Path $runtimeHome $relativePath
      if (Test-Path -LiteralPath $candidate -PathType Container) { $candidate }
    }
  )
  if ($logRoots.Count -ne 1) {
    throw "Installed Harness did not create exactly one runtime log directory under $runtimeHome."
  }
  $logRoot = $logRoots[0]

  $fatalPattern = "Cannot find module|MODULE_NOT_FOUND|The local Harness service failed [0-9]+ times|ffi-rs.*(missing|failed|error)|Managed plugin composition verification failed"
  $fatalMatches = @(
    Get-ChildItem -LiteralPath $logRoot -File -Recurse -ErrorAction SilentlyContinue |
      Select-String -Pattern $fatalPattern -ErrorAction SilentlyContinue
  )
  if ($fatalMatches.Count -gt 0) {
    $details = ($fatalMatches | Select-Object -First 10 | ForEach-Object { $_.Line.Trim() }) -join "`n"
    throw "Installed Harness logged a fatal packaged-runtime failure:`n$details"
  }

  if ($ExpectedPluginIds.Count -gt 0) {
    $expected = ($ExpectedPluginIds | Sort-Object -Unique) -join ","
    if (-not (Test-Path -LiteralPath $pluginBootReport -PathType Leaf)) {
      throw "Installed Harness did not report its loaded managed plugins."
    }
    $report = Get-Content -LiteralPath $pluginBootReport -Raw | ConvertFrom-Json
    $loaded = ($report.pluginIds | Sort-Object -Unique) -join ","
    if ($report.version -ne 1 -or $loaded -ne $expected) {
      throw "Installed Harness did not load the expected managed plugins: $expected"
    }
    Get-Process -Id $report.pid -ErrorAction Stop | Out-Null
  }

  Write-Host "Installed, upgraded, signature-verified, opened, and sustained TritonAI Harness from $appPath."
} finally {
  if ($null -ne $app) {
    Invoke-TritonAIProcessTreeTermination -Process $app
  }
  $env:TRITONAI_HOME = $previousRuntimeHome
  $env:TRITONAI_PLUGIN_BOOT_REPORT_PATH = $previousPluginBootReport
  Remove-Item -LiteralPath $runtimeHome -Recurse -Force -ErrorAction SilentlyContinue
}
