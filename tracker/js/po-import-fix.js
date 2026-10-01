// PO Launcher addition (tracker settings page): makes AUTO-CONFIGURE work for alttpr.com seeds.
//
// Upstream bug: when AUTO-CONFIGURE reads an alttpr.com seed from the ROM it writes the bare hash
// into the import field, but importflags() only derives the hash from a value containing '/' or
// '#'. A bare hash leaves it undefined, the request goes to .../undefined.json (403), and since
// the download has no failure handler the page sits on "Loading data from alttpr.com" for ever,
// reconnecting every 10 seconds. Pasting a seed URL by hand never hit this, which is why IMPORT
// FLAGS worked while AUTO-CONFIGURE did not.
//
// Fix, without editing upstream code: wrap importflags() to turn a bare hash into a seed URL,
// and report a failed download in the status line so nothing waits for it.
(function () {
  var original = window.importflags;
  if (typeof original !== 'function') return;
  window.importflags = function () {
    var box = document.getElementById('importflag');
    var v = box ? (box.value || '').trim() : '';
    if (v && v.indexOf('/') < 0 && v.indexOf('#') < 0) box.value = 'https://alttpr.com/h/' + v;
    return original.apply(this, arguments);
  };
  if (window.jQuery) {
    jQuery(document).ajaxError(function (_event, xhr, settings) {
      if (/alttpr-patch-data/.test(settings.url || '') && typeof autotrackSetStatus === 'function') {
        autotrackSetStatus('Could not load seed data from alttpr.com (HTTP ' + xhr.status + ')');
      }
    });
  }
})();
