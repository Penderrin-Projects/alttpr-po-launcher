// The page no longer has Node.js. These two shims keep every call site below unchanged:
// they forward to the narrow API exposed by launcher-preload.js.
const ipcRenderer = {
  invoke: (channel, ...args) => window.launcher.invoke(channel, ...args),
  on: (channel, callback) => {
    if (channel === 'tracker-configured') window.launcher.onTrackerConfigured(callback);
    if (channel === 'scan-progress') window.launcher.onScanProgress(callback);
  },
};
const path = {
  // same result as Node's path.extname() for a bare file name
  extname: (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i) : ''; },
};

// --- Theme Definitions (shared with tracker po-themes.js) ---
// Workbench: one charcoal ground for every theme; the accent is what changes.
// (Same table as tracker/js/po-themes.js — keep them in step.)
const WB = { bg: "#141517", bgPanel: "#1b1d21", bgInput: "#101113", border: "#26282d", borderLight: "#33363d", headerBg: "#141517" };
const poThemes = {
  amber:  { accent: "#e8a33d", hover: "#f2b95c", glow: "rgba(232, 163, 61, 0.14)", ...WB },
  orange: { accent: "#e07a4a", hover: "#ef9668", glow: "rgba(224, 122, 74, 0.14)", ...WB },
  red:    { accent: "#e0604f", hover: "#ec7f70", glow: "rgba(224, 96, 79, 0.14)",  ...WB },
  green:  { accent: "#5cb883", hover: "#7ccb9c", glow: "rgba(92, 184, 131, 0.14)", ...WB },
  teal:   { accent: "#5fb0a5", hover: "#7fc6bc", glow: "rgba(95, 176, 165, 0.14)", ...WB },
  blue:   { accent: "#6ea8e8", hover: "#8cbdf0", glow: "rgba(110, 168, 232, 0.14)", ...WB },
  purple: { accent: "#b391e0", hover: "#c6ace9", glow: "rgba(179, 145, 224, 0.14)", ...WB },
  slate:  { accent: "#c9c4b8", hover: "#dedad0", glow: "rgba(201, 196, 184, 0.12)", ...WB },
};
// Themes from before 2.3.0 (each had its own tinted background). Users who never picked one
// were on 'blue'; they get the new default. A deliberate colour choice is kept.
const LEGACY_THEMES = { blue: 'amber', midnight: 'amber', black: 'slate', ember: 'red', yellow: 'amber' };

let currentTheme = 'amber';

function applyTheme(name) {
  const theme = poThemes[name] || poThemes.amber;
  currentTheme = name;
  const r = document.documentElement;
  r.style.setProperty('--accent-color', theme.accent);
  r.style.setProperty('--accent-hover', theme.hover);
  r.style.setProperty('--accent-glow', theme.glow);
  r.style.setProperty('--theme-bg', theme.bg);
  r.style.setProperty('--theme-panel', theme.bgPanel);
  r.style.setProperty('--theme-input', theme.bgInput);
  r.style.setProperty('--theme-border', theme.border);
  r.style.setProperty('--theme-border-light', theme.borderLight);
  r.style.setProperty('--theme-header-bg', theme.headerBg);

  // Update swatch active states
  document.querySelectorAll('.theme-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.theme === name);
  });

  // Tell main process to propagate to tracker windows
  ipcRenderer.invoke('set-theme', name);
}

function buildThemeSwatches() {
  const container = document.getElementById('theme-swatches');
  container.innerHTML = '';
  for (const [name, theme] of Object.entries(poThemes)) {
    const swatch = document.createElement('div');
    swatch.className = 'theme-swatch' + (name === currentTheme ? ' active' : '');
    swatch.dataset.theme = name;
    swatch.title = name.charAt(0).toUpperCase() + name.slice(1);
    swatch.style.background = theme.accent;
    swatch.addEventListener('click', () => {
      applyTheme(name);
      persistSettings();
    });
    container.appendChild(swatch);
  }
}

// --- State ---
let packsFolder = null;
let packs = [];
let selectedPack = null;              // null = original soundtrack (no music pack)
let setupSkipped = false;             // packs step skipped on purpose (no packs folder)
let setupVersion = null;              // app version the setup guide was last finished for
let lastScan = null;                  // summary of the most recent pack scan
let scanSlowTimer = null;
let scanning = false;                 // a pack scan is in progress
let romPath = null;
let romFilename = null;
let emulatorPath = null;
let sniPath = null;
let luaScriptPath = null;
let stagingFolder = null;
let timerPath = null;

