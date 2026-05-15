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

if ($hwnd -ne [IntPtr]::Zero) {
    try {
        $windowElement = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
        $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
        $editEl = $windowElement.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
        if ($editEl) {
            $patternObj = $null
            if ($editEl.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$patternObj)) {
                Write-Output $patternObj.Current.Value
            } else {
                Write-Output "No ValuePattern"
            }
        } else {
            Write-Output "No Edit control found"
        }
    } catch {
        Write-Output "Error: $_"
    }
}
