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

// Theme names end up inside a string passed to executeJavaScript(), so only a plain
// identifier is ever allowed through. Anything else falls back to the default theme.
function safeThemeName(name) {
  return (typeof name === 'string' && /^[a-z0-9_-]{1,32}$/i.test(name)) ? name : 'blue';
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
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'launcher-preload.js'),
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
    trackerWindow.webContents.executeJavaScript(`if(typeof applyPoTheme==='function'){applyPoTheme('${safeThemeName(theme)}')}`).catch(() => {});
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
    settingsWindow.webContents.executeJavaScript(`if(typeof applyPoTheme==='function'){applyPoTheme('${safeThemeName(theme)}')}`).catch(() => {});
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
      win.webContents.executeJavaScript(`if(typeof applyPoTheme==='function'){applyPoTheme('${safeThemeName(theme)}')}`).catch(() => {});
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

// WinHelper.exe does the window capture/restore work. Its source is native/WinHelper.cs.
//
// Release builds ship it prebuilt (scripts/build-helper.js, run by `npm run build` and by
// CI), so nothing is compiled on a user's machine and no fresh exe is dropped into %TEMP% —
// a pattern antivirus heuristics dislike. A dev checkout without a prebuilt copy falls back
// to compiling it once into temp, exactly as every version up to 2.0 did.
let winHelperExePath = null;

function compileWindowHelper() {
  const prebuilt = [
    path.join(process.resourcesPath || '', 'WinHelper.exe'),    // packaged app (extraResources)
    path.join(__dirname, 'native', 'bin', 'WinHelper.exe'),     // dev, after `npm run build:helper`
  ].find(p => fs.existsSync(p));
  if (prebuilt) { winHelperExePath = prebuilt; return; }

  const helperDir = path.join(app.getPath('temp'), 'po-launcher');
  if (!fs.existsSync(helperDir)) fs.mkdirSync(helperDir, { recursive: true });
  winHelperExePath = path.join(helperDir, 'WinHelper.exe');

  const HELPER_VERSION = '23';
  const versionFile = path.join(helperDir, 'version.txt');

  // Reuse if already compiled at current version
  if (fs.existsSync(winHelperExePath)) {
    try {
      if (fs.readFileSync(versionFile, 'utf-8').trim() === HELPER_VERSION) return;
    } catch {}
    try { fs.unlinkSync(winHelperExePath); } catch {}
  }

  const csPath = path.join(helperDir, 'WinHelper.cs');
  try {
    fs.copyFileSync(path.join(__dirname, 'native', 'WinHelper.cs'), csPath);
  } catch (err) {
    console.error('WinHelper source missing:', err.message);
    winHelperExePath = null;
    return;
  }


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
  themeName = safeThemeName(themeName);
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

// Debug dumps go where they always went (next to the exe, or the project folder in
// dev) under the same names. They just can't take real work down with them any more:
// a failed dump inside captureExternalWindows() used to turn a good capture into
// "0 windows", and one inside save-layout rejected the IPC call after the layout
// had in fact been saved.
function writeDebugFile(name, content) {
  try {
    const base = app.isPackaged ? path.dirname(process.execPath) : __dirname;
    fs.writeFileSync(path.join(base, name), content, 'utf-8');
  } catch {}
}

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
      writeDebugFile('capture-raw.txt', result);
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
      writeDebugFile('capture-error.txt',
        `${err.message}\n\nSTDOUT: ${err.stdout || ''}\nSTDERR: ${err.stderr || ''}`);
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
    writeDebugFile('capture-raw.txt', result);
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
    writeDebugFile('capture-error.txt',
      `${err.message}\n\nSTDOUT: ${err.stdout || ''}\nSTDERR: ${err.stderr || ''}`);
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
  writeDebugFile('layout-debug.json', JSON.stringify({ layoutType, layout }, null, 2));

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
    writeDebugFile('restore-debug.json', JSON.stringify(layout.externalWindows, null, 2));
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
    writeDebugFile('restore-error.txt', err.message);
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
//  Companion App Launch
// ============================================================
// Start the emulator / SNI / timer and leave it running on its own.
//
// This is deliberately the same launch as before: exec() ran
//   cmd.exe /d /s /c "<command line>"   with cwd = the app's folder,
// and spawn(..., { shell: true }) produces exactly that. The one difference is
// stdio: 'ignore'. exec() pipes the app's console output into this process and keeps
// up to 1 MB of it; past that, Node kills the cmd.exe wrapper and closes the pipe, and
// from then on every console write the app makes fails with EPIPE (measured on
// Windows: the app itself survives, its output stream does not). Nothing here ever
// read that output, so it now goes nowhere instead.
//
// DO NOT "simplify" this to spawn(exePath, [args]) without the shell. On Windows,
// Node puts every direct, non-detached child into a kill-on-close job object, so a
// directly spawned emulator dies the moment the launcher closes (measured: killed at
// the same millisecond). Going through cmd.exe is what lets BizHawk / SNI / the timer
// outlive the launcher: cmd.exe is the job member, the app it starts is not.
function launchApp(exePath, argString) {
  const commandLine = argString ? `"${exePath}" ${argString}` : `"${exePath}"`;
  try {
    const child = spawn(commandLine, { cwd: path.dirname(exePath), shell: true, stdio: 'ignore' });
    child.on('error', (err) => console.error(`Launch failed (${exePath}):`, err.message));
    child.unref();
  } catch (err) {
    console.error(`Launch failed (${exePath}):`, err.message);
  }
}

// Is this exe already running? Used for SNI and the timer only: a second SNI can't
// bind its port, and a second timer is just a stray window the layout restore won't
// place. The emulator is never checked — relaunching it is the user's call.
// Any doubt (odd file name, tasklist unavailable) answers "no", i.e. launch as before.
function isAppRunning(exePath) {
  if (process.platform !== 'win32') return false;
  const image = path.basename(exePath);
  if (!/^[\w .()+\-\[\]]+$/.test(image)) return false;
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${image}" /FO CSV /NH`,
      { windowsHide: true, encoding: 'utf-8', timeout: 5000 });
    return out.toLowerCase().includes(`"${image.toLowerCase()}"`);
  } catch { return false; }
}

