Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$getForeground = @'
using System;
using System.Runtime.InteropServices;
public class WinTest {
   [DllImport("user32.dll")]
   public static extern IntPtr GetForegroundWindow();
}
'@
Add-Type -TypeDefinition $getForeground
$hwnd = [WinTest]::GetForegroundWindow()

$sw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $windowElement = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
    $editEls = $windowElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    foreach ($editEl in $editEls) {
        $patternObj = $null
        if ($editEl.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$patternObj)) {
            Write-Output "Found: $($patternObj.Current.Value)"
        }
    }
}
catch { }
Write-Output "Time: $($sw.ElapsedMilliseconds)ms"
