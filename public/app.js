const $ = (id) => document.getElementById(id);
const list = $('list');
const statusEl = $('status');
let busy = false;

const PILL = {
  unchecked: 'p-idle', checking: 'p-wait',
  VALID: 'p-valid', INVALID: 'p-bad', USED: 'p-warn', EXPIRED: 'p-warn', UNVERIFIED: 'p-warn'
};

function row(code) {
  const li = document.createElement('li');
  li.dataset.code = code;
  li.innerHTML = `<code>${code}</code><span class="pill p-idle">unchecked</span>`;
  li.querySelector('code').onclick = () => navigator.clipboard?.writeText(code);
  list.prepend(li);
  return li;
}

function paint(li, verdict, detail) {
  const pill = li.querySelector('.pill');
  pill.className = `pill ${PILL[verdict] || 'p-warn'}`;
  pill.textContent = verdict.toLowerCase();
  li.title = detail || '';
}

async function verifyRows(rows) {
  if (busy || !rows.length) return;
  busy = true;
  statusEl.textContent = `checking ${rows.length} code(s) against PlayStation…`;
  const codes = rows.map((r) => r.dataset.code);
  rows.forEach((r) => paint(r, 'checking'));

  try {
    const res = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes })
    });
    const data = await res.json();
    (data.results || []).forEach((r) => {
      const li = rows.find((x) => x.dataset.code === r.code);
      if (li) paint(li, r.status, r.detail);
    });
    const hits = (data.results || []).filter((r) => r.status === 'VALID').length;
    statusEl.textContent = `done — ${hits} valid of ${rows.length}`;
    save();
  } catch (err) {
    statusEl.textContent = `check failed: ${err.message}`;
    rows.forEach((r) => paint(r, 'UNVERIFIED', 'network'));
  } finally {
    busy = false;
  }
}

$('gen').onclick = async () => {
  const count = Math.min(50, Math.max(1, Number($('qty').value) || 1));
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count, excludeAmbiguous: $('amb').checked })
  });
  const data = await res.json();
  (data.codes || []).forEach(row);
  statusEl.textContent = `generated ${data.codes?.length || 0}`;
  save();
};

$('verify').onclick = () => verifyRows([...list.children]);
$('clear').onclick = () => { list.innerHTML = ''; statusEl.textContent = ''; save(); };

$('csv').onclick = () => {
  const rows = [['code', 'verdict', 'detail']];
  [...list.children].forEach((li) => rows.push([li.dataset.code, li.querySelector('.pill').textContent, li.title]));
  const blob = new Blob([rows.map((r) => r.map((c) => `"${c}"`).join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'psn-codes.csv';
  a.click();
  URL.revokeObjectURL(a.href);
};

$('check1').onclick = () => {
  const raw = $('manual').value.trim().toUpperCase();
  if (!raw) return;
  const li = row(raw);
  $('manual').value = '';
  verifyRows([li]);
};

function save() {
  const data = [...list.children].map((li) => ({
    code: li.dataset.code,
    verdict: li.querySelector('.pill').textContent,
    detail: li.title
  }));
  localStorage.setItem('psnlab', JSON.stringify(data.slice(0, 300)));
}

function restore() {
  try {
    (JSON.parse(localStorage.getItem('psnlab')) || []).reverse().forEach((item) => {
      const li = row(item.code);
      paint(li, item.verdict.toUpperCase(), item.detail);
    });
  } catch { /* ignore */ }
}
restore();
