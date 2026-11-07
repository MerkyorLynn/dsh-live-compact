$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This probe requires a disposable GitHub Actions VM.' }
$root = Join-Path "$($env:SystemDrive)\" "dsh112-acl-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)"
New-Item -ItemType Directory -Path $root | Out-Null
$node = (Get-Command node.exe -CommandType Application).Source
$gitRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Copy-Item -LiteralPath (Join-Path $gitRoot 'shadow.js') -Destination $root
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'probe.mjs') -Destination $root
'{"type":"module"}' | Set-Content -LiteralPath (Join-Path $root 'package.json')
'positive control' | Set-Content -LiteralPath (Join-Path $root 'control.txt')
$accounts = @()
try {
    $group = Get-LocalGroup -SID 'S-1-5-32-545'
    foreach ($role in @('writer','reader')) {
        $name = 'dshAcl' + [Guid]::NewGuid().ToString('N').Substring(0,8)
        $bytes = [byte[]]::new(24)
        [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
        $password = ConvertTo-SecureString (([Convert]::ToBase64String($bytes)) + 'Aa1!') -AsPlainText -Force
        $user = New-LocalUser -Name $name -Password $password -AccountNeverExpires
        $accounts += $name
        $account = "$($env:COMPUTERNAME)\$name"
        if (-not (Get-LocalGroupMember -Group $group.Name | Where-Object SID -eq $user.SID)) {
            Add-LocalGroupMember -Group $group.Name -Member $account
        }
        & "$env:SystemRoot\System32\icacls.exe" $root /grant:r "*$($user.SID.Value):(OI)(CI)M" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Unable to grant probe directory access for $role." }
        $argsForChild = "probe.mjs $role $root $($user.SID.Value)"
        $child = Start-Process -FilePath $node -ArgumentList $argsForChild -Credential ([pscredential]::new($account,$password)) -LoadUserProfile -WorkingDirectory $root -PassThru
        if (-not $child.WaitForExit(120000)) { $child.Kill(); throw "$role timed out." }
        if ($child.ExitCode -ne 0) { throw "$role exited $($child.ExitCode)." }
        Get-Content -LiteralPath (Join-Path $root "$role-proof.json")
    }
    $reader = Get-Content -LiteralPath (Join-Path $root 'reader-proof.json') -Raw | ConvertFrom-Json
    if ($reader.readerRead) { throw 'BASELINE_ACL_LEAK: another standard user read the synthetic backup.' }
} finally {
    foreach ($name in $accounts) { Remove-LocalUser -Name $name -ErrorAction SilentlyContinue }
}
