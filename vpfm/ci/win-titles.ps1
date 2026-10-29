# List the visible top-level windows of VPFM processes, or close the main window (-CloseMain).
# Used by the CI trial run of the multi-window feature. ASCII only.
param([switch]$CloseMain)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class VpfmWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static List<KeyValuePair<IntPtr, string>> List(HashSet<uint> pids) {
    var r = new List<KeyValuePair<IntPtr, string>>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (pids.Contains(p) && IsWindowVisible(h)) {
        var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
        if (sb.Length > 0) r.Add(new KeyValuePair<IntPtr, string>(h, sb.ToString()));
      }
      return true;
    }, IntPtr.Zero);
    return r;
  }
}
"@
$pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
Get-Process VPFM -ErrorAction SilentlyContinue | ForEach-Object { [void]$pids.Add([uint32]$_.Id) }
$wins = [VpfmWin]::List($pids)
if ($CloseMain) {
  $main = $wins | Where-Object { $_.Value -eq 'VPFM' } | Select-Object -First 1
  if (-not $main) { $main = $wins | Select-Object -First 1 }
  if ($main) { [void][VpfmWin]::PostMessage($main.Key, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); "closed: $($main.Value)" } else { "no window" }
} else {
  $wins | ForEach-Object { $_.Value }
}
