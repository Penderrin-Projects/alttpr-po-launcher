const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, execSync, spawn } = require('child_process');

// ============================================================
//  SETTINGS
// ============================================================
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'po-launcher-settings.json');
}

// Settings live in memory and are flushed to disk a moment after the last change.
//
// Why: the tracker window saves its bounds on every 'move'/'resize' event and the
// zoom on every step — dozens of times a second while dragging. Each of those used
// to be a synchronous read + parse + rewrite of the whole file, and the rewrite was
// not atomic. One interrupted write left a truncated file, loadSettings() then
// returned {}, and the next save replaced every path, layout and tracker preset
// with that empty object.
//
// Same API as before: loadSettings() returns the settings object, saveSettings(patch)
// shallow-merges a patch into it.
let settingsCache = null;
let settingsWriteTimer = null;
const SETTINGS_WRITE_DELAY_MS = 250;

function readSettingsFile(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('settings file is not a JSON object');
  }
  return parsed;
}

function loadSettings() {
  if (settingsCache) return settingsCache;
  const file = getSettingsPath();
  try {
    settingsCache = readSettingsFile(file);
  } catch (err) {
    // Missing file = first run. Anything else = damaged file: keep a copy of it
    // for inspection, then fall back to the last known-good backup.
    if (err.code !== 'ENOENT') {
      console.error('Settings file unreadable, trying backup:', err.message);
      try { fs.copyFileSync(file, file + '.corrupt'); } catch {}
    }
    try { settingsCache = readSettingsFile(file + '.bak'); }
    catch { settingsCache = {}; }
  }
  return settingsCache;
}

function saveSettings(settings) {
  settingsCache = { ...loadSettings(), ...settings };
  if (settingsWriteTimer) clearTimeout(settingsWriteTimer);
  settingsWriteTimer = setTimeout(flushSettings, SETTINGS_WRITE_DELAY_MS);
}

// Write the cache to disk now. Temp file + rename, so the real file is always
// either the old version or the new one — never half of one.
function flushSettings() {
  if (settingsWriteTimer) { clearTimeout(settingsWriteTimer); settingsWriteTimer = null; }
  if (!settingsCache) return;
  const file = getSettingsPath();
  const tmp = file + '.tmp';
  const data = JSON.stringify(settingsCache, null, 2);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, data, 'utf-8');
    // Only a file that still parses is allowed to become the backup.
    try { readSettingsFile(file); fs.copyFileSync(file, file + '.bak'); } catch {}
    try {
      fs.renameSync(tmp, file);
    } catch {
      // Rename can be refused if something (AV, indexer) has the file open.
      // Fall back to the old direct write rather than lose the save.
      fs.writeFileSync(file, data, 'utf-8');
      try { fs.unlinkSync(tmp); } catch {}
    }
  } catch (err) { console.error('Settings save error:', err); }
}

// ============================================================
//  WINDOWS
// ============================================================
let mainWindow = null;
let trackerWindow = null;
let settingsWindow = null;
let trackerContentDims = null;
let savedTrackerZoom = null;

// True if enough of the rectangle is on a connected display to grab and drag it.
function boundsAreVisible(b) {
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return false;
  return screen.getAllDisplays().some(d => {
    const a = d.workArea;
    const overlapW = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const overlapH = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
    return overlapW >= 100 && overlapH >= 50;
  });
}

// Saved tracker bounds, made safe to hand to a BrowserWindow.
// Position is dropped (size kept) when it points at a monitor that is no longer
// there, so the tracker can't open somewhere it can't be seen.
function getSafeTrackerBounds(saved) {
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return null;
  if (boundsAreVisible(saved)) return saved;
  return { width: saved.width, height: saved.height, x: undefined, y: undefined };
}

// Shared by both ways a tracker window gets created.
// A minimized window reports x/y of -32000 on Windows; saving that made the
// tracker reopen off-screen, so minimized state is never recorded.
function saveTrackerBounds() {
  if (!trackerWindow || trackerWindow.isDestroyed()) return;
  if (trackerWindow.isMinimized()) return;
  saveSettings({ trackerBounds: trackerWindow.getBounds() });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 480,
    minHeight: 600,
    resizable: true,
    frame: false,
    transparent: false,
    backgroundColor: '#0b1120',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  mainWindow.loadFile('renderer.html');
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ============================================================
//  TRACKER — Direct Launch
// ============================================================
function openTrackerWindow() {
  if (trackerWindow && !trackerWindow.isDestroyed()) {
    trackerWindow.focus();
    return 'open';
  }

  const settings = loadSettings();
  const query = settings.lastTrackerQuery;
  if (!query) {
    openSettingsWindow();
    return 'needs-setup';
  }

  const bounds = getSafeTrackerBounds(settings.trackerBounds);
  const parsedDims = parseTrackerDims(query);

  trackerWindow = new BrowserWindow({
    width: bounds ? bounds.width : (parsedDims.width + 16),
    height: bounds ? bounds.height : (parsedDims.height + 62),
    x: bounds ? bounds.x : undefined,
    y: bounds ? bounds.y : undefined,
    minWidth: 300,
    minHeight: 200,
    resizable: true,
    title: 'ALTTP Tracker',
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false,
    },
  });

  trackerContentDims = { width: parsedDims.width, height: parsedDims.height };
  trackerWindow.setMenuBarVisibility(false);

  const trackerUrl = `file://${path.join(__dirname, 'tracker', 'tracker.html').replace(/\\/g, '/')}?${query}&r=${Date.now()}`;
  trackerWindow.loadURL(trackerUrl);

  trackerWindow.on('resize', saveTrackerBounds);
  trackerWindow.on('move', saveTrackerBounds);
  trackerWindow.on('closed', () => { trackerWindow = null; });

  // Apply saved theme once page loads
  trackerWindow.webContents.on('did-finish-load', () => {
    const theme = loadSettings().theme || 'blue';
    trackerWindow.webContents.executeJavaScript(`if(typeof applyPoTheme==='function'){applyPoTheme('${theme}')}`).catch(() => {});
  });

  return 'open';
}

