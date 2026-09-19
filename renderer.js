// The page no longer has Node.js. These two shims keep every call site below unchanged:
// they forward to the narrow API exposed by launcher-preload.js.
const ipcRenderer = {
  invoke: (channel, ...args) => window.launcher.invoke(channel, ...args),
  on: (channel, callback) => { if (channel === 'tracker-configured') window.launcher.onTrackerConfigured(callback); },
};
const path = {
  // same result as Node's path.extname() for a bare file name
  extname: (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i) : ''; },
};

// --- Theme Definitions (shared with tracker po-themes.js) ---
const poThemes = {
  blue:     { accent: "#58a6ff", hover: "#79c0ff", glow: "rgba(88, 166, 255, 0.15)", bg: "#0a0f1a", bgPanel: "#0c1018", bgInput: "#070b12", border: "#1a2744", borderLight: "#1e2d4a", headerBg: "#060a12" },
  red:      { accent: "#ff6b6b", hover: "#ff9999", glow: "rgba(255, 107, 107, 0.15)", bg: "#1a0a0a", bgPanel: "#180c0c", bgInput: "#120707", border: "#44201e", borderLight: "#4a2522", headerBg: "#120606" },
  orange:   { accent: "#f0883e", hover: "#f4a261", glow: "rgba(240, 136, 62, 0.15)", bg: "#1a120a", bgPanel: "#180f0c", bgInput: "#120b07", border: "#44301e", borderLight: "#4a3622", headerBg: "#120a06" },
  green:    { accent: "#3fb950", hover: "#6fdd8b", glow: "rgba(63, 185, 80, 0.15)",  bg: "#0a1a0d", bgPanel: "#0c180e", bgInput: "#071207", border: "#1a4420", borderLight: "#1e4a24", headerBg: "#061208" },
  yellow:   { accent: "#d29922", hover: "#e3b341", glow: "rgba(210, 153, 34, 0.15)", bg: "#1a150a", bgPanel: "#18120c", bgInput: "#120e07", border: "#44361e", borderLight: "#4a3c22", headerBg: "#120e06" },
  purple:   { accent: "#bc8cff", hover: "#d2a8ff", glow: "rgba(188, 140, 255, 0.15)", bg: "#120a1a", bgPanel: "#100c18", bgInput: "#0b0712", border: "#2e1a44", borderLight: "#34204a", headerBg: "#0a0612" },
  black:    { accent: "#8b949e", hover: "#b1bac4", glow: "rgba(139, 148, 158, 0.12)", bg: "#000000", bgPanel: "#0a0a0a", bgInput: "#050505", border: "#2a2a2a", borderLight: "#333333", headerBg: "#000000" },
  ember:    { accent: "#ff6b6b", hover: "#ff9999", glow: "rgba(255, 107, 107, 0.15)", bg: "#000000", bgPanel: "#0a0505", bgInput: "#050202", border: "#3a1515", borderLight: "#441a1a", headerBg: "#000000" },
  midnight: { accent: "#58a6ff", hover: "#79c0ff", glow: "rgba(88, 166, 255, 0.15)", bg: "#000000", bgPanel: "#050810", bgInput: "#020508", border: "#152040", borderLight: "#1a2848", headerBg: "#000000" },
};

let currentTheme = 'blue';

