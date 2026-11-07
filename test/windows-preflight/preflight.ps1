$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This probe requires a disposable GitHub Actions VM.' }
$os = Get-CimInstance Win32_OperatingSystem
[pscustomobject]@{
    OS = $os.Caption
    Build = $os.BuildNumber
    ProductType = $os.ProductType
    Architecture = $env:RUNNER_ARCH
    ImageVersion = $env:ImageVersion
} | ConvertTo-Json -Compress
if ($env:RUNNER_ARCH -eq 'ARM64' -and ($os.ProductType -ne 1 -or $os.Caption -notmatch 'Windows 11')) {
    throw 'ARM runner did not report Windows 11.'
}
$root = Join-Path "$($env:SystemDrive)\" "dsh112-preflight-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)"
New-Item -ItemType Directory -Path $root | Out-Null
$name = 'dshGate' + [Guid]::NewGuid().ToString('N').Substring(0,8)
$bytes = [byte[]]::new(24)
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$password = ConvertTo-SecureString (([Convert]::ToBase64String($bytes)) + 'Aa1!') -AsPlainText -Force
$user = New-LocalUser -Name $name -Password $password -AccountNeverExpires
try {
    $usersGroup = Get-LocalGroup -SID 'S-1-5-32-545'
    $account = "$($env:COMPUTERNAME)\$name"
    if (-not (Get-LocalGroupMember -Group $usersGroup.Name | Where-Object SID -eq $user.SID)) {
        Add-LocalGroupMember -Group $usersGroup.Name -Member $account
    }
    & "$env:SystemRoot\System32\icacls.exe" $root /grant:r "*$($user.SID.Value):(OI)(CI)M" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Unable to grant the standard user access to its test folder.' }
    Set-Content -LiteralPath (Join-Path $root 'expected-sid.txt') -Value $user.SID.Value
    $childScript = Join-Path $root 'ordinary-user.ps1'
    @'
$ErrorActionPreference = 'Stop'
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $expected = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'expected-sid.txt')).Trim()
    if ($identity.User.Value -ne $expected) { throw 'The child ran as a different user.' }
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'The child is an administrator.' }
    $whoami = "$env:SystemRoot\System32\whoami.exe"
    $groups = (& $whoami /groups) -join "`n"
    $privileges = (& $whoami /priv) -join "`n"
    if ($groups -notmatch 'S-1-16-8192' -or $groups -match 'S-1-5-32-544') { throw 'Expected a medium-integrity standard token.' }
    if ($privileges -match 'SeBackupPrivilege|SeRestorePrivilege|SeTakeOwnershipPrivilege') { throw 'Unexpected privileged token.' }
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($PSScriptRoot))
    if ($drive.DriveFormat -ne 'NTFS') { throw 'Expected NTFS.' }
    $probe = Join-Path $PSScriptRoot 'ordinary-user-directory'
    New-Item -ItemType Directory -Path $probe | Out-Null
    Set-Content -LiteralPath (Join-Path $probe 'probe.txt') -Value 'owned and writable'
    [pscustomobject]@{ StandardUser = $true; Sid = $identity.User.Value; Integrity = 'Medium'; FileSystem = $drive.DriveFormat } |
        ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'ordinary-result.json')
    exit 0
} catch {
    $_.Exception.Message | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'ordinary-failure.txt')
    exit 1
}
'@ | Set-Content -LiteralPath $childScript
    $credential = [pscredential]::new($account, $password)
    $powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $argsForChild = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$childScript`""
    $child = Start-Process -FilePath $powerShell -ArgumentList $argsForChild -Credential $credential -LoadUserProfile -WorkingDirectory $root -PassThru
    if (-not $child.WaitForExit(120000)) { $child.Kill(); throw 'Standard-user token probe timed out.' }
    if ($child.ExitCode -ne 0) {
        $failure = Join-Path $root 'ordinary-failure.txt'
        if (Test-Path -LiteralPath $failure) { Write-Host (Get-Content -LiteralPath $failure -Raw) }
        throw "Standard-user probe failed with exit code $($child.ExitCode)."
    }
    Get-Content -LiteralPath (Join-Path $root 'ordinary-result.json')
    $installer = Join-Path $root 'deepseek-harness-0.2.2-rc.1-win-x64.exe'
    $url = 'https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe'
    $head = Invoke-WebRequest -Uri $url -Method Head -TimeoutSec 30
    if ([string]$head.Headers['Content-Disposition'] -notmatch 'deepseek-harness-0\.2\.2-rc\.1-win-x64\.exe') {
        throw 'The official endpoint no longer serves the preflight version.'
    }
    $etag = '"ecd1d9880f68ec91a63b4936163bfc44"'
    if ([string]$head.Headers['ETag'] -ne $etag) { throw 'The official installer ETag changed.' }
    Invoke-WebRequest -Uri $url -Headers @{'If-Match' = $etag} -OutFile $installer -TimeoutSec 240
    $signature = Get-AuthenticodeSignature -FilePath $installer
    $file = Get-Item -LiteralPath $installer
    if ($file.Length -ne 293425336) { throw 'The downloaded installer has an unexpected size.' }
    [pscustomobject]@{
        OfficialInstaller = $file.Name
        Bytes = $file.Length
        SHA256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
        Signature = $signature.Status.ToString()
        Signer = $signature.SignerCertificate.Subject
        ProductVersion = $file.VersionInfo.ProductVersion
    } | ConvertTo-Json -Compress
    if ($signature.Status -ne 'Valid') { throw 'Official Desktop installer signature did not validate.' }
} finally {
    Remove-LocalUser -Name $name -ErrorAction SilentlyContinue
}
