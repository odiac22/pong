[CmdletBinding()]
param(
  [ValidateSet('all', 'pong1', 'pong2')][string]$Instance = 'all',
  [string]$PrivateDirectory = 'C:\Users\arian\Documents\New project\vps-private-input'
)

$ErrorActionPreference = 'Stop'
$credentialPath = Join-Path $PrivateDirectory 'SLS-ALL-CREDENTIALS-PRIVATE.txt'
$keyPath = Join-Path $PrivateDirectory 'codex_vps_temp'
$lines = Get-Content -LiteralPath $credentialPath
function Get-PrivateValue([string]$Label) {
  $match = $lines | Where-Object { $_ -match ('^\s*' + [regex]::Escape($Label) + '\s*:') } | Select-Object -First 1
  if ($match) { return ($match -replace ('^\s*' + [regex]::Escape($Label) + '\s*:\s*'), '').Trim() }
  return ''
}

$hostName = Get-PrivateValue 'VPS IP'
$userName = Get-PrivateValue 'SSH username'
$port = Get-PrivateValue 'SSH port'
if (-not $port) { $port = '22' }
if (-not $hostName -or -not $userName -or -not (Test-Path -LiteralPath $keyPath)) {
  throw 'VPS connection information is incomplete.'
}

$path = if ($Instance -eq 'all') { '/instances' } else { "/instances/$Instance" }
$raw = & ssh -i $keyPath -p $port "$userName@$hostName" "curl -fsS http://127.0.0.1:8799$path"
if ($LASTEXITCODE -ne 0) { throw 'Pong live observer could not be reached.' }
$raw | ConvertFrom-Json | ConvertTo-Json -Depth 12
