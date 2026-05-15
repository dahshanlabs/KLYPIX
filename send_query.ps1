$text = "Explain the history of the internet briefly."
Add-Type -AssemblyName System.Windows.Forms
$windowTitle = "ALT+Space"
$proc = Get-Process -Name "electron" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq $windowTitle } | Select-Object -First 1

if ($proc) {
    # Focus window
    $wshell = New-Object -ComObject WScript.Shell
    $wshell.AppActivate($proc.Id)
    Start-Sleep -Milliseconds 500
    
    # Type text and press enter
    [System.Windows.Forms.SendKeys]::SendWait($text)
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
} else {
    Write-Error "ALT+Space process not found"
}