// --- DOM refs ---
const dropZone = document.getElementById('drop-zone');
const dropIcon = document.getElementById('drop-icon');
const dropLabel = document.getElementById('drop-label');
const dropFilename = document.getElementById('drop-filename');
const packListEl = document.getElementById('pack-list');
const packCount = document.getElementById('pack-count');
const playBtn = document.getElementById('play-btn');
const playLabel = document.getElementById('play-label');
const playHint = document.getElementById('play-hint');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const btnRefresh = document.getElementById('btn-refresh');
const btnChangeFolder = document.getElementById('btn-change-folder');
const btnMinimize = document.getElementById('btn-minimize');
const btnClose = document.getElementById('btn-close');

const btnRomRefresh = document.getElementById('btn-rom-refresh');
const btnRomStagingFolder = document.getElementById('btn-rom-staging-folder');

const btnLaunchTracker = document.getElementById('btn-launch-tracker');
const btnTrackerSettings = document.getElementById('btn-tracker-settings');

const btnSaveLayoutSfc = document.getElementById('btn-save-layout-sfc');
const btnSaveLayoutAplttp = document.getElementById('btn-save-layout-aplttp');

const settingsPanel = document.getElementById('settings-panel');
const settingsBtn = document.getElementById('settings-btn');
const settingsClose = document.getElementById('settings-close');

const chkEmulator = document.getElementById('chk-emulator');
const chkLua = document.getElementById('chk-lua');
const chkTracker = document.getElementById('chk-tracker');
const chkSni = document.getElementById('chk-sni');
const emulatorPathEl = document.getElementById('emulator-path');
const sniPathEl = document.getElementById('sni-path');
const btnBrowseEmulator = document.getElementById('btn-browse-emulator');
const btnBrowseSni = document.getElementById('btn-browse-sni');
const luaOption = document.getElementById('lua-option');
const luaScriptOption = document.getElementById('lua-script-option');
const luaScriptPathEl = document.getElementById('lua-script-path');
const btnBrowseLuaScript = document.getElementById('btn-browse-lua-script');

const chkTimer = document.getElementById('chk-timer');
const timerPathEl = document.getElementById('timer-path');
const btnBrowseTimer = document.getElementById('btn-browse-timer');

// --- Title bar ---
btnMinimize.addEventListener('click', () => ipcRenderer.invoke('minimize-window'));
btnClose.addEventListener('click', () => ipcRenderer.invoke('close-window'));

// --- Helpers ---
function isBizhawk() {
  if (!emulatorPath) return false;
  const lower = emulatorPath.toLowerCase();
  return lower.includes('bizhawk') || lower.includes('emuhawk');
}

function updateLuaVisibility() {
  const show = chkEmulator.checked && isBizhawk();
  luaOption.style.display = show ? 'flex' : 'none';
  luaScriptOption.style.display = (show && chkLua.checked) ? 'flex' : 'none';
}

// "Downloads · SFC" style line under the loaded ROM name
function romOrigin(filePath, filename) {
  const sep = filePath.lastIndexOf('\\') >= 0 ? '\\' : '/';
  const parts = filePath.split(sep);
  const folder = parts.length > 1 ? parts[parts.length - 2] : '';
  const ext = path.extname(filename).replace('.', '').toUpperCase();
  return [folder, ext === 'APLTTP' ? 'Archipelago' : ext].filter(Boolean).join(' · ');
}

function updatePlayState() {
  const ready = !!romPath;                       // a music pack is optional
  if (ready) {
    const ext = path.extname(romPath).replace('.', '').toUpperCase();
    playHint.textContent = `${ext === 'APLTTP' ? 'AP' : ext} · ${selectedPack ? selectedPack.name : 'Original soundtrack'}`;
  } else {
    playHint.textContent = 'Load a ROM';
  }
  playBtn.disabled = !ready;
  if (ready) {
    playBtn.classList.add('ready');
    playBtn.classList.remove('disabled');
  } else {
    playBtn.classList.remove('ready');
    playBtn.classList.add('disabled');
  }
}

function setStatus(text, type) {
  statusText.textContent = text;
  statusDot.className = 'status-dot';
  if (type) statusDot.classList.add(type);
}

function displayPath(el, fullPath, defaultText) {
  if (fullPath) {
    el.textContent = fullPath;
    el.classList.remove('not-set');
    el.title = fullPath;
  } else {
    el.textContent = defaultText || 'Not set';
    el.classList.add('not-set');
    el.title = '';
  }
}

