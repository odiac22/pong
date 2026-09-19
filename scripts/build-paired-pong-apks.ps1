[CmdletBinding()]
param(
  [string]$PrivateDirectory = 'C:\Users\arian\Documents\New project\vps-private-input',
  [string]$OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot 'downloads' }

$credentialPath = Join-Path $PrivateDirectory 'SLS-ALL-CREDENTIALS-PRIVATE.txt'
$signingPath = Join-Path $PrivateDirectory 'pong-android-signing-private.txt'
$keystorePath = Join-Path $PrivateDirectory 'pong-android-release.jks'
$sshKeyPath = Join-Path $PrivateDirectory 'codex_vps_temp'

foreach ($required in @($credentialPath, $signingPath, $keystorePath, $sshKeyPath)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Required private build input is missing: $required" }
}

$credentialLines = Get-Content -LiteralPath $credentialPath
function Get-ColonValue([string]$Label) {
  $match = $credentialLines | Where-Object { $_ -match ('^\s*' + [regex]::Escape($Label) + '\s*:') } | Select-Object -First 1
  if ($match) { return ($match -replace ('^\s*' + [regex]::Escape($Label) + '\s*:\s*'), '').Trim() }
  return ''
}

$signingValues = @{}
Get-Content -LiteralPath $signingPath | ForEach-Object {
  if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
    $signingValues[$matches[1]] = $matches[2]
  }
}

$hostName = Get-ColonValue 'VPS IP'
$userName = Get-ColonValue 'SSH username'
$sshPort = Get-ColonValue 'SSH port'
if (-not $sshPort) { $sshPort = '22' }
if (-not $hostName -or -not $userName) { throw 'VPS connection information is incomplete.' }

$remote = @'
set -eu
. /etc/pong-observer.env
domain=$(nginx -T 2>/dev/null | awk '/server_name aiostreams\./ { gsub(";", "", $2); print $2; exit }')
test -n "$domain"
printf '%s\n%s' "$domain" "$PONG_OBSERVER_INGEST_TOKEN"
'@
$remoteBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remote))
$remoteResult = & ssh -i $sshKeyPath -p $sshPort "$userName@$hostName" "echo $remoteBase64 | base64 -d | sudo bash"
if ($LASTEXITCODE -ne 0 -or @($remoteResult).Count -lt 2) { throw 'Could not obtain the observer build pairing.' }

$observerDomain = [string](@($remoteResult)[0])
$observerToken = [string](@($remoteResult)[1])
$observerDomain = $observerDomain.Trim()
$observerToken = $observerToken.Trim()
if (-not $observerDomain -or -not $observerToken) { throw 'Observer build pairing is incomplete.' }
$pairJson = @{ endpoint = "https://$observerDomain/pong-observe/ingest"; token = $observerToken } | ConvertTo-Json -Compress
$pairEncoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pairJson)).TrimEnd('=').Replace('+', '-').Replace('/', '_')

$oldEnvironment = @{}
foreach ($name in @('PONG_OBSERVER_PAIR', 'PONG_KEYSTORE_PATH', 'PONG_KEYSTORE_PASSWORD', 'PONG_KEY_ALIAS', 'PONG_KEY_PASSWORD', 'JAVA_HOME')) {
  $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

try {
  $env:PONG_OBSERVER_PAIR = $pairEncoded
  $env:PONG_KEYSTORE_PATH = $keystorePath
  $env:PONG_KEYSTORE_PASSWORD = $signingValues.KEYSTORE_PASSWORD
  $env:PONG_KEY_ALIAS = 'pong'
  # The Pong key was created with the same password as its PKCS12 store.
  # The legacy KEY_PASSWORD line is retained in the private note for history,
  # but it is not the password protecting the current key entry.
  $env:PONG_KEY_PASSWORD = $signingValues.KEYSTORE_PASSWORD
  $jdk17 = 'C:\Program Files\Java\jdk-17'
  if (Test-Path -LiteralPath (Join-Path $jdk17 'bin\java.exe')) { $env:JAVA_HOME = $jdk17 }
  if (-not $env:PONG_KEYSTORE_PASSWORD -or -not $env:PONG_KEY_PASSWORD) { throw 'Android signing values are incomplete.' }

  $gradleCommand = Join-Path $repoRoot 'android-app\gradlew.bat'
  if (-not (Test-Path -LiteralPath $gradleCommand)) {
    $gradleCommand = Get-ChildItem -LiteralPath (Join-Path $env:USERPROFILE '.gradle\wrapper\dists') -Filter gradle.bat -File -Recurse -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending |
      Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $gradleCommand -or -not (Test-Path -LiteralPath $gradleCommand)) { throw 'Gradle executable was not found.' }

  Push-Location (Join-Path $repoRoot 'android-app')
  try {
    & $gradleCommand clean assemblePong1Release assemblePong2Release
    if ($LASTEXITCODE -ne 0) { throw 'Android release build failed.' }
  } finally {
    Pop-Location
  }

  New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
  Copy-Item -LiteralPath (Join-Path $repoRoot 'android-app\app\build\outputs\apk\pong1\release\app-pong1-release.apk') -Destination (Join-Path $OutputDirectory 'Pong-1-27.71.apk') -Force
  Copy-Item -LiteralPath (Join-Path $repoRoot 'android-app\app\build\outputs\apk\pong2\release\app-pong2-release.apk') -Destination (Join-Path $OutputDirectory 'Pong-2-27.71.apk') -Force
} finally {
  foreach ($name in $oldEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name], 'Process')
  }
  $observerToken = $null
  $pairJson = $null
  $pairEncoded = $null
}

Write-Output 'Built paired Pong 1 and Pong 2 version 27.71 APKs.'
