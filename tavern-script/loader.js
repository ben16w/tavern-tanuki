// Tavern Tanuki dynamic loader. The connector is hosted at GitHub dist/connector.js
// and retrieved from one of three jsDelivr domains. The Supabase version pointer
// selects a commit or tag; the loader falls back to @main if it is unavailable.
// Source: https://github.com/ben16w/tavern-tanuki/blob/master/dist/connector.js
(async function () {
  var ref = 'main';
  try {
    var c0 = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var t0 = c0 ? setTimeout(function () { c0.abort(); }, 6000) : null;
    var r0 = await fetch('https://hieylivlsdmyznviumht.supabase.co/rest/v1/sb_config?key=eq.tanuki_script_ref&select=value', {
      cache: 'no-store', signal: c0 ? c0.signal : undefined,
      headers: {
        'apikey': 'sb_publishable_MH80Xnlm1oHli6UXwzRpNA_EsC1DnCO',
        'Authorization': 'Bearer sb_publishable_MH80Xnlm1oHli6UXwzRpNA_EsC1DnCO',
      },
    });
    if (t0) clearTimeout(t0);
    if (r0.ok) {
      var j0 = await r0.json();
      var v0 = j0 && j0[0] && String(j0[0].value || '').trim();
      if (v0 && /^[\w.\-]{4,60}$/.test(v0)) ref = v0; // Only accept safe commit or tag characters.
    }
  } catch (e0) { console.warn('[tanuki loader] Failed to fetch version pointer; falling back to @main', e0); }
  var refs = ref === 'main' ? [ref] : [ref, 'main'];
  var urls = refs.flatMap(function (version) {
    return ['testingcf.jsdelivr.net', 'fastly.jsdelivr.net', 'cdn.jsdelivr.net'].map(function (h) {
      return 'https://' + h + '/gh/ben16w/tavern-tanuki@' + version + '/dist/connector.js';
    });
  });
  var code = null, lastErr = null;
  for (var i = 0; i < urls.length; i++) {
    try {
      // An inaccessible CDN can hang rather than fail, so time out and try the next source.
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 12000) : null;
      var resp = await fetch(urls[i], { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
      if (timer) clearTimeout(timer);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      code = await resp.text();
      if (!code || code.length < 500) throw new Error('Unexpected content (' + (code ? code.length : 0) + ' chars)');
      console.log('[tanuki loader] connector.js via ' + urls[i].split('/')[2] + ' (' + code.length + ' chars)');
      break;
    } catch (e) { lastErr = e; code = null; console.warn('[tanuki loader] connector source ' + (i + 1) + ' failed; trying the next source', e); }
  }
  if (code == null) {
    try { toastr.error('Tavern Tanuki Connector failed to load. Check your network connection and refresh SillyTavern: ' + ((lastErr && lastErr.message) || lastErr), 'Tavern Tanuki'); } catch (e2) {}
    console.error('[tanuki loader] connector.js failed from all sources', lastErr);
    return;
  }
  try { eval(code); } catch (e3) {
    try { toastr.error('Tavern Tanuki Connector execution failed: ' + ((e3 && e3.message) || e3), 'Tavern Tanuki'); } catch (e4) {}
    console.error('[tanuki loader] connector.js evaluation failed', e3);
  }
})();