function parseTrackerDims(query) {
  const params = {};
  query.split('&').forEach(p => {
    const [k, v] = p.split('=');
    params[k] = v;
  });

  const d = params.d || '';
  const map = d.charAt(0);
  const sphere = d.charAt(3);
  const scale = d.charAt(5);

  let width = map === 'M' ? 1340 : 448;
  let height;
  if (map === 'V') { height = 1330; if (sphere === 'Y') width = 892; }
  else if (map === 'C') { height = sphere === 'Y' ? 988 : 692; }
  else { height = sphere === 'Y' ? 744 : 448; }

  switch (scale) {
    case 'D': width *= 2; height *= 2; break;
    case 'E': width *= 1.5; height *= 1.5; break;
    case 'F': break;
    case 'T': width *= 0.75; height *= 0.75; break;
    case 'H': width *= 0.5; height *= 0.5; break;
    case 'Q': width *= 0.25; height *= 0.25; break;
  }
  return { width: Math.ceil(width), height: Math.ceil(height) };
}

// ============================================================
//  TRACKER — Settings Window
// ============================================================
function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 720,
    height: 850,
    minWidth: 500,
    minHeight: 600,
    title: 'ALTTPR PO Tracker Settings',
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false,
    },
    backgroundColor: '#0d1117',
  });

  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, 'tracker', 'index.html'));

  const BASE_WIDTH = 720;
  settingsWindow.on('resize', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      const [w] = settingsWindow.getContentSize();
      settingsWindow.webContents.setZoomFactor(Math.max(0.5, Math.min(w / BASE_WIDTH, 1.5)));
    }
  });

  settingsWindow.webContents.on('did-finish-load', () => {
    const [w] = settingsWindow.getContentSize();
    settingsWindow.webContents.setZoomFactor(Math.max(0.5, Math.min(w / BASE_WIDTH, 1.5)));
    // Apply saved theme
    const theme = loadSettings().theme || 'blue';
    settingsWindow.webContents.executeJavaScript(`if(typeof applyPoTheme==='function'){applyPoTheme('${theme}')}`).catch(() => {});
  });

  settingsWindow.webContents.setWindowOpenHandler(({ url, features }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }

    // Save the tracker query for direct launches
    const qIdx = url.indexOf('?');
    if (qIdx >= 0) {
      const query = url.substring(qIdx + 1).replace(/&r=\d+/, '');
      saveSettings({ lastTrackerQuery: query });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tracker-configured');
      }
    }

    let width = 500, height = 1060;
    if (features) {
      const wMatch = features.match(/width=(\d+)/);
      const hMatch = features.match(/height=(\d+)/);
      if (wMatch) width = parseInt(wMatch[1]);
      if (hMatch) height = parseInt(hMatch[1]);
    }
    trackerContentDims = { width, height };

    const b = getSafeTrackerBounds(loadSettings().trackerBounds);
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: b ? b.width : width + 16,
        height: b ? b.height : height + 62,
        x: b ? b.x : undefined,
        y: b ? b.y : undefined,
        minWidth: 300, minHeight: 200, resizable: true,
        title: 'ALTTP Tracker',
        icon: path.join(__dirname, 'icon.ico'),
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          preload: path.join(__dirname, 'preload.js'),
          webSecurity: false,
        },
      },
    };
  });

  const onChildCreated = (_, win) => {
    if (win === mainWindow || win === settingsWindow) return;
    trackerWindow = win;
    win.setMenuBarVisibility(false);
    // Apply saved theme to popup tracker windows
    win.webContents.on('did-finish-load', () => {
      const theme = loadSettings().theme || 'blue';
      win.webContents.executeJavaScript(`if(typeof applyPoTheme==='function'){applyPoTheme('${theme}')}`).catch(() => {});
    });
    win.on('resize', saveTrackerBounds);
    win.on('move', saveTrackerBounds);
    win.on('closed', () => { trackerWindow = null; });
  };
  app.on('browser-window-created', onChildCreated);

  settingsWindow.on('closed', () => {
    settingsWindow = null;
    app.removeListener('browser-window-created', onChildCreated);
  });
}

// ============================================================
//  APP LIFECYCLE
// ============================================================

// Compile a native .exe helper for window capture/restore.
// Starts in ~100ms vs PowerShell's ~3s. Compiled once, cached in temp.
let winHelperExePath = null;

