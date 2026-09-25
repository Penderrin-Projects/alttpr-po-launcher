// Preload for the main launcher window.
//
// The launcher page used to run with nodeIntegration on and contextIsolation off, i.e. with
// full Node.js access from page script. It only ever needed three things, so those three
// things are all it gets now:
//   1. ipcRenderer.invoke() — restricted to the channels renderer.js actually uses
//   2. the 'tracker-configured' and 'scan-progress' notifications from main
//   3. the real filesystem path of a dropped file. File.path was removed in Electron 32;
//      webUtils.getPathForFile() is its replacement and only exists on this side of the bridge.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE_CHANNELS = new Set([
  'load-settings', 'save-settings',
  'pick-folder', 'pick-exe',
  'scan-packs', 'cancel-scan', 'scan-staging-folder',
  'launch-rom', 'save-layout',
  'open-tracker', 'open-tracker-settings', 'has-tracker-config',
  'set-theme',
  'minimize-window', 'maximize-window', 'close-window',
  'ap-romstart-get', 'ap-romstart-set',
  'check-for-update', 'open-release-page',
]);

contextBridge.exposeInMainWorld('launcher', {
  invoke(channel, ...args) {
    if (!INVOKE_CHANNELS.has(channel)) {
      return Promise.reject(new Error(`IPC channel not allowed: ${channel}`));
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  onTrackerConfigured(callback) {
    ipcRenderer.on('tracker-configured', () => callback());
  },
  onScanProgress(callback) {
    ipcRenderer.on('scan-progress', (_event, folders) => callback(folders));
  },
  getPathForFile(file) {
    try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
  },
});
