// PO Launcher addition (tracker settings page): choose what dungeon prize markers start as.
// Saved to localStorage ('poPrizeDefault') the moment it changes - no LAUNCH TRACKER needed -
// and read by tracker.html at start (js/po-prize-default.js). Default: blue crystal.
(function () {
  var OPTIONS = [['0', '? (unknown)'], ['1', 'Green pendant'], ['2', 'Blue / red pendant'], ['3', 'Blue crystal'], ['4', 'Red crystal']];
  function build() {
    var warn = document.getElementById('autotrackingWarning');
    if (!warn || document.getElementById('poPrizeDefault')) return;
    var row = warn.parentNode;                      // the autotracking settings row
    var div = document.createElement('div');
    var label = document.createElement('span');
    label.className = 'preset-span-double';
    label.appendChild(document.createTextNode('Dungeon prize markers start as: '));
    var tip = document.createElement('span');
    tip.className = 'south tooltop-character';
    tip.title = "What each dungeon's prize marker shows before you know the prize. Five of the ten prizes are blue crystals. With autotracking on, the real prize replaces it when collected. Saved as soon as you change it.";
    tip.textContent = '[?]';
    label.appendChild(tip);
    var holder = document.createElement('span');
    holder.className = 'preset-btn-span';
    var sel = document.createElement('select');
    sel.id = 'poPrizeDefault';
    sel.className = 'sprite-dropdown';
    sel.style.cssText = 'width: 200px !important;';
    OPTIONS.forEach(function (o) { var opt = document.createElement('option'); opt.value = o[0]; opt.textContent = o[1]; sel.appendChild(opt); });
    var saved = localStorage.getItem('poPrizeDefault');
    sel.value = OPTIONS.some(function (o) { return o[0] === saved; }) ? saved : '3';
    sel.addEventListener('change', function () { localStorage.setItem('poPrizeDefault', sel.value); });
    holder.appendChild(sel);
    div.appendChild(label);
    div.appendChild(holder);
    row.parentNode.insertBefore(div, row.nextSibling);
    // The page styles its dropdowns with select2 on load; match it when that has already run.
    if (window.jQuery && jQuery.fn.select2 && document.querySelector('#autotrackingselect.select2-hidden-accessible')) jQuery(sel).select2();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
