param([string]$Match = "LINUX DO")

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinApi {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string win);

  public static List<string> ListWindows() {
    var result = new List<string>();
    EnumWindows((hWnd, lParam) => {
      var sb = new StringBuilder(512);
      GetWindowText(hWnd, sb, sb.Capacity);
      string title = sb.ToString();
      if (title.Length > 0) {
        result.Add(hWnd.ToInt64() + "|" + IsWindowVisible(hWnd) + "|" + IsIconic(hWnd) + "|" + title);
      }
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
"@

$windows = [WinApi]::ListWindows()
Write-Output "--- top-level windows with titles ---"
$windows | ForEach-Object { $_ }

$target = $windows | Where-Object { $_ -match $Match } | Select-Object -First 1
if (-not $target) {
  Write-Output "NO_MATCH: no window title contains '$Match'"
  exit 1
}

$parts = $target -split '\|', 4
$handle = [IntPtr][int64]$parts[0]
Write-Output "FOUND handle=$handle visible=$($parts[1]) minimized=$($parts[2]) title=$($parts[3])"

[WinApi]::ShowWindow($handle, 9) | Out-Null
[WinApi]::BringWindowToTop($handle) | Out-Null
$ok = [WinApi]::SetForegroundWindow($handle)
Write-Output "SetForegroundWindow=$ok"