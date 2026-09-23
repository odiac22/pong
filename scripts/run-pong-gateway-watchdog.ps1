[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
$mutex = New-Object System.Threading.Mutex($false, 'Global\Odiac22PongGatewayWatchdog')
try {
  $owned = $mutex.WaitOne(0, $false)
} catch [System.Threading.AbandonedMutexException] {
  $owned = $true
}
if (-not $owned) { exit 0 }

$keyPath = 'C:\Users\arian\Documents\New project\vps-private-input\codex_vps_temp'
$remoteHost = '217.77.13.143'
$remotePort = 18787
$marker = "127.0.0.1:${remotePort}:127.0.0.1:8787"

function Test-GatewayTunnelRunning {
  try {
    return $null -ne (
      Get-CimInstance Win32_Process -Filter "Name = 'ssh.exe'" -ErrorAction Stop |
        Where-Object { $_.CommandLine -like "*$marker*" } |
        Select-Object -First 1
    )
  } catch { return $false }
}

while ($true) {
  if (-not (Test-GatewayTunnelRunning) -and (Test-Path -LiteralPath $keyPath)) {
    $ssh = Get-Command ssh.exe -ErrorAction SilentlyContinue
    if ($ssh) {
      $arguments = "-N -R $marker -i `"$keyPath`" -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 root@$remoteHost"
      try {
        Start-Process -FilePath $ssh.Source -ArgumentList $arguments -WindowStyle Hidden
      } catch {}
    }
  }
  Start-Sleep -Seconds 5
}

