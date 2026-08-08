param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [string]$ExpectedPublisherName = "",

  [switch]$AllowUnsigned,

  [int]$WindowTimeoutSeconds = 45,
  [int]$HealthyRuntimeSeconds = 20
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

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

$runtimeHome = Join-Path $env:RUNNER_TEMP "tritonai-packaged-boot-$PID"
New-Item -ItemType Directory -Path $runtimeHome -Force | Out-Null
$previousRuntimeHome = $env:TRITONAI_HOME
$env:TRITONAI_HOME = $runtimeHome
$app = $null

try {
  $app = Start-Process -FilePath $appPath -PassThru
  $deadline = (Get-Date).AddSeconds($WindowTimeoutSeconds)
  $windowVisible = $false

  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $app.Refresh()
    if ($app.HasExited) {
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
    throw "Installed Harness exited during the $HealthyRuntimeSeconds-second packaged runtime probe (exit code $($app.ExitCode))."
  }

  $logRoot = Join-Path $runtimeHome "userdata\logs"
  if (-not (Test-Path -LiteralPath $logRoot -PathType Container)) {
    throw "Installed Harness did not create its runtime log directory: $logRoot"
  }

  $fatalPattern = "Cannot find module|MODULE_NOT_FOUND|The local Harness service failed [0-9]+ times|ffi-rs.*(missing|failed|error)"
  $fatalMatches = @(
    Get-ChildItem -LiteralPath $logRoot -File -Recurse -ErrorAction SilentlyContinue |
      Select-String -Pattern $fatalPattern -ErrorAction SilentlyContinue
  )
  if ($fatalMatches.Count -gt 0) {
    $details = ($fatalMatches | Select-Object -First 10 | ForEach-Object { $_.Line.Trim() }) -join "`n"
    throw "Installed Harness logged a fatal packaged-runtime failure:`n$details"
  }

  Write-Host "Installed, signature-verified, opened, and sustained TritonAI Harness from $appPath."
} finally {
  if ($null -ne $app) {
    Invoke-TritonAIProcessTreeTermination -Process $app
  }
  $env:TRITONAI_HOME = $previousRuntimeHome
  Remove-Item -LiteralPath $runtimeHome -Recurse -Force -ErrorAction SilentlyContinue
}