function setRomLoaded(filePath, filename) {
  romPath = filePath;
  romFilename = filename;
  dropZone.classList.add('has-rom');
  dropFilename.textContent = filename;
  dropLabel.textContent = romOrigin(filePath, filename);
  playLabel.textContent = 'Play';
  setStatus('ROM ready', 'success');
  updatePlayState();
}

function clearRom() {
  romPath = null;
  romFilename = null;
  dropZone.classList.remove('has-rom');
  dropLabel.textContent = 'Drop a .sfc or .aplttp here';
  dropFilename.textContent = '';
  setStatus('ROM cleared', '');
  updatePlayState();
}

async function persistSettings() {
  await ipcRenderer.invoke('save-settings', {
    packsFolder,
    lastPack: selectedPack ? selectedPack.name : null,
    setupSkipped,
    setupVersion,
    emulatorPath,
    sniPath,
    luaScriptPath,
    stagingFolder,
    emulatorEnabled: chkEmulator.checked,
    luaEnabled: chkLua.checked,
    trackerEnabled: chkTracker.checked,
    sniEnabled: chkSni.checked,
    timerPath,
    timerEnabled: chkTimer.checked,
    theme: currentTheme,
  });
}

// --- ROM Staging ---
async function setStagingFolder(folder) {
  stagingFolder = folder;
  await persistSettings();
  setStatus('Seeds folder set', 'success');
  await loadFromStaging();
}
btnRomStagingFolder.addEventListener('click', async () => {
  const folder = await ipcRenderer.invoke('pick-folder');
  if (folder) await setStagingFolder(folder);
});

btnRomRefresh.addEventListener('click', async () => {
  if (!stagingFolder) {
    // No staging folder set — prompt to pick one
    const folder = await ipcRenderer.invoke('pick-folder');
    if (folder) {
      stagingFolder = folder;
      await persistSettings();
    } else {
      return;
    }
  }
  btnRomRefresh.classList.add('spinning');
  await loadFromStaging();
  setTimeout(() => btnRomRefresh.classList.remove('spinning'), 500);
});

async function loadFromStaging() {
  if (!stagingFolder) return;
  const rom = await ipcRenderer.invoke('scan-staging-folder', stagingFolder);
  if (rom) {
    setRomLoaded(rom.path, rom.name);
  } else {
    setStatus('No ROMs found in staging folder', 'error');
  }
}

// --- Pack List ---
function renderPacks() {
  packListEl.innerHTML = '';

  // Always-available first entry: play with the game's own music.
  const none = document.createElement('div');
  none.className = 'pack-item pack-item-none' + (selectedPack ? '' : ' selected');
  const noneName = document.createElement('span');
  noneName.className = 'pack-item-name';
  noneName.textContent = 'Original soundtrack';
  const noneMsu = document.createElement('span');
  noneMsu.className = 'pack-item-msu';
  noneMsu.textContent = 'no pack';
  none.appendChild(noneName);
  none.appendChild(noneMsu);
  none.addEventListener('click', () => {
    selectedPack = null;
    renderPacks();
    updatePlayState();
    persistSettings();
  });
  packListEl.appendChild(none);

  if (packs.length === 0 && packsFolder && lastScan && !scanning) {
    const empty = document.createElement('div');
    empty.className = 'pack-empty';
    const deep = lastScan.depthReached ? `${lastScan.depthReached} level${lastScan.depthReached === 1 ? '' : 's'} deep` : 'the folder itself';
    const skipped = lastScan.skipped ? `, ${lastScan.skipped} unreadable` : '';
    empty.innerHTML = `<b>No music packs found</b> in ${escapeHtml(packsFolder)}<br>` +
      `Looked ${deep} (${lastScan.folders} folder${lastScan.folders === 1 ? '' : 's'}${skipped}).<br>` +
      `A pack is a folder with a <b>.msu</b> file in it — pick the folder that holds your pack folders, or play with the original soundtrack.`;
    packListEl.appendChild(empty);
  }

  for (const pack of packs) {
    const item = document.createElement('div');
    item.className = 'pack-item';
    if (selectedPack && selectedPack.name === pack.name) item.classList.add('selected');

    const nameEl = document.createElement('span');
    nameEl.className = 'pack-item-name';
    const cut = pack.name.lastIndexOf(' / ');
    if (cut > 0) {
      const group = document.createElement('span');
      group.className = 'pack-group';
      group.textContent = pack.name.slice(0, cut + 3);
      nameEl.appendChild(group);
      nameEl.appendChild(document.createTextNode(pack.name.slice(cut + 3)));
    } else {
      nameEl.textContent = pack.name;
    }

    const msuEl = document.createElement('span');
    msuEl.className = 'pack-item-msu';
    msuEl.textContent = pack.msuBase;

    item.appendChild(nameEl);
    item.appendChild(msuEl);

    item.addEventListener('click', () => {
      selectedPack = pack;
      renderPacks();
      updatePlayState();
      persistSettings();
    });

    packListEl.appendChild(item);
  }
  let note = '';
  if (lastScan && lastScan.cancelled) note = ' · SCAN CANCELLED';
  else if (lastScan && lastScan.skipped) note = ` · ${lastScan.skipped} UNREADABLE`;
  packCount.textContent = packsFolder ? `· ${packs.length} FOUND${note}` : '';
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Settings Panel ---
settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.toggle('open');
  settingsBtn.classList.toggle('active');
});
settingsClose.addEventListener('click', () => {
  settingsPanel.classList.remove('open');
  settingsBtn.classList.remove('active');
});