function applyTheme(name) {
  const theme = poThemes[name] || poThemes.blue;
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
let selectedPack = null;
let romPath = null;
let romFilename = null;
let emulatorPath = null;
let sniPath = null;
let luaScriptPath = null;
let stagingFolder = null;
let timerPath = null;

// --- DOM refs ---
const setupOverlay = document.getElementById('setup-overlay');
const setupBtn = document.getElementById('setup-btn');
const dropZone = document.getElementById('drop-zone');
const dropIcon = document.getElementById('drop-icon');
const dropLabel = document.getElementById('drop-label');
const dropFilename = document.getElementById('drop-filename');
const packListEl = document.getElementById('pack-list');
const packCount = document.getElementById('pack-count');
const playBtn = document.getElementById('play-btn');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const btnRefresh = document.getElementById('btn-refresh');
const btnChangeFolder = document.getElementById('btn-change-folder');
const btnMinimize = document.getElementById('btn-minimize');
const btnMaximize = document.getElementById('btn-maximize');
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
btnMaximize.addEventListener('click', () => ipcRenderer.invoke('maximize-window'));
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

function updatePlayState() {
  const ready = romPath && selectedPack;
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
  dropIcon.textContent = '⚔️';
  dropLabel.textContent = 'ROM loaded';
  dropFilename.textContent = filename;
  playBtn.textContent = '▶ Play';
  setStatus('ROM ready', 'success');
  updatePlayState();
}

function clearRom() {
  romPath = null;
  romFilename = null;
  dropZone.classList.remove('has-rom');
  dropIcon.textContent = '🗡️';
  dropLabel.textContent = 'Drop ROM here';
  dropFilename.textContent = '';
  setStatus('ROM cleared', '');
  updatePlayState();
}

async function persistSettings() {
  await ipcRenderer.invoke('save-settings', {
    packsFolder,
    lastPack: selectedPack ? selectedPack.name : null,
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
btnRomStagingFolder.addEventListener('click', async () => {
  const folder = await ipcRenderer.invoke('pick-folder');
  if (folder) {
    stagingFolder = folder;
    await persistSettings();
    setStatus(`Staging folder set`, 'success');
    await loadFromStaging();
  }
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
  for (const pack of packs) {
    const item = document.createElement('div');
    item.className = 'pack-item';
    if (selectedPack && selectedPack.name === pack.name) item.classList.add('selected');

    const nameEl = document.createElement('span');
    nameEl.className = 'pack-item-name';
    nameEl.textContent = pack.name;

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
  packCount.innerHTML = `<span>${packs.length}</span> pack${packs.length !== 1 ? 's' : ''} found`;
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
  currentTheme = settings.theme || 'blue';
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

  if (settings.packsFolder) {
    packsFolder = settings.packsFolder;
    setupOverlay.classList.add('hidden');
    await scanPacks();
    if (settings.lastPack) {
      selectedPack = packs.find(p => p.name === settings.lastPack) || null;
      renderPacks();
      const sel = packListEl.querySelector('.selected');
      if (sel) sel.scrollIntoView({ block: 'center' });
    }
  }

  updatePlayState();
})();

// --- Setup ---
setupBtn.addEventListener('click', async () => {
  const folder = await ipcRenderer.invoke('pick-folder');
  if (folder) {
    packsFolder = folder;
    await persistSettings();
    setupOverlay.classList.add('hidden');
    await scanPacks();
  }
});

btnChangeFolder.addEventListener('click', async () => {
  const folder = await ipcRenderer.invoke('pick-folder');
  if (folder) {
    packsFolder = folder;
    selectedPack = null;
    await persistSettings();
    await scanPacks();
    setStatus('Folder changed', 'success');
  }
});

async function scanPacks() {
  packs = await ipcRenderer.invoke('scan-packs', packsFolder);
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
btnBrowseEmulator.addEventListener('click', async () => {
  const exe = await ipcRenderer.invoke('pick-exe', 'Select Emulator Executable');
  if (exe) {
    emulatorPath = exe;
    displayPath(emulatorPathEl, emulatorPath);
    updateLuaVisibility();
    persistSettings();
    setStatus('Emulator set', 'success');
  }
});

btnBrowseSni.addEventListener('click', async () => {
  const exe = await ipcRenderer.invoke('pick-exe', 'Select SNI Executable');
  if (exe) {
    sniPath = exe;
    displayPath(sniPathEl, sniPath);
    persistSettings();
    setStatus('SNI set', 'success');
  }
});

btnBrowseLuaScript.addEventListener('click', async () => {
  const result = await ipcRenderer.invoke('pick-exe', 'Select Lua Script');
  if (result) {
    luaScriptPath = result;
    displayPath(luaScriptPathEl, luaScriptPath, 'No script (console only)');
    persistSettings();
    setStatus('Lua script set', 'success');
  }
});

chkEmulator.addEventListener('change', () => { updateLuaVisibility(); persistSettings(); });
chkLua.addEventListener('change', () => { updateLuaVisibility(); persistSettings(); });
chkTracker.addEventListener('change', () => persistSettings());
chkSni.addEventListener('change', () => persistSettings());

btnBrowseTimer.addEventListener('click', async () => {
  const exe = await ipcRenderer.invoke('pick-exe', 'Select Timer Executable');
  if (exe) {
    timerPath = exe;
    displayPath(timerPathEl, timerPath);
    persistSettings();
    setStatus('Timer set', 'success');
  }
});
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
  if (!romPath || !selectedPack) return;

  const isAplttp = romPath.toLowerCase().endsWith('.aplttp');

  if (!isAplttp) {
    if (chkEmulator.checked && !emulatorPath) {
      setStatus('Emulator enabled but not set — open ⚙ settings', 'error');
      return;
    }
    if (chkSni.checked && !sniPath) {
      setStatus('SNI enabled but not set — open ⚙ settings', 'error');
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
  playBtn.textContent = '⏳ Working...';

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
    if (result.apRomStartOn) msg += ' (Archipelago rom_start is ON — see AP fix in settings)';
    if (result.alreadyRunning && result.alreadyRunning.length > 0) {
      msg += ` (${result.alreadyRunning.join(' & ')} already running)`;
    }
    setStatus(msg, 'success');
    playBtn.textContent = '✓ Launched';
    setTimeout(() => {
      playBtn.textContent = '▶ Play';
      updatePlayState();
    }, 2000);
  } else {
    setStatus(`Error: ${result.error}`, 'error');
    playBtn.textContent = '▶ Play';
    updatePlayState();
  }
});

// --- Archipelago rom_start (host.yaml) ---
const apRow = document.getElementById('ap-romstart-row');
const apChk = document.getElementById('chk-ap-romstart');
const apStatus = document.getElementById('ap-romstart-status');
function showApRomStart(state) {
  if (!state || !state.found) { apRow.style.display = 'none'; return; }
  apRow.style.display = '';
  apChk.checked = !state.on;                       // checked = fixed = only the launcher starts the ROM
  apStatus.className = 'companion-path ' + (state.on ? 'warn' : 'good');
  apStatus.textContent = state.on ? 'Archipelago also starts the ROM — emulator opens twice' : 'Only the launcher starts the ROM';
}
apChk.addEventListener('change', async () => {
  const state = await ipcRenderer.invoke('ap-romstart-set', !apChk.checked);
  if (state && state.ok === false) setStatus(`Could not update host.yaml: ${state.error}`, 'error');
  showApRomStart(state);
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
