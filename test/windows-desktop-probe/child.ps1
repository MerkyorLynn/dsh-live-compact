$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$process = $null
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($identity.User.Value -ne (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'expected-sid.txt')).Trim() -or
        $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Expected the standard test account.' }
    $installer = Join-Path $PSScriptRoot 'dsh-0.2.2-rc.1.exe'
    if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne '830947F8996DC05D991CA9133FFF4D3400073E47B9CFA6507754867E79482B23') {
        throw 'Installer hash mismatch before execution.'
    }
    $install = Start-Process -FilePath $installer -ArgumentList '/S' -PassThru
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
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $process = Start-Process -FilePath $app.FullName -ArgumentList @("--remote-debugging-port=$port","--remote-debugging-address=127.0.0.1","--force-renderer-accessibility") -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(75)
    $page = $null
    do {
        Start-Sleep -Seconds 2
        if ($process.HasExited) { break }
        try {
            $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 2
            $page = @($targets | Where-Object { $_.type -eq 'page' -and $_.webSocketDebuggerUrl -and $_.title }) | Select-Object -First 1
        } catch {}
    } until ($page -or [DateTime]::UtcNow -gt $deadline)
    $process.Refresh()
    $automation = $false
    if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
        $legacyShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
        & $legacyShell -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'uia.ps1') -WindowHandle $process.MainWindowHandle.ToInt64() -AppProcess $process.Id
        $automation = $LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'uia-proof.json'))
    }
    [pscustomobject]@{
        StandardUser = $true
        InstallerExitCode = $installCode
        LaunchMode = $launchMode
        SignedInstallerVersion = '0.2.2-rc.1'
        DesktopExecutableVersion = $version
        Alive = -not $process.HasExited
        NativeWindow = $process.MainWindowHandle -ne [IntPtr]::Zero
        AutomationPage = [bool]$page
        WindowsAutomation = $automation
    } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'desktop-proof.json')
    if (-not $page -and -not $automation) { throw 'DESKTOP_AUTOMATION_BLOCKED: neither CDP nor native UI Automation could read the official window.' }
} catch {
    $_.Exception.Message | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'desktop-failure.txt')
    exit 1
} finally {
    if ($process -and -not $process.HasExited) {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F 2>$null | Out-Null
    }
}