function compileWindowHelper() {
  const helperDir = path.join(app.getPath('temp'), 'po-launcher');
  if (!fs.existsSync(helperDir)) fs.mkdirSync(helperDir, { recursive: true });
  winHelperExePath = path.join(helperDir, 'WinHelper.exe');

  const HELPER_VERSION = '22';
  const versionFile = path.join(helperDir, 'version.txt');

  // Reuse if already compiled at current version
  if (fs.existsSync(winHelperExePath)) {
    try {
      if (fs.readFileSync(versionFile, 'utf-8').trim() === HELPER_VERSION) return;
    } catch {}
    try { fs.unlinkSync(winHelperExePath); } catch {}
  }

  const csPath = path.join(helperDir, 'WinHelper.cs');
  fs.writeFileSync(csPath, `
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
            sb.AppendFormat("{{\\"process\\":\\"{0}\\",\\"title\\":\\"{1}\\",\\"x\\":{2},\\"y\\":{3},\\"width\\":{4},\\"height\\":{5},\\"minimized\\":{6}}}",
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
            w.minimized = obj.Contains("\\"minimized\\":true") || obj.Contains("\\"minimized\\": true");
            list.Add(w);
            i = objEnd + 1;
        }
        return list;
    }

    static string ExtractStr(string obj, string key) {
        var needle = "\\"" + key + "\\":\\"";
        int s = obj.IndexOf(needle);
        if (s < 0) return "";
        s += needle.Length;
        int e = obj.IndexOf("\\"", s);
        return e < 0 ? "" : obj.Substring(s, e - s);
    }

    static int ExtractInt(string obj, string key) {
        var needle = "\\"" + key + "\\":";
        int s = obj.IndexOf(needle);
        if (s < 0) return 0;
        s += needle.Length;
        var sb2 = new StringBuilder();
        while (s < obj.Length && (char.IsDigit(obj[s]) || obj[s] == '-')) { sb2.Append(obj[s]); s++; }
        int v; int.TryParse(sb2.ToString(), out v); return v;
    }

    static string Esc(string s) { return s.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\""); }

    // MODE: launch-hidden — start a process with no visible window
    static void LaunchHidden(string exePath, string workDir) {
        var psi = new ProcessStartInfo();
        psi.FileName = exePath;
        psi.WorkingDirectory = workDir;
        psi.CreateNoWindow = true;
        psi.UseShellExecute = false;
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        Process.Start(psi);
    }

    // MODE: drop-file — wait for Lua Console, then load a script via menu command
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr GetMenu(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr GetSubMenu(IntPtr hMenu, int nPos);
    [DllImport("user32.dll")] static extern uint GetMenuItemID(IntPtr hMenu, int nPos);
    [DllImport("user32.dll")] static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
    [DllImport("user32.dll")] static extern IntPtr FindWindowEx(IntPtr hWndParent, IntPtr hWndChildAfter, string lpClassName, string lpWindowName);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] static extern IntPtr SendMessageStr(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam);

    const uint WM_COMMAND = 0x0111;
    const uint WM_SETTEXT = 0x000C;
    const uint BM_CLICK = 0x00F5;

    static void DropFile(string processName, string titleMatch, string filePath, int maxWaitSec) {
        var start = DateTime.Now;
        IntPtr targetHwnd = IntPtr.Zero;

        // Poll for the target window
        while ((DateTime.Now - start).TotalSeconds < maxWaitSec) {
            var handles = GetAllHandles();
            var pids = GetTargetPids(new string[] { processName });
            foreach (var h in handles) {
                uint wpid; GetWindowThreadProcessId(h, out wpid);
                string pname;
                if (!pids.TryGetValue((int)wpid, out pname)) continue;
                if (pname != processName) continue;
                var title = GetTitle(h);
                if (title.IndexOf(titleMatch) >= 0) {
                    targetHwnd = h;
                    break;
                }
            }
            if (targetHwnd != IntPtr.Zero) break;
            Thread.Sleep(200);
        }

        if (targetHwnd == IntPtr.Zero) return;

        // Get the menu bar and find Script > Open Script command ID
        IntPtr menuBar = GetMenu(targetHwnd);
        if (menuBar == IntPtr.Zero) return;

        // Script menu is at index 1 (File=0, Script=1, Settings=2, Help=3)
        IntPtr scriptMenu = GetSubMenu(menuBar, 1);
        if (scriptMenu == IntPtr.Zero) return;

        // "Open Script" is typically the first item (index 0)
        uint openScriptId = GetMenuItemID(scriptMenu, 0);
        if (openScriptId == 0xFFFFFFFF) return;

        // Send the menu command to open the file dialog
        SetForegroundWindow(targetHwnd);
        Thread.Sleep(200);
        PostMessage(targetHwnd, WM_COMMAND, (IntPtr)openScriptId, IntPtr.Zero);

        // Wait for the Open File dialog to appear
        IntPtr dlg = IntPtr.Zero;
        var dlgStart = DateTime.Now;
        while ((DateTime.Now - dlgStart).TotalSeconds < 5) {
            Thread.Sleep(200);
            // Look for the Open dialog (standard Windows file dialog)
            dlg = FindWindow("#32770", "Open");
            if (dlg == IntPtr.Zero) dlg = FindWindow("#32770", "Open Script");
            if (dlg != IntPtr.Zero) break;
        }

        if (dlg == IntPtr.Zero) return;

        // Find the filename edit box (ComboBoxEx32 > ComboBox > Edit)
        IntPtr comboBoxEx = FindWindowEx(dlg, IntPtr.Zero, "ComboBoxEx32", null);
        if (comboBoxEx != IntPtr.Zero) {
            IntPtr comboBox = FindWindowEx(comboBoxEx, IntPtr.Zero, "ComboBox", null);
            if (comboBox != IntPtr.Zero) {
                IntPtr edit = FindWindowEx(comboBox, IntPtr.Zero, "Edit", null);
                if (edit != IntPtr.Zero) {
                    // Set the filename
                    SendMessageStr(edit, WM_SETTEXT, IntPtr.Zero, filePath);
                    Thread.Sleep(200);
                }
            }
        }

        // Find and click the Open button
        IntPtr openBtn = FindWindowEx(dlg, IntPtr.Zero, "Button", "&Open");
        if (openBtn == IntPtr.Zero) openBtn = FindWindowEx(dlg, IntPtr.Zero, "Button", "Open");
        if (openBtn != IntPtr.Zero) {
            SendMessage(openBtn, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
        }
    }

    // MODE: hide-window — find a window by process name and hide it (SW_HIDE)
    static void HideWindow(string processName, int maxWaitSec) {
        var start = DateTime.Now;
        while ((DateTime.Now - start).TotalSeconds < maxWaitSec) {
            var handles = GetAllHandles();
            var pids = GetTargetPids(new string[] { processName });
            foreach (var h in handles) {
                uint wpid; GetWindowThreadProcessId(h, out wpid);
                string pname;
                if (!pids.TryGetValue((int)wpid, out pname)) continue;
                if (pname != processName) continue;
                var title = GetTitle(h);
                if (string.IsNullOrEmpty(title)) continue;
                if (title.Contains("Default IME") || title.Contains("MSCTFIME")) continue;
                // SW_HIDE = 0
                ShowWindow(h, 0);
                return;
            }
            Thread.Sleep(100);
        }
    }

    [STAThread]
    static void Main(string[] args) {
        if (args.Length < 1) return;
        if (args[0] == "capture" && args.Length >= 2) {
            Capture(args[1].Split(','));
        } else if (args[0] == "restore" && args.Length >= 2) {
            Restore(args[1]);
        } else if (args[0] == "launch-hidden" && args.Length >= 3) {
            LaunchHidden(args[1], args[2]);
        } else if (args[0] == "drop-file" && args.Length >= 4) {
            // drop-file <processName> <titleMatch> <filePath> [maxWaitSec]
            int wait = args.Length >= 5 ? int.Parse(args[4]) : 15;
            DropFile(args[1], args[2], args[3], wait);
        } else if (args[0] == "hide-window" && args.Length >= 2) {
            int wait = args.Length >= 3 ? int.Parse(args[2]) : 10;
            HideWindow(args[1], wait);
        }
    }
}
`, { encoding: 'utf-8' });

  try {
    // Try 64-bit first, fall back to 32-bit
    let cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
    if (!fs.existsSync(cscPath)) {
      cscPath = 'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe';
    }
    if (!fs.existsSync(cscPath)) {
      console.error('No .NET Framework csc.exe found — window layout features disabled');
      winHelperExePath = null;
      return;
    }
    execSync(
      `"${cscPath}" /nologo /optimize /reference:System.Windows.Forms.dll /out:"${winHelperExePath}" "${csPath}"`,
      { windowsHide: true, timeout: 15000 }
    );
    fs.writeFileSync(versionFile, HELPER_VERSION, 'utf-8');
  } catch (err) {
    console.error('Failed to compile WinHelper:', err.message);
    winHelperExePath = null;
  }
}

