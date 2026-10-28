const { app, BrowserWindow, ipcMain, dialog, shell, screen, net, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// The tracker (a single-page app) is served from its own scheme; see registerTrackerProtocol().
// Must be declared before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'po', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);
// The tracker talks to SNI / QUsb2snes on localhost. Chromium's Local Network Access checks
// would prompt (or silently refuse) that from a non-http origin; this is a desktop app whose
// whole point is talking to local programs, so the checks are off.
app.commandLine.appendSwitch('disable-features', 'LocalNetworkAccessChecks');
const { exec, execSync, spawn } = require('child_process');
const zlib = require('zlib');

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
const trackerPopouts = { map: null, log: null };   // the tracker's own map / event-log popout windows
let trackerContentDims = null;                     // natural (unscaled) size of the tracker page, reported by its preload

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
  return (typeof name === 'string' && /^[a-z0-9_-]{1,32}$/i.test(name)) ? name : 'amber';
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    // Rounded corners need a transparent frameless window; Electron can't resize those from
    // the edges, so the launcher is a fixed 476x540 with a scrolling pack list. The width is
    // what the footer's button row needs (461px as of 2.7.1) plus a little slack — widen it
    // again if a button is added there.
    width: 476,
    height: 540,
    resizable: false,
    maximizable: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',   // must be the ONLY backgroundColor here: an opaque one fills in the corners
    show: false,                    // shown on ready-to-show, so a transparent window never sits invisible while the page loads
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'launcher-preload.js'),
    },
  });
  mainWindow.once('ready-to-show', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show(); });
  mainWindow.loadFile('renderer.html');
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ============================================================
//  TRACKER — Muffins Tracker 2.0, served from po://tracker/
// ============================================================
// The tracker is the React build of KrisDavie/alttptracker (branch react_rewrite) plus a few
// additions of ours, kept on the `po` branch of Penderrin-Projects/alttptracker.
// scripts/build-tracker.js builds the commit pinned in tracker-source.json into tracker/.
//
// It is a single-page app with real routes (/ is the Launch page, /tracker, /map, /event-log),
// so it is served from its own scheme instead of file://: any path that is not a file comes back
// as index.html and the app routes it. All tracker windows share this origin, so they share the
// tracker's localStorage and IndexedDB (sessions, remembered settings).
const TRACKER_ORIGIN = 'po://tracker';
const TRACKER_LAUNCH_PAGE = `${TRACKER_ORIGIN}/`;
// Our addition on the po branch: a fresh session from whatever the Launch page launched last
// (or the tracker's defaults — standard open mode — if nothing was ever launched).
const TRACKER_LAST_LAUNCH = `${TRACKER_ORIGIN}/tracker?last=1`;
// The tracker's default layout (items + both maps) is 1344x448; used before the page has said
// what size it really is.
const TRACKER_DEFAULT_CONTENT = { width: 1344, height: 448 };

