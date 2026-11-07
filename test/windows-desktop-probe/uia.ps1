param([long]$WindowHandle, [int]$AppProcess)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$window = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new($WindowHandle))
if ($window.Current.ProcessId -ne $AppProcess) { throw 'UI Automation attached to the wrong process.' }
$root = $window.Current
[pscustomobject]@{
    RootClass = $root.ClassName
    RootType = $root.ControlType.ProgrammaticName
    Framework = $root.FrameworkId
    Offscreen = $root.IsOffscreen
    Width = $root.BoundingRectangle.Width
    Height = $root.BoundingRectangle.Height
} | ConvertTo-Json -Compress | Write-Output
$children = $window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
$types = @{}
foreach ($child in $children) {
    $type = $child.Current.ControlType.ProgrammaticName
    $types[$type] = 1 + [int]$types[$type]
}
[pscustomobject]@{ ControlCount = $children.Count; ControlTypes = $types } | ConvertTo-Json -Compress | Write-Output
if ($children.Count -lt 2 -or (-not $types['ControlType.Document'] -and -not $types['ControlType.Button'])) {
    throw 'No accessible application controls in the official Desktop window.'
}
[pscustomobject]@{
    UIAutomation = $true
    ControlCount = $children.Count
    ControlTypes = $types
} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'uia-proof.json')
