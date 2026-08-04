[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$startupDirectory = [Environment]::GetFolderPath('Startup')
$launcherPath = Join-Path $PSScriptRoot 'start-pong-control.vbs'
$shortcutPath = Join-Path $startupDirectory 'Pong Server Control.lnk'

if (-not (Test-Path -LiteralPath $launcherPath)) {
  throw "Pong control launcher was not found at $launcherPath"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$shortcut.Arguments = "`"$launcherPath`""
$shortcut.WorkingDirectory = Split-Path -Parent $PSScriptRoot
$shortcut.Description = 'Lightweight LAN control for starting and stopping Pong services'
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,27"
$shortcut.WindowStyle = 7
$shortcut.Save()

Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') -ArgumentList "`"$launcherPath`"" -WindowStyle Hidden | Out-Null
Write-Output $shortcutPath
