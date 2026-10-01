$ErrorActionPreference = 'Stop'

$base = 'http://127.0.0.1:8787/pong-swap'
$faceId = 'approved-23-f248040d8604'
$sourceUrl = 'https://videos.pexels.com/video-files/7894253/7894253-sd_506_960_25fps.mp4'
$frame = 'C:\Users\arian\Documents\Codex\2026-07-15\files-mentioned-by-the-user-chatgpt\work\pong\artifacts\face-lock-frame-4.29.png'
$previewId = ''
$sessionId = ''
$temporaryOutput = $null

try {
    $bytes = [System.IO.File]::ReadAllBytes($frame)
    $data = 'data:image/png;base64,' + [Convert]::ToBase64String($bytes)
    $previewBody = @{
        sourceUrl = $sourceUrl
        faceId = $faceId
        startSeconds = 4.29
        frameDataUrl = $data
    } | ConvertTo-Json -Compress
    $preview = Invoke-RestMethod -Uri "$base/frame-previews" -Method Post -ContentType 'application/json' -Body $previewBody -TimeoutSec 60
    $previewId = $preview.preview.id
    $faces = (Invoke-RestMethod -Uri "$base/frame-previews/$previewId/faces" -Method Get -TimeoutSec 120).faces
    if ($faces.Count -lt 3) {
        throw "Expected at least 3 detected faces, got $($faces.Count)"
    }
    $target = $faces[2]

    $lineupScores = foreach ($face in $faces) {
        $dot = 0.0
        $targetNorm = 0.0
        $faceNorm = 0.0
        for ($index = 0; $index -lt $target.identityEmbedding.Count; $index++) {
            $targetValue = [double]$target.identityEmbedding[$index]
            $faceValue = [double]$face.identityEmbedding[$index]
            $dot += $targetValue * $faceValue
            $targetNorm += $targetValue * $targetValue
            $faceNorm += $faceValue * $faceValue
        }
        $cosine = $dot / ([Math]::Sqrt($targetNorm) * [Math]::Sqrt($faceNorm))
        $arcScore = 100.0 * [Math]::Max(0.0, [Math]::Min(1.0, ($cosine - 0.05) / 0.65))
        $appearanceSquared = 0.0
        for ($index = 0; $index -lt $target.presentation.appearance.Count; $index++) {
            $difference = [double]$target.presentation.appearance[$index] - [double]$face.presentation.appearance[$index]
            $appearanceSquared += $difference * $difference
        }
        $appearanceDistance = [Math]::Sqrt($appearanceSquared / $target.presentation.appearance.Count)
        $appearanceScore = 100.0 * [Math]::Exp(-5.0 * [Math]::Max(0.0, $appearanceDistance))
        [pscustomobject]@{
            index = $face.index
            x = [Math]::Round([double]$face.x, 3)
            y = [Math]::Round([double]$face.y, 3)
            arc = [Math]::Round($arcScore, 2)
            appearance = [Math]::Round($appearanceScore, 2)
            combined = [Math]::Round(0.85 * $arcScore + 0.15 * $appearanceScore, 2)
        }
    }
    Write-Output ('LINEUP_SCORES=' + ($lineupScores | ConvertTo-Json -Compress))

    $previewSettings = @{
        parameters = @{
            DetectScoreSlider = 9
            FaceLockSlider = 100
        }
    } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "$base/settings/preview" -Method Put -ContentType 'application/json' -Body $previewSettings -TimeoutSec 60 | Out-Null

    $sessionBody = @{
        channel = 'identity-lock-live-test'
        sourceUrl = $sourceUrl
        faceId = $faceId
        faceIds = @($faceId)
        startSeconds = 0
        prefetch = $false
        prebufferSeconds = 0.5
        navigationClass = 'foreground'
        clientEpoch = 'identity-lock-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        activationSequence = 1
        targetX = [double]$target.x
        targetY = [double]$target.y
        targetEmbedding = @($target.identityEmbedding)
        targetPresentationLabel = [string]$target.presentation.label
        targetPresentationConfidence = [double]$target.presentation.confidence
        targetAppearance = @($target.presentation.appearance)
    } | ConvertTo-Json -Depth 8 -Compress
    $created = Invoke-RestMethod -Uri "$base/sessions" -Method Post -ContentType 'application/json' -Body $sessionBody -TimeoutSec 120
    $sessionId = $created.session.id
    Write-Output "PREVIEW=$previewId SESSION=$sessionId FACES=$($faces.Count) TARGET=$($target.index) LOCKED=$($created.session.manualTarget.identityLocked)"

    $temporaryOutput = New-TemporaryFile
    Invoke-WebRequest -Uri "$base/sessions/$sessionId/stream" -OutFile $temporaryOutput.FullName -TimeoutSec 900 | Out-Null
    $session = (Invoke-RestMethod -Uri "$base/sessions/$sessionId" -Method Get -TimeoutSec 30).session
    [pscustomobject]@{
        id = $sessionId
        state = $session.state
        complete = $session.complete
        frames = $session.frames
        inferenceFrames = $session.inferenceFrames
        compatibilityStatus = $session.compatibilityStatus
        compatibilityChecks = $session.compatibilityChecks
        compatibilityRejections = $session.compatibilityRejections
        targetIdentityChecks = $session.targetIdentityChecks
        targetIdentityRejections = $session.targetIdentityRejections
        targetIdentityMinSimilarity = $session.targetIdentityMinSimilarity
        targetIdentityMaxSimilarity = $session.targetIdentityMaxSimilarity
        selectedFaceSimilarity = $session.selectedFaceSimilarity
        selectedTargetPresentation = $session.selectedTargetPresentation
        firstTransformed = $session.firstRenderedFrameTransformed
        bytes = $session.bytesWritten
        audioEnabled = $false
    } | ConvertTo-Json -Compress
}
finally {
    if ($temporaryOutput) {
        Remove-Item -LiteralPath $temporaryOutput.FullName -Force -ErrorAction SilentlyContinue
    }
    if ($sessionId) {
        Invoke-RestMethod -Uri "$base/sessions/$sessionId" -Method Delete -TimeoutSec 30 | Out-Null
    }
    if ($previewId) {
        Invoke-RestMethod -Uri "$base/frame-previews/$previewId" -Method Delete -TimeoutSec 30 | Out-Null
    }
}
