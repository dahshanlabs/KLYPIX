Add-Type @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}
public class Win32 {
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
}
"@

$proc = Get-Process -Name "electron" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq "ALT+Space" } | Select-Object -First 1
if ($proc) {
    $rect = New-Object RECT
    if ([Win32]::GetWindowRect($proc.MainWindowHandle, [ref]$rect)) {
        $width = $rect.Right - $rect.Left
        $height = $rect.Bottom - $rect.Top
        Write-Output "Window: $($proc.MainWindowTitle)"
        Write-Output "Size: ${width}x${height}"
        Write-Output "Pos: $($rect.Left),$($rect.Top)"
    } else {
        Write-Error "Failed to get window rect"
    }
} else {
    Write-Error "ALT+Space process not found"
}
