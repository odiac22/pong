param([string]$Tag, [int]$Seconds = 45)
# One live measurement: swap visibility (monitor.mjs) and swapped-overlay
# smoothness (diag-overlay-fps.js windows) captured over the same period.
Set-Location $PSScriptRoot
$out = "F:\pong-claude-bench\live\m-$Tag.json"
$job = Start-Job -ScriptBlock { param($d, $s, $o) Set-Location $d; node monitor.mjs $s $o | Out-Null } -ArgumentList $PSScriptRoot, $Seconds, $out
$windows = @()
$t0 = Get-Date
while (((Get-Date) - $t0).TotalSeconds -lt ($Seconds - 9)) {
    $j = (node page-eval.mjs diag-overlay-fps.js tiktok) -join "`n" | ConvertFrom-Json
    $windows += @($j.windows)
}
Wait-Job $job | Out-Null; Remove-Job $job
$fps = @($windows | ForEach-Object { [double]$_.fps } | Sort-Object)
$gap = @($windows | ForEach-Object { [int]$_.worstGapMs } | Sort-Object)
$med = { param($a) if ($a.Count) { $a[[int][Math]::Floor(($a.Count - 1) / 2)] } else { 'n/a' } }
"== $Tag"
& .\summarize.ps1 $out
"overlay fps median $(& $med $fps) (min $($fps | Select-Object -First 1), n=$($fps.Count))  worst-gap median $(& $med $gap) ms"