// --- Tracker Buttons ---
btnLaunchTracker.addEventListener('click', async () => {
  const result = await ipcRenderer.invoke('open-tracker');
  if (result === 'needs-setup') {
    setStatus('Set up your tracker preset, then click LAUNCH TRACKER in the config window', 'working');
  } else {
    setStatus('Tracker launched', 'success');
  }
});

btnTrackerSettings.addEventListener('click', () => {
  ipcRenderer.invoke('open-tracker-settings');
  setStatus('Tracker settings opened', 'success');
});

ipcRenderer.on('tracker-configured', () => {
  setStatus('Tracker configured! You can now launch directly.', 'success');
  guideRefresh();
});

// --- Layout Buttons ---
btnSaveLayoutSfc.addEventListener('click', async () => {
  const result = await ipcRenderer.invoke('save-layout', 'sfc');
  setStatus(`SFC layout saved (${result.windowCount} window${result.windowCount !== 1 ? 's' : ''})`, 'success');
});

btnSaveLayoutAplttp.addEventListener('click', async () => {
  const result = await ipcRenderer.invoke('save-layout', 'aplttp');
  setStatus(`AP layout saved (${result.windowCount} window${result.windowCount !== 1 ? 's' : ''})`, 'success');
});

// --- Init ---
(async () => {
  const settings = await ipcRenderer.invoke('load-settings');

  // Apply theme first so UI renders with correct colors
  currentTheme = LEGACY_THEMES[settings.theme] || (poThemes[settings.theme] ? settings.theme : 'amber');
  buildThemeSwatches();
  applyTheme(currentTheme);

  emulatorPath = settings.emulatorPath || null;
  sniPath = settings.sniPath || null;
  luaScriptPath = settings.luaScriptPath || null;
  stagingFolder = settings.stagingFolder || null;
  displayPath(emulatorPathEl, emulatorPath);
  displayPath(sniPathEl, sniPath);
  displayPath(luaScriptPathEl, luaScriptPath, 'No script (console only)');

  chkEmulator.checked = settings.emulatorEnabled !== undefined ? settings.emulatorEnabled : true;
  chkLua.checked = settings.luaEnabled !== undefined ? settings.luaEnabled : true;
  chkTracker.checked = settings.trackerEnabled !== undefined ? settings.trackerEnabled : true;
  chkSni.checked = settings.sniEnabled !== undefined ? settings.sniEnabled : true;
  chkTimer.checked = settings.timerEnabled !== undefined ? settings.timerEnabled : true;
  timerPath = settings.timerPath || null;
  displayPath(timerPathEl, timerPath);
  updateLuaVisibility();

  setupSkipped = settings.setupSkipped === true;
  setupVersion = settings.setupVersion || null;
  if (settings.packsFolder) {
    packsFolder = settings.packsFolder;
    await scanPacks();
    if (settings.lastPack) {
      selectedPack = packs.find(p => p.name === settings.lastPack) || null;
      renderPacks();
      const sel = packListEl.querySelector('.selected');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    }
  } else {
    renderPacks();
  }

  updatePlayState();

  // First launch of this version: walk through setup (a quick check if a setup already exists)
  const info = await ipcRenderer.invoke('guide-info');
  if (setupVersion !== info.version) {
    const configured = !!(emulatorPath || sniPath || packsFolder || settings.lastTrackerQuery);
    openGuide(configured ? 'check' : 'setup', info);
  }
})();

