$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This probe requires a disposable GitHub Actions VM.' }
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
    $child = Start-Process -FilePath $pwsh -ArgumentList $command -Credential ([pscredential]::new($account,$password)) -LoadUserProfile -WorkingDirectory $root -PassThru
    if (-not $child.WaitForExit(300000)) {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $child.Id /T /F 2>$null | Out-Null
        throw 'Standard-user Desktop probe timed out.'
    }
    foreach ($f in @('desktop-env-proof.json','desktop-proof.json','cdp-proof.json','plugin-manager-proof.json','plugin-install-proof.json','uia-diagnostic.txt','desktop-failure.txt')) {
        $p = Join-Path $root $f
        if (Test-Path -LiteralPath $p) { Get-Content -LiteralPath $p -TotalCount 32 }
    }
    if ($child.ExitCode -ne 0) { throw "Standard-user Desktop probe exited $($child.ExitCode)." }
} finally {
    Remove-LocalUser -Name $name -ErrorAction SilentlyContinue
}
