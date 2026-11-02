param([string]$Match = "LINUX DO")

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinShow {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

  public static IntPtr Find(string match) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hWnd, lParam) => {
      var sb = new StringBuilder(512);
      GetWindowText(hWnd, sb, sb.Capacity);
      if (sb.ToString().Contains(match)) { found = hWnd; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

$hwnd = [WinShow]::Find($Match)
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "NO_WINDOW"; exit 1 }

Write-Output "before: visible=$([WinShow]::IsWindowVisible($hwnd))"

[WinShow]::ShowWindowAsync($hwnd, 1) | Out-Null
Start-Sleep -Milliseconds 300
[WinShow]::ShowWindow($hwnd, 5) | Out-Null
Start-Sleep -Milliseconds 300
Write-Output "after show: visible=$([WinShow]::IsWindowVisible($hwnd))"

[WinShow]::SetWindowPos($hwnd, [IntPtr]::new(-1), 0, 0, 0, 0, 0x0043) | Out-Null
Start-Sleep -Milliseconds 200
[WinShow]::SetWindowPos($hwnd, [IntPtr]::new(-2), 0, 0, 0, 0, 0x0003) | Out-Null

$fgThread = [WinShow]::GetWindowThreadProcessId([WinShow]::GetForegroundWindow(), [IntPtr]::Zero)
$targetThread = [WinShow]::GetWindowThreadProcessId($hwnd, [IntPtr]::Zero)
[WinShow]::AttachThreadInput($fgThread, $targetThread, $true) | Out-Null
$fgResult = [WinShow]::SetForegroundWindow($hwnd)
[WinShow]::AttachThreadInput($fgThread, $targetThread, $false) | Out-Null
[WinShow]::BringWindowToTop($hwnd) | Out-Null
Write-Output "SetForegroundWindow=$fgResult"
Write-Output "final: visible=$([WinShow]::IsWindowVisible($hwnd))"