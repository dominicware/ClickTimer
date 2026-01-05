(() => {
  // -----------------------------
  // Config
  // -----------------------------
  const BLACKLIST_TAGS = new Set([
    "A", "BUTTON", "INPUT", "TEXTAREA", "SELECT", "OPTION",
    "CODE", "PRE", "SVG", "CANVAS", "SCRIPT", "STYLE", "NOSCRIPT"
  ]);

  const MIN_SECONDS = 5;
  const MAX_SECONDS = 6 * 60 * 60; // 6 hours
  const RESCAN_DEBOUNCE_MS = 500;

  const CANDIDATE_RE =
    /(?:\b\d+\s*(?:hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b)(?:\s+\d+\s*(?:hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b)*|\b\d+\s*[-–—]\s*\d+\s*(?:hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b/gi;

  const TIME_OF_DAY_RE = /\b\d{1,2}:\d{2}\b/;
  const TEMP_RE = /°\s*[CF]?\b/i;

  // -----------------------------
  // Alarm audio (loops until done timers dismissed)
  // -----------------------------
  const alarmUrl = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL)
    ? chrome.runtime.getURL("assets/alarm.mp3")
    : null;

  const alarmAudio = alarmUrl ? new Audio(alarmUrl) : null;
  if (alarmAudio) {
    alarmAudio.loop = true;
    alarmAudio.preload = "auto";
  }

  async function updateAlarmPlayback() {
    if (!alarmAudio) return;

    const hasUndismissedDoneTimers = timers.some(t => t.done);
    if (hasUndismissedDoneTimers) {
      // Try to start (may be blocked if the user hasn't interacted with the page).
      try {
        await alarmAudio.play();
      } catch {
        // If blocked, user can click any time again and it will likely allow playback thereafter.
      }
    } else {
      alarmAudio.pause();
      alarmAudio.currentTime = 0;
    }
  }

  // -----------------------------
  // Panel lifecycle (lazy create / auto-destroy)
  // -----------------------------
  let panelHost = null;
  let shadow = null;
  let listEl = null;
  let countEl = null;

  /** @type {Array<{id:string,label:string,endTime:number,paused:boolean,remainingMs:number,done:boolean}>} */
  const timers = [];
  let tickHandle = null;

  function createPanelIfNeeded() {
    if (panelHost) return;

    panelHost = document.createElement("div");
    panelHost.id = "rt-panel-host";
    panelHost.style.position = "fixed";
    panelHost.style.right = "16px";
    panelHost.style.bottom = "16px";
    panelHost.style.zIndex = "2147483647";
    document.documentElement.appendChild(panelHost);

    shadow = panelHost.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .panel {
          font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
          width: 280px;
          background: rgba(20,20,20,0.92);
          color: white;
          border-radius: 10px;
          box-shadow: 0 8px 24px rgba(0,0,0,0.35);
          overflow: hidden;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 12px;
          border-bottom: 1px solid rgba(255,255,255,0.12);
          font-size: 13px;
          letter-spacing: 0.2px;
        }
        .header .title { font-weight: 600; }
        .header .count { opacity: 0.8; }
        .list { max-height: 240px; overflow: auto; }
        .row {
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 10px;
          padding: 10px 12px;
          border-bottom: 1px solid rgba(255,255,255,0.10);
          align-items: center;
        }
        .row:last-child { border-bottom: none; }
        .meta {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }
        .label {
          font-size: 12px;
          opacity: 0.85;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .time {
          font-size: 16px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
        }
        .actions { display: flex; gap: 6px; }
        button {
          all: unset;
          cursor: pointer;
          font-size: 12px;
          padding: 6px 8px;
          border-radius: 8px;
          background: rgba(255,255,255,0.12);
          user-select: none;
        }
        button:hover { background: rgba(255,255,255,0.18); }
        .danger { background: rgba(255,70,70,0.22); }
        .danger:hover { background: rgba(255,70,70,0.30); }
        .done { animation: flash 1s ease-in-out 0s 999; }
        @keyframes flash {
          0%, 100% { background: rgba(255,255,255,0.00); }
          50% { background: rgba(255,255,255,0.10); }
        }
      </style>
      <div class="panel">
        <div class="header">
          <div class="title">Timers</div>
          <div class="count" id="rt-count">0</div>
        </div>
        <div class="list" id="rt-list"></div>
      </div>
    `;

    listEl = shadow.getElementById("rt-list");
    countEl = shadow.getElementById("rt-count");

    shadow.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("button") : null;
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      const id = btn.getAttribute("data-id");
      if (!action || !id) return;

      if (action === "pause") togglePause(id);
      if (action === "remove") removeTimer(id);
    });

    renderPanel();
  }

  function destroyPanelIfEmpty() {
    if (timers.length !== 0) return;

    if (tickHandle) {
      clearInterval(tickHandle);
      tickHandle = null;
    }

    if (panelHost) panelHost.remove();

    panelHost = null;
    shadow = null;
    listEl = null;
    countEl = null;
  }

  // -----------------------------
  // Timer logic
  // -----------------------------
  function formatMs(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function ensureTicking() {
    if (tickHandle) return;

    tickHandle = setInterval(async () => {
      const now = Date.now();
      let hasRunning = false;
      let newlyDone = false;

      for (const t of timers) {
        if (t.done || t.paused) continue;

        const remaining = t.endTime - now;
        if (remaining <= 0) {
          t.done = true;
          t.remainingMs = 0;
          newlyDone = true;
        } else {
          t.remainingMs = remaining;
          hasRunning = true;
        }
      }

      renderPanel();

      if (newlyDone) {
        await updateAlarmPlayback();
      }

      if (!hasRunning) {
        const stillRunning = timers.some(t => !t.done && !t.paused);
        if (!stillRunning) {
          clearInterval(tickHandle);
          tickHandle = null;
        }
      }
    }, 1000);
  }

  async function addTimer(seconds, label) {
    createPanelIfNeeded();

    const ms = seconds * 1000;
    const id = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);

    timers.unshift({
      id,
      label: label || "Timer",
      endTime: Date.now() + ms,
      paused: false,
      remainingMs: ms,
      done: false
    });

    renderPanel();
    ensureTicking();

    // Prime audio permission path (best effort) after a user click.
    // If it fails, it’s fine; later completion may still play if allowed.
    await updateAlarmPlayback();
  }

  function togglePause(id) {
    const t = timers.find(x => x.id === id);
    if (!t || t.done) return;

    if (!t.paused) {
      t.paused = true;
      t.remainingMs = Math.max(0, t.endTime - Date.now());
    } else {
      t.paused = false;
      t.endTime = Date.now() + t.remainingMs;
      ensureTicking();
    }
    renderPanel();
  }

  async function removeTimer(id) {
    const idx = timers.findIndex(x => x.id === id);
    if (idx >= 0) timers.splice(idx, 1);

    renderPanel();
    await updateAlarmPlayback();
    destroyPanelIfEmpty();
  }

  function renderPanel() {
    if (!panelHost || !listEl || !countEl) return;

    countEl.textContent = String(timers.length);

    const rows = timers.map(t => {
      const cls = t.done ? "row done" : "row";
      const timeText = formatMs(
        t.done ? 0 : (t.paused ? t.remainingMs : Math.max(0, t.endTime - Date.now()))
      );
      const pauseText = t.paused ? "Resume" : "Pause";

      return `
        <div class="${cls}">
          <div class="meta">
            <div class="label">${escapeHtml(t.label)}</div>
            <div class="time">${timeText}</div>
          </div>
          <div class="actions">
            <button data-action="pause" data-id="${t.id}">${pauseText}</button>
            <button class="danger" data-action="remove" data-id="${t.id}">X</button>
          </div>
        </div>
      `;
    }).join("");

    listEl.innerHTML = rows;
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  // -----------------------------
  // Parsing
  // -----------------------------
  function unitToSeconds(unitRaw) {
    const u = unitRaw.toLowerCase();
    if (u === "h" || u === "hr" || u === "hrs" || u === "hour" || u === "hours") return 3600;
    if (u === "m" || u === "min" || u === "mins" || u === "minute" || u === "minutes") return 60;
    if (u === "s" || u === "sec" || u === "secs" || u === "second" || u === "seconds") return 1;
    return null;
  }

  function parseDurationText(text) {
    const raw = text.trim();
    if (TEMP_RE.test(raw)) return null;
    if (TIME_OF_DAY_RE.test(raw)) return null;

    const normalized = raw.replace(/[–—]/g, "-");

    // Range: default to upper bound
    const rangeMatch = normalized.match(
      /\b(\d+)\s*-\s*(\d+)\s*(hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b/i
    );
    if (rangeMatch) {
      const upper = parseInt(rangeMatch[2], 10);
      const unit = unitToSeconds(rangeMatch[3]);
      if (!unit) return null;
      const seconds = upper * unit;
      if (seconds < MIN_SECONDS || seconds > MAX_SECONDS) return null;
      return seconds;
    }

    // Sequence: "1 hour 30 minutes", "1h 30m"
    const tokenRe = /(\d+)\s*(hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b/gi;
    let m;
    let total = 0;
    let found = 0;

    while ((m = tokenRe.exec(normalized)) !== null) {
      const n = parseInt(m[1], 10);
      const unit = unitToSeconds(m[2]);
      if (!unit) continue;
      total += n * unit;
      found++;
    }

    if (!found) return null;
    if (total < MIN_SECONDS || total > MAX_SECONDS) return null;
    return total;
  }

  // -----------------------------
  // DOM scanning & replacement
  // -----------------------------
  function isBlacklistedNode(node) {
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (el) {
      if (el.id === "rt-panel-host") return true;
      if (BLACKLIST_TAGS.has(el.tagName)) return true;
      if (el.classList && el.classList.contains("rt-time")) return true;
      el = el.parentElement;
    }
    return false;
  }

  function makeClickableSpan(text, seconds) {
    const span = document.createElement("span");
    span.className = "rt-time";
    span.textContent = text;
    span.setAttribute("data-rt-seconds", String(seconds));
    span.setAttribute("title", "Click to start a timer");
    return span;
  }

  function processTextNode(textNode) {
    const text = textNode.nodeValue;
    if (!text) return;
    if (!/\d/.test(text)) return;
    if (text.length > 2000) return;

    CANDIDATE_RE.lastIndex = 0;
    let match;
    let lastIndex = 0;
    const frag = document.createDocumentFragment();
    let changed = false;

    while ((match = CANDIDATE_RE.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (start < lastIndex) continue;

      const candidate = match[0];
      const seconds = parseDurationText(candidate);
      if (seconds == null) continue;

      if (start > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, start)));
      frag.appendChild(makeClickableSpan(candidate, seconds));
      lastIndex = end;
      changed = true;
    }

    if (!changed) return;

    if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
    textNode.parentNode.replaceChild(frag, textNode);
  }

  function scanAndLinkTimes(root = document.body) {
    if (!root) return;

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node || !node.nodeValue) return NodeFilter.FILTER_REJECT;
          if (!node.nodeValue.match(/\d/)) return NodeFilter.FILTER_REJECT;
          if (isBlacklistedNode(node)) return NodeFilter.FILTER_REJECT;
          const p = node.parentElement;
          if (p && p.classList && p.classList.contains("rt-time")) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    for (const node of nodes) processTextNode(node);
  }

  // Initial scan
  scanAndLinkTimes();

  // Start timer immediately on click (bubble-phase)
  document.addEventListener("click", (e) => {
    const el = e.target && e.target.closest ? e.target.closest(".rt-time") : null;
    if (!el) return;
    const seconds = parseInt(el.getAttribute("data-rt-seconds") || "", 10);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    addTimer(seconds, el.textContent.trim());
  });

  // Rescan dynamic pages
  let rescanTimer = null;
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.target && (m.target.id === "rt-panel-host" || (m.target.closest && m.target.closest("#rt-panel-host")))) {
        return;
      }
    }
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => scanAndLinkTimes(), RESCAN_DEBOUNCE_MS);
  });

  mo.observe(document.documentElement, { childList: true, subtree: true });
})();
