param([switch]$Close)
$ErrorActionPreference='Stop'
# No profile files are removed. Only disposable, silent, headless Pong helper
# roots with an absent original parent qualify; personal browsers never do.
$pongSnapshot=@(Get-CimInstance Win32_Process)
$pongCandidates=@($pongSnapshot | Where-Object {
  $_.Name -eq 'chrome.exe' -and $_.CommandLine -match '--headless' -and
  $_.CommandLine -match '--mute-audio' -and $_.CommandLine -notmatch '--type=' -and
  $_.CommandLine -match '--user-data-dir="?C:\\Users\\arian\\AppData\\Local\\Temp\\pong-simpcity-[A-Za-z0-9]+(?:"|\s|$)'
})
foreach($pongCandidate in $pongCandidates){
  $pongParent=@($pongSnapshot | Where-Object { $_.ProcessId -eq $pongCandidate.ParentProcessId -and $_.CreationDate -le $pongCandidate.CreationDate })
  if($pongParent.Count){continue}
  $pongLive=Get-CimInstance Win32_Process -Filter "ProcessId=$($pongCandidate.ProcessId)"
  if(-not $pongLive -or $pongLive.CreationDate -ne $pongCandidate.CreationDate -or $pongLive.CommandLine -ne $pongCandidate.CommandLine){continue}
  if($Close){Stop-Process -Id $pongLive.ProcessId -ErrorAction Stop}
  [pscustomobject]@{PID=$pongCandidate.ProcessId;Started=$pongCandidate.CreationDate;Closed=[bool]$Close;ProfileFilesPreserved=$true}
}
