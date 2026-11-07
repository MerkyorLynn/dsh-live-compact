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
    if ($install.ExitCode -ne 0) { throw "Desktop installer exited $($install.ExitCode)." }
    $programs = Join-Path $env:LOCALAPPDATA 'Programs'
    $app = Get-ChildItem -LiteralPath $programs -Filter 'DeepSeek Harness.exe' -Recurse -File | Select-Object -First 1
    if (-not $app) { throw 'Per-user Desktop executable was not found.' }
    $version = $app.VersionInfo.ProductVersion
    if ($version -notmatch '^0\.2\.2-rc\.1(?:$|\s)') { throw "Unexpected installed version $version." }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $process = Start-Process -FilePath $app.FullName -ArgumentList @("--remote-debugging-port=$port","--remote-debugging-address=127.0.0.1") -PassThru
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
    [pscustomobject]@{
        StandardUser = $true
        DesktopVersion = $version
        Alive = -not $process.HasExited
        NativeWindow = $process.MainWindowHandle -ne [IntPtr]::Zero
        AutomationPage = [bool]$page
    } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'desktop-proof.json')
    if (-not $page) { throw 'DESKTOP_AUTOMATION_BLOCKED: no authentic renderer page available to the ordinary account.' }
} catch {
    $_.Exception.Message | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'desktop-failure.txt')
    exit 1
} finally {
    if ($process -and -not $process.HasExited) {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F 2>$null | Out-Null
    }
}
