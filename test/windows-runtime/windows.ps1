$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Requires a disposable GitHub Actions VM.' }
if ($env:GITHUB_REF -ne 'refs/heads/validation/112-windows-runtime') { throw 'Wrong validation branch.' }
$root = Join-Path "$($env:SystemDrive)\" ('dsh112-runtime-' + [Guid]::NewGuid().ToString('N'))
$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
if (-not $node) { throw 'Could not resolve the pinned Node application.' }
$accountName = 'dshRt' + [Guid]::NewGuid().ToString('N').Substring(0,8)
$user = $null
$child = $null
function Set-TestAcl([string]$Path, [string]$Sid, [bool]$ReadOnly) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $admin = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $acl.SetOwner($admin)
    foreach ($entry in @(@('S-1-5-18','FullControl'), @('S-1-5-32-544','FullControl'), @($Sid, $(if ($ReadOnly) { 'ReadAndExecute' } else { 'Modify' })))) {
        $identity = [Security.Principal.SecurityIdentifier]::new($entry[0])
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, [Security.AccessControl.FileSystemRights]$entry[1], 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}
try {
    New-Item -ItemType Directory -Path $root | Out-Null
    # Disposable local account password only: never a service/repository credential.
    $bytes = [byte[]]::new(24)
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $password = ConvertTo-SecureString (([Convert]::ToBase64String($bytes)) + 'Aa1!') -AsPlainText -Force
    $user = New-LocalUser -Name $accountName -Password $password -AccountNeverExpires
    $account = "$($env:COMPUTERNAME)\$accountName"
    $group = Get-LocalGroup -SID 'S-1-5-32-545'
    if (-not (Get-LocalGroupMember -Group $group.Name | Where-Object SID -eq $user.SID)) { Add-LocalGroupMember -Group $group.Name -Member $account }
    if (Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object SID -eq $user.SID) { throw 'Test user is an administrator.' }
    Set-TestAcl $root $user.SID.Value $false
    $work = Join-Path $root 'work'
    $run = Join-Path $root 'run'
    New-Item -ItemType Directory -Path $work,$run | Out-Null
    $repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    # Copy the exact bounded candidate source set plus only this disposable harness.
    $pin = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'candidate.json') -Raw | ConvertFrom-Json
    foreach ($file in $pin.files) {
        $target = Join-Path $work $file.path
        New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $repo $file.path) -Destination $target
    }
    $harness = Join-Path $work 'test\windows-runtime'
    New-Item -ItemType Directory -Path $harness -Force | Out-Null
    foreach ($file in @('common.mjs','scenario.mjs','verify.mjs','run.mjs','observe.mjs','network-guard.mjs','fixture.mjs','candidate.json')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $harness }
    New-Item -ItemType Directory -Path (Join-Path $harness 'fixtures') | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "fixtures\$($pin.filename)") -Destination (Join-Path $harness 'fixtures')
    $nativeFixtures = Join-Path $work 'test\fixtures'
    New-Item -ItemType Directory -Path $nativeFixtures -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repo 'test\issue-27.mjs') -Destination (Join-Path $work 'test')
    Copy-Item -LiteralPath (Join-Path $repo 'test\fixtures\issue-27-worker.mjs') -Destination $nativeFixtures
    $denied = Join-Path $run 'denied-shadow'
    New-Item -ItemType Directory -Path $denied | Out-Null
    Set-TestAcl $denied $user.SID.Value $true
    $denialAcl = Get-Acl -LiteralPath $denied
    if (-not $denialAcl.AreAccessRulesProtected -or $denialAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544') { throw 'Denial ACL owner/protection precondition failed.' }
    $user.SID.Value | Set-Content -LiteralPath (Join-Path $run 'expected-sid.txt') -Encoding utf8NoBOM
    Write-Host "CANDIDATE_SHA256 $($pin.sha256)"
    Write-Host "INDEX_SHA256 $(($pin.files | Where-Object path -eq 'index.js').sha256)"
    Write-Host "SHADOW_SHA256 $(($pin.files | Where-Object path -eq 'shadow.js').sha256)"
    $runtime = Join-Path $run 'runtime'
    New-Item -ItemType Directory -Path $runtime | Out-Null
    '{"name":"disposable-dsh112-runtime","private":true,"type":"module"}' | Set-Content -LiteralPath (Join-Path $runtime 'package.json') -Encoding utf8NoBOM
    $npm = Join-Path (Split-Path $node -Parent) 'node_modules\npm\bin\npm-cli.js'
    $npmUserConfig = Join-Path $root 'empty-user.npmrc'
    $npmGlobalConfig = Join-Path $root 'empty-global.npmrc'
    '' | Set-Content -LiteralPath $npmUserConfig -Encoding utf8NoBOM
    '' | Set-Content -LiteralPath $npmGlobalConfig -Encoding utf8NoBOM
    $setupOut = Join-Path $root 'runtime-setup.stdout.log'
    $setupErr = Join-Path $root 'runtime-setup.stderr.log'
    $dshVersion = $env:DSH_VERIFY_VERSION
    if ($dshVersion -notin @('0.2.0-rc.2','0.2.1-rc.2')) { throw 'Unexpected DSH version for the native probe.' }
    Write-Host "PINNED_DSH_VERSION $dshVersion"
    $install = "`"$npm`" install --ignore-scripts --save-exact --no-audit --no-fund --prefer-offline --fetch-retries=0 --fetch-timeout=30000 --registry=https://registry.npmjs.org/ --userconfig=`"$npmUserConfig`" --globalconfig=`"$npmGlobalConfig`" @deepseek-ai/dsh@$dshVersion @deepseek-ai/dsh-llm-replay@$dshVersion pnpm@11.7.0"
    $setup = Start-Process -FilePath $node -ArgumentList $install -WorkingDirectory $runtime -RedirectStandardOutput $setupOut -RedirectStandardError $setupErr -PassThru
    $setupDeadline = [DateTime]::UtcNow.AddMinutes(12)
    while (-not $setup.WaitForExit(20000)) {
        Write-Host "RUNNING PID $($setup.Id); preinstalling pinned official runtime dependencies"
        if ([DateTime]::UtcNow -gt $setupDeadline) {
            & "$env:SystemRoot\System32\taskkill.exe" /PID $setup.Id /T /F | Out-Null
            if (Test-Path -LiteralPath $setupOut) { Get-Content -LiteralPath $setupOut -Tail 10 }
            if (Test-Path -LiteralPath $setupErr) { Get-Content -LiteralPath $setupErr -Tail 12 }
            throw 'Official runtime setup timed out.'
        }
    }
    Get-Content -LiteralPath $setupOut -Tail 10
    if ($setup.ExitCode -ne 0) { Get-Content -LiteralPath $setupErr -Tail 20; throw "Official runtime setup exited $($setup.ExitCode)." }
    $stdoutFile = Join-Path $root 'standard-user.stdout.log'
    $stderrFile = Join-Path $root 'standard-user.stderr.log'
    $arguments = @((Join-Path $harness 'run.mjs'), '--root', $run)
    $child = Start-Process -FilePath $node -ArgumentList $arguments -Credential ([pscredential]::new($account,$password)) -LoadUserProfile -WorkingDirectory $work -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile -PassThru
    Write-Host "STANDARD_USER_PID $($child.Id)"
    $deadline = [DateTime]::UtcNow.AddMinutes(12)
    while (-not $child.WaitForExit(20000)) {
        Write-Host "RUNNING PID $($child.Id); awaiting bounded install / four runtime stage results"
        if ([DateTime]::UtcNow -gt $deadline) { & "$env:SystemRoot\System32\taskkill.exe" /PID $child.Id /T /F | Out-Null; throw 'Standard-user runtime probe timed out.' }
    }
    if (Test-Path -LiteralPath $stdoutFile) { Get-Content -LiteralPath $stdoutFile -Tail 30 }
    if (Test-Path -LiteralPath $stderrFile) { Get-Content -LiteralPath $stderrFile -Tail 20 }
    $resultFile = Join-Path $run 'result.json'
    if (-not (Test-Path -LiteralPath $resultFile)) { throw 'Runtime did not save result.json.' }
    $result = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
    if ($child.ExitCode -ne 0 -or $result.status -ne 'PASS') {
        $failed = $result.stages.PSObject.Properties | Where-Object { $_.Value.status -eq 'FAIL' } | Select-Object -First 1
        if ($failed -and $failed.Name -in @('install','plugin-install','fixture','before','denied','new-session','restart','native-rotation')) {
            $log = Join-Path $run "$($failed.Name).stderr.log"
            if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Tail 24 }
        }
        throw "Runtime probe failed: exit=$($child.ExitCode), status=$($result.status)"
    }
    foreach ($stage in @('before','denied','new-session','restart','native-rotation')) {
        if ($result.stages.$stage.status -ne 'PASS') { throw "Missing stage PASS: $stage" }
    }
} finally {
    # Save synthetic evidence before removing account and disposable VM data.
    $evidence = Join-Path $PSScriptRoot '.local\windows-evidence'
    if (Test-Path -LiteralPath $evidence) { Remove-Item -LiteralPath $evidence -Recurse -Force }
    New-Item -ItemType Directory -Path $evidence -Force | Out-Null
    if (Test-Path -LiteralPath (Join-Path $root 'run')) {
        Get-ChildItem -LiteralPath (Join-Path $root 'run') -File | Where-Object { $_.Name -match '\.(json|jsonl|log)$' } | Copy-Item -Destination $evidence
    }
    if ($child -and -not $child.HasExited) { & "$env:SystemRoot\System32\taskkill.exe" /PID $child.Id /T /F | Out-Null }
    if ($user) { Remove-LocalUser -Name $accountName -ErrorAction SilentlyContinue }
    if ($user) { Get-CimInstance -ClassName Win32_UserProfile -Filter "SID='$($user.SID.Value)'" -ErrorAction SilentlyContinue | Remove-CimInstance -ErrorAction Continue }
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Continue }
}
