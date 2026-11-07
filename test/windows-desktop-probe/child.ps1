$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$process = $null
$exitCode = 1
$stage = 'Standard account preflight'
$ownedProcesses = [Collections.Generic.List[Diagnostics.Process]]::new()
$proof = [ordered]@{
    Complete = $false
    StandardUser = $false
    CandidateInstalled = $false
    EditableMinTokens = $false
    OfficialSaveClicked = $false
    PersistedInProfile = $false
    RestartReadback = $false
    Profile = 'desktop'
    Namespace = 'compaction-spine'
}
function Set-ProbeStage([string]$Name) {
    $script:stage = $Name
    $Name | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'desktop-stage.txt')
    Write-Host "Desktop probe: $Name"
}
function Update-OwnedProcesses {
    # Follow only descendants of process objects we launched, retaining their
    # handles/start times so PID reuse cannot turn cleanup into an image-name kill.
    for ($i = 0; $i -lt $ownedProcesses.Count; $i++) {
        $parent = $ownedProcesses[$i]
        if ($parent.HasExited) { continue }
        foreach ($info in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($parent.Id)")) {
            if (@($ownedProcesses | Where-Object Id -eq $info.ProcessId).Count) { continue }
            try {
                $descendant = [Diagnostics.Process]::GetProcessById([int]$info.ProcessId)
                if ($descendant.StartTime -ge $parent.StartTime) {
                    $null = $descendant.Handle
                    $ownedProcesses.Add($descendant)
                }
            } catch [ArgumentException] {
                # A child may exit between enumeration and lookup.
            } catch [InvalidOperationException] {
            } catch [ComponentModel.Win32Exception] {}
        }
    }
}
function Stop-OwnedProcesses {
    try { Update-OwnedProcesses } catch { Write-Host 'Desktop probe: descendant snapshot unavailable; cleaning known owned processes.' }
    $failed = [Collections.Generic.List[int]]::new()
    foreach ($owned in $ownedProcesses) {
        try {
            if (-not $owned.HasExited) {
                $owned.Kill($true)
                if (-not $owned.WaitForExit(10000)) { $failed.Add($owned.Id) }
            }
        } catch {
            if (-not $owned.HasExited) { $failed.Add($owned.Id) }
        }
    }
    if ($failed.Count) { throw "Owned processes did not stop: $($failed -join ', ')." }
}
function Start-Desktop {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
    try {
        $listener.Start()
        $script:port = $listener.LocalEndpoint.Port
    } finally { $listener.Stop() }
    $script:process = Start-Process -FilePath $app.FullName -WorkingDirectory $app.DirectoryName -ArgumentList @(
        "--user-data-dir=`"$appProfile`"", "--remote-debugging-port=$port",
        '--remote-debugging-address=127.0.0.1', '--force-renderer-accessibility'
    ) -PassThru
    $ownedProcesses.Add($process)
    Write-Host "Desktop probe: launched owned PID $($process.Id)."
}
function Get-DesktopView([string]$Evidence, [int]$TimeoutSeconds = 75) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $process.Refresh()
        if ($process.HasExited) { throw 'The owned official Desktop process exited.' }
        Update-OwnedProcesses
        try {
            $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 2
            $target = $targets | Where-Object { $_.type -eq 'page' -and $_.url -like 'dsh-app:*' -and $_.webSocketDebuggerUrl } | Select-Object -First 1
            if ($target) {
                $raw = & (Join-Path $PSScriptRoot 'cdp.ps1') -Endpoint $target.webSocketDebuggerUrl -Port $port
                $raw | Set-Content -LiteralPath (Join-Path $PSScriptRoot $Evidence)
                $state = $raw | ConvertFrom-Json
                if ($state.protocol -eq 'dsh-app:' -and $state.ready -eq 'complete' -and $state.buttons -contains 'Plugins') {
                    return [pscustomobject]@{ Endpoint = $target.webSocketDebuggerUrl; State = $state }
                }
            }
        } catch {
            # Only renderer discovery/readiness is retried. No save/install failure
            # is swallowed here, and no raw profile content is put in diagnostics.
            [pscustomobject]@{ Stage = $stage; ReadError = $_.Exception.GetType().Name } |
                ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'cdp-read-diagnostic.json')
        }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Official Desktop renderer did not become readable before the deadline.'
}
function Invoke-RequiredClick([string]$Label) {
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        $view = Get-DesktopView 'last-ui-proof.json' 10
        if (& (Join-Path $PSScriptRoot 'cdp.ps1') -Endpoint $view.Endpoint -Port $port -Click $Label) { return }
        Start-Sleep -Seconds 1
    }
    throw "Official UI control was unavailable: $Label."
}
function Open-CandidateSettings([string]$Evidence, [bool]$AllowEnable) {
    # Always navigate again, including in the fresh renderer after restart.
    $deadline = [DateTime]::UtcNow.AddSeconds(75)
    $attempt = 0
    $openedPlugins = $false
    do {
        $view = Get-DesktopView $Evidence 10
        $field = $view.State.minTokens
        if ($openedPlugins -and $field -and $field.visible -eq $true -and $field.disabled -eq $false -and $field.readOnly -eq $false) {
            return $view
        }
        if ($AllowEnable -and (& (Join-Path $PSScriptRoot 'cdp.ps1') -Endpoint $view.Endpoint -Port $port -Click 'EnableCandidate')) {
            Start-Sleep -Seconds 3
        } elseif (& (Join-Path $PSScriptRoot 'cdp.ps1') -Endpoint $view.Endpoint -Port $port -Click 'DismissInstall') {
            Start-Sleep -Seconds 1
        } elseif (-not $openedPlugins) {
            $openedPlugins = & (Join-Path $PSScriptRoot 'cdp.ps1') -Endpoint $view.Endpoint -Port $port -Click 'Plugins'
        } else {
            & (Join-Path $PSScriptRoot 'cdp.ps1') -Endpoint $view.Endpoint -Port $port -Click 'CandidateDetails' | Out-Null
        }
        if ($openedPlugins -and $attempt -eq 2) {
            & (Join-Path $PSScriptRoot 'cdp.ps1') -Endpoint $view.Endpoint -Port $port -Click 'Refresh' | Out-Null
        }
        $attempt++
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Candidate minTokens was not visible and editable in the official settings UI.'
}
function Test-CandidateProfileValue {
    if (-not (Test-Path -LiteralPath $profilePatch -PathType Leaf)) { return $false }
    if ((Get-Item -LiteralPath $profilePatch).Length -gt 262144) { throw 'Profile patch exceeds the bounded validation size.' }
    $text = [IO.File]::ReadAllText($profilePatch)
    # The pinned host serializes block-style profile patches. Fail closed for
    # unsupported structure rather than finding a value in another row/config.
    if ($text.Contains("`t") -or $text -match '(?m)^-(?! (?:id|insert):[ \r\n])') { return $false }
    $rows = @([regex]::Matches($text, '(?m)^- id: (?:compaction-spine|''compaction-spine''|"compaction-spine")[ ]*(?:#.*)?\r?$'))
    if ($rows.Count -ne 1) { return $false }
    $row = $text.Substring($rows[0].Index + $rows[0].Length)
    $end = [regex]::Match($row, '(?m)^- ')
    if ($end.Success) { $row = $row.Substring(0, $end.Index) }
    if ($row -match '(?m)^  id:' -or @([regex]::Matches($row, '(?m)^  config:')).Count -ne 1) { return $false }
    $config = [regex]::Match($row, '(?m)^  config:[ ]*(?:#.*)?\r?$')
    if (-not $config.Success) { return $false }
    $body = $row.Substring($config.Index + $config.Length)
    $end = [regex]::Match($body, '(?m)^  [^ #\r\n]')
    if ($end.Success) { $body = $body.Substring(0, $end.Index) }
    $values = @([regex]::Matches($body, '(?m)^    minTokens:[^\r\n]*'))
    return $values.Count -eq 1 -and $values[0].Value -match '^    minTokens: 24000[ ]*(?:#.*)?$'
}
function Assert-CandidateIdentity {
    foreach ($file in @('package.json','index.js','shadow.js')) {
        if (-not (Test-Path -LiteralPath (Join-Path $installed $file) -PathType Leaf)) { throw 'Candidate installation is missing required files in the desktop profile.' }
    }
    $package = Get-Content -LiteralPath (Join-Path $installed 'package.json') -Raw | ConvertFrom-Json
    $engineHash = (Get-FileHash -LiteralPath (Join-Path $installed 'index.js') -Algorithm SHA256).Hash
    $shadowHash = (Get-FileHash -LiteralPath (Join-Path $installed 'shadow.js') -Algorithm SHA256).Hash
    if ($package.name -ne 'dsh-live-compact' -or $package.version -ne '1.1.2' -or
        $engineHash -ne '5e6f0536d8fb2d1707d14597dfbd8af6c047e2746a60705889ea531e0b937f96' -or
        $shadowHash -ne '50037db3e442386cca82121b70866a08ba8911f4dae911463e078218ec30974f') { throw 'Desktop installed candidate identity mismatch.' }
    [pscustomobject]@{ CandidateInstalled = $true; Version = $package.version; EngineSHA256 = $engineHash; ShadowSHA256 = $shadowHash } |
        ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'installed-candidate-proof.json')
}
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($identity.User.Value -ne (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'expected-sid.txt')).Trim() -or
        $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Expected the standard test account.' }
    $profileKey = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$($identity.User.Value)"
    $profile = [Environment]::ExpandEnvironmentVariables((Get-ItemPropertyValue -LiteralPath $profileKey -Name ProfileImagePath))
    if (-not (Test-Path -LiteralPath $profile -PathType Container)) { throw 'Standard account Windows profile is unavailable.' }
    $roaming = Join-Path $profile 'AppData\Roaming'
    $local = Join-Path $profile 'AppData\Local'
    # Start-Process -Credential can retain the runner account's shell-folder
    # environment. Initialize only the disposable test account's own hive.
    $shellFolders = "Registry::HKEY_USERS\$($identity.User.Value)\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders"
    if (-not (Test-Path -LiteralPath "Registry::HKEY_USERS\$($identity.User.Value)")) { throw 'Standard account Windows hive is unavailable.' }
    if (-not (Test-Path -LiteralPath $shellFolders)) { New-Item -Path $shellFolders -Force | Out-Null }
    New-ItemProperty -LiteralPath $shellFolders -Name 'AppData' -Value $roaming -PropertyType ExpandString -Force | Out-Null
    New-ItemProperty -LiteralPath $shellFolders -Name 'Local AppData' -Value $local -PropertyType ExpandString -Force | Out-Null
    New-Item -ItemType Directory -Path $roaming, $local -Force | Out-Null
    $env:USERPROFILE = $profile
    $env:HOME = $profile
    $env:APPDATA = $roaming
    $env:LOCALAPPDATA = $local
    $env:TEMP = Join-Path $local 'Temp'
    $env:TMP = $env:TEMP
    $env:DSH_HOME = Join-Path $profile '.dsh'
    New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
    $installer = Join-Path $PSScriptRoot 'dsh-0.2.2-rc.1.exe'
    if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne '830947F8996DC05D991CA9133FFF4D3400073E47B9CFA6507754867E79482B23') {
        throw 'Installer hash mismatch before execution.'
    }
    Set-ProbeStage 'Installing pinned signed Desktop'
    $install = Start-Process -FilePath $installer -ArgumentList '/S' -PassThru
    $ownedProcesses.Add($install)
    if (-not $install.WaitForExit(180000)) {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $install.Id /T /F 2>$null | Out-Null
        throw 'Desktop installation timed out.'
    }
    $installCode = $install.ExitCode
    $launchMode = 'installed'
    if ($installCode -eq 0) {
        $programs = Join-Path $env:LOCALAPPDATA 'Programs'
        $app = Get-ChildItem -LiteralPath $programs -Filter 'DeepSeek Harness.exe' -Recurse -File | Select-Object -First 1
    } else {
        $launchMode = 'signed-installer-payload'
        $sevenZip = (Get-Command 7z.exe -CommandType Application -ErrorAction SilentlyContinue).Source
        if (-not $sevenZip) { $sevenZip = Join-Path $env:ProgramFiles '7-Zip\7z.exe' }
        if (-not (Test-Path -LiteralPath $sevenZip)) { throw "Installer exited $installCode and 7-Zip was unavailable." }
        $extract = Join-Path $PSScriptRoot 'installer-payload'
        & $sevenZip x $installer "-o$extract" -y | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Failed to extract the verified installer payload.' }
        $archive = Get-ChildItem -LiteralPath $extract -Filter 'app-64.7z' -Recurse -File | Select-Object -First 1
        if ($archive) {
            $unpack = Join-Path $PSScriptRoot 'app-payload'
            & $sevenZip x $archive.FullName "-o$unpack" -y | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Failed to extract the embedded x64 app.' }
        } else {
            $unpack = $extract
        }
        $app = Get-ChildItem -LiteralPath $unpack -Filter 'DeepSeek Harness.exe' -Recurse -File | Select-Object -First 1
    }
    if (-not $app) { throw "Desktop executable was not found in mode $launchMode." }
    if ((Get-AuthenticodeSignature -FilePath $app.FullName).Status -ne 'Valid') { throw 'Desktop executable signature did not validate.' }
    $version = $app.VersionInfo.ProductVersion
    # PE version metadata is numeric; the signed installer digest pins the prerelease.
    if ($version -notmatch '^0\.2\.2(?:\.0|-rc\.1)?$') { throw "Unexpected Desktop executable version $version." }
    $folders = [pscustomobject]@{
        HasProfile = Test-Path -LiteralPath ([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile))
        ProfileEnvMatches = $env:USERPROFILE -eq [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
        LocalAppDataEnvMatches = $env:LOCALAPPDATA -eq [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
        AppDataEnvMatches = $env:APPDATA -eq [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
        HasAppAsar = Test-Path -LiteralPath (Join-Path $app.DirectoryName 'resources\app.asar')
    }
    $folders | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'desktop-env-proof.json')
    $proof.StandardUser = $true
    $proof.InstallerExitCode = $installCode
    $proof.LaunchMode = $launchMode
    $proof.SignedInstallerVersion = '0.2.2-rc.1'
    $proof.DesktopExecutableVersion = $version
    $appProfile = Join-Path $local 'DSH Release Validation'
    $desktopHome = $env:DSH_HOME
    $installed = Join-Path $desktopHome 'profiles\desktop\node_modules\dsh-live-compact'
    $profilePatch = Join-Path $desktopHome 'profiles\desktop\cordis.patch.yml'
    New-Item -ItemType Directory -Path $appProfile -Force | Out-Null
    Set-ProbeStage 'Opening official Desktop plugin manager'
    Start-Desktop
    $initialProcess = $process
    $initialPid = $process.Id
    $initialStart = $process.StartTime
    $initialAppProfile = $appProfile
    $view = Get-DesktopView 'cdp-proof.json'
    Invoke-RequiredClick 'Plugins'
    $view = Get-DesktopView 'plugin-manager-proof.json'
    Invoke-RequiredClick 'Add plugin'
    $view = Get-DesktopView 'plugin-install-proof.json'
    $candidate = 'https://raw.githubusercontent.com/Tranquillitatis-Lab/dsh-live-compact/93c73ec334d302ff0e2d7ffb2ffc8ee26bc402f0/test/windows-runtime/fixtures/dsh-live-compact-1.1.2.tgz'
    if (-not (& (Join-Path $PSScriptRoot 'cdp.ps1') -Endpoint $view.Endpoint -Port $port -PackageAddress $candidate)) { throw 'Cannot enter candidate package address.' }
    Set-ProbeStage 'Installing frozen candidate through official UI'
    Invoke-RequiredClick 'Install'
    $installDeadline = [DateTime]::UtcNow.AddSeconds(150)
    while (-not (Test-Path -LiteralPath (Join-Path $installed 'index.js')) -and [DateTime]::UtcNow -lt $installDeadline) {
        Start-Sleep -Seconds 5
        $view = Get-DesktopView 'install-progress-proof.json' 10
    }
    Assert-CandidateIdentity
    $proof.CandidateInstalled = $true

    Set-ProbeStage 'Opening candidate settings and saving minTokens 24000'
    $view = Open-CandidateSettings 'candidate-details-proof.json' $true
    $proof.EditableMinTokens = $true
    if ($view.State.minTokens.value -eq '24000' -or (Test-CandidateProfileValue)) { throw 'Disposable profile already contains the target value; cannot prove a new UI save.' }
    if (-not (& (Join-Path $PSScriptRoot 'cdp.ps1') -Endpoint $view.Endpoint -Port $port -SettingValue '24000')) { throw 'Cannot edit candidate minTokens.' }
    $view = Get-DesktopView 'settings-edited-proof.json' 10
    if ($view.State.minTokens.value -ne '24000' -or -not $view.State.minTokens.visible -or
        $view.State.minTokens.disabled -or $view.State.minTokens.readOnly) { throw 'Candidate minTokens edit was not reflected in the visible editable field.' }
    Invoke-RequiredClick 'SaveCandidate'
    $proof.OfficialSaveClicked = $true
    $persistDeadline = [DateTime]::UtcNow.AddSeconds(15)
    while (-not (Test-CandidateProfileValue) -and [DateTime]::UtcNow -lt $persistDeadline) { Start-Sleep -Seconds 1 }
    if (-not (Test-CandidateProfileValue)) { throw 'Official Save did not persist desktop/compaction-spine.config.minTokens = 24000.' }
    $proof.PersistedInProfile = $true
    [pscustomobject]@{
        SettingsField = 'minTokens'; SavedValue = 24000; OfficialSaveClicked = $true
        PersistedInProfile = $true; Profile = 'desktop'; Namespace = 'compaction-spine'
        RelativePatch = 'profiles/desktop/cordis.patch.yml'
        PatchSHA256 = (Get-FileHash -LiteralPath $profilePatch -Algorithm SHA256).Hash
    } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'settings-save-proof.json')

    Set-ProbeStage 'Stopping owned Desktop processes for same-profile restart'
    $oldPort = $port
    Stop-OwnedProcesses
    $oldEndpointAlive = $false
    try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:$oldPort/json/list" -TimeoutSec 2
        $oldEndpointAlive = $true
    } catch {}
    if ($oldEndpointAlive) { throw 'Old Desktop CDP endpoint survived process shutdown.' }
    if ($env:DSH_HOME -ne $desktopHome -or $env:USERPROFILE -ne $profile -or $appProfile -ne $initialAppProfile) { throw 'Disposable Desktop profile changed before restart.' }
    Set-ProbeStage 'Restarting official Desktop and reopening candidate settings'
    Start-Desktop
    if ($process.Id -eq $initialPid -or $process.StartTime -le $initialStart -or $process.Path -ne $app.FullName) {
        throw 'Official Desktop did not start as a fresh owned process.'
    }
    $view = Get-DesktopView 'restart-cdp-proof.json'
    # Read-only verification: no enable, setting edits, or Save after restart.
    $view = Open-CandidateSettings 'restart-settings-ui-proof.json' $false
    if ($view.State.minTokens.value -ne '24000') { throw 'Restarted official Desktop did not read back minTokens 24000 from the same profile.' }
    if (-not (Test-CandidateProfileValue)) { throw 'Candidate namespace value was lost from the desktop profile after restart.' }
    Assert-CandidateIdentity
    $process.Refresh()
    if ($process.HasExited -or $process.MainWindowHandle -eq [IntPtr]::Zero) { throw 'Restarted official Desktop has no live native window.' }
    $proof.RestartReadback = $true
    [pscustomobject]@{
        Restarted = $true; OldProcessExited = $initialProcess.HasExited; OldEndpointClosed = -not $oldEndpointAlive
        InitialPID = $initialPid; RestartPID = $process.Id; SameUserDataDirectory = $appProfile -eq $initialAppProfile
        SameDshHome = $env:DSH_HOME -eq $desktopHome; Profile = 'desktop'; Namespace = 'compaction-spine'
        ReopenedSettings = $true; Visible = $view.State.minTokens.visible
        Editable = -not $view.State.minTokens.disabled -and -not $view.State.minTokens.readOnly
        ReadbackValue = [int]$view.State.minTokens.value
    } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'settings-restart-proof.json')
    $proof.Complete = $proof.CandidateInstalled -and $proof.EditableMinTokens -and $proof.OfficialSaveClicked -and $proof.PersistedInProfile -and $proof.RestartReadback
    if (-not $proof.Complete) { throw 'Desktop candidate validation has incomplete required gates.' }
    Set-ProbeStage 'All candidate install, UI save, persistence, and restart gates passed'
    $exitCode = 0
} catch {
    $message = $_.Exception.Message
    "Stage: $stage`n$($message.Substring(0, [Math]::Min($message.Length, 1600)))" | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'desktop-failure.txt')
} finally {
    # UIA is bounded supplemental evidence; it can never satisfy the candidate gates.
    try {
        if ($process -and -not $process.HasExited) {
            $process.Refresh()
            $proof.Alive = -not $process.HasExited
            $proof.NativeWindow = $process.MainWindowHandle -ne [IntPtr]::Zero
            $proof.SessionId = $process.SessionId
            if ($proof.NativeWindow) {
                $legacyShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
                $uia = Start-Process -FilePath $legacyShell -ArgumentList @(
                    '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
                    '-File', "`"$(Join-Path $PSScriptRoot 'uia.ps1')`"",
                    '-WindowHandle', $process.MainWindowHandle.ToInt64(), '-AppProcess', $process.Id
                ) -RedirectStandardOutput (Join-Path $PSScriptRoot 'uia-diagnostic.txt') -RedirectStandardError (Join-Path $PSScriptRoot 'uia-error.txt') -PassThru
                $ownedProcesses.Add($uia)
                if (-not $uia.WaitForExit(15000)) { Write-Host "Desktop probe: UIA diagnostic PID $($uia.Id) timed out; cleaning up." }
            }
        }
    } catch { Write-Host 'Desktop probe: supplemental UIA diagnostic unavailable.' }
    try { Stop-OwnedProcesses } catch {
        $exitCode = 1
        $proof.Complete = $false
        'Owned-process cleanup failed.' | Add-Content -LiteralPath (Join-Path $PSScriptRoot 'desktop-failure.txt')
    }
    $proof.Stage = $stage
    $proof | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'desktop-proof.json')
}
exit $exitCode
