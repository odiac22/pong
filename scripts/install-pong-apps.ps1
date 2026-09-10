[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ObserverEndpoint,
  [Parameter(Mandatory = $true)][string]$ObserverToken,
  [string]$PongUrl = 'http://127.0.0.1:8787/pong'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$browserCandidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
)
$browser = $browserCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $browser) { throw 'Chrome or Edge was not found.' }

$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$shell = New-Object -ComObject WScript.Shell

for ($instance = 1; $instance -le 2; $instance++) {
  $config = @{ endpoint = $ObserverEndpoint; token = $ObserverToken } | ConvertTo-Json -Compress
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($config)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  $separator = if ($PongUrl.Contains('?')) { '&' } else { '?' }
  $url = "$PongUrl${separator}pongInstance=$instance#pongObserve=$encoded"
  foreach ($folder in @($desktop, $startMenu)) {
    $shortcut = $shell.CreateShortcut((Join-Path $folder "Pong $instance.lnk"))
    $shortcut.TargetPath = $browser
    $shortcut.Arguments = "--app=`"$url`" --start-maximized --autoplay-policy=user-gesture-required"
    $shortcut.WorkingDirectory = $repoRoot
    $shortcut.IconLocation = "$(Join-Path $repoRoot "pong-$instance-icon.ico"),0"
    $shortcut.Description = "Pong $instance with private live diagnostics"
    $shortcut.Save()
  }
}

Write-Output 'Installed Pong 1 and Pong 2 shortcuts.'