// One launcher at a time. Settings are now held in memory, so two instances would
// each keep their own copy and overwrite each other's saves. A second launch just
// brings the existing window forward.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    const settings = loadSettings();
    savedTrackerZoom = settings.zoom || null;
    createMainWindow();
    compileWindowHelper();
  });
}

app.on('window-all-closed', () => app.quit());

// Pending settings changes must reach disk before the process goes away.
app.on('before-quit', flushSettings);
app.on('will-quit', flushSettings);

// ============================================================
//  IPC — Window Controls
// ============================================================
ipcMain.handle('minimize-window', () => mainWindow && mainWindow.minimize());
ipcMain.handle('maximize-window', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.handle('close-window', () => mainWindow && mainWindow.close());

// ============================================================
//  IPC — Settings
// ============================================================
ipcMain.handle('load-settings', () => loadSettings());
ipcMain.handle('save-settings', (_e, s) => saveSettings(s));

// ============================================================
//  IPC — File Dialogs
// ============================================================
ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Folder', properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('pick-exe', async (_e, title) => {
  const isLua = title && title.toLowerCase().includes('lua');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: title || 'Select File',
    properties: ['openFile'],
    filters: isLua
      ? [{ name: 'Lua Scripts', extensions: ['lua'] }, { name: 'All Files', extensions: ['*'] }]
      : [{ name: 'Executables', extensions: ['exe'] }, { name: 'All Files', extensions: ['*'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

// ============================================================
//  IPC — Pack Scanning
// ============================================================
ipcMain.handle('scan-packs', (_e, parentDir) => {
  const packs = [];
  try {
    const entries = fs.readdirSync(parentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subPath = path.join(parentDir, entry.name);
      const files = fs.readdirSync(subPath);
      const msuFile = files.find(f => f.toLowerCase().endsWith('.msu'));
      if (msuFile) {
        packs.push({ name: entry.name, path: subPath, msuBase: path.parse(msuFile).name });
      }
    }
  } catch (err) { console.error('Scan error:', err); }
  packs.sort((a, b) => a.name.localeCompare(b.name));
  return packs;
});

// ============================================================
//  IPC — ROM Staging Folder
// ============================================================
ipcMain.handle('scan-staging-folder', (_e, folderPath) => {
  try {
    const files = fs.readdirSync(folderPath);
    const roms = files
      .filter(f => {
        const ext = path.extname(f).toLowerCase();
        return ext === '.sfc' || ext === '.aplttp';
      })
      .map(f => {
        const fullPath = path.join(folderPath, f);
        const stat = fs.statSync(fullPath);
        return { name: f, path: fullPath, modified: stat.mtimeMs };
      })
      .sort((a, b) => b.modified - a.modified);
    return roms.length > 0 ? roms[0] : null;
  } catch (err) { return null; }
});

// ============================================================
//  IPC — Tracker Windows
// ============================================================
ipcMain.handle('open-tracker', () => openTrackerWindow());
ipcMain.handle('open-tracker-settings', () => { openSettingsWindow(); });
ipcMain.handle('has-tracker-config', () => !!loadSettings().lastTrackerQuery);

// Theme propagation to all open tracker/settings windows
ipcMain.handle('set-theme', (event, themeName) => {
  const js = `if(typeof applyPoTheme==='function'){applyPoTheme('${themeName}')}`;
  if (trackerWindow && !trackerWindow.isDestroyed()) {
    trackerWindow.webContents.executeJavaScript(js).catch(() => {});
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.executeJavaScript(js).catch(() => {});
  }
  // Also save to settings so tracker windows opened later use it
  saveSettings({ theme: themeName });
});

// Tracker preload support
ipcMain.handle('get-app-path', () => app.getAppPath());
ipcMain.handle('get-content-dimensions', () => trackerContentDims);

ipcMain.handle('fit-window-to-content', (event, contentW, contentH) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    const [winW, winH] = win.getSize();
    const [clientW, clientH] = win.getContentSize();
    win.setSize(contentW + (winW - clientW), contentH + (winH - clientH));
  }
});

ipcMain.handle('save-zoom', (_e, zoom) => {
  savedTrackerZoom = zoom;
  saveSettings({ zoom });
});

ipcMain.handle('get-saved-zoom', () => savedTrackerZoom);

ipcMain.handle('set-aspect-ratio', (event, ratio) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.setAspectRatio(ratio);
});

// ============================================================
//  LAYOUT — PowerShell Window Capture & Restore
// ============================================================

// Names of external processes to capture.
// We dynamically add process names from the user's configured exe paths.
function getExternalProcessNames(settings) {
  const names = new Set(['EmuHawk', 'Archipelago', 'ArchipelagoLttPClient', 'ArchipelagoSNIClient']);
  if (settings.emulatorPath) {
    names.add(path.parse(settings.emulatorPath).name);
  }
  if (settings.timerPath) {
    names.add(path.parse(settings.timerPath).name);
  }
  return Array.from(names);
}

function captureExternalWindows() {
  const settings = loadSettings();
  const processNames = getExternalProcessNames(settings);
  const debugBase = app.isPackaged ? path.dirname(process.execPath) : __dirname;

  // Use compiled helper if available, fall back to PowerShell
  if (winHelperExePath && fs.existsSync(winHelperExePath)) {
    try {
      const result = execSync(
        `"${winHelperExePath}" capture "${processNames.join(',')}"`,
        { windowsHide: true, encoding: 'utf-8', timeout: 5000 }
      ).trim();
      fs.writeFileSync(path.join(debugBase, 'capture-raw.txt'), result, 'utf-8');
      if (!result || result === '[]') return [];
      const all = JSON.parse(result);

      const junkTitles = ['Default IME', 'MSCTFIME UI', 'GDI+ Window', 'NVOGLDC',
                          '__wglDummyWindow', '.NET-BroadcastEvent'];
      return all.filter(w => {
        if (junkTitles.some(j => w.title.includes(j))) return false;
        if (!w.minimized && (w.width < 50 || w.height < 50)) return false;
        return true;
      });
    } catch (err) {
      fs.writeFileSync(path.join(debugBase, 'capture-error.txt'),
        `${err.message}\n\nSTDOUT: ${err.stdout || ''}\nSTDERR: ${err.stderr || ''}`, 'utf-8');
      return [];
    }
  }

  // Fallback: PowerShell (slow but works)
  return captureExternalWindowsPS(processNames, debugBase);
}

// PowerShell fallback for capture
function captureExternalWindowsPS(processNames, debugBase) {
  const namesList = processNames.map(n => `'${n}'`).join(',');
  const script = [
    '$ErrorActionPreference = "Stop"',
    '',
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'using System.Collections.Generic;',
    'public class WinHelper {',
    '    public delegate bool EnumWinProc(IntPtr h, IntPtr l);',
    '    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWinProc cb, IntPtr l);',
    '    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);',
    '    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
    '    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    '    [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT wp);',
    '    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }',
    '    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }',
    '    [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {',
    '        public int length, flags, showCmd;',
    '        public POINT minPos, maxPos;',
    '        public RECT normalPos;',
    '    }',
    '}',
    '"@',
    '',
    `$targetNames = @(${namesList})`,
    '$pids = @{}',
    'foreach ($n in $targetNames) {',
    '    Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object { $pids[$_.Id] = $_.ProcessName }',
    '}',
    '',
    '$allHandles = New-Object System.Collections.Generic.List[IntPtr]',
    '$callback = [WinHelper+EnumWinProc]{',
    '    param($h, $l)',
    '    if ([WinHelper]::GetWindowTextLength($h) -gt 0) { $allHandles.Add($h) }',
    '    return $true',
    '}',
    '[WinHelper]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null',
    '',
    '$results = @()',
    'foreach ($h in $allHandles) {',
    '    $wpid = [uint32]0',
    '    [WinHelper]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null',
    '    if ($pids.ContainsKey([int]$wpid)) {',
    '        $sb = New-Object System.Text.StringBuilder 256',
    '        [WinHelper]::GetWindowText($h, $sb, 256) | Out-Null',
    '        $t = $sb.ToString()',
    '        if ($t -eq "") { continue }',
    '        $iconic = [WinHelper]::IsIconic($h)',
    '        $wp = New-Object WinHelper+WINDOWPLACEMENT',
    '        $wp.length = [System.Runtime.InteropServices.Marshal]::SizeOf($wp)',
    '        [WinHelper]::GetWindowPlacement($h, [ref]$wp) | Out-Null',
    '        $r = $wp.normalPos',
    '        $results += [PSCustomObject]@{',
    '            process = $pids[[int]$wpid]',
    '            title = $t',
    '            x = $r.L',
    '            y = $r.T',
    '            width = $r.R - $r.L',
    '            height = $r.B - $r.T',
    '            minimized = [bool]$iconic',
    '        }',
    '    }',
    '}',
    '',
    'if ($results.Count -eq 0) { Write-Output "[]" }',
    'elseif ($results.Count -eq 1) { Write-Output ("[" + ($results | ConvertTo-Json -Compress) + "]") }',
    'else { Write-Output ($results | ConvertTo-Json -Compress) }',
  ].join('\r\n');

  try {
    const tmpScript = path.join(app.getPath('temp'), 'po-launcher-capture.ps1');
    fs.writeFileSync(tmpScript, script, { encoding: 'utf-8' });
    const result = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpScript}"`,
      { windowsHide: true, encoding: 'utf-8', timeout: 10000 }
    ).trim();
    fs.writeFileSync(path.join(debugBase, 'capture-raw.txt'), result, 'utf-8');
    if (!result || result === '[]') return [];
    const parsed = JSON.parse(result);
    const all = Array.isArray(parsed) ? parsed : [parsed];
    const junkTitles = ['Default IME', 'MSCTFIME UI', 'GDI+ Window', 'NVOGLDC',
                        '__wglDummyWindow', '.NET-BroadcastEvent'];
    return all.filter(w => {
      if (junkTitles.some(j => w.title.includes(j))) return false;
      if (!w.minimized && (w.width < 50 || w.height < 50)) return false;
      return true;
    });
  } catch (err) {
    fs.writeFileSync(path.join(debugBase, 'capture-error.txt'),
      `${err.message}\n\nSTDOUT: ${err.stdout || ''}\nSTDERR: ${err.stderr || ''}`, 'utf-8');
    return [];
  }
}

