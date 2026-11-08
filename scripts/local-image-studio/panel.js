const byId = id => document.getElementById(id);
const phases = { ready: 'povezan, čeka slike', working: 'obrada u toku', paused: 'pauziran iz admina',
  error: 'problem sa vezom ili obradom', connecting: 'povezivanje…' };

async function updateState() {
  try {
    const response = await fetch('/state');
    if (!response.ok) throw new Error();
    const payload = await response.json();
    const { status } = payload;
    const render = payload.render?.data ?? payload.render;
    byId('worker').textContent = 'DAJA računar · ' + (phases[status.phase] ?? 'nepoznato stanje') +
      (status.error ? ' (' + status.error + ')' : '');
    const failed = render?.renderErrorAt && (!render.renderCompletedAt ||
      new Date(render.renderErrorAt) > new Date(render.renderCompletedAt));
    byId('render').textContent = 'Render · ' + (!render ? 'server nije potvrdio stanje' :
      !render.renderOnline ? 'nema svežeg signala' : failed ? 'aktivan, poslednja obrada prijavila grešku' :
      'raspored aktivan (03–07)');
  } catch {
    byId('worker').textContent = 'DAJA računar · lokalni worker nije dostupan';
    byId('render').textContent = 'Render · stanje nije dostupno';
  }
}

byId('trial').onsubmit = async event => {
  event.preventDefault();
  const file = byId('source').files[0];
  if (!file || file.size > 25 * 1024 * 1024) {
    byId('trial-status').textContent = 'Izaberi sliku do 25 MiB.';
    return;
  }
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  byId('trial-status').textContent = 'Obrada je u toku…';
  byId('results').replaceChildren();
  try {
    const response = await fetch('/convert', { method: 'POST', body: file, headers: { 'X-DAJA-Panel': '1' } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    byId('trial-status').textContent = 'Original ' + (data.original / 1024).toFixed(1) + ' KiB · obrada ' +
      data.seconds.toFixed(1) + ' s · ' + data.output;
    byId('results').replaceChildren(...data.files.map(file => {
      const row = document.createElement('li');
      const link = document.createElement('a');
      link.textContent = file.filename;
      link.href = '/result/' + data.id + '/' + file.filename;
      link.download = file.filename;
      row.append(link, ' · ' + file.width + ' × ' + file.height + ' px · ' + (file.bytes / 1024).toFixed(1) +
        ' KiB · ' + (file.savings >= 0 ? file.savings.toFixed(1) + '% manje' : (-file.savings).toFixed(1) + '% veće'));
      return row;
    }));
  } catch (error) { byId('trial-status').textContent = error.message; }
  finally { button.disabled = false; }
};
void updateState();
setInterval(() => { if (!document.hidden) void updateState(); }, 4_000);
