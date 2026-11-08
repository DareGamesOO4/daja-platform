const byId = id => document.getElementById(id);
const variants = [['avif', 'Veliki AVIF'], ['webp', 'Veliki WebP'], ['avifThumb', 'Mali AVIF'], ['webpThumb', 'Mali WebP']];
const fields = {};
const previews = new Map();
let saved;
let page = 0;
let loading = false;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

for (const [index, [key, title]] of variants.entries()) {
  const avif = key.startsWith('avif');
  const group = element('fieldset');
  group.append(element('legend', title));
  const controls = fields[key] = {};
  for (const [name, label, min, max] of [
    ['quality', 'Kvalitet', 1, 100], ['effort', 'Effort', 0, avif ? 9 : 6], ['size', 'Max px', 1, index < 2 ? 2048 : 512]
  ]) {
    const field = element('label', label);
    const input = controls[name] = element('input');
    Object.assign(input, { type: 'number', min, max, step: 1, required: true });
    field.append(input);
    group.append(field);
  }
  const color = element('label', 'Boja', 'color');
  const select = controls.color = element('select');
  for (const [value, label] of avif ? [['4:4:4', '4:4:4'], ['4:2:0', '4:2:0']] : [['smart', 'Smart'], ['regular', 'Obična']]) {
    const option = element('option', label);
    option.value = value;
    select.append(option);
  }
  color.append(select);
  const check = element('label', '', 'check');
  const lossless = controls.lossless = element('input');
  lossless.type = 'checkbox';
  lossless.onchange = () => { select.disabled = lossless.checked; };
  check.append(lossless, 'Lossless');
  group.append(color, check);
  byId('variants').append(group);
}

function showProfile(profile) {
  for (const [key] of variants) {
    const control = fields[key], value = profile[key];
    for (const name of ['quality', 'effort', 'size']) control[name].value = value[name];
    control.lossless.checked = value.lossless;
    control.lossless.onchange();
    control.color.value = value.chromaSubsampling ?? (value.smartSubsample ? 'smart' : 'regular');
  }
}

function readProfile() {
  const profile = { paused: saved.paused };
  for (const [key] of variants) {
    const f = fields[key];
    profile[key] = {
      quality: f.quality.valueAsNumber, effort: f.effort.valueAsNumber, size: f.size.valueAsNumber,
      lossless: f.lossless.checked,
      ...(key.startsWith('avif') ? { chromaSubsampling: f.color.value } : { smartSubsample: f.color.value === 'smart' })
    };
  }
  return profile;
}

