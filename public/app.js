const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();
// Without this, Telegram intercepts vertical drags as its own
// swipe-to-collapse/close gesture, so scrolling inside the Terminal
// and Logs views (and anywhere else) never reaches the page — it just
// looks like the output is "stuck" and old lines are unreachable.
if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
tg.setHeaderColor('secondary_bg_color');

const initData = tg.initData; // raw string sent with every API request

const state = {
  screen: 'codespaces',
  tokens: [],
  activeTokenId: null,
  codespaces: [],
  billing: [],
  schedules: [],
};
const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

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
    name === 'tokens' ? 'GitHub Accounts' :
    name === 'schedule' ? 'Auto-Switch' :
    name === 'logs' ? 'Logs' : 'Terminal';
  if (name === 'codespaces') loadCodespaces();
  if (name === 'tokens') loadTokensAndBilling();
  if (name === 'schedule') loadSchedules();
  if (name === 'logs') { loadSchedules(); startLogPolling(); } else { stopLogPolling(); }
}

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => { haptic(); switchScreen(btn.dataset.screen); });
});
document.getElementById('refreshBtn').addEventListener('click', () => {
  haptic();
  if (state.screen === 'codespaces') loadCodespaces();
  if (state.screen === 'tokens') loadTokensAndBilling();
  if (state.screen === 'schedule') loadSchedules();
});

// ---------- Tokens (Accounts, with billing merged in) ----------
async function loadTokensAndBilling() {
  try {
    const { tokens, activeTokenId } = await api('/api/tokens');
    state.tokens = tokens;
    state.activeTokenId = activeTokenId;
    renderTokens();
    renderActiveAccountChip();
  } catch (e) {
    showToast(e.message, 'error');
    return;
  }
  // Usage is fetched second and merged in — a slow/broken billing call
  // never blocks the account list itself from showing.
  try {
    state.billing = await api('/api/billing');
    renderTokens();
  } catch (e) { /* usage is a bonus; account list already rendered */ }
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
    const usage = state.billing.find((b) => b.tokenId === t._id);
    const card = document.createElement('div');
    card.className = 'card token-card';
    card.innerHTML = `
      <div class="token-info">
        <div class="token-label">${escapeHtml(t.label)} ${isActive ? '<span class="badge-active">ACTIVE</span>' : ''}</div>
        <div class="token-sub">Added ${new Date(t.createdAt).toLocaleDateString()}</div>
        ${usage ? (usage.error
            ? `<div class="token-usage error">⚠ ${escapeHtml(usage.error)}</div>`
            : `<div class="token-usage">💳 ${usage.total_hours.toFixed(2)} hrs run this month${usage.login ? ` · @${escapeHtml(usage.login)}` : ''}</div>`)
          : ''}
      </div>
      <div class="token-actions">
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
    await loadTokensAndBilling();
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteToken(id) {
  if (!confirm('Remove this GitHub account?')) return;
  try {
    await api(`/api/tokens/${id}`, { method: 'DELETE' });
    showToast('Account removed');
    await loadTokensAndBilling();
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
    await loadTokensAndBilling();
  } catch (e) { showToast(e.message, 'error'); }
});

// ---------- Codespaces ----------
async function loadCodespaces() {
  try {
    const data = await api('/api/codespaces');
    state.codespaces = data;
    renderCodespaces();
  } catch (e) {
    if (state.tokens.length === 0) await loadTokensAndBilling();
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

// ---------- Schedules (Auto-Switch) ----------
let editingScheduleId = null;
let schCommands = [];

async function loadSchedules() {
  try {
    state.schedules = await api('/api/schedules');
    renderSchedules();
    renderLogScheduleOptions();
  } catch (e) { showToast(e.message, 'error'); }
}

function scheduleTiming(s) {
  return s.mode === 'clock'
    ? `Daily at ${s.clock_time} (${s.timezone})`
    : `Every ${s.timer_minutes} min`;
}

function renderSchedules() {
  const list = document.getElementById('scheduleList');
  const empty = document.getElementById('scheduleEmpty');
  list.innerHTML = '';
  if (!state.schedules.length) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  state.schedules.forEach((s) => {
    const card = document.createElement('div');
    card.className = 'card schedule-card';
    card.innerHTML = `
      <div class="cs-card-head">
        <div>
          <div class="cs-name">${escapeHtml(s.owner)}/${escapeHtml(s.repo)}</div>
          <div class="cs-repo">${escapeHtml(scheduleTiming(s))} · on switch: ${s.on_switch === 'delete' ? 'delete old' : 'stop old'}</div>
          ${s.current_codespace_name ? `<div class="cs-repo">Current: ${escapeHtml(s.current_codespace_name)}</div>` : ''}
        </div>
        <span class="status-pill ${s.enabled ? 'status-Available' : 'status-Stopped'}">${s.enabled ? 'ON' : 'OFF'}</span>
      </div>
      <div class="cs-actions">
        <button class="btn" data-act="toggle" data-id="${s._id}">${s.enabled ? 'Disable' : 'Enable'}</button>
        <button class="btn" data-act="run" data-id="${s._id}">▶ Run Now</button>
        ${s.current_codespace_name ? `<button class="btn" data-act="watch" data-id="${s._id}">⌨ Watch Terminal</button>` : ''}
        <button class="btn" data-act="edit" data-id="${s._id}">Edit</button>
        <button class="btn danger" data-act="del" data-id="${s._id}">🗑 Delete</button>
      </div>`;
    list.appendChild(card);
  });

  list.querySelectorAll('[data-act="toggle"]').forEach((b) => b.addEventListener('click', () => toggleSchedule(b.dataset.id)));
  list.querySelectorAll('[data-act="run"]').forEach((b) => b.addEventListener('click', () => runScheduleNow(b.dataset.id)));
  list.querySelectorAll('[data-act="watch"]').forEach((b) => b.addEventListener('click', () => {
    const s = state.schedules.find((x) => x._id === b.dataset.id);
    if (s?.current_codespace_name) watchAutoTerminal(s.current_codespace_name);
  }));
  list.querySelectorAll('[data-act="edit"]').forEach((b) => b.addEventListener('click', () => openScheduleModal(b.dataset.id)));
  list.querySelectorAll('[data-act="del"]').forEach((b) => b.addEventListener('click', () => deleteSchedule(b.dataset.id)));
}

async function toggleSchedule(id) {
  const s = state.schedules.find((x) => x._id === id);
  if (!s) return;
  try {
    await api(`/api/schedules/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !s.enabled }) });
    await loadSchedules();
  } catch (e) { showToast(e.message, 'error'); }
}

