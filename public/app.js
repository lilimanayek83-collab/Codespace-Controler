const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();
tg.setHeaderColor('secondary_bg_color');

const initData = tg.initData; // raw string sent with every API request

const state = {
  screen: 'codespaces',
  tokens: [],
  activeTokenId: null,
  codespaces: [],
  billing: [],
};

// ---------- helpers ----------
function api(path, opts = {}) {
  return fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': initData,
      ...(opts.headers || {}),
    },
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  });
}

function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), 2800);
}

function haptic(style = 'light') {
  try { tg.HapticFeedback.impactOccurred(style); } catch {}
}

function switchScreen(name) {
  state.screen = name;
  document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden'));
  document.getElementById(`screen-${name}`).classList.remove('hidden');
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.screen === name));
  document.getElementById('topbarTitle').textContent =
    name === 'codespaces' ? 'Codespaces' :
    name === 'tokens' ? 'GitHub Accounts' : 'Terminal';
  if (name === 'codespaces') loadCodespaces();
  if (name === 'tokens') loadTokens(true);
}

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => { haptic(); switchScreen(btn.dataset.screen); });
});
document.getElementById('refreshBtn').addEventListener('click', () => {
  haptic();
  if (state.screen === 'codespaces') loadCodespaces();
  if (state.screen === 'tokens') loadTokens(true);
});

