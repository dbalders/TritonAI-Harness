param(
  [Parameter(Mandatory = $true)]
  [string]$ExpectedPublisherName,

  [Parameter(Mandatory = $true)]
  [string]$EncodedPaths
)

$ErrorActionPreference = "Stop"
$DecodedPaths = [System.Text.Encoding]::UTF8.GetString(
  [System.Convert]::FromBase64String($EncodedPaths)
)
$Paths = @($DecodedPaths | ConvertFrom-Json)

if ($Paths.Count -eq 0) {
  throw "No Windows executables were supplied for Authenticode verification."
}

foreach ($ArtifactPath in $Paths) {
  if (-not (Test-Path -LiteralPath $ArtifactPath -PathType Leaf)) {
    throw "Windows release artifact does not exist: $ArtifactPath"
  }

  $Signature = Get-AuthenticodeSignature -LiteralPath $ArtifactPath
  if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Invalid Authenticode signature for $ArtifactPath: $($Signature.Status) $($Signature.StatusMessage)"
  }
  if ($null -eq $Signature.SignerCertificate) {
    throw "Authenticode signature for $ArtifactPath has no signer certificate."
  }

  $PublisherName = $Signature.SignerCertificate.GetNameInfo(
    [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
    $false
  )
  if ($PublisherName -cne $ExpectedPublisherName) {
    throw "Authenticode publisher mismatch for $ArtifactPath. Expected '$ExpectedPublisherName', found '$PublisherName'."
  }

  Write-Host "Verified Authenticode: $ArtifactPath ($PublisherName, $($Signature.SignerCertificate.Thumbprint))"
}
