$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This probe requires a disposable GitHub Actions VM.' }
foreach ($scriptName in @('child.ps1','cdp.ps1')) {
    $tokens = $null
    $parseErrors = $null
    $null = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $scriptName), [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw "PowerShell syntax check failed for $scriptName ($($parseErrors.Count) errors)." }
}
$root = Join-Path "$($env:SystemDrive)\" "dsh112-desktop-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)"
New-Item -ItemType Directory -Path $root | Out-Null
$installer = Join-Path $root 'dsh-0.2.2-rc.1.exe'
Invoke-WebRequest -Uri 'https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe' -OutFile $installer -TimeoutSec 240
if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne '830947F8996DC05D991CA9133FFF4D3400073E47B9CFA6507754867E79482B23' -or
    (Get-AuthenticodeSignature -FilePath $installer).Status -ne 'Valid') { throw 'Unexpected official installer hash or signature.' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'child.ps1') -Destination $root
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uia.ps1') -Destination $root
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'cdp.ps1') -Destination $root
$name = 'dshDesk' + [Guid]::NewGuid().ToString('N').Substring(0,8)
$bytes = [byte[]]::new(24)
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$password = ConvertTo-SecureString (([Convert]::ToBase64String($bytes)) + 'Aa1!') -AsPlainText -Force
$user = New-LocalUser -Name $name -Password $password -AccountNeverExpires
$child = $null
try {
    $account = "$($env:COMPUTERNAME)\$name"
    $group = Get-LocalGroup -SID 'S-1-5-32-545'
    if (-not (Get-LocalGroupMember -Group $group.Name | Where-Object SID -eq $user.SID)) {
        Add-LocalGroupMember -Group $group.Name -Member $account
    }
    & "$env:SystemRoot\System32\icacls.exe" $root /grant:r "*$($user.SID.Value):(OI)(CI)M" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Unable to grant access to the probe folder.' }
    Set-Content -LiteralPath (Join-Path $root 'expected-sid.txt') -Value $user.SID.Value
    $pwsh = (Get-Command pwsh.exe -CommandType Application).Source
    $command = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $root 'child.ps1')`""
    $child = Start-Process -FilePath $pwsh -ArgumentList $command -Credential ([pscredential]::new($account,$password)) -LoadUserProfile -WorkingDirectory $root -RedirectStandardOutput (Join-Path $root 'child-output.txt') -RedirectStandardError (Join-Path $root 'child-error.txt') -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(780)
    while (-not $child.WaitForExit(30000)) {
        $stagePath = Join-Path $root 'desktop-stage.txt'
        $stage = if (Test-Path -LiteralPath $stagePath) { (Get-Content -LiteralPath $stagePath -TotalCount 1) } else { 'Standard account startup' }
        Write-Host "Desktop probe: owned child PID $($child.Id) is still running; waiting for $stage."
        if ([DateTime]::UtcNow -ge $deadline) { throw 'Standard-user Desktop probe timed out.' }
    }
    if ($child.ExitCode -ne 0) { throw "Standard-user Desktop probe exited $($child.ExitCode)." }
    $proof = Get-Content -LiteralPath (Join-Path $root 'desktop-proof.json') -Raw | ConvertFrom-Json
    foreach ($gate in @('Complete','StandardUser','CandidateInstalled','EditableMinTokens','OfficialSaveClicked','PersistedInProfile','RestartReadback','NativeWindow')) {
        if ($proof.$gate -ne $true) { throw "Desktop validation gate did not pass: $gate." }
    }
    $saved = Get-Content -LiteralPath (Join-Path $root 'settings-save-proof.json') -Raw | ConvertFrom-Json
    $restart = Get-Content -LiteralPath (Join-Path $root 'settings-restart-proof.json') -Raw | ConvertFrom-Json
    if ($saved.Profile -ne 'desktop' -or $saved.Namespace -ne 'compaction-spine' -or $saved.SavedValue -ne 24000 -or
        $saved.OfficialSaveClicked -ne $true -or $saved.PersistedInProfile -ne $true -or
        $restart.Profile -ne 'desktop' -or $restart.Namespace -ne 'compaction-spine' -or $restart.ReadbackValue -ne 24000 -or
        $restart.Restarted -ne $true -or $restart.ReopenedSettings -ne $true -or $restart.OldProcessExited -ne $true -or
        $restart.OldEndpointClosed -ne $true -or $restart.SameUserDataDirectory -ne $true -or $restart.SameDshHome -ne $true -or
        $restart.Visible -ne $true -or $restart.Editable -ne $true -or $restart.InitialPID -eq $restart.RestartPID) {
        throw 'Desktop save/restart evidence is incomplete or targets the wrong namespace/profile.'
    }
} finally {
    if ($child -and -not $child.HasExited) {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $child.Id /T /F 2>$null | Out-Null
        $null = $child.WaitForExit(10000)
    }
    foreach ($f in @('desktop-stage.txt','desktop-env-proof.json','desktop-proof.json','cdp-proof.json','cdp-read-diagnostic.json','last-ui-proof.json','plugin-manager-proof.json','plugin-install-proof.json','install-progress-proof.json','installed-candidate-proof.json','candidate-details-proof.json','settings-edited-proof.json','settings-save-proof.json','restart-cdp-proof.json','restart-settings-ui-proof.json','settings-restart-proof.json','uia-diagnostic.txt','uia-error.txt','child-output.txt','child-error.txt','desktop-failure.txt')) {
        $p = Join-Path $root $f
        if (Test-Path -LiteralPath $p) {
            Write-Host "Desktop probe evidence: $f"
            Get-Content -LiteralPath $p -TotalCount 32 | ForEach-Object { $_.Substring(0, [Math]::Min($_.Length, 12000)) }
        }
    }
    Remove-LocalUser -Name $name -ErrorAction SilentlyContinue
}
