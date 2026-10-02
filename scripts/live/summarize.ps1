param([string]$Path)
# Summarise a monitor.mjs recording: how often the visible post showed a swap
# and how quickly sessions reached their first swapped frame.
$rows = Get-Content $Path -Raw | ConvertFrom-Json
$final = @{}
foreach ($r in $rows) { foreach ($s in $r.sessions) { $final[$s.id] = $s } }
$posts = @($rows | ForEach-Object { $_.pong.post } | Select-Object -Unique).Count
$samples = @($rows | Where-Object { $_.pong.post })
$swappedSamples = @($samples | Where-Object { $_.pong.phase -eq 'playing' -and $_.tiktok.visible }).Count
$ft = @($final.Values | Where-Object { $_.firstTxMs } | ForEach-Object { [int]$_.firstTxMs } | Sort-Object)
$noSwap = @($final.Values | Where-Object { -not $_.firstTxMs -and $_.frames -gt 0 }).Count
$pct = { param($a, $p) if ($a.Count) { $a[[Math]::Min($a.Count - 1, [Math]::Ceiling($a.Count * $p) - 1)] } else { 'n/a' } }
"posts=$posts  samples with swap visible: $swappedSamples/$($samples.Count)  sessions=$($final.Count) neverSwapped=$noSwap"
"session first swap ms: median $(& $pct $ft 0.5)  p95 $(& $pct $ft 0.95)"
"phases: " + (($samples | Group-Object { $_.pong.phase } | ForEach-Object { "$($_.Name)=$($_.Count)" }) -join ' ')