// ---------- Tokens ----------
async function loadTokens(withBilling = false) {
  try {
    const { tokens, activeTokenId } = await api('/api/tokens');
    state.tokens = tokens;
    state.activeTokenId = activeTokenId;
    renderTokens();
    renderActiveAccountChip();
    if (withBilling && tokens.length) loadBilling();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function billingFor(id) {
  return (state.billing || []).find((b) => b.tokenId === id);
}

function billingHtml(t) {
  if (state.billingLoading && !billingFor(t._id)) return '<div class="acct-usage muted">Fetching usage…</div>';
  const b = billingFor(t._id);
  if (!b) return '';
  if (b.error) return `<div class="billing-error">⚠ ${escapeHtml(b.error)}</div>`;
  const rows = (b.breakdown || []).map((r) => `
    <div class="billing-row"><span>${escapeHtml(r.sku)}</span><span>${r.hours.toFixed(2)} h</span></div>`).join('');
  return `
    <div class="acct-usage">
      <div class="billing-hours">${b.total_hours.toFixed(2)} <span>hrs this month</span></div>
      ${rows ? `<div class="billing-breakdown">${rows}</div>` : '<div class="billing-row muted"><span>No Codespaces usage recorded yet</span></div>'}
    </div>`;
}

function renderTokens() {
  const list = document.getElementById('tokenList');
  list.innerHTML = '';
  if (!state.tokens.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">🔑</div><p>No accounts saved yet</p></div>`;
    return;
  }
  state.tokens.forEach((t) => {
    const isActive = t._id === state.activeTokenId;
    const b = billingFor(t._id);
    const card = document.createElement('div');
    card.className = 'card acct-card';
    card.innerHTML = `
      <div class="acct-head">
        <div class="acct-title">
          <div class="token-label">${escapeHtml(t.label)}</div>
          <div class="token-sub">${b && b.login ? '@' + escapeHtml(b.login) + ' · ' : ''}Added ${new Date(t.createdAt).toLocaleDateString()}</div>
        </div>
        ${isActive ? '<span class="badge-active">ACTIVE</span>' : ''}
      </div>
      ${billingHtml(t)}
      <div class="acct-actions">
        ${!isActive ? `<button class="btn small primary" data-act="use" data-id="${t._id}">Use</button>` : ''}
        <button class="btn small danger" data-act="del" data-id="${t._id}">Delete</button>
      </div>`;
    list.appendChild(card);
  });

  list.querySelectorAll('[data-act="use"]').forEach((b) =>
    b.addEventListener('click', () => activateToken(b.dataset.id))
  );
  list.querySelectorAll('[data-act="del"]').forEach((b) =>
    b.addEventListener('click', () => deleteToken(b.dataset.id))
  );
}

function renderActiveAccountChip() {
  const chip = document.getElementById('activeAccountChip');
  const label = document.getElementById('activeAccountLabel');
  const active = state.tokens.find((t) => t._id === state.activeTokenId);
  if (active) {
    label.textContent = `Using: ${active.label}`;
    chip.classList.add('online');
  } else {
    label.textContent = 'No account selected';
    chip.classList.remove('online');
  }
}

async function activateToken(id) {
  try {
    await api(`/api/tokens/${id}/activate`, { method: 'POST' });
    haptic('medium');
    showToast('Account switched', 'success');
    await loadTokens();
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteToken(id) {
  if (!confirm('Remove this GitHub account?')) return;
  try {
    await api(`/api/tokens/${id}`, { method: 'DELETE' });
    showToast('Account removed');
    await loadTokens();
  } catch (e) { showToast(e.message, 'error'); }
}

document.getElementById('saveTokenBtn').addEventListener('click', async () => {
  const label = document.getElementById('tokenLabelInput').value.trim();
  const token = document.getElementById('tokenValueInput').value.trim();
  if (!label || !token) return showToast('Enter a label and token', 'error');
  try {
    await api('/api/tokens', { method: 'POST', body: JSON.stringify({ label, token }) });
    document.getElementById('tokenLabelInput').value = '';
    document.getElementById('tokenValueInput').value = '';
    haptic('medium');
    showToast('Account saved', 'success');
    await loadTokens(true);
  } catch (e) { showToast(e.message, 'error'); }
});

// ---------- Billing (shown inside each account card) ----------
async function loadBilling() {
  state.billingLoading = true;
  renderTokens();
  try {
    state.billing = await api('/api/billing');
  } catch (e) {
    showToast(e.message, 'error');
  }
  state.billingLoading = false;
  if (state.screen === 'tokens') renderTokens();
}

// ---------- Codespaces ----------
async function loadCodespaces() {
  try {
    const data = await api('/api/codespaces');
    state.codespaces = data;
    renderCodespaces();
  } catch (e) {
    if (state.tokens.length === 0) await loadTokens();
    document.getElementById('codespaceList').innerHTML = '';
    document.getElementById('codespacesEmpty').style.display = 'block';
    document.getElementById('codespacesEmpty').querySelector('p').textContent = e.message;
  }
}

function renderCodespaces() {
  const list = document.getElementById('codespaceList');
  const empty = document.getElementById('codespacesEmpty');
  list.innerHTML = '';
  if (!state.codespaces.length) {
    empty.style.display = 'block';
    empty.querySelector('p').textContent = 'No codespaces yet';
    return;
  }
  empty.style.display = 'none';

  state.codespaces.forEach((cs) => {
    const running = cs.state === 'Available';
    const awake = !!cs.keepalive_active;
    const card = document.createElement('div');
    card.className = 'card cs-card';
    card.innerHTML = `
      <div class="cs-card-head">
        <div>
          <div class="cs-name">${escapeHtml(cs.display_name || cs.name)}</div>
          <div class="cs-repo">${escapeHtml(cs.repository?.full_name || '')} · ${escapeHtml(cs.machine?.display_name || '')}</div>
        </div>
        <span class="status-pill status-${cs.state}">${cs.state}</span>
      </div>
      <div class="cs-actions">
        ${!running ? `<button class="btn primary" data-act="start" data-name="${cs.name}">▶ Start</button>` : `<button class="btn" data-act="stop" data-name="${cs.name}">⏸ Stop</button>`}
        <button class="btn" data-act="terminal" data-name="${cs.name}">⌨ Terminal</button>
        <button class="btn danger" data-act="delete" data-name="${cs.name}">🗑 Delete</button>
      </div>
      ${running ? `<button class="btn full ${awake ? 'awake-on' : ''}" data-act="keepalive" data-name="${cs.name}" data-state="${awake ? 'on' : 'off'}">
        ${awake ? '🟢 Keep Awake: ON (tap to allow auto-stop)' : '⚪ Keep Awake: OFF (tap to prevent auto-stop)'}
      </button>` : ''}`;
    list.appendChild(card);
  });

  list.querySelectorAll('[data-act="start"]').forEach((b) => b.addEventListener('click', () => csAction(b.dataset.name, 'start')));
  list.querySelectorAll('[data-act="stop"]').forEach((b) => b.addEventListener('click', () => csAction(b.dataset.name, 'stop')));
  list.querySelectorAll('[data-act="delete"]').forEach((b) => b.addEventListener('click', () => csDelete(b.dataset.name)));
  list.querySelectorAll('[data-act="terminal"]').forEach((b) => b.addEventListener('click', () => openTerminalFor(b.dataset.name)));
  list.querySelectorAll('[data-act="keepalive"]').forEach((b) => b.addEventListener('click', () => toggleKeepAwake(b.dataset.name, b.dataset.state)));
}

async function toggleKeepAwake(name, currentState) {
  const turningOn = currentState !== 'on';
  haptic('medium');
  try {
    await api(`/api/codespaces/${name}/keepalive/${turningOn ? 'start' : 'stop'}`, { method: 'POST' });
    showToast(turningOn ? 'Keep Awake enabled — it will stay running until you stop it' : 'Keep Awake disabled', 'success');
    await loadCodespaces();
  } catch (e) { showToast(e.message, 'error'); }
}

async function csAction(name, action) {
  haptic('medium');
  showToast(action === 'start' ? 'Starting...' : 'Stopping...');
  try {
    await api(`/api/codespaces/${name}/${action}`, { method: 'POST' });
    showToast(`Codespace ${action}ed`, 'success');
    setTimeout(loadCodespaces, 1500);
  } catch (e) { showToast(e.message, 'error'); }
}

async function csDelete(name) {
  if (!confirm(`Delete codespace "${name}"? This cannot be undone.`)) return;
  try {
    await api(`/api/codespaces/${name}`, { method: 'DELETE' });
    showToast('Codespace deleted', 'success');
    await loadCodespaces();
  } catch (e) { showToast(e.message, 'error'); }
}

// ---------- New codespace modal ----------
const newCsModal = document.getElementById('newCsModal');
document.getElementById('newCodespaceBtn').addEventListener('click', () => newCsModal.classList.remove('hidden'));
document.getElementById('closeNewCsModal').addEventListener('click', () => newCsModal.classList.add('hidden'));
document.getElementById('createCsBtn').addEventListener('click', async () => {
  const owner = document.getElementById('csOwnerInput').value.trim();
  const repo = document.getElementById('csRepoInput').value.trim();
  const ref = document.getElementById('csRefInput').value.trim() || 'main';
  const machine = document.getElementById('csMachineInput').value;
  if (!owner || !repo) return showToast('Owner and repo are required', 'error');
  try {
    showToast('Creating codespace...');
    await api('/api/codespaces/create', { method: 'POST', body: JSON.stringify({ owner, repo, ref, machine }) });
    newCsModal.classList.add('hidden');
    showToast('Codespace created', 'success');
    await loadCodespaces();
  } catch (e) { showToast(e.message, 'error'); }
});

// ---------- Terminal ----------
// Each tab ("Terminal 1", "Terminal 2"...) is its own xterm.js instance and
// its own tmux session (cs-<id>) on the codespace, so e.g. cloudflared in
// Terminal 1 and bot.py in Terminal 2 run fully independently of each
// other and of whichever tab you're currently looking at.
let currentCsName = null;
let activeTerminalId = null;
const terminalInstances = {}; // id -> { term, fitAddon, ws, pane }

function terminalsKey(name) { return `terminals:${name}`; }

function loadStoredTerminalIds(name) {
  try {
    const raw = localStorage.getItem(terminalsKey(name));
    const ids = raw ? JSON.parse(raw) : [];
    return ids.length ? ids : ['1'];
  } catch { return ['1']; }
}

function saveStoredTerminalIds(name, ids) {
  try { localStorage.setItem(terminalsKey(name), JSON.stringify(ids)); } catch {}
}

function getOrCreateTerminal(id) {
  if (terminalInstances[id]) return terminalInstances[id];
  const pane = document.createElement('div');
  pane.className = 'term-pane';
  // Deliberately NOT hidden yet: xterm.js needs the container to have real
  // layout (non-zero size) at open()/fit() time to size its keyboard-input
  // layer correctly. It's hidden (if needed) right after, once xterm has
  // already measured it — see the callers of getOrCreateTerminal.
  document.getElementById('terminalContainer').appendChild(pane);

  const term = new Terminal({
    theme: { background: '#000000', foreground: '#e6edf3' },
    fontSize: 13,
    cursorBlink: true,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(pane);
  try { fitAddon.fit(); } catch {}

  // Bind input handling ONCE per terminal instance so reconnects don't
  // stack up extra onData listeners.
  term.onData((data) => {
    const inst = terminalInstances[id];
    if (inst.ws && inst.ws.readyState === WebSocket.OPEN) {
      inst.ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  const inst = { term, fitAddon, ws: null, pane };
  terminalInstances[id] = inst;
  return inst;
}

function showTerminalPane(id) {
  Object.entries(terminalInstances).forEach(([tid, inst]) => {
    inst.pane.style.display = tid === id ? 'block' : 'none';
  });
  activeTerminalId = id;
  requestAnimationFrame(() => {
    const inst = terminalInstances[id];
    if (inst) { try { inst.fitAddon.fit(); inst.term.focus(); sendResize(id); } catch {} }
  });
}

function renderTerminalTabs(ids) {
  const bar = document.getElementById('terminalTabs');
  bar.innerHTML = '';
  ids.forEach((id) => {
    const tab = document.createElement('button');
    tab.className = `terminal-tab ${id === activeTerminalId ? 'active' : ''}`;
    tab.textContent = `Terminal ${id}`;
    tab.addEventListener('click', () => switchTerminal(id));
    bar.appendChild(tab);
  });
  const addBtn = document.createElement('button');
  addBtn.className = 'terminal-tab terminal-tab-add';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', addTerminal);
  bar.appendChild(addBtn);
}

function ensureConnected(id) {
  const inst = terminalInstances[id];
  const live = inst && inst.ws && (inst.ws.readyState === WebSocket.OPEN || inst.ws.readyState === WebSocket.CONNECTING);
  if (live) return; // already connected/connecting — switching tabs shouldn't reset it
  connectTerminal(id);
}

function switchTerminal(id) {
  if (id === activeTerminalId) return;
  haptic();
  showTerminalPane(id);
  renderTerminalTabs(loadStoredTerminalIds(currentCsName));
  ensureConnected(id);
}

function addTerminal() {
  haptic('medium');
  const ids = loadStoredTerminalIds(currentCsName);
  let n = 1;
  while (ids.includes(String(n))) n++;
  const id = String(n);
  ids.push(id);
  saveStoredTerminalIds(currentCsName, ids);
  getOrCreateTerminal(id);
  showTerminalPane(id);
  renderTerminalTabs(ids);
  ensureConnected(id);
}

async function killCurrentTerminal() {
  if (!currentCsName || !activeTerminalId) return;
  const id = activeTerminalId;
  if (!confirm(`Kill Terminal ${id}? This stops whatever is running in it.`)) return;
  try {
    if (terminalInstances[id]?.ws) terminalInstances[id].ws.close();
    await api(`/api/codespaces/${currentCsName}/terminals/${id}`, { method: 'DELETE' });
  } catch (e) { showToast(e.message, 'error'); }

  let ids = loadStoredTerminalIds(currentCsName).filter((x) => x !== id);
  if (!ids.length) ids = ['1'];
  saveStoredTerminalIds(currentCsName, ids);

  if (terminalInstances[id]) {
    terminalInstances[id].term.dispose();
    terminalInstances[id].pane.remove();
    delete terminalInstances[id];
  }
  getOrCreateTerminal(ids[0]);
  showTerminalPane(ids[0]);
  renderTerminalTabs(ids);
  ensureConnected(ids[0]);
  showToast(`Terminal ${id} killed`, 'success');
}

async function openTerminalFor(name) {
  currentCsName = name;
  switchScreen('terminal');
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.screen === 'terminal'));
  document.getElementById('terminalTargetLabel').textContent = `Connected to: ${name}`;

  let ids = loadStoredTerminalIds(name);
  try {
    // Pick up terminals that already exist on the codespace (e.g. opened
    // from another device, or this app was closed and reopened) so tabs
    // aren't lost even though they only live in local storage otherwise.
    const { terminals } = await api(`/api/codespaces/${name}/terminals`);
    if (terminals && terminals.length) ids = Array.from(new Set([...ids, ...terminals]));
  } catch {}
  if (!ids.length) ids = ['1'];
  saveStoredTerminalIds(name, ids);

  ids.forEach((id) => getOrCreateTerminal(id));
  showTerminalPane(ids[0]);
  renderTerminalTabs(ids);
  ensureConnected(ids[0]);
}

function connectTerminal(id) {
  if (!currentCsName || !id) return showToast('Pick a codespace from the Codespaces tab first', 'error');
  const inst = getOrCreateTerminal(id);
  inst.term.clear();
  inst.term.write('Connecting...\r\n');

  if (inst.ws) { try { inst.ws.close(); } catch {} }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/ws/terminal`);
  inst.ws = socket;

  socket.onopen = () => {
    socket.send(JSON.stringify({
      initData, codespaceName: currentCsName, terminalId: id,
      cols: inst.term.cols, rows: inst.term.rows,
    }));
    requestAnimationFrame(() => { try { inst.fitAddon.fit(); sendResize(id); } catch {} });
  };
  socket.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'data') inst.term.write(msg.data);
    if (msg.type === 'error') { inst.term.write(`\r\n\x1b[31m${msg.data}\x1b[0m\r\n`); showToast(msg.data, 'error'); }
    if (msg.type === 'exit') inst.term.write(`\r\n\x1b[33mSession ended (code ${msg.data})\x1b[0m\r\n`);
  };
  socket.onclose = () => { if (inst.ws === socket) inst.term.write('\r\n\x1b[90mDisconnected\x1b[0m\r\n'); };
}

function sendResize(id) {
  const inst = terminalInstances[id];
  if (inst && inst.ws && inst.ws.readyState === WebSocket.OPEN) {
    inst.ws.send(JSON.stringify({ type: 'resize', cols: inst.term.cols, rows: inst.term.rows }));
  }
}

window.addEventListener('resize', () => {
  if (activeTerminalId) { try { showTerminalPane(activeTerminalId); } catch {} }
});

document.getElementById('terminalReconnectBtn').addEventListener('click', () => connectTerminal(activeTerminalId));
document.getElementById('terminalCloseBtn').addEventListener('click', () => {
  const inst = terminalInstances[activeTerminalId];
  if (inst && inst.ws) inst.ws.close();
});
document.getElementById('terminalKillBtn').addEventListener('click', killCurrentTerminal);

// ---------- utils ----------
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- init ----------
loadTokens();
loadCodespaces();