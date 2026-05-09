// app.js — BIT Data Studio entry page
//
// Polls a public GitHub Gist for service status, redirects to the tunnel URL
// when healthy, and shows a friendly "restarting" screen when not.

// ===== Configuration =====
// Gist raw URL is derived from the canonical URL you get when you open the
// gist on github.com. `?t=` is appended at fetch time to defeat CDN caching.
// EDIT THIS: replace {user} and {gist_id} after creating the gist.
const STATUS_URL = "https://gist.githubusercontent.com/larvitar0457/0b3f31656fa657f280ae8f0225764666/raw/status.json";
const POLL_INTERVAL_MS = 10000;

// ===== DOM refs =====
const card = document.getElementById("card");
const headline = document.getElementById("headline");
const subline = document.getElementById("subline");
const lastOnlineEl = document.getElementById("last-online");
const lastCheckEl = document.getElementById("last-check");
const countdownEl = document.getElementById("countdown");
const retryBtn = document.getElementById("retry-btn");

// ===== State =====
let pollTimer = null;
let countdownTimer = null;
let nextPollAt = 0;

// ===== Helpers =====
function formatLocalTime(isoString) {
  if (!isoString) return "—";
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function setState(state, { title, message } = {}) {
  card.dataset.state = state;
  if (title !== undefined) headline.textContent = title;
  if (message !== undefined) subline.textContent = message;
}

function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  nextPollAt = Date.now() + POLL_INTERVAL_MS;
  updateCountdown();
  countdownTimer = setInterval(updateCountdown, 500);
}

function updateCountdown() {
  const remaining = Math.max(0, Math.ceil((nextPollAt - Date.now()) / 1000));
  countdownEl.textContent = remaining > 0 ? `${remaining}s` : "now";
}

async function fetchStatus() {
  const bust = `?t=${Date.now()}`;
  const res = await fetch(STATUS_URL + bust, { cache: "no-store" });
  if (!res.ok) throw new Error(`status fetch failed: HTTP ${res.status}`);
  return res.json();
}

async function probeTunnel(url) {
  // Best-effort liveness probe. no-cors gives us opaque responses; throwing
  // means the browser couldn't reach the tunnel at all.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    await fetch(`${url}/_stcore/health`, {
      mode: "no-cors",
      cache: "no-store",
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// ===== Main loop =====
async function check() {
  retryBtn.disabled = true;

  let status;
  try {
    status = await fetchStatus();
  } catch (err) {
    setState("error", {
      title: "状态端点暂不可用",
      message: "无法读取服务状态，正在重试…",
    });
    lastCheckEl.textContent = formatLocalTime(new Date().toISOString());
    scheduleNext();
    return;
  }

  lastCheckEl.textContent = formatLocalTime(status.last_check);
  lastOnlineEl.textContent = formatLocalTime(status.last_online);

  if (status.healthy && status.url) {
    setState("healthy", {
      title: "服务已就绪，正在跳转…",
      message: status.message || "Connecting to BIT Data Studio",
    });
    const alive = await probeTunnel(status.url);
    if (alive) {
      window.location.replace(status.url);
      return;
    }
    setState("waiting", {
      title: "服务重启中",
      message: "隧道地址已获取但暂时无法连通，稍后会自动重试。",
    });
  } else {
    setState("waiting", {
      title: "服务重启中",
      message: status.message
        ? `${status.message}。系统会自动恢复，无需手动处理。`
        : "后台服务正在恢复，通常 1 分钟内完成。",
    });
  }

  scheduleNext();
}

function scheduleNext() {
  retryBtn.disabled = false;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(check, POLL_INTERVAL_MS);
  startCountdown();
}

retryBtn.addEventListener("click", () => {
  if (pollTimer) clearTimeout(pollTimer);
  check();
});

// Re-check when the tab regains focus — users often tab back expecting fresh data
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (pollTimer) clearTimeout(pollTimer);
    check();
  }
});

check();