async function runScheduleNow(id) {
  haptic('medium');
  try {
    await api(`/api/schedules/${id}/run-now`, { method: 'POST' });
    showToast('Switch started — check the Logs tab', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteSchedule(id) {
  if (!confirm('Delete this schedule? Its logs will be removed too.')) return;
  try {
    await api(`/api/schedules/${id}`, { method: 'DELETE' });
    showToast('Schedule deleted');
    await loadSchedules();
  } catch (e) { showToast(e.message, 'error'); }
}

const scheduleModal = document.getElementById('newScheduleModal');

function setScheduleMode(mode) {
  document.getElementById('modeTimerBtn').classList.toggle('active', mode === 'timer');
  document.getElementById('modeClockBtn').classList.toggle('active', mode === 'clock');
  document.getElementById('schTimerInput').classList.toggle('hidden', mode !== 'timer');
  document.getElementById('schClockInput').classList.toggle('hidden', mode !== 'clock');
  document.getElementById('schClockHint').classList.toggle('hidden', mode !== 'clock');
}
document.getElementById('modeTimerBtn').addEventListener('click', () => setScheduleMode('timer'));
document.getElementById('modeClockBtn').addEventListener('click', () => setScheduleMode('clock'));
document.getElementById('schClockHint').textContent = `Uses your device's time zone: ${userTimezone}`;

function setOnSwitch(val) {
  document.getElementById('onSwitchStopBtn').classList.toggle('active', val === 'stop');
  document.getElementById('onSwitchDeleteBtn').classList.toggle('active', val === 'delete');
}
document.getElementById('onSwitchStopBtn').addEventListener('click', () => setOnSwitch('stop'));
document.getElementById('onSwitchDeleteBtn').addEventListener('click', () => setOnSwitch('delete'));

function renderCommandChips() {
  const box = document.getElementById('schCommandList');
  box.innerHTML = '';
  schCommands.forEach((cmd, i) => {
    const chip = document.createElement('div');
    chip.className = 'command-chip';
    chip.innerHTML = `<pre>${i + 1}. ${escapeHtml(cmd)}</pre><button data-i="${i}">✕</button>`;
    box.appendChild(chip);
  });
  box.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => { schCommands.splice(Number(b.dataset.i), 1); renderCommandChips(); })
  );
}
document.getElementById('schCommandAddBtn').addEventListener('click', () => {
  const input = document.getElementById('schCommandInput');
  const val = input.value.replace(/\n+$/, '');
  if (!val.trim()) return;
  schCommands.push(val);
  input.value = '';
  renderCommandChips();
});

function openScheduleModal(id) {
  editingScheduleId = id || null;
  const s = id ? state.schedules.find((x) => x._id === id) : null;
  document.getElementById('scheduleModalTitle').textContent = s ? 'Edit Schedule' : 'New Schedule';
  document.getElementById('schOwnerInput').value = s?.owner || '';
  document.getElementById('schRepoInput').value = s?.repo || '';
  document.getElementById('schRefInput').value = s?.ref || '';
  document.getElementById('schMachineInput').value = s?.machine || 'basicLinux32gb';
  document.getElementById('schTimerInput').value = s?.timer_minutes || '';
  document.getElementById('schClockInput').value = s?.clock_time || '';
  setScheduleMode(s?.mode || 'timer');
  setOnSwitch(s?.on_switch || 'stop');
  schCommands = s?.commands ? [...s.commands] : [];
  renderCommandChips();
  scheduleModal.classList.remove('hidden');
}

document.getElementById('newScheduleBtn').addEventListener('click', () => openScheduleModal(null));
document.getElementById('closeScheduleModal').addEventListener('click', () => scheduleModal.classList.add('hidden'));

document.getElementById('saveScheduleBtn').addEventListener('click', async () => {
  const owner = document.getElementById('schOwnerInput').value.trim();
  const repo = document.getElementById('schRepoInput').value.trim();
  if (!owner || !repo) return showToast('Owner and repo are required', 'error');

  const mode = document.getElementById('modeTimerBtn').classList.contains('active') ? 'timer' : 'clock';
  const onSwitch = document.getElementById('onSwitchDeleteBtn').classList.contains('active') ? 'delete' : 'stop';
  const timerMinutes = document.getElementById('schTimerInput').value.trim();
  const clockTime = document.getElementById('schClockInput').value.trim();
  if (mode === 'timer' && !timerMinutes) return showToast('Set a timer interval in minutes', 'error');
  if (mode === 'clock' && !clockTime) return showToast('Set a daily switch time', 'error');

  const payload = {
    owner, repo,
    ref: document.getElementById('schRefInput').value.trim() || 'main',
    machine: document.getElementById('schMachineInput').value,
    mode,
    timer_minutes: mode === 'timer' ? Number(timerMinutes) : null,
    clock_time: mode === 'clock' ? clockTime : null,
    timezone: userTimezone,
    on_switch: onSwitch,
    commands: schCommands,
  };

  try {
    if (editingScheduleId) {
      await api(`/api/schedules/${editingScheduleId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      showToast('Schedule updated', 'success');
    } else {
      await api('/api/schedules', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Schedule created', 'success');
    }
    scheduleModal.classList.add('hidden');
    await loadSchedules();
  } catch (e) { showToast(e.message, 'error'); }
});

// ---------- Logs (read-only — no way to send input from this screen) ----------
let logPollTimer = null;
let currentLogSince = 0;
let currentLogScheduleId = null;

function renderLogScheduleOptions() {
  const select = document.getElementById('logScheduleSelect');
  const empty = document.getElementById('logEmpty');
  const prev = select.value;
  select.innerHTML = '';
  if (!state.schedules.length) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  state.schedules.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s._id;
    opt.textContent = `${s.owner}/${s.repo}`;
    select.appendChild(opt);
  });
  select.value = state.schedules.some((s) => s._id === prev) ? prev : state.schedules[0]._id;
  if (select.value !== currentLogScheduleId) switchLogSchedule(select.value);
}

function switchLogSchedule(id) {
  currentLogScheduleId = id;
  currentLogSince = 0;
  document.getElementById('logView').innerHTML = '';
}

document.getElementById('logScheduleSelect').addEventListener('change', (e) => switchLogSchedule(e.target.value));
document.getElementById('copyLogBtn').addEventListener('click', async () => {
  const text = Array.from(document.querySelectorAll('#logView .log-line')).map((el) => el.textContent).join('\n');
  if (!text) return showToast('Nothing to copy yet', 'error');
  try {
    await navigator.clipboard.writeText(text);
    showToast('Log copied', 'success');
  } catch {
    showToast('Copy failed — long-press to select manually', 'error');
  }
});

async function pollLogs() {
  if (!currentLogScheduleId) return;
  try {
    const lines = await api(`/api/schedules/${currentLogScheduleId}/logs?since=${currentLogSince}`);
    if (!lines.length) return;
    const view = document.getElementById('logView');
    const atBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 20;
    lines.forEach((l) => {
      const row = document.createElement('div');
      row.className = 'log-line';
      row.textContent = l.line;
      view.appendChild(row);
      currentLogSince = Math.max(currentLogSince, l.ts);
    });
    if (atBottom) view.scrollTop = view.scrollHeight;
  } catch { /* keep last-known logs on a transient fetch failure */ }
}

function startLogPolling() {
  stopLogPolling();
  pollLogs();
  logPollTimer = setInterval(pollLogs, 2500);
}
function stopLogPolling() {
  if (logPollTimer) clearInterval(logPollTimer);
  logPollTimer = null;
}

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
    scrollback: 5000, // how many old lines you can scroll back through
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(pane);
  try { fitAddon.fit(); } catch {}

  // Bind input handling ONCE per terminal instance so reconnects don't
  // stack up extra onData listeners.
  term.onData((data) => {
    const inst = terminalInstances[id];
    if (inst.inCopyMode) terminalGoLive(id); // typing means "get back to the shell"
    if (inst.ws && inst.ws.readyState === WebSocket.OPEN) {
      inst.ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  const inst = { term, fitAddon, ws: null, pane, inCopyMode: false };
  terminalInstances[id] = inst;
  return inst;
}

function showTerminalPane(id) {
  Object.entries(terminalInstances).forEach(([tid, inst]) => {
    inst.pane.style.display = tid === id ? 'block' : 'none';
  });
  activeTerminalId = id;
  updateScrollButtons(id);
  requestAnimationFrame(() => {
    const inst = terminalInstances[id];
    if (inst) { try { inst.fitAddon.fit(); inst.term.focus(); sendResize(id); } catch {} }
  });
}

// ---------- Terminal Y-axis scrollbar (tmux copy-mode) ----------
// Each terminal tab is a tmux session on the codespace, which owns the
// whole screen (the "alternate screen buffer") — there's no local browser
// scrollback to fall back on, so seeing old output means scrolling tmux's
// own history via its copy-mode. This drag handle drives that directly.
// It's scoped to its own small thumb element only (via Pointer Events, so
// the same code handles mouse and touch) — it never captures touches over
// the terminal itself, so normal typing/tapping/selecting keeps working.
function sendRaw(id, data) {
  const inst = terminalInstances[id];
  if (inst && inst.ws && inst.ws.readyState === WebSocket.OPEN) inst.ws.send(JSON.stringify({ type: 'input', data }));
}

function updateScrollButtons(id) {
  const inst = terminalInstances[id];
  const banner = document.getElementById('termLiveBanner');
  if (banner) banner.style.display = inst && inst.inCopyMode ? 'block' : 'none';
}

// Moves the active terminal's tmux view by `n` lines: positive scrolls
// back into history (dragging the scrollbar thumb down), negative scrolls
// toward the live tail (dragging it up).
function scrollActiveTerminalByLines(n) {
  const id = activeTerminalId;
  const inst = terminalInstances[id];
  if (!inst || n === 0) return;
  if (n > 0) {
    if (!inst.inCopyMode) {
      sendRaw(id, '\x02['); // tmux prefix (Ctrl-b) then "[" enters copy-mode
      inst.inCopyMode = true;
      updateScrollButtons(id);
    }
    for (let i = 0; i < n; i++) sendRaw(id, '\x1b[A'); // Up = one line back
  } else {
    if (!inst.inCopyMode) return; // already live, nothing further down to go
    for (let i = 0; i < -n; i++) sendRaw(id, '\x1b[B'); // Down = one line forward
  }
}

function terminalGoLive(id) {
  const inst = terminalInstances[id];
  if (!inst || !inst.inCopyMode) return;
  sendRaw(id, 'q'); // exits tmux copy-mode, snaps back to the live tail
  inst.inCopyMode = false;
  updateScrollButtons(id);
}

document.getElementById('termLiveBanner').addEventListener('click', () => {
  if (activeTerminalId) terminalGoLive(activeTerminalId);
});

(function setupTerminalScrollbar() {
  const thumb = document.getElementById('termScrollbarThumb');
  const PX_PER_LINE = 18; // smaller drag distance per line = finer control
  let drag = null;

  thumb.addEventListener('pointerdown', (e) => {
    thumb.setPointerCapture(e.pointerId);
    drag = { lastY: e.clientY, offset: 0 };
    e.preventDefault();
  });

  thumb.addEventListener('pointermove', (e) => {
    if (!drag || !activeTerminalId) return;
    const dy = e.clientY - drag.lastY;
    drag.lastY = e.clientY;
    drag.offset += dy;
    // small visual nudge so the thumb feels responsive to the drag,
    // clamped to a short travel range (we don't know the real scrollback
    // depth, so this is a feel-good indicator, not a literal position)
    const nudge = Math.max(-40, Math.min(40, drag.offset));
    thumb.style.transform = `translateY(${nudge}px)`;
    const accum = (drag.accum || 0) + dy;
    const lines = Math.trunc(accum / PX_PER_LINE);
    if (lines !== 0) {
      scrollActiveTerminalByLines(lines);
      drag.accum = accum - lines * PX_PER_LINE;
    } else {
      drag.accum = accum;
    }
  });

  function endDrag(e) {
    if (!drag) return;
    try { thumb.releasePointerCapture(e.pointerId); } catch {}
    drag = null;
    thumb.style.transform = 'translateY(0px)'; // snap back, ready for the next drag
  }
  thumb.addEventListener('pointerup', endDrag);
  thumb.addEventListener('pointercancel', endDrag);
})();

// ---------- Terminal touch-scroll (two-finger swipe) ----------
// A single finger is left completely alone here — no listeners, no
// preventDefault — so xterm's own touch handling (tap to focus the
// keyboard, drag to select text) works exactly like it does out of the
// box, same as the plain-text Logs view. Scrolling instead uses a
// two-finger vertical swipe (the same convention Termius/Blink/JuiceSSH
// use), which can't be confused with a selection drag and needs no
// mode-switch. touchstart/touchmove are used directly (not Pointer
// Events) since we need the real finger count.
(function setupTerminalTwoFingerScroll() {
  const el = document.getElementById('terminalContainer');
  const PX_PER_LINE = 14;
  let lastY = null;
  let accum = 0;

  function avgY(touches) {
    return (touches[0].clientY + touches[1].clientY) / 2;
  }

  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) { lastY = null; return; }
    lastY = avgY(e.touches);
    accum = 0;
    try { terminalInstances[activeTerminalId]?.term.clearSelection(); } catch {}
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || lastY === null) return;
    e.preventDefault(); // stop pinch-zoom/page bounce while scrolling
    const y = avgY(e.touches);
    accum += y - lastY;
    lastY = y;
    const lines = Math.trunc(accum / PX_PER_LINE);
    if (lines !== 0) {
      scrollActiveTerminalByLines(lines);
      accum -= lines * PX_PER_LINE;
    }
  }, { passive: false });

  function reset(e) {
    if (e.touches.length < 2) lastY = null;
  }
  el.addEventListener('touchend', reset);
  el.addEventListener('touchcancel', reset);
})();

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

// Jumps straight to the "auto" tmux session — the same session the
// scheduler types its startup commands into — so the user can watch it
// live and type into it themselves.
async function watchAutoTerminal(name) {
  await openTerminalFor(name);
  let ids = loadStoredTerminalIds(name);
  if (!ids.includes('auto')) { ids = [...ids, 'auto']; saveStoredTerminalIds(name, ids); }
  getOrCreateTerminal('auto');
  showTerminalPane('auto');
  renderTerminalTabs(ids);
  ensureConnected('auto');
}

function connectTerminal(id) {
  if (!currentCsName || !id) return showToast('Pick a codespace from the Codespaces tab first', 'error');
  const inst = getOrCreateTerminal(id);
  inst.term.clear();
  inst.term.write('Connecting...\r\n');
  inst.inCopyMode = false;
  updateScrollButtons(id);

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

document.getElementById('terminalCopyBtn').addEventListener('click', async () => {
  const inst = terminalInstances[activeTerminalId];
  const text = inst?.term.getSelection() || '';
  if (!text) { showToast('Select some text first', 'error'); return; }
  try { await navigator.clipboard.writeText(text); showToast('Copied'); }
  catch { showToast('Copy failed', 'error'); }
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
loadTokensAndBilling();
loadCodespaces();