param(
    [Parameter(Mandatory = $true)]
    [string] $Path
)

$data = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
$results = @()
foreach ($appearanceWeightStep in 0..20) {
    $appearanceWeight = $appearanceWeightStep / 20.0
    foreach ($threshold in 0..100) {
        $correct = 0
        $falsePositive = 0
        $missed = 0
        $targetFrames = 0
        $first = $null
        $last = $null
        foreach ($frame in $data.frames) {
            $targetIndex = if ($null -eq $frame.targetIndex) { -1 } else { [int]$frame.targetIndex }
            if ($targetIndex -ge 0) { $targetFrames++ }
            $best = $null
            $bestScore = -1e9
            foreach ($face in $frame.faces) {
                $appearance = if ($null -eq $face.sourceAppearanceSimilarity) {
                    -100.0
                } else {
                    [double]$face.sourceAppearanceSimilarity
                }
                $score = (1.0 - $appearanceWeight) * [double]$face.sourceArcSimilarity + $appearanceWeight * $appearance
                if ($score -gt $bestScore) {
                    $bestScore = $score
                    $best = $face
                }
            }
            if ($null -ne $best -and $bestScore -ge $threshold) {
                if ($null -eq $first) { $first = [int]$frame.frame }
                $last = [int]$frame.frame
                if ($targetIndex -ge 0 -and [int]$best.index -eq $targetIndex) {
                    $correct++
                } else {
                    $falsePositive++
                }
            } elseif ($targetIndex -ge 0) {
                $missed++
            }
        }
        $results += [pscustomobject]@{
            appearanceWeight = $appearanceWeight
            strictness = $threshold
            targetFrames = $targetFrames
            correct = $correct
            falsePositive = $falsePositive
            missed = $missed
            precision = $correct / [math]::Max(1, $correct + $falsePositive)
            recall = $correct / [math]::Max(1, $targetFrames)
            first = $first
            last = $last
        }
    }
}

Write-Output 'BEST ZERO FALSE'
$results |
    Where-Object falsePositive -eq 0 |
    Sort-Object @{ Expression = 'recall'; Descending = $true }, @{ Expression = 'appearanceWeight'; Descending = $true }, strictness |
    Select-Object -First 20 |
    Format-Table -AutoSize

Write-Output 'BEST FALSE <= 3'
$results |
    Where-Object falsePositive -le 3 |
    Sort-Object @{ Expression = 'recall'; Descending = $true }, @{ Expression = 'falsePositive'; Descending = $false } |
    Select-Object -First 20 |
    Format-Table -AutoSize