// --- Packs folder ---
async function choosePacksFolder() {
  const folder = await ipcRenderer.invoke('pick-folder');
  if (folder) {
    packsFolder = folder;
    selectedPack = null;
    setupSkipped = false;
    await persistSettings();
    await scanPacks();
    setStatus('Folder changed', 'success');
  }
  return !!folder;
}
btnChangeFolder.addEventListener('click', async () => {
  await choosePacksFolder();
});

const scanBar = document.getElementById('scan-bar');
const scanText = document.getElementById('scan-text');
const btnCancelScan = document.getElementById('btn-cancel-scan');

function showScanning(folders) {
  scanBar.style.display = '';
  scanText.textContent = folders ? `Scanning… ${folders} folders` : 'Scanning…';
}

ipcRenderer.on('scan-progress', (folders) => { if (scanning) showScanning(folders); });

btnCancelScan.addEventListener('click', () => {
  scanText.textContent = 'Stopping…';
  ipcRenderer.invoke('cancel-scan');
});

async function scanPacks() {
  if (!packsFolder) { packs = []; lastScan = null; renderPacks(); updatePlayState(); return; }
  scanning = true;
  scanBar.classList.remove('slow');
  showScanning(0);
  // After a few seconds the scan is taking longer than a normal library would — make the
  // Cancel option obvious. The scan itself keeps going until the user stops it.
  clearTimeout(scanSlowTimer);
  scanSlowTimer = setTimeout(() => { if (scanning) { scanBar.classList.add('slow'); scanText.textContent += ' — this is taking a while, you can cancel'; } }, 6000);
  const result = await ipcRenderer.invoke('scan-packs', packsFolder);
  clearTimeout(scanSlowTimer);
  scanning = false;
  scanBar.style.display = 'none';
  lastScan = result;
  packs = result.packs || [];
  if (selectedPack && !packs.find(p => p.name === selectedPack.name)) selectedPack = null;
  renderPacks();
  updatePlayState();
}

btnRefresh.addEventListener('click', async () => {
  btnRefresh.classList.add('spinning');
  await scanPacks();
  setStatus('Packs refreshed', 'success');
  setTimeout(() => btnRefresh.classList.remove('spinning'), 500);
});

// --- Companion App Browsing ---
async function chooseEmulator() {
  const exe = await ipcRenderer.invoke('pick-exe', 'Select Emulator Executable');
  if (exe) {
    emulatorPath = exe;
    displayPath(emulatorPathEl, emulatorPath);
    updateLuaVisibility();
    persistSettings();
    setStatus('Emulator set', 'success');
  }
  return !!exe;
}
btnBrowseEmulator.addEventListener('click', chooseEmulator);

async function chooseSni() {
  const exe = await ipcRenderer.invoke('pick-exe', 'Select SNI Executable');
  if (exe) {
    sniPath = exe;
    displayPath(sniPathEl, sniPath);
    persistSettings();
    setStatus('SNI set', 'success');
  }
  return !!exe;
}
btnBrowseSni.addEventListener('click', chooseSni);

async function chooseLuaScript() {
  const result = await ipcRenderer.invoke('pick-exe', 'Select Lua Script');
  if (result) {
    luaScriptPath = result;
    displayPath(luaScriptPathEl, luaScriptPath, 'No script (console only)');
    persistSettings();
    setStatus('Lua script set', 'success');
  }
  return !!result;
}
btnBrowseLuaScript.addEventListener('click', chooseLuaScript);

chkEmulator.addEventListener('change', () => { updateLuaVisibility(); persistSettings(); });
chkLua.addEventListener('change', () => { updateLuaVisibility(); persistSettings(); });
chkTracker.addEventListener('change', () => persistSettings());
chkSni.addEventListener('change', () => persistSettings());

async function chooseTimer() {
  const exe = await ipcRenderer.invoke('pick-exe', 'Select Timer Executable');
  if (exe) {
    timerPath = exe;
    displayPath(timerPathEl, timerPath);
    persistSettings();
    setStatus('Timer set', 'success');
  }
  return !!exe;
}
btnBrowseTimer.addEventListener('click', chooseTimer);
chkTimer.addEventListener('change', () => persistSettings());

// --- Drag & Drop ---
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.remove('drag-over');

  const files = e.dataTransfer.files;
  if (files.length > 0) {
    const file = files[0];
    const ext = path.extname(file.name).toLowerCase();
    const filePath = window.launcher.getPathForFile(file);   // File.path was removed in Electron 32
    if ((ext === '.sfc' || ext === '.aplttp') && filePath) {
      setRomLoaded(filePath, file.name);
    } else {
      setStatus('Invalid file — drop a .sfc or .aplttp ROM', 'error');
    }
  }
});