// ============================================================
//  IPC — Layout Save/Restore
// ============================================================
ipcMain.handle('save-layout', (_e, layoutType) => {
  const layout = {};

  // Capture PO Launcher main window
  if (mainWindow && !mainWindow.isDestroyed()) {
    layout.mainWindow = mainWindow.getBounds();
  }

  // Capture tracker (Electron window)
  if (trackerWindow && !trackerWindow.isDestroyed()) {
    layout.trackerWindow = trackerWindow.getBounds();
  }

  // Capture all external windows
  const externalWindows = captureExternalWindows();
  if (externalWindows.length > 0) {
    layout.externalWindows = externalWindows;
  }

  const key = layoutType === 'aplttp' ? 'layoutAplttp' : 'layoutSfc';
  saveSettings({ [key]: layout });

  // Write debug log
  const debugPath = path.join(
    app.isPackaged ? path.dirname(process.execPath) : __dirname,
    'layout-debug.json'
  );
  fs.writeFileSync(debugPath, JSON.stringify({ layoutType, layout }, null, 2), 'utf-8');

  const count = (layout.mainWindow ? 1 : 0) + (layout.trackerWindow ? 1 : 0) + externalWindows.length;
  return { saved: true, windowCount: count };
});

function restoreLayout(layoutType) {
  const settings = loadSettings();
  const key = layoutType === 'aplttp' ? 'layoutAplttp' : 'layoutSfc';
  const layout = settings[key];
  if (!layout) return;

  // Restore Electron windows immediately
  // (skipped when the saved spot is on a monitor that isn't connected right now)
  if (layout.mainWindow && mainWindow && !mainWindow.isDestroyed() && boundsAreVisible(layout.mainWindow)) {
    mainWindow.setBounds(layout.mainWindow);
  }
  if (layout.trackerWindow && trackerWindow && !trackerWindow.isDestroyed() && boundsAreVisible(layout.trackerWindow)) {
    trackerWindow.setBounds(layout.trackerWindow);
  }

  // Poll for external windows and restore each as it appears
  if (layout.externalWindows && layout.externalWindows.length > 0) {
    const debugBase = app.isPackaged ? path.dirname(process.execPath) : __dirname;
    fs.writeFileSync(path.join(debugBase, 'restore-debug.json'), JSON.stringify(layout.externalWindows, null, 2), 'utf-8');
    pollAndRestoreExternalWindows(layout.externalWindows);
  }
}

