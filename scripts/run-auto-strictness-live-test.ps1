$ErrorActionPreference = 'Stop'

$base = 'http://127.0.0.1:8787/pong-swap'
$faceId = 'approved-23-f248040d8604'
$sourceUrl = 'https://videos.pexels.com/video-files/7894253/7894253-sd_506_960_25fps.mp4'
$sessionId = ''
$temporaryOutput = $null

try {
    $previewSettings = @{
        parameters = @{
            DetectScoreSlider = 70
            FaceLockSlider = 100
        }
    } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri "$base/settings/preview" -Method Put -ContentType 'application/json' -Body $previewSettings -TimeoutSec 60 | Out-Null

    $sessionBody = @{
        channel = 'automatic-strictness-live-test'
        sourceUrl = $sourceUrl
        faceId = $faceId
        faceIds = @($faceId)
        startSeconds = 0
        prefetch = $false
        prebufferSeconds = 0.5
        navigationClass = 'foreground'
        clientEpoch = 'automatic-strictness-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        activationSequence = 1
    } | ConvertTo-Json -Depth 5 -Compress
    $created = Invoke-RestMethod -Uri "$base/sessions" -Method Post -ContentType 'application/json' -Body $sessionBody -TimeoutSec 120
    $sessionId = $created.session.id
    if ($created.session.manualTarget.identityLocked) {
        throw 'Automatic strictness test unexpectedly enabled Face Lock'
    }
    Write-Output "SESSION=$sessionId MANUAL_LOCK=$($created.session.manualTarget.identityLocked)"

    $temporaryOutput = New-TemporaryFile
    Invoke-WebRequest -Uri "$base/sessions/$sessionId/stream" -OutFile $temporaryOutput.FullName -TimeoutSec 900 | Out-Null
    $session = (Invoke-RestMethod -Uri "$base/sessions/$sessionId" -Method Get -TimeoutSec 30).session
    [pscustomobject]@{
        id = $sessionId
        state = $session.state
        complete = $session.complete
        frames = $session.frames
        inferenceFrames = $session.inferenceFrames
        temporalReuseFrames = $session.temporalReuseFrames
        temporalRedetectRecoveries = $session.temporalRedetectRecoveries
        compatibilityStatus = $session.compatibilityStatus
        compatibilityChecks = $session.compatibilityChecks
        compatibilityRejections = $session.compatibilityRejections
        automaticTargetLockFrame = $session.automaticTargetLockFrame
        automaticTargetLockSeconds = $session.automaticTargetLockSeconds
        automaticAcquisitionBackfilledFrames = $session.automaticAcquisitionBackfilledFrames
        selectedFaceSimilarity = $session.selectedFaceSimilarity
        selectedTargetPresentation = $session.selectedTargetPresentation
        targetIdentityChecks = $session.targetIdentityChecks
        targetIdentityRejections = $session.targetIdentityRejections
        targetIdentityMinSimilarity = $session.targetIdentityMinSimilarity
        targetIdentityMaxSimilarity = $session.targetIdentityMaxSimilarity
        targetIdentityRejectionSamples = $session.targetIdentityRejectionSamples
        timingTotals = $session.timingTotals
        temporalReuseRejections = $session.temporalReuseRejections
        manualIdentityLock = $session.manualTarget.identityLocked
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
}
