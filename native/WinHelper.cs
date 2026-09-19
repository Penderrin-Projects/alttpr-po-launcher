
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class WinHelper {
    delegate bool EnumWinProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWinProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool r);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT wp);

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] struct WINDOWPLACEMENT {
        public int length, flags, showCmd;
        public POINT minPos, maxPos;
        public RECT normalPos;
    }

    struct WinInfo { public string process; public string title; public int x, y, w, h; public bool minimized; }

    static List<IntPtr> GetAllHandles() {
        var list = new List<IntPtr>();
        EnumWindows((h, l) => { if (GetWindowTextLength(h) > 0) list.Add(h); return true; }, IntPtr.Zero);
        return list;
    }

    static Dictionary<int, string> GetTargetPids(string[] names) {
        var map = new Dictionary<int, string>();
        foreach (var name in names) {
            try {
                foreach (var p in Process.GetProcessesByName(name))
                    if (!map.ContainsKey(p.Id)) map[p.Id] = p.ProcessName;
            } catch {}
        }
        return map;
    }

    static string GetTitle(IntPtr h) {
        var sb = new StringBuilder(256);
        GetWindowText(h, sb, 256);
        return sb.ToString();
    }

    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    // MODE: capture — enumerate windows, output JSON
    static void Capture(string[] processNames) {
        var pids = GetTargetPids(processNames);
        var handles = GetAllHandles();
        var sb = new StringBuilder("[");
        bool first = true;
        foreach (var h in handles) {
            uint wpid; GetWindowThreadProcessId(h, out wpid);
            string pname;
            if (!pids.TryGetValue((int)wpid, out pname)) continue;
            var title = GetTitle(h);
            if (string.IsNullOrEmpty(title)) continue;
            var iconic = IsIconic(h);

            int x, y, w, ht;
            if (iconic) {
                // For minimized windows, use GetWindowPlacement to get the restore position
                var wp = new WINDOWPLACEMENT(); wp.length = Marshal.SizeOf(wp);
                GetWindowPlacement(h, ref wp);
                var r = wp.normalPos;
                x = r.L; y = r.T; w = r.R - r.L; ht = r.B - r.T;
            } else {
                // For visible windows, use GetWindowRect for actual screen position
                RECT r;
                GetWindowRect(h, out r);
                x = r.L; y = r.T; w = r.R - r.L; ht = r.B - r.T;
            }

            if (!first) sb.Append(","); first = false;
            sb.AppendFormat("{{\"process\":\"{0}\",\"title\":\"{1}\",\"x\":{2},\"y\":{3},\"width\":{4},\"height\":{5},\"minimized\":{6}}}",
                Esc(pname), Esc(title), x, y, w, ht, iconic ? "true" : "false");
        }
        sb.Append("]");
        Console.Write(sb.ToString());
    }

    // MODE: restore — poll for windows and restore them from JSON config
    // Two-pass matching: first exact title, then process-only for remaining
    static void Restore(string configPath) {
        var json = File.ReadAllText(configPath);
        var targets = ParseTargets(json);
        var restored = new bool[targets.Count];
        int restoredCount = 0;
        // Track which handles we've already matched so we don't double-match
        var matchedHandles = new HashSet<IntPtr>();
        var start = DateTime.Now;
        while (restoredCount < targets.Count && (DateTime.Now - start).TotalSeconds < 20) {
            var handles = GetAllHandles();
            var pids = GetTargetPids(GetAllProcessNames(targets));

            // Pass 1: exact title match (use substring for long titles)
            for (int i = 0; i < targets.Count; i++) {
                if (restored[i]) continue;
                var t = targets[i];
                // For BizHawk main window, match on "- BizHawk" suffix since ROM name changes
                // For Lua Console, match exactly
                string matchStr;
                if (t.title.Contains("- BizHawk") && !t.title.Contains("Lua Console")) {
                    matchStr = "- BizHawk";
                } else {
                    matchStr = t.title.Length > 30 ? t.title.Substring(0, 30) : t.title;
                }
                foreach (var h in handles) {
                    if (matchedHandles.Contains(h)) continue;
                    uint wpid; GetWindowThreadProcessId(h, out wpid);
                    string pname;
                    if (!pids.TryGetValue((int)wpid, out pname)) continue;
                    if (pname != t.process) continue;
                    var title = GetTitle(h);
                    if (title.IndexOf(matchStr) >= 0) {
                        // Extra check: if we're matching "- BizHawk" (main window), 
                        // exclude Lua Console which is also under EmuHawk process
                        if (matchStr == "- BizHawk" && title.Contains("Lua Console")) continue;
                        ApplyRestore(h, t);
                        restored[i] = true;
                        matchedHandles.Add(h);
                        restoredCount++;
                        break;
                    }
                }
            }

            // Pass 2: for still-unrestored targets, match any unmatched window
            // from the same process (catches Lua Console before title is set)
            for (int i = 0; i < targets.Count; i++) {
                if (restored[i]) continue;
                var t = targets[i];
                foreach (var h in handles) {
                    if (matchedHandles.Contains(h)) continue;
                    uint wpid; GetWindowThreadProcessId(h, out wpid);
                    string pname;
                    if (!pids.TryGetValue((int)wpid, out pname)) continue;
                    if (pname != t.process) continue;
                    var title = GetTitle(h);
                    // Must have a title and not be a junk window
                    if (string.IsNullOrEmpty(title)) continue;
                    if (title.Contains("Default IME") || title.Contains("MSCTFIME") ||
                        title.Contains("GDI+ Window") || title.Contains("NVOGLDC") ||
                        title.Contains("__wglDummy") || title.Contains(".NET-Broadcast")) continue;
                    // Skip tiny windows
                    var wp2 = new WINDOWPLACEMENT(); wp2.length = Marshal.SizeOf(wp2);
                    GetWindowPlacement(h, ref wp2);
                    var r2 = wp2.normalPos;
                    if ((r2.R - r2.L) < 50 && (r2.B - r2.T) < 50 && !IsIconic(h)) continue;

                    ApplyRestore(h, t);
                    restored[i] = true;
                    matchedHandles.Add(h);
                    restoredCount++;
                    break;
                }
            }

            if (restoredCount < targets.Count) {
                // Poll faster if remaining windows need to be minimized (hide ASAP)
                bool anyMinimized = false;
                for (int i = 0; i < targets.Count; i++)
                    if (!restored[i] && targets[i].minimized) { anyMinimized = true; break; }
                Thread.Sleep(anyMinimized ? 50 : 200);
            }
        }
    }

    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndAfter, int x, int y, int cx, int cy, uint flags);

    static void ApplyRestore(IntPtr h, WinInfo t) {
        if (t.process == "EmuHawk") {
            // BizHawk manages its own window positions.
            // For minimized windows (Lua Console), wait for form init to complete
            // by polling until the window title stabilizes (no longer placeholder),
            // then minimize before the Lua script starts blocking.
            if (t.minimized) {
                var initStart = DateTime.Now;
                while ((DateTime.Now - initStart).TotalSeconds < 5) {
                    var title = GetTitle(h);
                    // Title changes from placeholder to "Lua Console" when OnLoad completes
                    if (title.Contains("Lua Console")) break;
                    Thread.Sleep(50);
                }
                ShowWindow(h, 6);
            }
            // Non-minimized EmuHawk windows: skip entirely
            return;
        }
        if (t.minimized) {
            ShowWindow(h, 6);
        } else {
            ShowWindow(h, 9);
            MoveWindow(h, t.x, t.y, t.w, t.h, true);
        }
    }

    static string[] GetAllProcessNames(List<WinInfo> targets) {
        var set = new HashSet<string>();
        foreach (var t in targets) set.Add(t.process);
        var arr = new string[set.Count]; set.CopyTo(arr); return arr;
    }

    // Minimal JSON parser for our known format
    static List<WinInfo> ParseTargets(string json) {
        var list = new List<WinInfo>();
        int i = 0;
        while (i < json.Length) {
            int objStart = json.IndexOf('{', i);
            if (objStart < 0) break;
            int objEnd = json.IndexOf('}', objStart);
            if (objEnd < 0) break;
            var obj = json.Substring(objStart, objEnd - objStart + 1);
            var w = new WinInfo();
            w.process = ExtractStr(obj, "process");
            w.title = ExtractStr(obj, "title");
            w.x = ExtractInt(obj, "x");
            w.y = ExtractInt(obj, "y");
            w.w = ExtractInt(obj, "width");
            w.h = ExtractInt(obj, "height");
            w.minimized = obj.Contains("\"minimized\":true") || obj.Contains("\"minimized\": true");
            list.Add(w);
            i = objEnd + 1;
        }
        return list;
    }

    static string ExtractStr(string obj, string key) {
        var needle = "\"" + key + "\":\"";
        int s = obj.IndexOf(needle);
        if (s < 0) return "";
        s += needle.Length;
        int e = obj.IndexOf("\"", s);
        return e < 0 ? "" : obj.Substring(s, e - s);
    }

    static int ExtractInt(string obj, string key) {
        var needle = "\"" + key + "\":";
        int s = obj.IndexOf(needle);
        if (s < 0) return 0;
        s += needle.Length;
        var sb2 = new StringBuilder();
        while (s < obj.Length && (char.IsDigit(obj[s]) || obj[s] == '-')) { sb2.Append(obj[s]); s++; }
        int v; int.TryParse(sb2.ToString(), out v); return v;
    }

    static string Esc(string s) { return s.Replace("\\", "\\\\").Replace("\"", "\\\""); }

    // Three modes were removed here in 2.1 (launch-hidden, drop-file, hide-window). They were
    // abandoned experiments from the original build, never called by main.js since:
    //   launch-hidden / hide-window - attempts to hide SNI's console; dropped once SNI's own
    //                                 hide-console option was found.
    //   drop-file                   - loading Connector.lua into an already-positioned Lua Console
    //                                 (WM_DROPFILES, then SendKeys, then menu WM_COMMAND); dropped in
    //                                 favour of passing the script straight to --lua=.
    // They are in git history (native/WinHelper.cs before this commit) if ever wanted.

    [STAThread]
    static void Main(string[] args) {
        if (args.Length < 1) return;
        if (args[0] == "capture" && args.Length >= 2) {
            Capture(args[1].Split(','));
        } else if (args[0] == "restore" && args.Length >= 2) {
            Restore(args[1]);
        }
    }
}
