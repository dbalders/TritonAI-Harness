$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
New-Item -ItemType Directory qa-evidence -Force | Out-Null
$old=(Resolve-Path 'old/TritonAI-Harness-0.3.6-x64.exe').Path
$new=(Resolve-Path 'candidate/TritonAI-Harness-0.3.7-x64.exe').Path
$hash=(Get-FileHash $new -Algorithm SHA256).Hash.ToLower()
if($hash -ne 'c1ccc37c4e4700b9e380071994a979ce4508dc74306e8b1755d2edfc252cbf6b'){throw 'Draft artifact hash mismatch'}
function Assert-Trust([string]$file){
  $sig=Get-AuthenticodeSignature $file
  if($sig.Status -ne 'Valid' -or !$sig.TimeStamperCertificate){throw 'Invalid signed artifact'}
  if($sig.SignerCertificate.Subject -notlike '*The Regents of the University of California*'){throw 'Wrong publisher'}
}
function Stop-Owned($process){
  $process.Refresh()
  if(!$process.HasExited){& "$env:SystemRoot/System32/taskkill.exe" /PID $process.Id /T /F | Out-Null; $null=$process.WaitForExit(10000)}
}
function Install([string]$file,[string]$cwd){
  $p=Start-Process $file -ArgumentList '/S','--updated' -WorkingDirectory $cwd -PassThru
  if(!$p.WaitForExit(240000)){Stop-Owned $p;throw 'Installer timed out'}
  if($p.ExitCode -ne 0){throw "Installer exited $($p.ExitCode)"}
}
Assert-Trust $old
Assert-Trust $new
Install $old $env:RUNNER_TEMP
$app=Join-Path $env:LOCALAPPDATA 'Programs/tritonai-harness/TritonAI Harness.exe'
if((Get-Item $app).VersionInfo.ProductVersion -ne '0.3.6.0'){throw 'Old version not installed'}
$env:TRITONAI_HOME=Join-Path $env:RUNNER_TEMP 'qa037-existing-profile'
New-Item -ItemType Directory $env:TRITONAI_HOME -Force | Out-Null
function Boot([string]$label,[string[]]$expected){
  $env:TRITONAI_PLUGIN_BOOT_REPORT_PATH=Join-Path $env:TRITONAI_HOME "$label-plugins.json"
  $p=Start-Process $app -WorkingDirectory (Split-Path $app) -PassThru
  try {
    $deadline=(Get-Date).AddSeconds(120)
    do {
      Start-Sleep -Seconds 1
      $p.Refresh()
      if($p.HasExited){throw 'App exited before readiness'}
      $ready=($p.MainWindowHandle -ne 0 -and (Test-Path $env:TRITONAI_PLUGIN_BOOT_REPORT_PATH))
    }while(!$ready -and (Get-Date) -lt $deadline)
    if(!$ready){throw 'Visible window and plugin receipt did not become ready'}
    $receipt=Get-Content $env:TRITONAI_PLUGIN_BOOT_REPORT_PATH -Raw | ConvertFrom-Json
    if((($receipt.pluginIds|Sort-Object)-join ',') -ne (($expected|Sort-Object)-join ',')){throw 'Wrong runtime plugin set'}
    Start-Sleep -Seconds 20
    $p.Refresh();if($p.HasExited){throw 'App did not sustain runtime'}
    Get-Process -Id $receipt.pid -ErrorAction Stop | Out-Null
    $receipt|ConvertTo-Json -Depth 5|Set-Content "qa-evidence/$label-plugins.json"
    Write-Host "$label opened a visible window, loaded the expected plugins, and sustained runtime."
  }finally{Stop-Owned $p}
}
$six=@('github','google-workspace','kuali-build','lucid','microsoft-365','n8n')
Boot 'stable036' ($six+@('tableau'))
$db=Join-Path $env:TRITONAI_HOME 'userdata/state.sqlite'
if(!(Test-Path $db)){throw 'Old profile database missing'}
$skills=Join-Path $env:TRITONAI_HOME 'codex/skills'
$retired=Join-Path $skills 'qa037-retired-tableau'
$personal=Join-Path $skills 'qa037-personal'
New-Item -ItemType Directory $retired,$personal -Force|Out-Null
'{"version":1,"integrationId":"tableau","skill":"qa037-retired-tableau"}'|Set-Content (Join-Path $retired '.tritonai-integration-skill.json')
"---`nname: qa037-retired-tableau`ndescription: QA owned fixture`n---`nQA fixture"|Set-Content (Join-Path $retired 'SKILL.md')
"---`nname: qa037-personal`ndescription: QA personal fixture`n---`nQA fixture"|Set-Content (Join-Path $personal 'SKILL.md')
Install $new (Split-Path $app)
if((Get-Item $app).VersionInfo.ProductVersion -ne '0.3.7.0'){throw 'Upgrade version mismatch'}
Assert-Trust $app
if((Get-Content (Join-Path (Split-Path $app) '.tritonai-install-complete') -Raw).Trim() -ne '0.3.7'){throw 'Completion marker mismatch'}
Boot 'upgraded037' $six
if(Test-Path $retired){throw 'Owned Tableau skill was not removed'}
if(!(Test-Path (Join-Path $personal 'SKILL.md'))){throw 'Personal skill was removed'}
if(!(Test-Path $db)){throw 'Existing profile database removed'}
@{from='0.3.6';to='0.3.7';sha256=$hash;visibleWindow=$true;sustainedRuntime=$true;tableauAbsent=$true;ownedSkillRemoved=$true;personalSkillPreserved=$true;profileDatabasePreserved=$true}|ConvertTo-Json|Set-Content qa-evidence/result.json
