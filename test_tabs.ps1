Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$chrome = Get-Process Chrome -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1
if (!$chrome) { exit }

$root = [System.Windows.Automation.AutomationElement]::FromHandle($chrome.MainWindowHandle)
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)

Write-Host "Searching tabs in Chrome PID $($chrome.Id)..."
$tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)

foreach ($t in $tabs) {
    Write-Output $t.Current.Name
}
