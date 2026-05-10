// app.js — BIT Data Studio entry page
//
// Polls a public GitHub Gist for service status, redirects to the tunnel URL
// when healthy, shows a friendly "restarting" or "off-hours" screen otherwise.
// Users can notify the admin via a Lark webhook when service is unavailable.

// ============ Configuration (replace before deploy) ============
const STATUS_URL = "https://gist.githubusercontent.com/larvitar0457/0b3f31656fa657f280ae8f0225764666/raw/status.json";
const LARK_NOTIFY_WEBHOOK = "https://open.larksuite.com/open-apis/bot/v2/hook/dffaa804-c49b-4562-a77d-9afe02c20af9";
const POLL_INTERVAL_MS = 10000;
const COOLDOWN_MS = 5 * 60 * 1000;

// Work hours: Monday–Friday 08:00–18:00 (local time)
const WORK_HOURS = { startHour: 8, endHour: 18, workdays: [1, 2, 3, 4, 5] };

// ============ State ============
const SVG_ICONS = {
  checking: `<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke-linecap="round"/></svg>`,
  healthy: `<svg fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  maintenance: `<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  'off-hours': `<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

const COPY = {
  checking: { title: '正在唤醒数据服务', message: '稍候片刻' },
  healthy: { title: '准备就绪，即将跳转', message: '正在打开 BIT Data Studio' },
  maintenance: { title: '服务异常，自动恢复中', message: '通常 5 分钟内恢复，页面会自动跳转；久未恢复请通知管理员' },
  'off-hours': { title: '服务已下班', message: '工作日 09:00 自动恢复，如需紧急使用请点下方按钮' },
};

const BLOCKLIST = new Set(['test', 'aaa', 'xxx', 'abc', '123', 'admin', 'null', 'undefined']);
const STORAGE = { name: 'bit_entry_name', lastSent: 'bit_entry_last_sent' };

// ============ DOM refs ============
const card = document.getElementById('card');
const headline = document.getElementById('headline');
const subline = document.getElementById('subline');
const iconWrap = document.getElementById('icon-wrap');
const progress = document.getElementById('progress');

const notifyBtn = document.getElementById('notify-btn');
const notifyBtnText = document.getElementById('notify-btn-text');
const toast = document.getElementById('toast');
const toastText = document.getElementById('toast-text');

const modalBackdrop = document.getElementById('modal-backdrop');
const modalSubmit = document.getElementById('modal-submit');
const modalCancel = document.getElementById('modal-cancel');
const nameInput = document.getElementById('name-input');
const modalHint = document.getElementById('modal-hint');

// ============ Helpers ============
function isWorkHours(now = new Date()) {
  const day = now.getDay();
  const hour = now.getHours();
  return WORK_HOURS.workdays.includes(day) &&
         hour >= WORK_HOURS.startHour &&
         hour < WORK_HOURS.endHour;
}

function setState(state) {
  card.dataset.state = state;
  const copy = COPY[state];
  headline.textContent = copy.title;
  subline.textContent = copy.message;
  iconWrap.innerHTML = SVG_ICONS[state];
}

async function fetchStatus() {
  const res = await fetch(`${STATUS_URL}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function probeTunnel(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    await fetch(`${url}/_stcore/health`, { mode: 'no-cors', cache: 'no-store', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// ============ Main polling loop ============
let pollTimer = null;

async function check() {
  let status;
  try {
    status = await fetchStatus();
  } catch {
    // Can't read Gist — treat as transient, stay in checking state
    if (card.dataset.state !== 'healthy') setState('checking');
    scheduleNext();
    return;
  }

  if (status.healthy && status.url) {
    setState('healthy');
    const alive = await probeTunnel(status.url);
    if (alive) {
      window.location.replace(status.url);
      return;
    }
    // Gist says healthy but tunnel not reachable — fall through to waiting
  }

  // Not healthy (or tunnel not reachable): choose maintenance vs off-hours by time
  setState(isWorkHours() ? 'maintenance' : 'off-hours');
  scheduleNext();
}

function scheduleNext() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(check, POLL_INTERVAL_MS);
  animateProgress();
}

function animateProgress() {
  progress.style.transition = 'none';
  progress.style.width = '0%';
  requestAnimationFrame(() => {
    progress.style.transition = `width ${POLL_INTERVAL_MS}ms linear`;
    progress.style.width = '100%';
  });
}

// Re-check when tab regains focus
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (pollTimer) clearTimeout(pollTimer);
    check();
  }
});

// ============ Notify flow ============
function remainingCooldown() {
  const last = Number(localStorage.getItem(STORAGE.lastSent) || 0);
  return Math.max(0, COOLDOWN_MS - (Date.now() - last));
}

