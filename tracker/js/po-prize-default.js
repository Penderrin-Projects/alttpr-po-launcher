// PO Launcher addition: dungeon prize markers start as the blue crystal instead of "?".
// Five of the ten prizes are blue crystals, so it is the likeliest guess; with autotracking on,
// the real prize replaces it the moment it is collected, and clicking a marker still cycles it.
// Only markers still at "?" are touched, so a restored session keeps whatever it had.
(function () {
  var BLUE_CRYSTAL = 3;                                   // prize-3 (see css .prize-N and images/dungeons/prizeN.png)
  function apply() {
    if (!window.prizes || typeof window.set_prize !== 'function') return;
    for (var i = 0; i < 10; i++) {
      if (window.prizes[i] === 0 && document.getElementById('dungeonPrize' + i)) window.set_prize(i, BLUE_CRYSTAL);
    }
  }
  // Loaded from <head>; the tracker's start() runs from an inline script at the end of the body,
  // which is before DOMContentLoaded, so the markers exist by then.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  else apply();
})();
