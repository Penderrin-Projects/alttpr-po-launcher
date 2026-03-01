const { contextBridge, ipcRenderer } = require('electron');

let contentWidth = null;
let contentHeight = null;
let ignoreResize = false;

function applyZoom(factor) {
  const html = document.documentElement;
  html.dataset.electronZoom = factor;
  html.style.transform = `scale(${factor})`;
  html.style.transformOrigin = '0 0';
  html.style.width = `${100 / factor}%`;
  html.style.height = `${100 / factor}%`;
}

function isTrackerWindow() {
  return window.location.pathname.includes('tracker.html');
}

function fitToWindow() {
  if (!contentWidth || !contentHeight) return;
  const winW = window.innerWidth;
  const winH = window.innerHeight;
  const factor = Math.min(winW / contentWidth, winH / contentHeight);
  const rounded = Math.round(factor * 100) / 100;
  applyZoom(rounded);
  ipcRenderer.invoke('save-zoom', rounded);

  // Snap window to remove any black bars (enforce aspect ratio)
  ignoreResize = true;
  const newW = Math.ceil(contentWidth * rounded);
  const newH = Math.ceil(contentHeight * rounded);
  ipcRenderer.invoke('fit-window-to-content', newW, newH).then(() => {
    setTimeout(() => { ignoreResize = false; }, 100);
  });
}

function resizeWindowToZoom(zoom) {
  if (!contentWidth || !contentHeight) return;
  ignoreResize = true;
  const newW = Math.ceil(contentWidth * zoom);
  const newH = Math.ceil(contentHeight * zoom);
  ipcRenderer.invoke('fit-window-to-content', newW, newH).then(() => {
    setTimeout(() => { ignoreResize = false; }, 200);
  });
}

contextBridge.exposeInMainWorld('electronAPI', {
  getAppPath: () => ipcRenderer.invoke('get-app-path'),
  isElectron: true,

  adjustZoom: (delta) => {
    const current = parseFloat(document.documentElement.dataset.electronZoom || '1');
    const newZoom = Math.min(3.0, Math.max(0.25, Math.round((current + delta) * 100) / 100));
    applyZoom(newZoom);
    ipcRenderer.invoke('save-zoom', newZoom);
    resizeWindowToZoom(newZoom);
  },

  setZoom: (factor) => {
    applyZoom(factor);
  },

  fitZoom: () => {
    fitToWindow();
  },
});

window.addEventListener('DOMContentLoaded', () => {
  if (!isTrackerWindow()) return;

  Promise.all([
    ipcRenderer.invoke('get-content-dimensions'),
    ipcRenderer.invoke('get-saved-zoom'),
  ]).then(([dims, savedZoom]) => {
    if (dims) {
      contentWidth = dims.width;
      contentHeight = dims.height;
    } else {
      const app = document.getElementById('app');
      contentWidth = app ? app.scrollWidth : 1340;
      contentHeight = app ? app.scrollHeight : 744;
    }

    // Tell main process the aspect ratio so it can enforce it
    if (contentWidth && contentHeight) {
      ipcRenderer.invoke('set-aspect-ratio', contentWidth / contentHeight);
    }

    if (savedZoom && savedZoom > 0) {
      applyZoom(savedZoom);
      resizeWindowToZoom(savedZoom);
    } else {
      fitToWindow();
    }
  });
});

// Re-fit whenever the window is manually resized
window.addEventListener('resize', () => {
  if (!isTrackerWindow() || ignoreResize) return;
  fitToWindow();
});
