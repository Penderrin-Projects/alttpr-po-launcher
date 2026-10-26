// Preload for the race timer window. The page does all its Archipelago work itself; this
// bridge only exists so it can ask main to resize and pin its own window (compact / full
// mode, keep-on-top). Everything else about the page is plain web.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('poTimer', {
  // → { compact, onTop }
  getState: () => ipcRenderer.invoke('race-timer-state'),
  // Switch mode. contentHeight: the page height compact needs, for its first-ever size.
  setCompact: (compact, contentHeight) => ipcRenderer.invoke('race-timer-mode', !!compact, contentHeight | 0),
  // Compact only: resize the window height to the page's content.
  fitHeight: (contentHeight) => ipcRenderer.invoke('race-timer-fit', contentHeight | 0),
  setOnTop: (onTop) => ipcRenderer.invoke('race-timer-on-top', !!onTop),
});