function formatRemaining(ms) {
  const totalSec = Math.ceil(ms / 1000);
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`;
}

let cooldownTimer = null;
function refreshNotifyBtn() {
  const rem = remainingCooldown();
  if (rem > 0) {
    notifyBtn.disabled = true;
    notifyBtnText.textContent = `冷却中 · ${formatRemaining(rem)}`;
    if (!cooldownTimer) cooldownTimer = setInterval(refreshNotifyBtn, 1000);
  } else {
    notifyBtn.disabled = false;
    notifyBtnText.textContent = '通知管理员';
    if (cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
  }
}

function validateName(raw) {
  const trimmed = raw.trim();
  if (trimmed.length < 2) return { ok: false, reason: '请输入 2–10 个字的真实称呼' };
  if (trimmed.length > 10) return { ok: false, reason: '称呼过长（最多 10 字）' };
  if (BLOCKLIST.has(trimmed.toLowerCase())) return { ok: false, reason: '请输入真实称呼，方便管理员识别' };
  if (/^(.)\1+$/.test(trimmed)) return { ok: false, reason: '请输入真实称呼，方便管理员识别' };
  return { ok: true, value: trimmed };
}

function showToast(text, type = 'success') {
  toastText.textContent = text;
  toast.className = 'toast show ' + type;
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => { toast.className = 'toast ' + type; }, 3000);
}

function fingerprint() {
  const raw = navigator.userAgent + '|' + screen.width + 'x' + screen.height + '|' + (navigator.language || '');
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 6);
}

function browserLabel() {
  const ua = navigator.userAgent;
  let browser = 'Unknown';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  let os = 'Unknown';
  if (/Mac OS/.test(ua)) os = 'macOS';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Linux/.test(ua)) os = 'Linux';
  else if (/iPhone|iPad/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  return browser + ' / ' + os;
}

function stateLabel() {
  const map = { checking: '检查中', healthy: '已就绪', maintenance: '维护中', 'off-hours': '非工作时段' };
  return map[card.dataset.state] || card.dataset.state;
}

function openModal() {
  if (remainingCooldown() > 0) return;
  modalBackdrop.classList.add('show');
  const saved = localStorage.getItem(STORAGE.name) || '';
  nameInput.value = saved;
  nameInput.dispatchEvent(new Event('input'));
  setTimeout(() => nameInput.focus(), 50);
}

function closeModal() {
  modalBackdrop.classList.remove('show');
}

async function submitNotify() {
  const { ok, value } = validateName(nameInput.value);
  if (!ok) return;

  modalSubmit.disabled = true;
  modalSubmit.textContent = '发送中...';

  localStorage.setItem(STORAGE.name, value);

  const now = new Date();
  const timeStr = now.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });

  const message = [
    '🔔 BIT Data Studio 用户协助请求',
    '',
    `· 称呼：${value}`,
    `· 时间：${timeStr}`,
    `· 状态：${stateLabel()}`,
    `· 设备：${browserLabel()}`,
    `· 来源：${fingerprint()}`,
  ].join('\n');

  try {
    const res = await fetch(LARK_NOTIFY_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text: message } }),
    });
    const data = await res.json();
    if (data.code !== 0 && data.StatusCode !== 0) {
      throw new Error(data.msg || 'unknown error');
    }

    localStorage.setItem(STORAGE.lastSent, String(Date.now()));
    closeModal();
    showToast(`已通知管理员（${value}）`, 'success');
  } catch (err) {
    showToast('通知发送失败，请稍后再试', 'error');
    console.error('notify error:', err);
  } finally {
    refreshNotifyBtn();
    modalSubmit.disabled = false;
    modalSubmit.textContent = '发送通知';
  }
}

// ============ Wire up ============
nameInput.addEventListener('input', () => {
  const { ok, reason } = validateName(nameInput.value);
  modalSubmit.disabled = !ok;
  if (nameInput.value.trim().length === 0) {
    modalHint.textContent = '请输入 2–10 个字的真实称呼';
    modalHint.classList.remove('error');
  } else if (!ok) {
    modalHint.textContent = reason;
    modalHint.classList.add('error');
  } else {
    modalHint.textContent = '按 Enter 或点「发送通知」';
    modalHint.classList.remove('error');
  }
});

nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !modalSubmit.disabled) { e.preventDefault(); submitNotify(); }
  if (e.key === 'Escape') closeModal();
});

modalCancel.addEventListener('click', closeModal);
modalBackdrop.addEventListener('click', (e) => { if (e.target === modalBackdrop) closeModal(); });
modalSubmit.addEventListener('click', submitNotify);

notifyBtn.addEventListener('click', openModal);

// ============ Init ============
refreshNotifyBtn();
setState('checking');
iconWrap.innerHTML = SVG_ICONS.checking;
check();
