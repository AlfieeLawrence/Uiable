'use strict';
Pages.logs = (el) => {
  el.innerHTML = `<div class="toolbar">
    <select data-src style="width:auto;min-width:220px"></select>
    <input class="search" data-q placeholder="Filter / grep…">
    <select data-since style="width:auto"><option>1 hour ago</option><option>15 minutes ago</option><option>6 hours ago</option><option>24 hours ago</option><option>7 days ago</option></select>
    <button data-go>${ICON.refresh} Query</button>
    <label class="row small"><input type="checkbox" data-follow> Live follow</label>
  </div><div class="card flush"><pre class="out" data-out style="height:calc(100vh - 230px);overflow:auto;border-radius:0;margin:0">Pick a source and click Query.</pre></div>`;
  const out = $('[data-out]', el); let ws = null;
  const stopFollow = () => { if (ws) { ws.onclose = null; ws.close(); ws = null; } $('[data-follow]', el).checked = false; };
  GET('/logs/sources').then((s) => {
    const opts = [];
    if (s.journal) opts.push(`<option value="journal">Host journal (journalctl)</option>`);
    (s.files || []).forEach((f) => opts.push(`<option value="file:${esc(f)}">File ${esc(f)}</option>`));
    (s.containers || []).forEach((c) => opts.push(`<option value="container:${esc(c.id)}">Container ${esc(c.name)}</option>`));
    $('[data-src]', el).innerHTML = opts.join('') || '<option value="journal">journal</option>';
  }).catch((e) => toastErr(e));
  const query = async () => {
    stopFollow();
    out.textContent = 'Loading…';
    try {
      const r = await GET(`/logs/query?source=${encodeURIComponent($('[data-src]', el).value)}&q=${encodeURIComponent($('[data-q]', el).value)}&since=${encodeURIComponent($('[data-since]', el).value)}&tail=500`);
      out.textContent = (r.lines || []).join('\n') || '(no lines)'; out.scrollTop = out.scrollHeight;
      if (r.message) toast(r.message, true);
    } catch (e) { out.textContent = e.message; }
  };
  $('[data-go]', el).onclick = query;
  $('[data-follow]', el).onchange = (e) => {
    if (!e.target.checked) return stopFollow();
    const src = $('[data-src]', el).value;
    if (src.startsWith('file:')) { toast('Live follow is available for the journal and containers', true); e.target.checked = false; return; }
    out.textContent = '';
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/logs?source=${encodeURIComponent(src)}&q=${encodeURIComponent($('[data-q]', el).value)}`);
    ws.onmessage = (m) => { out.textContent += m.data; out.scrollTop = out.scrollHeight; };
    ws.onclose = () => { $('[data-follow]', el).checked = false; ws = null; };
  };
  return stopFollow;
};
