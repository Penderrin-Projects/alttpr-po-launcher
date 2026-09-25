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
let setupSkipped = false;             // first-run screen dismissed without choosing a folder
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
const setupOverlay = document.getElementById('setup-overlay');
const setupBtn = document.getElementById('setup-btn');
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
  if (settings.packsFolder) {
    packsFolder = settings.packsFolder;
    setupOverlay.classList.add('hidden');
    await scanPacks();
    if (settings.lastPack) {
      selectedPack = packs.find(p => p.name === settings.lastPack) || null;
      renderPacks();
      const sel = packListEl.querySelector('.selected');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    }
  } else if (setupSkipped) {
    setupOverlay.classList.add('hidden');
    renderPacks();
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

document.getElementById('setup-skip').addEventListener('click', async () => {
  setupSkipped = true;
  setupOverlay.classList.add('hidden');
  await persistSettings();
  renderPacks();
  updatePlayState();
  setStatus('Playing with the original soundtrack — pick a packs folder any time with the folder button', 'success');
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
