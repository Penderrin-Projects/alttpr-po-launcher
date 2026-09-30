// PO Launcher addition: a small "scan seed" control on the tracker window.
// Asks the launcher to run the settings page's AUTO-CONFIGURE against the running game
// (through SNI) and reloads this window with the detected settings. Only appears when the
// tracker runs inside the launcher. Sits just left of the autotracking status text and takes
// no layout space, so the window size is unchanged.
(function () {
  if (!window.electronAPI || typeof window.electronAPI.scanSeed !== 'function') return;
  // Loaded from <head>, so wait for the page body before looking for the status element.
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', arguments.callee); return; }
  var status = document.getElementById('autotrackingstatus');
  if (!status || !status.parentElement) return;

  var style = document.createElement('style');
  style.textContent = [
    '#po-scan{position:absolute;bottom:0;right:3px;height:16px;padding:0 3px;margin:0;border:0;background:none;',
    'color:#fff;font:12px/16px inherit;opacity:.35;cursor:pointer;z-index:5;user-select:none}',
    '#po-scan:hover{opacity:1}',
    '#po-scan.busy{opacity:1;animation:po-spin 1s linear infinite}',
    '@keyframes po-spin{to{transform:rotate(360deg)}}',
  ].join('');
  document.head.appendChild(style);

  var btn = document.createElement('button');
  btn.id = 'po-scan';
  btn.type = 'button';
  btn.textContent = '\u21bb';
  btn.title = "Scan the running game for this seed's settings and reload the tracker";
  status.parentElement.appendChild(btn);

  // Keep the button just left of the right-aligned status text, however long it gets.
  // offsetWidth is layout width, so the tracker's CSS-transform zoom does not skew it.
  var probe = document.createElement('span');
  function place() {
    var cs = getComputedStyle(status);
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:' + cs.font + ';';
    probe.textContent = status.textContent;
    document.body.appendChild(probe);
    var w = probe.offsetWidth;
    probe.parentNode.removeChild(probe);
    btn.style.right = (3 + w + 6) + 'px';
  }
  new MutationObserver(place).observe(status, { childList: true, characterData: true, subtree: true });
  window.addEventListener('resize', place);
  place();

  var busy = false;
  btn.addEventListener('click', function () {
    if (busy) return;
    busy = true;
    btn.classList.add('busy');
    var before = status.textContent;
    status.textContent = 'Scanning seed\u2026';
    window.electronAPI.scanSeed().then(function (r) {
      // On success the launcher reloads this window; nothing more to do here.
      if (!r || !r.ok) {
        status.textContent = 'Scan failed: ' + ((r && r.error) || 'unknown error');
        setTimeout(function () { if (status.textContent.indexOf('Scan failed') === 0) status.textContent = before; }, 6000);
      }
    }).catch(function (e) {
      status.textContent = 'Scan failed: ' + e.message;
    }).then(function () {
      busy = false;
      btn.classList.remove('busy');
    });
  });
})();
