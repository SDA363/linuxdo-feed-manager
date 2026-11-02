param([string]$Match = "Example Domain")
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinCheck {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  public static List<string> ListWindows() {
    var result = new List<string>();
    EnumWindows((hWnd, lParam) => {
      var sb = new StringBuilder(512);
      GetWindowText(hWnd, sb, sb.Capacity);
      string title = sb.ToString();
      if (title.Length > 0) result.Add(IsWindowVisible(hWnd) + "|" + title);
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
"@
$windows = [WinCheck]::ListWindows()
$hits = $windows | Where-Object { $_ -match $Match }
if (-not $hits) { Write-Output "NOT_FOUND: '$Match'"; exit 1 }
$hits | ForEach-Object { Write-Output "MATCH: $_" }