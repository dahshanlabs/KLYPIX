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

Start-Sleep -Seconds 3
$hwnd = [WinTest]::GetForegroundWindow()

function PrintTree($el, $depth) {
    if ($depth -gt 3) { return }
    $indent = "".PadLeft($depth * 2)
    $controlType = $el.Current.ControlType.ProgrammaticName
    $name = $el.Current.Name
    $val = ""
    $patternObj = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$patternObj)) {
        $val = " Value: '" + $patternObj.Current.Value + "'"
    }
    Write-Output "$indent- $($controlType) '$($name)'$($val)"
    
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $child = $walker.GetFirstChild($el)
    while ($child -ne $null) {
        PrintTree $child ($depth + 1)
        $child = $walker.GetNextSibling($child)
    }
}

$windowElement = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
PrintTree $windowElement 0