// launchApp(), unless it's already up. Returns true if it was already running.
function launchAppOnce(exePath) {
  if (isAppRunning(exePath)) return true;
  launchApp(exePath);
  return false;
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

// Wait for Archipelago to generate the .sfc in the pack folder.
// Same signal as before (an .sfc appears; stageRom() guarantees none was there), same
// 60s limit. The addition: the emulator is never handed a ROM that is still being
// written. "Finished" means the size has stopped changing —
//   - for 2 polls in a row if the file is shaped like a complete SNES ROM (a whole
//     number of 32 KB banks, at least 512 KB, optionally + a 512-byte copier header);
//   - for 4 polls in a row (1s) for anything else. An unusual ROM is only ever delayed,
//     never refused, so this can't turn a working launch into a timeout.
// Resolves with the full path, or null on timeout.
function waitForGeneratedSfc(packDir, timeoutMs = 60000, pollMs = 250) {
  const looksLikeWholeRom = (size) => {
    const body = size % 0x8000 === 512 ? size - 512 : size;
    return body >= 0x80000 && body % 0x8000 === 0;
  };
  return new Promise((resolve) => {
    const started = Date.now();
    let lastName = null;
    let lastSize = -1;
    let stablePolls = 0;
    const interval = setInterval(() => {
      try {
        const sfc = fs.readdirSync(packDir).find(f => f.toLowerCase().endsWith('.sfc'));
        if (sfc) {
          const size = fs.statSync(path.join(packDir, sfc)).size;
          stablePolls = (size > 0 && sfc === lastName && size === lastSize) ? stablePolls + 1 : 0;
          lastName = sfc;
          lastSize = size;
          if (stablePolls >= (looksLikeWholeRom(size) ? 1 : 3)) {
            clearInterval(interval);
            resolve(path.join(packDir, sfc));
            return;
          }
        }
      } catch {}
      if (Date.now() - started > timeoutMs) {
        clearInterval(interval);
        resolve(null);
      }
    }, pollMs);
  });
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

    // Companions we found already running and therefore did not start again
    const alreadyRunning = [];

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
        if (launchAppOnce(timerPath)) alreadyRunning.push('Timer');
      }

      // Poll for the generated .sfc file (Archipelago creates it) — 60 second timeout
      const generatedSfc = await waitForGeneratedSfc(pack.path);

      if (!generatedSfc) {
        return { success: false, error: 'Timeout waiting for Archipelago to generate .sfc' };
      }

      // Launch SNI
      if (launchSni && sniPath) {
        if (launchAppOnce(sniPath)) alreadyRunning.push('SNI');
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
        launchApp(emulatorPath, args);
      } else {
        shell.openPath(generatedSfc);
      }
    } else {
      // === NORMAL SFC FLOW ===
      // Launch SNI
      if (launchSni && sniPath) {
        if (launchAppOnce(sniPath)) alreadyRunning.push('SNI');
      }

      // Launch timer
      if (launchTimer && timerPath) {
        if (launchAppOnce(timerPath)) alreadyRunning.push('Timer');
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
        launchApp(emulatorPath, args);
      } else {
        shell.openPath(destRom);
      }
    }

    return { success: true, trackerResult, romMovedTo, alreadyRunning };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
