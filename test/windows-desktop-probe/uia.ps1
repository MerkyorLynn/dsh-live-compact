param([long]$WindowHandle, [int]$AppProcess)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$window = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new($WindowHandle))
if ($window.Current.ProcessId -ne $AppProcess) { throw 'UI Automation attached to the wrong process.' }
$children = $window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
$types = @{}
foreach ($child in $children) {
    $type = $child.Current.ControlType.ProgrammaticName
    $types[$type] = 1 + [int]$types[$type]
}
if ($children.Count -lt 2 -or (-not $types['ControlType.Document'] -and -not $types['ControlType.Button'])) {
    throw 'No accessible application controls in the official Desktop window.'
}
[pscustomobject]@{
    UIAutomation = $true
    ControlCount = $children.Count
    ControlTypes = $types
} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'uia-proof.json')