async function call(path, body, extra = {}) {
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST', body: body instanceof File ? body : JSON.stringify(body),
    headers: { 'X-DAJA-Panel': '1', ...extra }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

const phaseLabels = { ready: 'Povezan · čeka slike', working: 'Obrada u toku', paused: 'Red je pauziran',
  error: 'Problem s vezom ili obradom', connecting: 'Povezivanje…' };
const queueLabels = { active: 'U obradi', waiting: 'Na čekanju', fallback: 'Čeka Render',
  paused: 'Zaustavljeno', retry: 'Ponovni pokušaj' };

async function updateState() {
  try {
    const { status, profile } = await call('/state');
    if (!saved) showProfile(profile);
    saved = profile;
    byId('pause').textContent = profile.paused ? 'Nastavi red' : 'Pauziraj red';
    byId('worker').textContent = phaseLabels[status.phase] ?? 'Čeka worker';
    byId('worker').title = status.error || (status.completed ? 'Poslednja obrada ' + new Date(status.completed).toLocaleString() : '');
  } catch { byId('worker').textContent = 'Lokalni worker nije dostupan'; }
}

async function save(profile) {
  const buttons = [...byId('profile').querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  try {
    saved = (await call('/profile', profile)).profile;
    byId('pause').textContent = saved.paused ? 'Nastavi red' : 'Pauziraj red';
    byId('profile-status').textContent = saved.paused ? 'Trenutna slika će se završiti. Novi poslovi čekaju.' : 'Profil je sačuvan za sledeću sliku.';
  } catch (error) { byId('profile-status').textContent = error.message; }
  finally { buttons.forEach(button => { button.disabled = false; }); }
}

byId('profile').onsubmit = event => { event.preventDefault(); if (saved) void save(readProfile()); };
byId('pause').onclick = () => { if (saved) void save({ ...saved, paused: !saved.paused }); };
byId('presets').onchange = event => {
  const preset = event.target.value;
  if (!preset) return;
  const quality = { standard: [95, 75, 65, 75], detail: [98, 92, 85, 85], small: [75, 72, 58, 65] }[preset];
  showProfile(Object.fromEntries(variants.map(([key], i) => [key, {
    quality: quality[i], effort: preset === 'detail' ? 5 : 4, size: i < 2 ? 2048 : 512, lossless: false,
    ...(key.startsWith('avif') ? { chromaSubsampling: preset === 'small' ? '4:2:0' : '4:4:4' } : { smartSubsample: true })
  }])));
  byId('profile-status').textContent = 'Profil je učitan u prozor. Sačuvaj ga za red poslova.';
  event.target.value = '';
};

async function refresh(target = page) {
  if (loading || target < 0 || target > 10000) return;
  loading = true;
  byId('refresh').disabled = true;
  try {
    const data = await call('/queue', { page: target, keys: [...previews.keys()] });
    if (!data.items.length && target > 0) {
      page = target - 1;
      setTimeout(() => void refresh(), 0);
      return;
    }
    page = target;
    const retained = new Set(data.items.map(item => item.key));
    for (const key of previews.keys()) if (!retained.has(key)) previews.delete(key);
    const rows = data.items.map(item => {
      if (item.thumbnail) previews.set(item.key, 'data:image/png;base64,' + item.thumbnail);
      const row = element('li', '', 'job');
      const photo = previews.has(item.key) ? element('img') : element('span', '', 'placeholder');
      if (photo instanceof HTMLImageElement) { photo.alt = ''; photo.src = previews.get(item.key); }
      const caption = element('div');
      caption.append(element('strong', (item.slug ?? item.id) + (item.image ? ' / slika ' + item.image : '')),
        element('small', (queueLabels[item.state] ?? item.state) + ' · ' + (item.bytes / 1024).toFixed(1) + ' KiB'));
      row.append(photo, caption);
      return row;
    });
    byId('queue').replaceChildren(...rows);
    byId('queue-status').textContent = data.total ? data.total + ' u redu · strana ' + (page + 1) : 'Nema slika na čekanju.';
    byId('back').disabled = page === 0;
    byId('next').disabled = (page + 1) * 8 >= data.total || page === 10000;
  } catch (error) { byId('queue-status').textContent = 'Red trenutno nije dostupan. ' + error.message; }
  finally { loading = false; byId('refresh').disabled = false; }
}

byId('back').disabled = byId('next').disabled = true;
byId('back').onclick = () => void refresh(page - 1);
byId('next').onclick = () => void refresh(page + 1);
byId('refresh').onclick = () => void refresh();
byId('trial').onsubmit = async event => {
  event.preventDefault();
  if (!saved || !byId('profile').reportValidity()) return;
  const file = byId('source').files[0];
  if (!file || file.size > 25 * 1024 * 1024) {
    byId('trial-status').textContent = 'Izaberi sliku do 25 MiB.';
    return;
  }
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  byId('trial-status').textContent = 'Obrada je u toku…';
  try {
    const data = await call('/convert', file, { 'X-DAJA-Profile': btoa(JSON.stringify(readProfile())) });
    byId('trial-status').textContent = 'Original ' + (data.original / 1024).toFixed(1) + ' KiB · obrada ' +
      data.seconds.toFixed(1) + ' s · ' + data.output;
    byId('results').replaceChildren(...data.files.map(file => {
      const row = element('li');
      const link = element('a', file.filename);
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
void refresh();
setInterval(() => { if (!document.hidden) void updateState(); }, 4_000);
setInterval(() => { if (!document.hidden) void refresh(); }, 15_000);
