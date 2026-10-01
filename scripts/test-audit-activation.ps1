# Isolated function tests. Does not execute the activation script's top level,
# inspect real processes, stop services, or launch anything.
$ErrorActionPreference = 'Stop'
$testActivationPath = Join-Path $PSScriptRoot 'activate-audit-services-v3038.ps1'
$testTokens = $null
$testErrors = $null
$testAst = [System.Management.Automation.Language.Parser]::ParseFile($testActivationPath, [ref]$testTokens, [ref]$testErrors)
if ($testErrors.Count) { throw 'Activation script has parse errors' }
$testFunction = $testAst.Find({param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-ActivationListener'
}, $true)
. ([scriptblock]::Create($testFunction.Extent.Text))
$testWatchdogFunction = $testAst.Find({param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-ActivationWatchdogProcess'
}, $true)
. ([scriptblock]::Create($testWatchdogFunction.Extent.Text))
$testRendererFunction = $testAst.Find({param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Wait-ActivationRendererViaHelper'
}, $true)
. ([scriptblock]::Create($testRendererFunction.Extent.Text))

function Get-NetTCPConnection {
    param($LocalPort, $State, $ErrorAction)
    $testStep = [Math]::Min($script:testProbe++, $script:testOwnerSteps.Count - 1)
    foreach ($testOwner in $script:testOwnerSteps[$testStep]) { [pscustomobject]@{OwningProcess=$testOwner} }
}
function Get-CimInstance {
    param($ClassName, $Filter)
    if ($script:testMissingProcess -gt 0) { $script:testMissingProcess--; return $null }
    return [pscustomobject]@{ProcessId=42;Name='python.exe'}
}
function Start-Sleep { param($Milliseconds) $script:testWaits++ }
function Reset-TestProbe($Steps) {
    $script:testOwnerSteps = $Steps
    $script:testProbe = 0
    $script:testWaits = 0
    $script:testMissingProcess = 0
}
function Assert-Test($Condition, $Message) { if (-not $Condition) { throw $Message } }

Reset-TestProbe (, @(42))
Assert-Test ((Get-ActivationListener 8792).ProcessId -eq 42) 'Ready listener was not returned'
Reset-TestProbe @(@(), @(42))
Assert-Test ((Get-ActivationListener 8792 -WaitSeconds 1).ProcessId -eq 42 -and $script:testWaits -eq 1) 'Transient absence did not recover'
Reset-TestProbe (, @(42,42))
Assert-Test ((Get-ActivationListener 8792).ProcessId -eq 42) 'Dual bindings for one owner were not deduplicated'
Reset-TestProbe (, @(42,43))
$testRejected = $false
try { Get-ActivationListener 8792 -WaitSeconds 1 | Out-Null } catch { $testRejected = $_.Exception.Message -like 'Multiple service owners*' }
Assert-Test ($testRejected -and $script:testWaits -eq 0) 'Ambiguous owners did not fail immediately'
Reset-TestProbe (, @())
$testRejected = $false
try { Get-ActivationListener 8792 | Out-Null } catch { $testRejected = $_.Exception.Message -like 'Service on port*' }
Assert-Test $testRejected 'Missing listener was accepted'
Reset-TestProbe (, @(42))
$script:testMissingProcess = 1
Assert-Test ((Get-ActivationListener 8792 -WaitSeconds 1).ProcessId -eq 42 -and $script:testWaits -eq 1) 'Exited process snapshot was not retried'
$watchdogPath = 'C:\pong\scripts\run-pong-server-watchdog.ps1'
$watchdogParent = [pscustomobject]@{Name='powershell.exe';CommandLine='powershell.exe -NoProfile -File "scripts\run-pong-server-watchdog.ps1"'}
Assert-Test (Test-ActivationWatchdogProcess $watchdogParent $watchdogPath) 'Relative watchdog launch was not recognized'
$watchdogParent.CommandLine = 'powershell.exe -NoProfile -File "C:\pong\scripts\run-pong-server-watchdog.ps1"'
Assert-Test (Test-ActivationWatchdogProcess $watchdogParent $watchdogPath) 'Absolute watchdog launch was not recognized'
$watchdogParent.CommandLine = 'powershell.exe -NoProfile -File "scripts\run-pong-server-watchdog.ps1.bak"'
Assert-Test (-not (Test-ActivationWatchdogProcess $watchdogParent $watchdogPath)) 'Watchdog-like file suffix was accepted'
$watchdogParent.CommandLine = 'powershell.exe -NoProfile -Command "Write-Output scripts\run-pong-server-watchdog.ps1"'
Assert-Test (-not (Test-ActivationWatchdogProcess $watchdogParent $watchdogPath)) 'Unrelated command text was accepted'
$watchdogParent.CommandLine = 'powershell.exe -NoProfile -File "scripts\run-pong-server-watchdog.ps1"'
$watchdogParent.Name = 'node.exe'
Assert-Test (-not (Test-ActivationWatchdogProcess $watchdogParent $watchdogPath)) 'Non-PowerShell process was accepted'
function Wait-ActivationHttp { param($Url, $Seconds) $script:testHelperUrl=$Url; $script:testHelperWait=$Seconds }
function Get-ActivationListener { param($Port, $WaitSeconds)
    $script:testRendererPort=$Port
    return [pscustomobject]@{Name=$script:testRendererName;CommandLine=$script:testRendererCommand}
}
$script:testRendererName='python.exe'
$script:testRendererCommand='python.exe "C:\pong\Pong Swap\pong_swap_service.py"'
$servicePath='C:\pong\Pong Swap\pong_swap_service.py'
$null=Wait-ActivationRendererViaHelper $servicePath
Assert-Test ($script:testHelperUrl -eq 'http://127.0.0.1:8787/pong-swap/health' -and
    $script:testHelperWait -eq 90 -and $script:testRendererPort -eq 8792) 'Renderer was not requested through the helper'
$script:testRendererCommand='python.exe other_service.py'
$testRejected=$false
try { Wait-ActivationRendererViaHelper $servicePath | Out-Null } catch { $testRejected=$true }
Assert-Test $testRejected 'Unexpected renderer listener was accepted'
Write-Output '13 isolated activation tests passed. No real process or service was touched.'
