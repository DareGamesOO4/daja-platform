const byId = id => document.getElementById(id);
const phases = { 'local-paused': 'obrada slika pauzirana', ready: 'povezan, čeka slike', working: 'obrada u toku', paused: 'pauziran iz admina',
  error: 'problem sa vezom ili obradom', connecting: 'povezivanje…' };

function setStatusText(id, text) {
  const element = byId(id);
  if (element.textContent !== text) element.textContent = text;
}

async function updateState() {
  try {
    const response = await fetch('/state', { cache: 'no-store', signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error();
    const { status, render: rawRender } = await response.json();
    const render = rawRender?.data ?? rawRender;
    setStatusText('worker', 'DAJA računar · ' + (phases[status.phase] ?? 'nepoznato stanje') +
      (status.error ? ' (' + status.error + ')' : ''));
    const failed = render?.renderErrorAt && (!render.renderCompletedAt ||
      new Date(render.renderErrorAt) > new Date(render.renderCompletedAt));
    setStatusText('render', 'Render · ' + (!render ? 'server nije potvrdio stanje' :
      !render.renderOnline ? 'nema svežeg signala' : failed ? 'aktivan, poslednja obrada prijavila grešku' :
      'raspored aktivan (03–07)'));
    setStatusText('linkel', 'Linkel · ' + (status.linkel ?? 'stanje nije dostupno'));
    setStatusText('linkel-last', status.linkelLast ? 'Poslednja lokalna provera · ' + status.linkelLast : '');
  } catch {
    setStatusText('worker', 'DAJA računar · lokalni worker nije dostupan');
    setStatusText('render', 'Render · stanje nije dostupno');
    setStatusText('linkel', 'Linkel · stanje nije dostupno');
    setStatusText('linkel-last', '');
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
async function refreshState() {
  if (!document.hidden) await updateState();
  setTimeout(refreshState, 4_000);
}
void refreshState();
