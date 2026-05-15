Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(850, 410)
# Note: coordinates might need adjustment based on DPI and actual layout.
# Let's try to click.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class UI {
    [DllImport("user32.dll")]
    public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
}
"@
# MOUSEEVENTF_LEFTDOWN = 0x02, MOUSEEVENTF_LEFTUP = 0x04
[UI]::mouse_event(0x02, 0, 0, 0, 0)
Start-Sleep -Milliseconds 100
[UI]::mouse_event(0x04, 0, 0, 0, 0)