dropZone.addEventListener('click', () => {
  if (romPath) {
    clearRom();
  }
});

// --- Play ---
playBtn.addEventListener('click', async () => {
  if (!romPath) return;

  const isAplttp = romPath.toLowerCase().endsWith('.aplttp');

  if (!isAplttp) {
    if (chkEmulator.checked && !emulatorPath) {
      setStatus('Emulator enabled but not set — open settings', 'error');
      return;
    }
    if (chkSni.checked && !sniPath) {
      setStatus('SNI enabled but not set — open settings', 'error');
      return;
    }
  }

  if (chkTracker.checked) {
    const hasConfig = await ipcRenderer.invoke('has-tracker-config');
    if (!hasConfig) {
      setStatus('First launch — set up your tracker preset, then click LAUNCH TRACKER', 'working');
      await ipcRenderer.invoke('open-tracker-settings');
      return;
    }
  }

  setStatus('Launching...', 'working');
  playBtn.disabled = true;
  playBtn.classList.remove('ready');
  playBtn.classList.add('disabled');
  playLabel.textContent = 'Working…';

  const result = await ipcRenderer.invoke('launch-rom', {
    romPath,
    pack: selectedPack,
    launchEmulator: chkEmulator.checked,
    emulatorPath,
    openLua: chkLua.checked,
    luaScriptPath,
    isBizhawk: isBizhawk(),
    launchTracker: chkTracker.checked,
    launchSni: chkSni.checked,
    sniPath,
    launchTimer: chkTimer.checked,
    timerPath,
  });

  if (result.success) {
    // ROM was launched from inside the pack folder and now carries the pack's name
    if (result.romMovedTo) romPath = result.romMovedTo;
    let msg = isAplttp ? 'Archipelago launched!' : 'Game launched!';
    if (!result.usedPack) msg += ' (original soundtrack)';
    if (result.apRomStartOn) msg += ' (Archipelago rom_start is ON — see AP fix in settings)';
    if (result.alreadyRunning && result.alreadyRunning.length > 0) {
      msg += ` (${result.alreadyRunning.join(' & ')} already running)`;
    }
    setStatus(msg, 'success');
    playLabel.textContent = 'Launched';
    setTimeout(() => {
      playLabel.textContent = 'Play';
      updatePlayState();
    }, 2000);
  } else {
    setStatus(`Error: ${result.error}`, 'error');
    playLabel.textContent = 'Play';
    updatePlayState();
  }
});

// --- Archipelago rom_start (host.yaml) ---
const apRow = document.getElementById('ap-romstart-row');
const apChk = document.getElementById('chk-ap-romstart');
const apStatus = document.getElementById('ap-romstart-status');
function showApRomStart(state) {
  const apGroup = document.getElementById('ap-group');
  if (!state || !state.found) { apRow.style.display = 'none'; apGroup.style.display = 'none'; return; }
  apRow.style.display = '';
  apGroup.style.display = '';
  apChk.checked = !state.on;                       // checked = fixed = only the launcher starts the ROM
  apStatus.className = 'companion-path ' + (state.on ? 'warn' : 'good');
  apStatus.textContent = state.on ? 'Archipelago also starts the ROM — emulator opens twice' : 'Only the launcher starts the ROM';
}
apChk.addEventListener('change', async () => {
  const state = await ipcRenderer.invoke('ap-romstart-set', !apChk.checked);
  if (state && state.ok === false) setStatus(`Could not update host.yaml: ${state.error}`, 'error');
  showApRomStart(state);
  guideRefresh();
});
ipcRenderer.invoke('ap-romstart-get').then(showApRomStart).catch(() => {});

// --- Update notice ---
ipcRenderer.invoke('check-for-update').then((update) => {
  if (!update) return;
  document.getElementById('update-text').textContent = `Version ${update.version} is available (you have ${update.current})`;
  document.getElementById('update-banner').style.display = '';
}).catch(() => {});
document.getElementById('btn-update-open').addEventListener('click', () => ipcRenderer.invoke('open-release-page'));
document.getElementById('btn-update-dismiss').addEventListener('click', () => { document.getElementById('update-banner').style.display = 'none'; });