// Restore external windows using compiled helper exe.
// The exe polls internally every 300ms until all windows found or 20s timeout.
// Starts in ~100ms vs PowerShell's ~3s.
function pollAndRestoreExternalWindows(targetWindows) {
  const debugBase = app.isPackaged ? path.dirname(process.execPath) : __dirname;

  if (winHelperExePath && fs.existsSync(winHelperExePath)) {
    // Write target windows to JSON config file
    const configPath = path.join(app.getPath('temp'), 'po-launcher', 'restore-config.json');
    fs.writeFileSync(configPath, JSON.stringify(targetWindows), { encoding: 'utf-8' });

    // Fire and forget — exe handles polling internally
    exec(
      `"${winHelperExePath}" restore "${configPath}"`,
      { windowsHide: true, timeout: 25000 }
    );
    return;
  }

  // Fallback: PowerShell single-script polling (slow startup but works)
  pollAndRestoreExternalWindowsPS(targetWindows, debugBase);
}

// PowerShell fallback for restore polling
function pollAndRestoreExternalWindowsPS(targetWindows, debugBase) {
  const windowBlocks = targetWindows.map((w, i) => {
    const safeTitle = w.title.replace(/'/g, "''");
    const processName = w.process.replace(/'/g, "''");
    const matchStr = safeTitle.substring(0, Math.min(safeTitle.length, 30)).replace(/'/g, "''");
    const restoreAction = w.minimized
      ? `[WinHelper]::ShowWindow($h, 6) | Out-Null`
      : [
          `[WinHelper]::ShowWindow($h, 9) | Out-Null`,
          `[WinHelper]::MoveWindow($h, ${w.x}, ${w.y}, ${w.width}, ${w.height}, $true) | Out-Null`,
        ].join('\r\n                ');
    return [
      `        if (-not $restored[${i}]) {`,
      `            foreach ($h in $handles) {`,
      `                $wpid = [uint32]0`,
      `                [WinHelper]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null`,
      `                $proc = Get-Process -Id $wpid -ErrorAction SilentlyContinue`,
      `                if ($proc -and $proc.ProcessName -eq '${processName}') {`,
      `                    $sb = New-Object System.Text.StringBuilder 256`,
      `                    [WinHelper]::GetWindowText($h, $sb, 256) | Out-Null`,
      `                    $t = $sb.ToString()`,
      `                    if ($t -like '*${matchStr}*') {`,
      `                ${restoreAction}`,
      `                        $restored[${i}] = $true`,
      `                        $restoredCount++`,
      `                        break`,
      `                    }`,
      `                }`,
      `            }`,
      `        }`,
    ].join('\r\n');
  });

  const script = [
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'using System.Collections.Generic;',
    'public class WinHelper {',
    '    public delegate bool EnumWinProc(IntPtr h, IntPtr l);',
    '    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWinProc cb, IntPtr l);',
    '    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);',
    '    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
    '    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool r);',
    '    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
    '}',
    '"@',
    '',
    `$totalWindows = ${targetWindows.length}`,
    '$restored = @(' + targetWindows.map(() => '$false').join(',') + ')',
    '$restoredCount = 0',
    '$startTime = Get-Date',
    '',
    'while ($restoredCount -lt $totalWindows -and ((Get-Date) - $startTime).TotalSeconds -lt 20) {',
    '    $handles = New-Object System.Collections.Generic.List[IntPtr]',
    '    $callback = [WinHelper+EnumWinProc]{',
    '        param($h, $l)',
    '        if ([WinHelper]::GetWindowTextLength($h) -gt 0) { $handles.Add($h) }',
    '        return $true',
    '    }',
    '    [WinHelper]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null',
    '',
    ...windowBlocks,
    '',
    '    if ($restoredCount -lt $totalWindows) { Start-Sleep -Milliseconds 400 }',
    '}',
  ].join('\r\n');

  try {
    const tmpScript = path.join(app.getPath('temp'), 'po-launcher-restore.ps1');
    fs.writeFileSync(tmpScript, script, { encoding: 'utf-8' });
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpScript}"`, { windowsHide: true, timeout: 25000 });
  } catch (err) {
    fs.writeFileSync(path.join(debugBase, 'restore-error.txt'), err.message, 'utf-8');
  }
}

// Try to restore specific windows. Calls back with array of titles that were found and restored.
// ============================================================
//  Lua Console Helper
// ============================================================
// Generate a Lua launcher script. Since BizHawk's script environment
// doesn't support dofile() for scripts that load native DLLs,
// we load the real script directly. The layout restore's fast polling
// will reposition the Lua Console as soon as it appears.
function getLuaLauncherPath(realScriptPath) {
  // If user has a real script configured, use it directly
  if (realScriptPath) return realScriptPath;

  // No script configured — generate a dummy that just opens the console
  const base = app.isPackaged ? path.dirname(process.execPath) : __dirname;
  const launcherPath = path.join(base, 'open_console.lua');
  fs.writeFileSync(launcherPath, '-- PO Launcher: opens Lua Console on startup\n', 'utf-8');
  return launcherPath;
}

// ============================================================
//  ROM Staging
// ============================================================
// Put the chosen ROM into the pack folder under the pack's MSU name and make it
// the only ROM in there. Returns the staged path.
//
// The cleanup rule is unchanged — every .sfc/.aplttp in the pack folder is removed —
// because the rest of the launcher relies on it: MSU-1 needs the ROM to carry the
// pack's name, and the Archipelago flow treats "an .sfc appeared in this folder" as
// the signal that generation finished, so a stale .sfc would be picked up instantly.
//
// What changed is the ORDER. It used to delete first and copy second, so launching a
// ROM that already lived in the pack folder deleted the source before it was copied:
// the copy failed with ENOENT and the ROM was gone. Now the copy happens first, under
// a name the cleanup never matches, and is renamed into place at the end.
function stageRom(romPath, pack) {
  const romExt = path.extname(romPath).toLowerCase();
  const destRom = path.join(pack.path, pack.msuBase + romExt);
  const tmpRom = path.join(pack.path, `.po-staging-${process.pid}.tmp`);

  // Sweep up after any earlier run that was interrupted mid-stage.
  for (const f of fs.readdirSync(pack.path)) {
    if (/^\.po-staging-\d+\.tmp$/.test(f)) {
      try { fs.unlinkSync(path.join(pack.path, f)); } catch {}
    }
  }

  fs.copyFileSync(romPath, tmpRom);
  try {
    for (const f of fs.readdirSync(pack.path)) {
      const ext = path.extname(f).toLowerCase();
      if (ext === '.sfc' || ext === '.aplttp') {
        fs.unlinkSync(path.join(pack.path, f));
      }
    }
    fs.renameSync(tmpRom, destRom);
  } catch (err) {
    try { fs.unlinkSync(tmpRom); } catch {}
    throw err;
  }
  return destRom;
}

// ============================================================
//  IPC — Launch ROM
// ============================================================
ipcMain.handle('launch-rom', async (_e, {
  romPath, pack,
  launchEmulator, emulatorPath,
  launchTracker,
  launchSni, sniPath,
  launchTimer, timerPath,
  openLua, luaScriptPath, isBizhawk
}) => {
  try {
    const romExt = path.extname(romPath).toLowerCase();
    const isArchipelago = romExt === '.aplttp';

    // Copy ROM into the pack folder (copy first, then clean old ROMs — see stageRom)
    const destRom = stageRom(romPath, pack);

    // If the ROM was launched from inside the pack folder, its old name is gone now;
    // the renderer needs the new path or the next Play would fail with "file not found".
    const romMovedTo = fs.existsSync(romPath) ? null : destRom;

    // Open built-in tracker
    let trackerResult = 'skipped';
    if (launchTracker) {
      trackerResult = openTrackerWindow();
    }

    if (isArchipelago) {
      // === ARCHIPELAGO FLOW ===
      // The .aplttp file is already copied to the pack folder (with old SFCs cleaned).
      // Opening it launches Archipelago, which generates an .sfc in the same folder.
      // We poll for the new .sfc, then launch emulator + companions.
      shell.openPath(destRom);

      // Launch timer
      if (launchTimer && timerPath) {
        exec(`"${timerPath}"`, { cwd: path.dirname(timerPath) });
      }

      // Poll for the generated .sfc file (Archipelago creates it)
      const packDir = pack.path;
      const generatedSfc = await new Promise((resolve) => {
        let elapsed = 0;
        const interval = setInterval(() => {
          try {
            const files = fs.readdirSync(packDir);
            const sfc = files.find(f => f.toLowerCase().endsWith('.sfc'));
            if (sfc) {
              clearInterval(interval);
              resolve(path.join(packDir, sfc));
            }
          } catch {}
          elapsed += 500;
          if (elapsed > 60000) { // 60 second timeout
            clearInterval(interval);
            resolve(null);
          }
        }, 500);
      });

      if (!generatedSfc) {
        return { success: false, error: 'Timeout waiting for Archipelago to generate .sfc' };
      }

      // Launch SNI
      if (launchSni && sniPath) {
        exec(`"${sniPath}"`, { cwd: path.dirname(sniPath) });
      }

      // Start layout restore
      restoreLayout('aplttp');

      // Launch emulator with the generated SFC
      if (launchEmulator && emulatorPath) {
        let args = `"${generatedSfc}"`;
        if (isBizhawk && openLua) {
          const luaPath = luaScriptPath || getLuaLauncherPath(null);
          args += ` --lua="${luaPath}"`;
        }
        exec(`"${emulatorPath}" ${args}`, { cwd: path.dirname(emulatorPath) });
      } else {
        shell.openPath(generatedSfc);
      }
    } else {
      // === NORMAL SFC FLOW ===
      // Launch SNI
      if (launchSni && sniPath) {
        exec(`"${sniPath}"`, { cwd: path.dirname(sniPath) });
      }

      // Launch timer
      if (launchTimer && timerPath) {
        exec(`"${timerPath}"`, { cwd: path.dirname(timerPath) });
      }

      // Start layout restore polling BEFORE launching emulator
      // so it's ready to catch windows the instant they appear
      const layoutType = isArchipelago ? 'aplttp' : 'sfc';
      restoreLayout(layoutType);

      // Launch emulator
      if (launchEmulator && emulatorPath) {
        let args = `"${destRom}"`;
        if (isBizhawk && openLua) {
          const luaPath = luaScriptPath || getLuaLauncherPath(null);
          args += ` --lua="${luaPath}"`;
        }
        exec(`"${emulatorPath}" ${args}`, { cwd: path.dirname(emulatorPath) });
      } else {
        shell.openPath(destRom);
      }
    }

    return { success: true, trackerResult, romMovedTo };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
