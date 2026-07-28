[CmdletBinding()]
param(
  [string]$ShortcutPath = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Pong Start-Terminate.lnk')
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$toggleScript = Join-Path $PSScriptRoot 'toggle-pong.ps1'
$powershellPath = Join-Path $PSHOME 'powershell.exe'

if (-not (Test-Path -LiteralPath $toggleScript)) {
  throw "Pong toggle script was not found at $toggleScript"
}

$shortcutDirectory = Split-Path -Parent $ShortcutPath
if (-not (Test-Path -LiteralPath $shortcutDirectory)) {
  New-Item -ItemType Directory -Path $shortcutDirectory -Force | Out-Null
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = $powershellPath
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$toggleScript`""
$shortcut.WorkingDirectory = $repoRoot
$shortcut.Description = 'Start Pong when stopped, or fully terminate Pong when running'
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,27"
$shortcut.Save()

Write-Output $ShortcutPath