// --- Prevent default drag on window ---
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// --- Setup guide ---
// Shown on the first launch of each version (a quick check when a setup already exists) and
// from Settings -> Setup guide. Every step uses the same choose* functions as the settings
// panel, so nothing is stored twice.
const guideEl = document.getElementById('guide');
const guide = { steps: [], index: 0, info: null, mode: 'setup', skipped: new Set() };
const GUIDE_TITLES = {
  welcome: 'Welcome', emulator: 'Emulator', sni: 'SNI', timer: 'Timer', seeds: 'Seeds folder',
  packs: 'Music packs', archipelago: 'Archipelago', tracker: 'Tracker preset', layout: 'Layouts', done: 'All set',
};
const g = (id) => document.getElementById(id);

async function openGuide(mode, info) {
  guide.info = info || await ipcRenderer.invoke('guide-info');
  guide.mode = mode;
  guide.skipped = new Set();
  guide.steps = ['welcome', 'emulator', 'sni', 'timer', 'seeds', 'packs'];
  if (guide.info.found.hostYaml) guide.steps.push('archipelago');
  guide.steps.push('tracker', 'layout', 'done');
  // Things the guide can fill in on its own
  if (!luaScriptPath && guide.info.found.connectorLua) { luaScriptPath = guide.info.found.connectorLua; displayPath(luaScriptPathEl, luaScriptPath, 'No script (console only)'); }
  if (!sniPath && guide.info.found.sni) { sniPath = guide.info.found.sni; displayPath(sniPathEl, sniPath); }
  g('guide-welcome-setup').hidden = mode !== 'setup';
  g('guide-welcome-check').hidden = mode !== 'check';
  g('guide-finish-early').hidden = mode !== 'check';
  settingsPanel.classList.remove('open');
  guideEl.hidden = false;
  showGuideStep(0);
}

function showGuideStep(i) {
  guide.index = Math.max(0, Math.min(i, guide.steps.length - 1));
  const id = guide.steps[guide.index];
  for (const sec of guideEl.querySelectorAll('.guide-step')) sec.classList.toggle('active', sec.dataset.step === id);
  g('guide-count').textContent = `STEP ${guide.index + 1} OF ${guide.steps.length}`;
  g('guide-title').textContent = GUIDE_TITLES[id];
  g('guide-back').hidden = guide.index === 0;
  g('guide-skip').hidden = ['welcome', 'layout', 'done'].includes(id);
  g('guide-next').textContent = id === 'done' ? 'Finish' : 'Next';
  g('guide-body').scrollTop = 0;
  guideRefresh();
}

// Repaint every readout from the live settings. Cheap, so it runs after any change.
function guideRefresh() {
  if (guideEl.hidden) return;
  const ex = (guide.info && guide.info.exists) || {};
  const show = (id, value, missingText, existsKey) => {
    const el = g(id); if (!el) return;
    el.classList.remove('not-set', 'good', 'warn');
    if (!value) { el.textContent = missingText; el.classList.add('not-set'); el.title = ''; return; }
    el.textContent = value; el.title = value;
    if (existsKey && guide.mode === 'check' && ex[existsKey] === false) { el.textContent = `No longer found: ${value}`; el.classList.add('warn'); }
    else el.classList.add('good');
  };
  show('guide-emulator-path', emulatorPath, 'Not set', 'emulatorPath');
  show('guide-lua-path', luaScriptPath, 'Not found — it ships with SNI, usually in C:\\ProgramData\\Archipelago\\SNI\\lua\\', 'luaScriptPath');
  g('guide-lua-block').style.display = emulatorPath && !isBizhawk() ? 'none' : '';
  show('guide-sni-path', sniPath, 'Not set', 'sniPath');
  show('guide-timer-path', timerPath, 'Not set', 'timerPath');
  show('guide-staging-path', stagingFolder, 'Not set', 'stagingFolder');
  g('guide-use-downloads').hidden = !(guide.info && guide.info.found.downloads) || stagingFolder === (guide.info && guide.info.found.downloads);
  show('guide-packs-path', packsFolder, 'Not set', 'packsFolder');
  if (packsFolder && lastScan) {
    g('guide-packs-result').textContent = packs.length
      ? `Found ${packs.length} pack${packs.length === 1 ? '' : 's'}.`
      : `No packs found in that folder (looked ${lastScan.depthReached || 0} level${lastScan.depthReached === 1 ? '' : 's'} deep). Each pack must be a folder with a .msu file in it.`;
  }
  ipcRenderer.invoke('has-tracker-config').then((has) => {
    const el = g('guide-tracker-status'); el.classList.toggle('good', has); el.classList.toggle('not-set', !has);
    el.textContent = has ? 'Preset saved' : 'No preset yet';
    if (guide.steps[guide.index] === 'done') renderGuideSummary(has);
  });
  if (guide.steps.includes('archipelago')) {
    ipcRenderer.invoke('ap-romstart-get').then((st) => {
      g('guide-ap-fix').checked = !!(st && st.found && !st.on);
      g('guide-ap-status').textContent = !st || !st.found ? 'host.yaml has no rom_start settings to change.'
        : st.on ? 'Archipelago will also start the ROM — the emulator will open twice.' : 'Only the launcher starts the ROM.';
    });
  }
}

