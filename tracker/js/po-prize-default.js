// PO Launcher addition: dungeon prize markers start as a chosen prize (blue crystal by default)
// instead of "?". With autotracking on, the real prize replaces it the moment it is collected, and
// clicking a marker still cycles it. Only markers still at "?" are touched, so a restored session
// keeps whatever it had.
(function () {
  // Which marker to start with is chosen on the tracker settings page (js/po-prize-setting.js)
  // and kept in localStorage: 0 = ?, 1 = green pendant, 2 = blue/red pendant, 3 = blue crystal
  // (the default), 4 = red crystal - the prize-N classes in css/style.css.
  function chosenDefault() {
    var v = parseInt(localStorage.getItem('poPrizeDefault'), 10);
    return (v >= 0 && v <= 4) ? v : 3;
  }
  function apply() {
    if (!window.prizes || typeof window.set_prize !== 'function') return;
    var start = chosenDefault();
    if (start === 0) return;                                 // '?' is what the tracker does anyway
    for (var i = 0; i < 10; i++) {
      if (window.prizes[i] === 0 && document.getElementById('dungeonPrize' + i)) window.set_prize(i, start);
    }
  }
  // Loaded from <head>; the tracker's start() runs from an inline script at the end of the body,
  // which is before DOMContentLoaded, so the markers exist by then.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  else apply();
})();