function registerTrackerProtocol() {
  const root = path.join(__dirname, 'tracker');
  protocol.handle('po', (request) => {
    let url;
    try { url = new URL(request.url); } catch { return new Response('Bad request', { status: 400 }); }
    if (url.host !== 'tracker') return new Response('Not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    let file = path.resolve(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
    let isFile = false;
    try { isFile = fs.statSync(file).isFile(); } catch {}
    if (!isFile) file = path.join(root, 'index.html');    // an app route, not a file
    return net.fetch(pathToFileURL(file).toString());
  });
}

function isTrackerUrl(url) {
  try { const u = new URL(url); return u.protocol === 'po:' && u.host === 'tracker' ? u : null; } catch { return null; }
}

function parseWindowFeatures(features) {
  const num = (k) => { const m = String(features || '').match(new RegExp(`${k}=(\\d+)`)); return m ? parseInt(m[1], 10) : 0; };
  const width = num('width'), height = num('height');
  return width > 0 && height > 0 ? { width, height } : null;
}

// window.open() from any tracker page. The Launch page opens the tracker (and its popouts) that
// way, and a direct launch opens its own popouts. Each becomes a top-level window of ours rather
// than a Chromium popup (a popup closes when its opener closes — which is why the tracker used to
// vanish when the settings window was closed). Ordinary web links go to the browser.
function trackerWindowOpenHandler({ url, features }) {
  if (/^https?:/i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
  const target = isTrackerUrl(url);
  if (!target) return { action: 'deny' };
  const size = parseWindowFeatures(features);
  if (target.pathname === '/tracker') {
    // Launched from the Launch page: the tracker remembers it (po_last_launch) and so do we.
    saveSettings({ trackerLaunched: true });
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tracker-configured');
    openTrackerWindow({ url: target.href, reload: true, dims: size });
  } else if (target.pathname === '/map' || target.pathname === '/event-log') {
    openTrackerPopout(target.pathname === '/map' ? 'map' : 'log', target.href, size);
  }
  return { action: 'deny' };
}

function applyThemeTo(win) {
  if (!win || win.isDestroyed()) return;
  const theme = safeThemeName(loadSettings().theme || 'amber');
  win.webContents.executeJavaScript(`if (typeof window.applyPoTheme === 'function') window.applyPoTheme('${theme}'); true`).catch(() => {});
}

// The tracker's pages set their own <title> ("Muffins Tracker 2.0 - ..."); our windows keep the
// names given above.
function keepOurTitle(win) {
  win.on('page-title-updated', (e) => e.preventDefault());
}

function trackerWebPreferences() {
  return { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') };
}

// url: a tracker route. Default is a fresh session from the last launch. reload: an open tracker
// is pointed at the url instead of just focused (the Launch page launched again).
// dims: the content size the Launch page asked for; otherwise the last size the page reported.
function openTrackerWindow({ url = TRACKER_LAST_LAUNCH, reload = false, dims = null } = {}) {
  if (trackerWindow && !trackerWindow.isDestroyed()) {
    if (reload) trackerWindow.loadURL(url);
    trackerWindow.focus();
    return 'open';
  }

  const settings = loadSettings();
  const bounds = getSafeTrackerBounds(settings.trackerBounds);
  const content = dims || settings.trackerDims || TRACKER_DEFAULT_CONTENT;
  trackerContentDims = null;

  trackerWindow = new BrowserWindow({
    width: bounds ? bounds.width : content.width,
    height: bounds ? bounds.height : content.height,
    useContentSize: !bounds,            // no saved window: size it to the content
    x: bounds ? bounds.x : undefined,
    y: bounds ? bounds.y : undefined,
    minWidth: 224,
    minHeight: 224,
    resizable: true,
    title: 'PO Tracker',
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    backgroundColor: '#242424',
    webPreferences: trackerWebPreferences(),
  });
  keepOurTitle(trackerWindow);
  trackerWindow.setMenuBarVisibility(false);
  trackerWindow.webContents.setWindowOpenHandler(trackerWindowOpenHandler);
  trackerWindow.loadURL(url);

  trackerWindow.on('resize', saveTrackerBounds);
  trackerWindow.on('move', saveTrackerBounds);
  trackerWindow.on('closed', () => {
    trackerWindow = null;
    for (const k of Object.keys(trackerPopouts)) {   // the popouts belong to this session
      if (trackerPopouts[k] && !trackerPopouts[k].isDestroyed()) trackerPopouts[k].close();
    }
  });
  trackerWindow.webContents.on('did-finish-load', () => applyThemeTo(trackerWindow));
  return 'open';
}

// The tracker's map or event-log popout (kind 'map' | 'log'). One window per kind; each remembers
// its own position and size. They are not part of saved layouts; they just come back where they were.
function openTrackerPopout(kind, url, size) {
  const existing = trackerPopouts[kind];
  if (existing && !existing.isDestroyed()) { existing.loadURL(url); existing.focus(); return; }
  const key = kind === 'map' ? 'trackerMapBounds' : 'trackerLogBounds';
  const saved = getSafeTrackerBounds(loadSettings()[key]);
  const content = size || (kind === 'map' ? { width: 896, height: 448 } : { width: 448, height: 300 });
  const win = new BrowserWindow({
    width: saved ? saved.width : content.width,
    height: saved ? saved.height : content.height,
    useContentSize: !saved,
    x: saved ? saved.x : undefined,
    y: saved ? saved.y : undefined,
    minWidth: 200,
    minHeight: 150,
    title: kind === 'map' ? 'PO Tracker - Map' : 'PO Tracker - Event Log',
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    backgroundColor: '#242424',
    webPreferences: trackerWebPreferences(),
  });
  keepOurTitle(win);
  trackerPopouts[kind] = win;
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(trackerWindowOpenHandler);
  win.loadURL(url);
  const save = () => { if (!win.isDestroyed() && !win.isMinimized()) saveSettings({ [key]: win.getBounds() }); };
  win.on('resize', save);
  win.on('move', save);
  win.on('closed', () => { if (trackerPopouts[kind] === win) trackerPopouts[kind] = null; });
  win.webContents.on('did-finish-load', () => applyThemeTo(win));
}

// The tracker page tells us its natural (unscaled) size once it has rendered: the window keeps
// that shape so the tracker fills it with no bars. The width is kept and the height follows,
// clamped to the display, and the aspect ratio is locked for the user's own resizing.
ipcMain.on('tracker-natural-size', (event, dims) => {
  if (!trackerWindow || trackerWindow.isDestroyed() || event.sender !== trackerWindow.webContents) return;
  const width = Number(dims && dims.width), height = Number(dims && dims.height);
  if (!(width > 0 && height > 0)) return;
  trackerContentDims = { width, height };
  saveSettings({ trackerDims: trackerContentDims });

  const ratio = width / height;
  trackerWindow.setAspectRatio(ratio);
  const [winW, winH] = trackerWindow.getSize();
  const [contentW, contentH] = trackerWindow.getContentSize();
  const chromeW = winW - contentW, chromeH = winH - contentH;
  const area = screen.getDisplayMatching(trackerWindow.getBounds()).workArea;
  let w = contentW, h = Math.round(w / ratio);
  if (h + chromeH > area.height) { h = area.height - chromeH; w = Math.round(h * ratio); }
  if (w + chromeW > area.width) { w = area.width - chromeW; h = Math.round(w / ratio); }
  if (Math.abs(h - contentH) > 2 || Math.abs(w - contentW) > 2) trackerWindow.setContentSize(w, h);
});
// ============================================================
//  RACE TIMER — Archipelago multiworld race stopwatch
// ============================================================
// A page (racetimer/racetimer.html) that talks to the Archipelago room over WebSocket from
// the renderer itself. The only thing it needs main for is the window: two sizes — "full"
// (controls, results, log) and "compact" (clock + player list, sized to its content) — plus
// a keep-on-top pin. Each mode remembers its own position and size, so flipping between
// them puts the window back where it was last used in that mode.
let raceTimerWindow = null;
let raceTimerSwitching = false;   // bounds we set during a mode switch aren't "where the user put it"

const RACE_TIMER_SIZES = {
  full:    { width: 580, height: 640, minWidth: 440, minHeight: 420 },
  compact: { width: 300, height: 190, minWidth: 220, minHeight: 110 },
};
const raceTimerMode = () => (loadSettings().raceTimerCompact ? 'compact' : 'full');
const raceTimerBoundsKey = (mode) => (mode === 'compact' ? 'raceTimerCompactBounds' : 'raceTimerBounds');

function saveRaceTimerBounds() {
  if (!raceTimerWindow || raceTimerWindow.isDestroyed()) return;
  if (raceTimerWindow.isMinimized() || raceTimerSwitching) return;
  saveSettings({ [raceTimerBoundsKey(raceTimerMode())]: raceTimerWindow.getBounds() });
}

// Switch the open window to a mode. bounds: explicit placement (layout restore); otherwise
// the mode's remembered bounds; otherwise the mode's default size at the current position.
// contentHeight: what the page says compact needs, used when compact has no remembered size.
function applyRaceTimerMode(mode, { bounds = null, contentHeight = 0 } = {}) {
  if (!raceTimerWindow || raceTimerWindow.isDestroyed()) return;
  const spec = RACE_TIMER_SIZES[mode] || RACE_TIMER_SIZES.full;
  saveSettings({ raceTimerCompact: mode === 'compact' });
  const saved = getSafeTrackerBounds(bounds || loadSettings()[raceTimerBoundsKey(mode)]);
  const cur = raceTimerWindow.getBounds();
  raceTimerSwitching = true;
  try {
    raceTimerWindow.setMinimumSize(spec.minWidth, spec.minHeight);
    if (saved) {
      raceTimerWindow.setBounds({ x: saved.x ?? cur.x, y: saved.y ?? cur.y, width: saved.width, height: saved.height });
    } else {
      raceTimerWindow.setBounds({ x: cur.x, y: cur.y, width: spec.width, height: spec.height });
      if (mode === 'compact' && contentHeight) fitRaceTimerHeight(contentHeight);
    }
  } finally { raceTimerSwitching = false; }
  saveSettings({ [raceTimerBoundsKey(mode)]: raceTimerWindow.getBounds() });
}

// Compact mode grows and shrinks with the player list: the page reports the height it needs.
function fitRaceTimerHeight(contentHeight) {
  if (!raceTimerWindow || raceTimerWindow.isDestroyed() || raceTimerMode() !== 'compact') return;
  const h = Math.max(RACE_TIMER_SIZES.compact.minHeight, Math.min(1200, Math.ceil(contentHeight)));
  const [w] = raceTimerWindow.getContentSize();
  raceTimerWindow.setContentSize(w, h);
}

// opts.mode / opts.bounds: open straight into a mode and place (layout restore).
function openRaceTimerWindow(opts = {}) {
  if (raceTimerWindow && !raceTimerWindow.isDestroyed()) {
    if (opts.mode) applyRaceTimerMode(opts.mode, { bounds: opts.bounds });
    raceTimerWindow.focus();
    return 'open';
  }

  const settings = loadSettings();
  const mode = opts.mode || (settings.raceTimerCompact ? 'compact' : 'full');
  const spec = RACE_TIMER_SIZES[mode];
  const bounds = getSafeTrackerBounds(opts.bounds || settings[raceTimerBoundsKey(mode)]);
  if (opts.mode) saveSettings({ raceTimerCompact: mode === 'compact' });

  raceTimerWindow = new BrowserWindow({
    width: bounds ? bounds.width : spec.width,
    height: bounds ? bounds.height : spec.height,
    x: bounds ? bounds.x : undefined,
    y: bounds ? bounds.y : undefined,
    minWidth: spec.minWidth,
    minHeight: spec.minHeight,
    resizable: true,
    alwaysOnTop: !!settings.raceTimerOnTop,
    title: 'PO Race Timer',
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    backgroundColor: '#141517',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'racetimer', 'racetimer-preload.js'),
    },
  });

  raceTimerWindow.setMenuBarVisibility(false);
  // The room of the last .aplttp launched rides along as the query string (see rememberApRoom),
  // and so does the mode, so the page renders compact from its first frame.
  const room = settings.apRoom || {};
  const query = room.slot ? { server: room.server || '', slot: room.slot, file: room.file || '' } : {};
  query.mode = mode;
  raceTimerWindow.loadFile(path.join(__dirname, 'racetimer', 'racetimer.html'), { query });

  raceTimerWindow.on('resize', saveRaceTimerBounds);
  raceTimerWindow.on('move', saveRaceTimerBounds);
  raceTimerWindow.on('closed', () => { raceTimerWindow = null; });

  raceTimerWindow.webContents.on('did-finish-load', () => {
    const theme = loadSettings().theme || 'amber';
    raceTimerWindow.webContents.executeJavaScript(`if(typeof applyPoTheme==='function'){applyPoTheme('${safeThemeName(theme)}')}`).catch(() => {});
  });

  return 'open';
}

// IPC from the race timer page (racetimer-preload.js). Only its own window is ever touched.
const fromRaceTimer = (event) => raceTimerWindow && !raceTimerWindow.isDestroyed() && event.sender === raceTimerWindow.webContents;
ipcMain.handle('race-timer-state', (event) => {
  if (!fromRaceTimer(event)) return null;
  const s = loadSettings();
  return { compact: !!s.raceTimerCompact, onTop: !!s.raceTimerOnTop };
});
ipcMain.handle('race-timer-mode', (event, compact, contentHeight) => {
  if (!fromRaceTimer(event)) return;
  applyRaceTimerMode(compact ? 'compact' : 'full', { contentHeight: Number(contentHeight) || 0 });
});
ipcMain.handle('race-timer-fit', (event, contentHeight) => {
  if (!fromRaceTimer(event)) return;
  fitRaceTimerHeight(Number(contentHeight) || 0);
});
ipcMain.handle('race-timer-on-top', (event, onTop) => {
  if (!fromRaceTimer(event)) return;
  raceTimerWindow.setAlwaysOnTop(!!onTop);
  saveSettings({ raceTimerOnTop: !!onTop });
});

// ============================================================
//  TRACKER — Settings window (the tracker's Launch page)
// ============================================================
// Tracker 2.0's Launch page is its settings page: presets, game settings, display and
// autotracking options, sprites, past sessions. Its Launch button opens the tracker through
// window.open(), which trackerWindowOpenHandler turns into our tracker window.
function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  const saved = getSafeTrackerBounds(loadSettings().settingsBounds);
  settingsWindow = new BrowserWindow({
    width: saved ? saved.width : 1180,
    height: saved ? saved.height : 860,
    x: saved ? saved.x : undefined,
    y: saved ? saved.y : undefined,
    minWidth: 720,
    minHeight: 540,
    title: 'PO Tracker - Setup',
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    backgroundColor: '#141517',
    webPreferences: trackerWebPreferences(),
  });
  keepOurTitle(settingsWindow);
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.webContents.setWindowOpenHandler(trackerWindowOpenHandler);
  settingsWindow.loadURL(TRACKER_LAUNCH_PAGE);
  settingsWindow.webContents.on('did-finish-load', () => applyThemeTo(settingsWindow));

  const save = () => { if (settingsWindow && !settingsWindow.isDestroyed() && !settingsWindow.isMinimized()) saveSettings({ settingsBounds: settingsWindow.getBounds() }); };
  settingsWindow.on('resize', save);
  settingsWindow.on('move', save);
  settingsWindow.on('closed', () => { settingsWindow = null; });
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

  const HELPER_VERSION = '24';
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

// ============================================================
//  Self-test (CI)
// ============================================================
// PO_LAUNCHER_SELFTEST=<report file>: boot normally against a throwaway profile, check the
// things that only break once packaged (preload found? helper shipped and runnable? tracker
// page loads?), write a JSON report, exit 0 or 1. Never touches the real settings.
const SELFTEST_REPORT = process.env.PO_LAUNCHER_SELFTEST || null;
// PO_LAUNCHER_SELFTEST_SHOTS=<dir>: also save screenshots of the windows the self-test opened.
const SELFTEST_SHOTS = process.env.PO_LAUNCHER_SELFTEST_SHOTS || null;
if (SELFTEST_REPORT) {
  app.setPath('userData', fs.mkdtempSync(path.join(require('os').tmpdir(), 'po-launcher-selftest-')));
}

async function runSelfTest() {
  const report = { version: app.getVersion(), electron: process.versions.electron, packaged: app.isPackaged, checks: {} };
  const check = (name, pass, detail) => { report.checks[name] = { pass: !!pass, detail }; };
  const shot = async (win, name) => {
    if (!SELFTEST_SHOTS || !win || win.isDestroyed()) return;
    try { fs.mkdirSync(SELFTEST_SHOTS, { recursive: true }); fs.writeFileSync(path.join(SELFTEST_SHOTS, name), (await win.webContents.capturePage()).toPNG()); } catch {}
  };
  const loaded = (win) => new Promise((resolve) => {
    if (!win.webContents.isLoading()) return resolve();
    win.webContents.once('did-finish-load', resolve);
    win.webContents.once('did-fail-load', (_e, code, desc) => { check('load:' + win.webContents.getURL(), false, desc); resolve(); });
  });
  try {
    await loaded(mainWindow);
    const page = await mainWindow.webContents.executeJavaScript(
      `({ bridge: Object.keys(window.launcher || {}), node: typeof require !== 'undefined', play: !!document.getElementById('status-text') })`);
    check('launcher page has its bridge', page.bridge.includes('invoke') && page.bridge.includes('getPathForFile'), page.bridge);
    check('launcher page has no Node.js', page.node === false, page.node);
    check('launcher UI rendered', page.play, page.play);

    if (process.platform === 'win32') {
      const prebuilt = !!winHelperExePath && winHelperExePath.startsWith(process.resourcesPath);
      check('WinHelper available', !!winHelperExePath && fs.existsSync(winHelperExePath), winHelperExePath);
      if (app.isPackaged) check('WinHelper is the prebuilt one (nothing compiled on this machine)', prebuilt, winHelperExePath);
      const captured = captureExternalWindows();
      check('WinHelper capture runs and returns JSON', Array.isArray(captured), `${captured.length} windows`);
    }

    // The tracker (Muffins Tracker 2.0) is served from po://tracker/. Its Launch page and its
    // tracker route must both render: a build or protocol problem shows up here, not on a user.
    const rendered = (win, probe) => new Promise((resolve) => {
      const started = Date.now();
      const tick = async () => {
        let r = null;
        try { r = await win.webContents.executeJavaScript(probe); } catch {}
        if (r || Date.now() - started > 20000) return resolve(r);
        setTimeout(tick, 250);
      };
      tick();
    });
    openSettingsWindow();
    await loaded(settingsWindow);
    const launch = await rendered(settingsWindow,
      `(() => { const root = document.getElementById('root'); if (!root || !root.children.length) return null;
        return { title: document.title, api: Object.keys(window.electronAPI || {}), theme: typeof window.applyPoTheme === 'function',
                 node: typeof require !== 'undefined', path: location.pathname, origin: location.protocol + '//' + location.host }; })()`);
    check('tracker Launch page renders from po://tracker/', !!launch && launch.origin === 'po://tracker' && launch.path === '/', launch);
    check('tracker Launch page has its preload', !!launch && launch.api.includes('isElectron') && launch.theme, launch && launch.api);
    check('tracker page has no Node.js', !!launch && launch.node === false, launch && launch.node);
    // PO_LAUNCHER_SELFTEST_TAB=<tab text>: open that tab of the Launch page before the screenshot
    if (process.env.PO_LAUNCHER_SELFTEST_TAB) {
      await settingsWindow.webContents.executeJavaScript(`(() => { const t = [...document.querySelectorAll('[role="tab"]')].find(b => b.textContent.trim() === ${JSON.stringify(process.env.PO_LAUNCHER_SELFTEST_TAB)}); if (t) t.click(); return !!t; })()`).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 500));
    await shot(settingsWindow, 'launch-page.png');

    // PO_LAUNCHER_SELFTEST_PREFS=<json>: remembered tracker preferences to seed before the tracker opens
    if (process.env.PO_LAUNCHER_SELFTEST_PREFS) {
      await settingsWindow.webContents.executeJavaScript(`localStorage.setItem('muffins_launcher_prefs', JSON.stringify(Object.assign(JSON.parse(localStorage.getItem('muffins_launcher_prefs') || '{}'), ${process.env.PO_LAUNCHER_SELFTEST_PREFS}))); true`).catch(() => {});
    }
    // PO_LAUNCHER_SELFTEST_LS=<json>: tracker localStorage entries (key -> value) to set before the tracker opens
    if (process.env.PO_LAUNCHER_SELFTEST_LS) {
      await settingsWindow.webContents.executeJavaScript(`(() => { const o = ${process.env.PO_LAUNCHER_SELFTEST_LS}; for (const k of Object.keys(o)) localStorage.setItem(k, typeof o[k] === 'string' ? o[k] : JSON.stringify(o[k])); return true; })()`).catch(() => {});
      // ...and show the Launch page as it starts with those entries in place
      settingsWindow.webContents.reload();
      await loaded(settingsWindow);
      await rendered(settingsWindow, `!!(document.getElementById('root') && document.getElementById('root').children.length)`);
      if (process.env.PO_LAUNCHER_SELFTEST_TAB) {
        await settingsWindow.webContents.executeJavaScript(`(() => { const t = [...document.querySelectorAll('[role="tab"]')].find(b => b.textContent.trim() === ${JSON.stringify(process.env.PO_LAUNCHER_SELFTEST_TAB)}); if (t) t.click(); return !!t; })()`).catch(() => {});
      }
      await new Promise(r => setTimeout(r, 500));
      await shot(settingsWindow, 'launch-page-seeded.png');
    }
    openTrackerWindow();
    await loaded(trackerWindow);
    const tracker = await rendered(trackerWindow,
      `(() => { const el = document.querySelector('[data-tracker-bounds]'); if (!el) return null;
        return { path: location.pathname, search: location.search, width: parseFloat(el.style.width), height: parseFloat(el.style.height) }; })()`);
    check('tracker route renders a session and reports its size', !!tracker && tracker.path === '/tracker' && /[?&]id=/.test(tracker.search) && tracker.width > 0, tracker);
    const dims = await new Promise((resolve) => { const t0 = Date.now(); const tick = () => (trackerContentDims || Date.now() - t0 > 5000) ? resolve(trackerContentDims) : setTimeout(tick, 100); tick(); });
    check('main received the tracker size and locked the aspect ratio', !!dims && dims.width > 0, dims);
    await new Promise(r => setTimeout(r, 500));
    // PO_LAUNCHER_SELFTEST_PROBE=<js>: an expression evaluated in the tracker window, reported as "probe"
    if (process.env.PO_LAUNCHER_SELFTEST_PROBE) {
      report.probe = await trackerWindow.webContents.executeJavaScript(process.env.PO_LAUNCHER_SELFTEST_PROBE).catch((e) => String(e));
    }
    await shot(trackerWindow, 'tracker.png');
    await shot(mainWindow, 'launcher.png');
  } catch (err) {
    check('self-test ran to completion', false, err.stack);
  }
  report.ok = Object.values(report.checks).every(c => c.pass);
  try { fs.writeFileSync(SELFTEST_REPORT, JSON.stringify(report, null, 2)); } catch {}
  app.exit(report.ok ? 0 : 1);
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
    registerTrackerProtocol();
    createMainWindow();
    compileWindowHelper();
    if (SELFTEST_REPORT) runSelfTest();
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
// ============================================================
//  IPC — Music Pack Scan
// ============================================================
// A pack is any folder that directly contains a .msu file. Starting from the folder the user
// picked, the scan looks up to SCAN_MAX_DEPTH levels down, so a library laid out as
// MSU\Zelda\<pack>\ still works, and if the picked folder itself holds a .msu it is offered as
// a pack (someone pointed at one pack instead of the folder above it). Unreadable folders are
// skipped and counted, never fatal; junctions and symlinks to folders are followed.
//
// The scan is asynchronous: it yields between folders, sends 'scan-progress' counts to the
// window, and stops early when the UI sends 'cancel-scan' or asks for a newer scan.
//
// Result: { packs, folders, skipped, cancelled, depthReached, ms }
//   packs[].name is the pack folder's path below the picked folder joined with " / ", so packs
//   at different depths cannot collide. Level-1 packs keep their bare folder name, which is
//   what the saved lastPack setting already holds.
const SCAN_MAX_DEPTH = 3;
const SCAN_SKIP_NAMES = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git']);
let scanGeneration = 0;

async function scanPacksFolder(rootDir, { isCancelled = () => false, onProgress = () => {} } = {}) {
  const t0 = Date.now();
  const result = { packs: [], folders: 0, skipped: 0, cancelled: false, depthReached: 0, ms: 0 };
  const done = () => { result.ms = Date.now() - t0; result.packs.sort((x, y) => x.name.localeCompare(y.name)); return result; };

  // List one folder; record it as a pack if a .msu sits directly inside. null = unreadable.
  const listFolder = async (dir, name) => {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch { result.skipped++; return null; }
    result.folders++;
    const msu = entries.find(e => !e.isDirectory() && e.name.toLowerCase().endsWith('.msu'));
    if (msu) result.packs.push({ name, path: dir, msuBase: path.parse(msu.name).name });
    return entries;
  };

  const rootEntries = await listFolder(rootDir, path.basename(rootDir) || rootDir);
  if (!rootEntries) return done();

  let frontier = [{ dir: rootDir, entries: rootEntries, rel: [] }];
  for (let depth = 1; depth <= SCAN_MAX_DEPTH && frontier.length; depth++) {
    const next = [];
    for (const { dir, entries, rel } of frontier) {
      for (const entry of entries) {
        if (isCancelled()) { result.cancelled = true; return done(); }
        if (SCAN_SKIP_NAMES.has(entry.name.toLowerCase())) { result.skipped++; continue; }
        const sub = path.join(dir, entry.name);
        let isDir = entry.isDirectory();
        if (!isDir && entry.isSymbolicLink()) {
          try { isDir = (await fs.promises.stat(sub)).isDirectory(); } catch { result.skipped++; continue; }
        }
        if (!isDir) continue;
        const relNames = [...rel, entry.name];
        const subEntries = await listFolder(sub, relNames.join(' / '));
        if (subEntries) { result.depthReached = depth; next.push({ dir: sub, entries: subEntries, rel: relNames }); }
        if (result.folders % 25 === 0) onProgress(result.folders);
      }
    }
    frontier = next;
  }
  return done();
}

ipcMain.handle('scan-packs', async (event, parentDir) => {
  const gen = ++scanGeneration;                         // a newer scan or cancel-scan bumps this
  const sender = event && event.sender;
  const onProgress = (n) => { try { if (sender && !sender.isDestroyed()) sender.send('scan-progress', n); } catch {} };
  return scanPacksFolder(parentDir, { isCancelled: () => scanGeneration !== gen, onProgress });
});

ipcMain.handle('cancel-scan', () => { scanGeneration++; });

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
//  Archipelago patch manifest — which room does this seed belong to?
// ============================================================
// An .aplttp is an ordinary zip with an archipelago.json manifest inside. It names the
// player's slot ("player_name") and, when the patch came from a hosted room page, the room's
// host:port ("server"; empty for self-hosted seeds). The race timer fills itself in from it.
// Walk the central directory from the end of the file and inflate just that one entry; no
// zip library needed for a 200-byte JSON file.
function readApPatchManifest(file) {
  try {
    const buf = fs.readFileSync(file);
    // End-of-central-directory record: signature 0x06054b50, within the last 64 KiB + 22 bytes.
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    for (let n = 0; n < count && p + 46 <= buf.length; n++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) break;
      const method = buf.readUInt16LE(p + 10);
      const csize = buf.readUInt32LE(p + 20);
      const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
      const localOff = buf.readUInt32LE(p + 42);
      const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
      if (name === 'archipelago.json' || name.endsWith('/archipelago.json')) {
        if (buf.readUInt32LE(localOff) !== 0x04034b50) return null;
        const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
        const raw = buf.subarray(start, start + csize);
        const data = method === 8 ? zlib.inflateRawSync(raw) : method === 0 ? raw : null;
        return data ? JSON.parse(data.toString('utf8')) : null;
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
  } catch { /* not a zip (old-style patch) or unreadable — the timer simply stays blank */ }
  return null;
}

// Remember the room a seed belongs to, and hand it to the race timer if it is open.
function rememberApRoom(patchFile) {
  const m = readApPatchManifest(patchFile);
  if (!m || typeof m.player_name !== 'string' || !m.player_name) return null;
  const room = {
    server: typeof m.server === 'string' ? m.server : '',
    slot: m.player_name,
    game: typeof m.game === 'string' ? m.game : '',
    file: path.basename(patchFile),
    at: Date.now(),
  };
  saveSettings({ apRoom: room });
  if (raceTimerWindow && !raceTimerWindow.isDestroyed()) {
    raceTimerWindow.webContents.executeJavaScript(`if(typeof applyPoRoomHint==='function'){applyPoRoomHint(${JSON.stringify(room)})}`).catch(() => {});
  }
  return room;
}

// ============================================================
//  Archipelago host.yaml — who starts the ROM?
// ============================================================
// For .aplttp seeds the launcher starts the emulator itself (that is how it can pass --lua=
// and restore the layout). If Archipelago's own "rom_start" is also on, the emulator opens
// twice. This is the in-app version of the two "Arch Auto Rom On/Off.bat" files and edits the
// same two keys, the same way: line by line, only inside their own sections, nothing else
// in the file touched.
const AP_HOST_YAML = 'C:\\ProgramData\\Archipelago\\host.yaml';
const AP_ROMSTART_KEYS = { sni_options: 'snes_rom_start', bizhawkclient_options: 'rom_start' };

// Walk the file; call visit(section, match, lineIndex) for each of the two keys found.
function scanApHostYaml(lines, visit) {
  let section = '';
  lines.forEach((line, i) => {
    const top = /^([A-Za-z0-9_]+):/.exec(line);
    if (top) section = top[1];
    else if (/^\S/.test(line)) section = '';
    const key = AP_ROMSTART_KEYS[section];
    if (!key) return;
    const m = new RegExp(`^(\\s+${key}\\s*:\\s*)(.*?)(\\s*(?:#.*)?)$`).exec(line);
    if (m) visit(section, m, i);
  });
}

// { found, on, values }   on = Archipelago will start the ROM itself (anything but "false")
function readApRomStart(file = AP_HOST_YAML) {
  try {
    const values = {};
    scanApHostYaml(fs.readFileSync(file, 'utf-8').split(/\r?\n/), (section, m) => { values[section] = m[2]; });
    const on = Object.values(values).some(v => v.replace(/['"]/g, '').toLowerCase() !== 'false');
    return { found: Object.keys(values).length > 0, on, values };
  } catch { return { found: false, on: false, values: {} }; }
}

// Turn Archipelago's rom_start off (false) or back on. A value other than true/false — AP also
// accepts a path to an emulator there — is remembered in settings and put back as it was.
function writeApRomStart(enable, file = AP_HOST_YAML) {
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    const previous = { ...(loadSettings().apRomStartPrevious || {}) };
    scanApHostYaml(lines, (section, m, i) => {
      const isOff = m[2].replace(/['"]/g, '').toLowerCase() === 'false';
      if (!enable && !isOff) { previous[section] = m[2]; lines[i] = `${m[1]}false${m[3]}`; }
      if (enable && isOff)   { lines[i] = `${m[1]}${previous[section] || 'true'}${m[3]}`; }
    });
    if (!fs.existsSync(file + '.po-launcher.bak')) fs.copyFileSync(file, file + '.po-launcher.bak');
    const tmp = file + '.po-launcher.tmp';
    fs.writeFileSync(tmp, lines.join(eol), 'utf-8');
    fs.renameSync(tmp, file);
    saveSettings({ apRomStartPrevious: previous });
    return { ok: true, ...readApRomStart(file) };
  } catch (err) {
    return { ok: false, error: err.message, ...readApRomStart(file) };
  }
}

ipcMain.handle('ap-romstart-get', () => readApRomStart());
ipcMain.handle('ap-romstart-set', (event, enable) => writeApRomStart(!!enable));

// ============================================================
//  Setup guide
// ============================================================
// What the first-run guide needs from here: the app version (the guide shows once per
// version), where the Archipelago pieces usually are, and whether each configured path still
// exists on disk (so an upgrade check can say "no longer found" instead of nothing).
const GUIDE_CANDIDATES = {
  sni: [
    'C:\\ProgramData\\Archipelago\\SNI\\sni.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Archipelago', 'SNI', 'sni.exe'),
  ],
  connectorLua: [
    'C:\\ProgramData\\Archipelago\\SNI\\lua\\Connector.lua',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Archipelago', 'SNI', 'lua', 'Connector.lua'),
  ],
};

ipcMain.handle('guide-info', () => {
  const s = loadSettings();
  const firstExisting = (list) => list.find(p => p && fs.existsSync(p)) || null;
  const exists = (p) => !!p && fs.existsSync(p);
  let downloads = null;
  try { downloads = app.getPath('downloads'); } catch {}
  return {
    version: app.getVersion(),
    found: {
      sni: firstExisting(GUIDE_CANDIDATES.sni),
      connectorLua: firstExisting(GUIDE_CANDIDATES.connectorLua),
      hostYaml: fs.existsSync(AP_HOST_YAML),
      downloads,
    },
    exists: {
      emulatorPath: exists(s.emulatorPath), sniPath: exists(s.sniPath), timerPath: exists(s.timerPath),
      luaScriptPath: exists(s.luaScriptPath), packsFolder: exists(s.packsFolder), stagingFolder: exists(s.stagingFolder),
    },
  };
});

// ============================================================
//  Update check
// ============================================================
// The portable exe cannot update itself, but it can say that a newer one exists. One anonymous
// request to GitHub per start; turn it off with "checkForUpdates": false in the settings file.
const RELEASES_API = 'https://api.github.com/repos/Penderrin-Projects/alttpr-po-launcher/releases/latest';
const RELEASES_PAGE = 'https://github.com/Penderrin-Projects/alttpr-po-launcher/releases/latest';

function isNewerVersion(latest, current) {
  const parse = (v) => { const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim()); return m ? m.slice(1).map(Number) : null; };
  const a = parse(latest), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}

ipcMain.handle('check-for-update', async () => {
  if (loadSettings().checkForUpdates === false) return null;
  try {
    const res = await net.fetch(RELEASES_API, { headers: { 'User-Agent': 'alttpr-po-launcher', 'Accept': 'application/vnd.github+json' } });
    if (!res.ok) return null;
    const release = await res.json();
    if (release.draft || release.prerelease) return null;
    return isNewerVersion(release.tag_name, app.getVersion()) ? { version: String(release.tag_name), current: app.getVersion() } : null;
  } catch { return null; }
});
// The page never supplies the URL; it can only ask for this one fixed page to be opened.
ipcMain.handle('open-release-page', () => { shell.openExternal(RELEASES_PAGE); });

// ============================================================
//  Tracker: scan the running game for this seed's settings
// ============================================================
// The tracker settings page already knows how to do this - its AUTO-CONFIGURE button reads the
// ROM through SNI and, for alttpr.com seeds, fetches the seed's settings - so the scan runs that
// page in a hidden window, waits for "Tracker auto-configured.", captures the query its LAUNCH
// TRACKER button would open, and reloads the visible tracker with it. The saved preset is left
// alone; the detected settings last for this tracker window only.
// ============================================================
//  IPC — Tracker Windows
// ============================================================
ipcMain.handle('open-tracker', () => openTrackerWindow());
ipcMain.handle('open-race-timer', () => openRaceTimerWindow());
ipcMain.handle('open-tracker-settings', () => { openSettingsWindow(); });

// Always true: the tracker launches into standard open mode until something else is launched.
ipcMain.handle('has-tracker-config', () => true);
// 'custom' once the user has launched from the tracker's Launch page (that launch is what the
// launcher reuses), 'default' while the tracker's own defaults are in use.
ipcMain.handle('tracker-preset-source', () => (loadSettings().trackerLaunched ? 'custom' : 'default'));

// Theme propagation to all open tracker/settings windows
ipcMain.handle('set-theme', (event, themeName) => {
  themeName = safeThemeName(themeName);
  saveSettings({ theme: themeName });   // first, so applyThemeTo() reads the new one
  for (const win of [trackerWindow, settingsWindow, raceTimerWindow, trackerPopouts.map, trackerPopouts.log]) applyThemeTo(win);
});

// Debug dumps (capture-raw.txt, layout-debug.json, restore-debug.json, *-error.txt).
//
// They used to be written on every run next to process.execPath. In the portable build that
// is the temp extraction folder, so nobody could find them anyway. They now go to
// <userData>/logs, and only when asked for:
//   - always when running from source (npm start), as before
//   - in a packaged build when PO_LAUNCHER_DEBUG=1 is set, or "debugLogs": true is in
//     po-launcher-settings.json
// Writing them is best-effort and can never fail real work.
function writeDebugFile(name, content) {
  try {
    const enabled = !app.isPackaged || process.env.PO_LAUNCHER_DEBUG === '1' || loadSettings().debugLogs === true;
    if (!enabled) return;
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), content, 'utf-8');
  } catch {}
}

// ============================================================
//  LAYOUT — Window Capture & Restore (WinHelper.exe)
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
  // Use the WinHelper exe if one is available
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

  // No helper available (no prebuilt exe and no csc.exe to build one). External windows
  // are simply not captured; the launcher's own windows still are.
  return [];
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

  // Capture the race timer (Electron window) with its mode, so the layout brings it back
  // the same shape it was saved in.
  if (raceTimerWindow && !raceTimerWindow.isDestroyed() && !raceTimerWindow.isMinimized()) {
    layout.raceTimerWindow = { ...raceTimerWindow.getBounds(), mode: raceTimerMode() };
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

  const count = (layout.mainWindow ? 1 : 0) + (layout.trackerWindow ? 1 : 0) + (layout.raceTimerWindow ? 1 : 0) + externalWindows.length;
  return { saved: true, windowCount: count };
});

// skipProcesses: process names (exe name without .exe) whose windows should not be restored
// this time, e.g. a timer the user has unticked. Without this the helper would spend its
// 20 seconds waiting for a window that is never going to appear.
// Process names of the companions NOT being started on this launch.
function skippedCompanions({ launchEmulator, emulatorPath, launchSni, sniPath, launchTimer, timerPath }) {
  const out = [];
  const nameOf = (p) => (p ? path.parse(p).name : null);
  if (!launchEmulator && nameOf(emulatorPath)) out.push(nameOf(emulatorPath));
  if (!launchSni && nameOf(sniPath)) out.push(nameOf(sniPath));
  if (!launchTimer && nameOf(timerPath)) out.push(nameOf(timerPath));
  return out;
}

function restoreLayout(layoutType, skipProcesses = []) {
  const settings = loadSettings();
  const key = layoutType === 'aplttp' ? 'layoutAplttp' : 'layoutSfc';
  const layout = settings[key];
  if (!layout) return;

  // Restore Electron windows immediately
  // (skipped when the saved spot is on a monitor that isn't connected right now)
  if (layout.mainWindow && mainWindow && !mainWindow.isDestroyed() && boundsAreVisible(layout.mainWindow)) {
    mainWindow.setPosition(layout.mainWindow.x, layout.mainWindow.y);   // size is fixed since 2.3.0
  }
  if (layout.trackerWindow && trackerWindow && !trackerWindow.isDestroyed() && boundsAreVisible(layout.trackerWindow)) {
    trackerWindow.setBounds(layout.trackerWindow);
  }
  // The race timer was part of this layout: open it if it isn't, in the saved mode, and place it.
  if (layout.raceTimerWindow && boundsAreVisible(layout.raceTimerWindow)) {
    const { mode, ...bounds } = layout.raceTimerWindow;
    openRaceTimerWindow({ mode: mode === 'compact' ? 'compact' : 'full', bounds });
  }

  // Poll for external windows and restore each as it appears
  const skip = new Set(skipProcesses.map(p => p.toLowerCase()));
  const wanted = (layout.externalWindows || []).filter(w => !skip.has(String(w.process).toLowerCase()));
  if (wanted.length > 0) {
    writeDebugFile('restore-debug.json', JSON.stringify(wanted, null, 2));
    pollAndRestoreExternalWindows(wanted);
  }
}

// Restore external windows using compiled helper exe.
// The exe polls internally every 300ms until all windows found or 20s timeout.
// Starts in ~100ms vs PowerShell's ~3s.
function pollAndRestoreExternalWindows(targetWindows) {
  if (winHelperExePath && fs.existsSync(winHelperExePath)) {
    // Write target windows to JSON config file
    const configPath = path.join(app.getPath('temp'), 'po-launcher', 'restore-config.json');
    // This folder used to exist as a side effect of compiling the helper into it. With a
    // prebuilt helper nothing else creates it, so make sure it is there.
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(targetWindows), { encoding: 'utf-8' });

    // Fire and forget — exe handles polling internally
    exec(
      `"${winHelperExePath}" restore "${configPath}"`,
      { windowsHide: true, timeout: 25000 }
    );
    return;
  }

  // No helper available: external windows are left where they open.
}


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

  // No script configured — generate a dummy that just opens the console.
  // Written to userData, not next to the exe: an installed copy may live in Program Files.
  const base = app.isPackaged ? app.getPath('userData') : __dirname;
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
// expectName (optional): only accept this exact file name (case-insensitive), used when the
// .aplttp is opened where it lies and the folder may hold unrelated .sfc files.
function waitForGeneratedSfc(packDir, timeoutMs = 60000, pollMs = 250, expectName = null) {
  const want = expectName ? expectName.toLowerCase() : null;
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
        const sfc = fs.readdirSync(packDir).find(f => want ? f.toLowerCase() === want : f.toLowerCase().endsWith('.sfc'));
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

    // With a pack: copy the ROM into the pack folder under the pack's name (copy first, then
    // clean old ROMs — see stageRom). Without one: play the ROM where it is, original soundtrack.
    const destRom = pack ? stageRom(romPath, pack) : romPath;

    // If the ROM was launched from inside the pack folder, its old name is gone now;
    // the renderer needs the new path or the next Play would fail with "file not found".
    const romMovedTo = pack && !fs.existsSync(romPath) ? destRom : null;

    // Companions we found already running and therefore did not start again
    const alreadyRunning = [];

    // Open the tracker (a fresh session from the last launch)
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
      rememberApRoom(destRom);

      // Launch timer
      if (launchTimer && timerPath) {
        if (launchAppOnce(timerPath)) alreadyRunning.push('Timer');
      }

      // Poll for the generated .sfc file (Archipelago creates it next to the .aplttp) — 60s timeout.
      // In a pack folder it is the only .sfc there; without a pack the folder may hold other
      // ROMs, so wait for the one named after the .aplttp.
      const generatedSfc = pack
        ? await waitForGeneratedSfc(pack.path)
        : await waitForGeneratedSfc(path.dirname(destRom), 60000, 250, path.parse(destRom).name + '.sfc');

      if (!generatedSfc) {
        return { success: false, error: 'Timeout waiting for Archipelago to generate .sfc' };
      }

      // Launch SNI
      if (launchSni && sniPath) {
        if (launchAppOnce(sniPath)) alreadyRunning.push('SNI');
      }

      // Start layout restore
      restoreLayout('aplttp', skippedCompanions({ launchEmulator, emulatorPath, launchSni, sniPath, launchTimer, timerPath }));

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
      restoreLayout(layoutType, skippedCompanions({ launchEmulator, emulatorPath, launchSni, sniPath, launchTimer, timerPath }));

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

    const apRomStartOn = isArchipelago && readApRomStart().on;
    return { success: true, trackerResult, romMovedTo, alreadyRunning, apRomStartOn, usedPack: !!pack };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
