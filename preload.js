// Preload for the tracker windows (Muffins Tracker 2.0: the Launch page, the tracker, its popouts).
//
// The tracker is an ordinary web app and needs nothing from Node.js. This file does three
// small things for it:
//   1. exposes a tiny `electronAPI` so the page (and our self-test) can tell it is inside
//      the launcher
//   2. seeds the tracker's own localStorage preferences the first time it runs here: dark
//      theme, and autotracking through SNI on localhost:8190 (the tracker's own defaults;
//      whatever the user changes on the Launch page is kept, these only fill in blanks)
//   3. on the /tracker route, reports the page's natural (unscaled) size to main, which
//      shapes the window around it. The tracker renders that element only after its state
//      has loaded, so it is watched for rather than read once.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
});

try {
  if (!localStorage.getItem('muffins-tracker-theme')) localStorage.setItem('muffins-tracker-theme', 'dark');
  if (!localStorage.getItem('muffins_autotrack_prefs')) {
    localStorage.setItem('muffins_autotrack_prefs', JSON.stringify({ protocol: 'sni', host: 'localhost', port: 8190 }));
  }
} catch {}

if (window.location.pathname === '/tracker') {
  let last = '';
  const report = () => {
    const el = document.querySelector('[data-tracker-bounds]');
    if (!el) return false;
    const width = parseFloat(el.style.width), height = parseFloat(el.style.height);
    if (!(width > 0 && height > 0)) return false;
    const key = `${width}x${height}`;
    if (key !== last) { last = key; ipcRenderer.send('tracker-natural-size', { width, height }); }
    return true;
  };
  window.addEventListener('DOMContentLoaded', () => {
    report();
    // Keep watching: the element appears after the state loads, and its size changes if the
    // map mode or event log is changed from inside the tracker.
    new MutationObserver(() => report()).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
  });
}
