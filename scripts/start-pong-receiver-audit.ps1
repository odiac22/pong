# Manual-only launch: separate receiver so Pong cannot capture its own screen.
[CmdletBinding()]
param([switch]$CheckOnly,
    [switch]$GuestVideoDecoder,
    [switch]$HostVideoDecoder,
    [switch]$IntegratedGraphicsTrial,
    [switch]$VulkanGraphicsTrial,
    [ValidateRange(2,8)][int]$CpuCores=4,
    [ValidateRange(2560,4096)][int]$MemoryMb=4096)
$ErrorActionPreference='Stop'
if ($IntegratedGraphicsTrial -and $VulkanGraphicsTrial) { throw 'Choose one graphics trial.' }
# Diagnostic only: the AMD ANGLE/Vulkan trial crashed HWUI when Media3 used
# a TextureView on this AVD. Do not enable it in the normal receiver launcher.
if ($IntegratedGraphicsTrial) {
    Write-Warning 'Experimental integrated graphics: known Media3 TextureView crash on this AVD; not a production configuration.'
}
if ($GuestVideoDecoder -and $HostVideoDecoder) {
    throw 'Choose at most one video decoder override.'
}
$receiverSdk=Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$receiverEmulator=Join-Path $receiverSdk 'emulator\emulator.exe'
$receiverOutput='E:\Pong Benchmarks\v3038-detect'
if (-not (Test-Path -LiteralPath $receiverEmulator)) { throw 'Android emulator executable is missing.' }
if (-not (Test-Path -LiteralPath $receiverOutput)) { throw 'Existing audit output directory is missing.' }
$receiverAvds=@(& $receiverEmulator -list-avds)
if ($receiverAvds -notcontains 'pong_receiver_audit_api35') { throw 'Dedicated Pong receiver AVD is missing.' }
foreach ($receiverPort in @(5582,5583,8557)) {
    if (Get-NetTCPConnection -LocalPort $receiverPort -State Listen -ErrorAction SilentlyContinue) {
        throw "Port $receiverPort is in use. Nothing was stopped; send this message to the assistant."
    }
}
if ($CheckOnly) { Write-Output 'Receiver preflight passed. Nothing started.'; return }
$receiverArgs=@('-avd','pong_receiver_audit_api35','-port','5582',
    '-grpc','8557','-grpc-use-token','-no-window','-no-audio','-no-snapshot-save',
    '-no-snapshot-load','-no-boot-anim','-gpu','host','-memory',"$MemoryMb",'-cores',"$CpuCores")
$receiverFeatures=@()
if ($GuestVideoDecoder) {
    # Isolated A/B only. Keep Android MediaCodec available, but use the guest
    # decoder instead of the emulator's host-codec translation layer. No
    # graphics acceleration, resolution, saved app data or quality is changed.
    $receiverFeatures += '-HardwareDecoder'
}
if ($HostVideoDecoder) {
    # Explicit paired diagnostic; leave the existing default launch unchanged.
    $receiverFeatures += 'HardwareDecoder'
}
if ($IntegratedGraphicsTrial -or $VulkanGraphicsTrial) {
    # API35 isolated receiver only: guest GLES -> ANGLE -> selected host Vulkan.
    # VK_SELECT_GPU alone does not move the ordinary host OpenGL translator.
    # Keep this opt-in; verify SurfaceFlinger's real renderer before scoring.
    $receiverFeatures += @('GuestAngle','Vulkan')
}
if ($receiverFeatures.Count) { $receiverArgs += @('-feature',($receiverFeatures -join ',')) }
$receiverSavedGpu=[Environment]::GetEnvironmentVariable('ANDROID_EMU_VK_SELECT_GPU','Process')
try {
    if ($IntegratedGraphicsTrial) { $env:ANDROID_EMU_VK_SELECT_GPU='AMD' }
    if ($VulkanGraphicsTrial) { $env:ANDROID_EMU_VK_SELECT_GPU='NVIDIA' }
    $receiverProcess=Start-Process -FilePath $receiverEmulator -ArgumentList $receiverArgs `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $receiverOutput 'receiver-dedicated-emulator.log') `
        -RedirectStandardError (Join-Path $receiverOutput 'receiver-dedicated-emulator.err')
} finally {
    [Environment]::SetEnvironmentVariable('ANDROID_EMU_VK_SELECT_GPU',$receiverSavedGpu,'Process')
}
Write-Output "Hidden, silent receiver emulator requested, PID $($receiverProcess.Id). Test data stays on E:."
Write-Output 'Waiting up to 45 seconds for the receiver listener...'
$receiverDeadline=[DateTime]::UtcNow.AddSeconds(45)
do {
    if (Get-NetTCPConnection -LocalPort 8557 -State Listen -ErrorAction SilentlyContinue) {
        Write-Output 'Receiver control listener is up. Android may still be finishing its first boot.'
        Write-Output 'Existing TikTok emulator unchanged. No authentication keys printed. Send this output to the assistant.'
        return
    }
    Start-Sleep -Milliseconds 500
} while ([DateTime]::UtcNow -lt $receiverDeadline)
throw 'Receiver listener did not start. Send this message; do not close the existing TikTok emulator.'
