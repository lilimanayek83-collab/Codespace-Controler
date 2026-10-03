// Services screen (VPS-style rotation). Uses globals from app.js: state, showToast, haptic, escapeHtml, switchScreen, initData.
async function rapi(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData, ...(opts.headers || {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || data.error || `Request failed (${r.status})`);
  return data;
}

const MACHINES = [
  ['basicLinux32gb', '2-core, 8GB RAM'],
  ['standardLinux32gb', '4-core, 16GB RAM'],
  ['premiumLinux', '8-core, 32GB RAM'],
  ['largePremiumLinux', '16-core, 64GB RAM'],
];
const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const TZ_LIST = (typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []).concat(['UTC']);
const svc = { view: 'list', list: [], cur: null, tokens: [], draft: null, poll: null };
const root = () => document.getElementById('svcRoot');
const tokLabel = (id) => (svc.tokens.find((t) => t._id === id) || {}).label || '?';

const _origSwitchScreen = switchScreen;
switchScreen = function (name) {
  _origSwitchScreen(name);
  if (name !== 'rotation') return;
  document.getElementById('topbarTitle').textContent = 'Services';
  svc.view = 'list';
  svc.tokens = []; // re-fetch so newly added/removed accounts show up
  svcRefresh();
  clearInterval(svc.poll);
  svc.poll = setInterval(() => {
    if (state.screen !== 'rotation') return clearInterval(svc.poll);
    if (svc.view !== 'edit') svcRefresh();
  }, 4000);
};
document.getElementById('refreshBtn').addEventListener('click', () => {
  if (state.screen === 'rotation' && svc.view !== 'edit') svcRefresh();
});

async function svcRefresh() {
  try {
    if (!svc.tokens.length) svc.tokens = (await rapi('/api/tokens')).tokens;
    if (svc.view === 'detail' && svc.cur) svc.cur = await rapi(`/api/services/${svc.cur.id}`);
    else if (svc.view === 'list') svc.list = await rapi('/api/services');
    svcRender();
  } catch (e) { showToast(e.message, 'error'); }
}

function svcRender() {
  if (svc.view === 'list') renderList();
  else if (svc.view === 'detail') renderDetail();
  else renderEdit();
}

// ---------- list ----------
function renderList() {
  const cards = svc.list.map((s) => `
    <div class="card svc-card" data-open="${s.id}">
      <div class="rot-row"><b>${escapeHtml(s.name)}</b>
        <span class="badge-active">${s.running ? '● RUNNING' : '○ IDLE'}</span></div>
      <div class="token-sub">${escapeHtml(s.repo)}${s.ref ? ' @ ' + escapeHtml(s.ref) : ''} · ${s.accounts.length} account(s) · on switch: ${s.onSwitch}</div>
      <div class="token-sub">${escapeHtml(s.status)}</div>
    </div>`).join('') || '<div class="empty-state"><div class="empty-icon">🖥️</div><p>No services yet</p></div>';
  root().innerHTML = `<div class="list">${cards}</div><button class="btn primary full" id="svcNew">+ New Service</button>`;
  root().querySelectorAll('[data-open]').forEach((c) => c.addEventListener('click', async () => {
    svc.cur = svc.list.find((x) => x.id === c.dataset.open);
    svc.view = 'detail';
    svcRefresh();
  }));
  document.getElementById('svcNew').addEventListener('click', () => {
    svc.draft = { id: null, name: '', repo: '', ref: '', machine: 'standardLinux32gb', onSwitch: 'stop', commandsText: '', accounts: [svc.tokens[0]?._id || ''], autoSwitchMinutes: 30, switchMode: 'off', clockTime: '04:00', timezone: BROWSER_TZ, tzMode: 'auto' };
    svc.view = 'edit';
    svcRender();
  });
}

// ---------- detail ----------
function renderDetail() {
  const c = svc.cur;
  const rows = c.accounts.map((tid, i) => {
    const ptr = i === c.pointer, live = c.running && c.active && c.active.idx === i;
    return `<div class="rot-row">
      <div>${i + 1}. <b>${escapeHtml(tokLabel(tid))}</b> ${ptr ? '<span class="badge-active">POINTER</span>' : ''} ${live ? '<span class="badge-active">LIVE</span>' : ''}</div>
      ${ptr ? '' : `<button class="btn small" data-ptr="${i}">Point here</button>`}</div>`;
  }).join('');
  const sched = c.switchMode === 'timer' ? `every ${c.autoSwitchMinutes} min` : c.switchMode === 'clock' ? `daily at ${escapeHtml(c.clockTime)} (${escapeHtml(c.timezone)})` : 'off';
  const auto = `<div class="token-sub">Auto-switch: ${sched}${c.running && c.switchAt ? ' · next: ' + new Date(c.switchAt).toLocaleString() : ''}</div>`;
  const logEl = document.getElementById('svcLog');
  const keepScroll = logEl ? logEl.scrollTop : 0;
  const atBottom = !logEl || logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20;
  root().innerHTML = `
    <button class="btn small" id="svcBack">← Services</button>
    <div class="card svc-card" style="margin-top:10px">
      <div class="section-label">${escapeHtml(c.name)} — ${c.running ? '● RUNNING' : '○ IDLE'}</div>
      <div class="token-sub">${escapeHtml(c.repo)}${c.ref ? ' @ ' + escapeHtml(c.ref) : ''} · ${(MACHINES.find((m) => m[0] === c.machine) || [, c.machine])[1]} · on switch: ${c.onSwitch === 'delete' ? 'Delete (Recreate next time)' : 'Stop (Resume next time)'}</div>
      <div class="token-sub">${escapeHtml(c.status)}</div>${auto}
      ${rows}
      <div class="rot-actions">
        ${c.running ? `<button class="btn primary" id="svcSwitch">Switch now</button><button class="btn danger" id="svcStop">Stop</button>`
                    : `<button class="btn primary" id="svcStart">Start from pointer</button>`}
        <button class="btn" id="svcEdit">Edit</button>
        <button class="btn danger" id="svcDel">Delete</button>
      </div>
    </div>
    <div class="section-label">Log</div><pre class="rot-log" id="svcLog"></pre>`;
  const log = document.getElementById('svcLog');
  log.textContent = c.log.join('\n');
  log.scrollTop = atBottom ? log.scrollHeight : keepScroll;

  const act = (id, path, body) => { const b = document.getElementById(id); if (b) b.addEventListener('click', () => svcPost(path, body)); };
  document.getElementById('svcBack').addEventListener('click', () => { svc.view = 'list'; svcRefresh(); });
  act('svcStart', `/api/services/${c.id}/start`);
  act('svcSwitch', `/api/services/${c.id}/switch`);
  act('svcStop', `/api/services/${c.id}/stop`);
  root().querySelectorAll('[data-ptr]').forEach((b) => b.addEventListener('click', () => svcPost(`/api/services/${c.id}/pointer`, { index: +b.dataset.ptr })));
  document.getElementById('svcEdit').addEventListener('click', () => {
    svc.draft = { id: c.id, name: c.name, repo: c.repo, ref: c.ref, machine: c.machine, onSwitch: c.onSwitch, commandsText: c.commands.join('\n'), accounts: [...c.accounts], autoSwitchMinutes: c.autoSwitchMinutes || 30, switchMode: c.switchMode, clockTime: c.clockTime || '04:00', tzMode: c.tzMode === 'manual' ? 'manual' : 'auto', timezone: c.tzMode === 'manual' ? (c.timezone || BROWSER_TZ) : BROWSER_TZ };
    svc.view = 'edit';
    svcRender();
  });
  document.getElementById('svcDel').addEventListener('click', async () => {
    if (!confirm('Delete this service?')) return;
    try { await rapi(`/api/services/${c.id}`, { method: 'DELETE' }); svc.view = 'list'; svcRefresh(); } catch (e) { showToast(e.message, 'error'); }
  });
}

async function svcPost(path, body) {
  try {
    haptic('medium');
    await rapi(path, { method: 'POST', body: JSON.stringify(body || {}) });
    await svcRefresh();
  } catch (e) { showToast(e.message, 'error'); }
}

// ---------- create / edit ----------
function renderEdit() {
  const d = svc.draft;
  const machOpts = MACHINES.map(([v, l]) => `<option value="${v}" ${v === d.machine ? 'selected' : ''}>${l}</option>`).join('');
  const accRows = d.accounts.map((tid, i) => `
    <div class="acc-row" data-i="${i}">
      <span>${i + 1}.</span>
      <select class="field" data-acc="${i}">
        <option value="">— GitHub account —</option>
        ${svc.tokens.map((t) => `<option value="${t._id}" ${t._id === tid ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('')}
      </select>
      <button class="btn small" data-mv="-1">▲</button><button class="btn small" data-mv="1">▼</button>
      <button class="btn small danger" data-rm="1">✕</button>
    </div>`).join('');
  root().innerHTML = `
    <div class="card rot-slot">
      <div class="section-label">${d.id ? 'Edit' : 'New'} Service</div>
      <input class="field" data-f="name" placeholder="Service name (e.g. SUBARU bot)" value="${escapeHtml(d.name)}" />
      <input class="field" data-f="repo" placeholder="Repository: owner/repo (or GitHub URL)" value="${escapeHtml(d.repo)}" />
      <input class="field" data-f="ref" placeholder="Branch (blank = default branch)" value="${escapeHtml(d.ref)}" />
      <select class="field" data-f="machine">${machOpts}</select>
      <select class="field" data-f="onSwitch">
        <option value="stop" ${d.onSwitch === 'stop' ? 'selected' : ''}>On switch: Stop (Resume next time)</option>
        <option value="delete" ${d.onSwitch === 'delete' ? 'selected' : ''}>On switch: Delete (Recreate next time)</option>
      </select>
      <textarea class="field" data-f="commandsText" rows="6" placeholder="One command per line, run in /workspaces/&lt;repo&gt;.&#10;Prefix with bg: to keep it running in background (tmux), e.g.&#10;pip install -r requirements.txt&#10;bg: python bot.py">${escapeHtml(d.commandsText)}</textarea>
      <div class="section-label">Accounts (runs 1st, then 2nd, ... then back to 1st)</div>
      <div id="svcAccs">${accRows}</div>
      <button class="btn" id="svcAddAcc">+ Add Account</button>
      <div class="section-label">Auto-switch</div>
      <select class="field" data-f="switchMode">
        <option value="off" ${d.switchMode === 'off' ? 'selected' : ''}>Off (switch manually only)</option>
        <option value="timer" ${d.switchMode === 'timer' ? 'selected' : ''}>Timer — switch after a set time</option>
        <option value="clock" ${d.switchMode === 'clock' ? 'selected' : ''}>Clock — switch at a fixed time every day</option>
      </select>
      ${d.switchMode === 'timer' ? `<input class="field" data-f="autoSwitchMinutes" type="number" min="1" placeholder="Minutes" value="${d.autoSwitchMinutes || 30}" />
        <p class="token-sub">Switches this many minutes after the service starts on each account.</p>` : ''}
      ${d.switchMode === 'clock' ? `<input class="field" data-f="clockTime" type="time" value="${escapeHtml(d.clockTime || '04:00')}" />
        <select class="field" data-f="tzMode">
          <option value="auto" ${d.tzMode !== 'manual' ? 'selected' : ''}>Timezone: Auto — this device (${escapeHtml(BROWSER_TZ)})</option>
          <option value="manual" ${d.tzMode === 'manual' ? 'selected' : ''}>Timezone: Manual — choose myself</option>
        </select>
        ${d.tzMode === 'manual' ? `<input class="field" data-f="timezone" list="tzList" autocomplete="off" placeholder="Timezone (e.g. Asia/Kolkata)" value="${escapeHtml(d.timezone)}" />
        <datalist id="tzList">${TZ_LIST.map((z) => `<option value="${z}"></option>`).join('')}</datalist>` : ''}
        <p class="token-sub">Switches every day at this time in the timezone above.</p>` : ''}
      <div class="rot-actions"><button class="btn primary" id="svcSave">Save</button><button class="btn" id="svcCancel">Cancel</button></div>
    </div>`;
  const box = root();
  box.querySelectorAll('[data-f]').forEach((el) => {
    const h = () => { d[el.dataset.f] = el.value; };
    el.addEventListener('input', h); el.addEventListener('change', h);
  });
  const modeSel = box.querySelector('[data-f="switchMode"]');
  modeSel.addEventListener('change', () => renderEdit());
  const tzSel = box.querySelector('[data-f="tzMode"]');
  if (tzSel) tzSel.addEventListener('change', () => { if (d.tzMode === 'auto') d.timezone = BROWSER_TZ; renderEdit(); });
  box.querySelectorAll('[data-acc]').forEach((el) => el.addEventListener('change', () => { d.accounts[+el.dataset.acc] = el.value; }));
  box.querySelectorAll('#svcAccs [data-i]').forEach((row) => row.addEventListener('click', (e) => {
    const i = +row.dataset.i;
    if (e.target.dataset.rm) d.accounts.splice(i, 1);
    else if (e.target.dataset.mv) {
      const j = i + +e.target.dataset.mv;
      if (j < 0 || j >= d.accounts.length) return;
      [d.accounts[i], d.accounts[j]] = [d.accounts[j], d.accounts[i]];
    } else return;
    renderEdit();
  }));
  document.getElementById('svcAddAcc').addEventListener('click', () => { d.accounts.push(''); renderEdit(); });
  document.getElementById('svcCancel').addEventListener('click', () => { svc.view = d.id ? 'detail' : 'list'; svcRefresh(); });
  document.getElementById('svcSave').addEventListener('click', async () => {
    try {
      if (d.tzMode !== 'manual') d.timezone = BROWSER_TZ;
      const body = JSON.stringify({ ...d, autoSwitchMinutes: +d.autoSwitchMinutes || 0, commands: d.commandsText.split('\n') });
      const saved = await rapi(d.id ? `/api/services/${d.id}` : '/api/services', { method: d.id ? 'PUT' : 'POST', body });
      haptic('medium');
      showToast('Service saved', 'success');
      svc.cur = saved; svc.view = 'detail'; svcRefresh();
    } catch (e) { showToast(e.message, 'error'); }
  });
}