function renderGuideSummary(hasTracker) {
  const ex = (guide.info && guide.info.exists) || {};
  const gone = (key, value) => (value && guide.mode === 'check' && ex[key] === false) ? `No longer found: ${value}` : null;
  const rows = [
    ['Emulator', emulatorPath, 'not set', gone('emulatorPath', emulatorPath)],
    ['Lua connector', emulatorPath && !isBizhawk() ? 'n/a' : luaScriptPath, 'not set', gone('luaScriptPath', luaScriptPath)],
    ['SNI', sniPath, 'not set', gone('sniPath', sniPath)],
    ['Timer', timerPath, 'skipped', gone('timerPath', timerPath)],
    ['Seeds folder', stagingFolder, 'not set', gone('stagingFolder', stagingFolder)],
    ['Music packs', packsFolder ? `${packsFolder} (${packs.length} pack${packs.length === 1 ? '' : 's'})` : null, 'original soundtrack'],
    ['Tracker preset', hasTracker ? 'saved' : null, 'not saved yet'],
  ];
  if (guide.steps.includes('archipelago')) rows.push(['AP fix', g('guide-ap-fix').checked ? 'on' : null, 'off']);
  const box = g('guide-summary'); box.innerHTML = '';
  for (const [k, v, missing, missingNow] of rows) {
    const kk = document.createElement('span'); kk.className = 'k'; kk.textContent = k;
    const vv = document.createElement('span');
    vv.className = 'v ' + (missingNow ? 'warn' : v ? 'good' : (missing === 'not set' || missing === 'not saved yet' ? 'warn' : 'skip'));
    vv.textContent = missingNow || v || missing; vv.title = v || '';
    box.appendChild(kk); box.appendChild(vv);
  }
}

async function finishGuide() {
  setupVersion = guide.info.version;
  await persistSettings();
  guideEl.hidden = true;
  renderPacks();
  updatePlayState();
  setStatus('Setup finished', 'success');
}

g('guide-next').addEventListener('click', () => {
  if (guide.steps[guide.index] === 'done') finishGuide();
  else showGuideStep(guide.index + 1);
});
g('guide-back').addEventListener('click', () => showGuideStep(guide.index - 1));
g('guide-skip').addEventListener('click', async () => {
  const id = guide.steps[guide.index];
  guide.skipped.add(id);
  if (id === 'packs' && !packsFolder) { setupSkipped = true; await persistSettings(); }
  showGuideStep(guide.index + 1);
});
g('guide-finish-early').addEventListener('click', finishGuide);
g('guide-browse-emulator').addEventListener('click', async () => { await chooseEmulator(); guideRefresh(); });
g('guide-browse-lua').addEventListener('click', async () => { await chooseLuaScript(); guideRefresh(); });
g('guide-browse-sni').addEventListener('click', async () => { await chooseSni(); guideRefresh(); });
g('guide-browse-timer').addEventListener('click', async () => { await chooseTimer(); guideRefresh(); });
g('guide-browse-staging').addEventListener('click', async () => { const f = await ipcRenderer.invoke('pick-folder'); if (f) await setStagingFolder(f); guideRefresh(); });
g('guide-use-downloads').addEventListener('click', async () => { if (guide.info.found.downloads) await setStagingFolder(guide.info.found.downloads); guideRefresh(); });
g('guide-browse-packs').addEventListener('click', async () => { await choosePacksFolder(); guideRefresh(); });
g('guide-open-tracker-settings').addEventListener('click', () => { ipcRenderer.invoke('open-tracker-settings'); });
g('guide-ap-fix').addEventListener('change', async () => {
  const state = await ipcRenderer.invoke('ap-romstart-set', !g('guide-ap-fix').checked);
  if (state && state.ok === false) setStatus(`Could not update host.yaml: ${state.error}`, 'error');
  showApRomStart(state);
  guideRefresh();
});
document.getElementById('btn-run-guide').addEventListener('click', () => openGuide('setup'));
