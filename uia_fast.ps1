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

if ($hwnd -eq [IntPtr]::Zero) { exit }

$windowElement = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function FindUrl($el, $depth) {
    if ($depth -gt 10) { return $null }
    
    $ctrlType = $el.Current.ControlType
    $name = $el.Current.Name
    
    # Do not traverse into the actual web page DOM!
    if ($ctrlType -eq [System.Windows.Automation.ControlType]::Document) { return $null }
    if ($name -match "Chrome Legacy Window") { return $null }
    
    if ($ctrlType -eq [System.Windows.Automation.ControlType]::Edit) {
        $patternObj = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$patternObj)) {
            $val = $patternObj.Current.Value
            # Basic heuristic: if it looks like a URL or starts with www/http, return it.
            # Even if it's just "google.com", we can prefix http:// later.
            if ($val -notmatch "\s" -or $val -match "^https?://") {
                return $val
            }
        }
    }
    
    $child = $walker.GetFirstChild($el)
    while ($child -ne $null) {
        $res = FindUrl $child ($depth + 1)
        if ($res) { return $res }
        $child = $walker.GetNextSibling($child)
    }
    
    return $null
}

$url = FindUrl $windowElement 0

if ($url) {
    if ($url -notmatch "^https?://") { $url = "https://" + $url }
    Write-Output $url
}
