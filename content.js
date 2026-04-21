// content.js
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
    /(?:\b\d+(?:\s+\d+\/\d+)?\s*(?:hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b)(?:\s+\d+(?:\s+\d+\/\d+)?\s*(?:hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b)*/gi;

  const TIME_OF_DAY_RE = /\b\d{1,2}:\d{2}\b/;
  const TEMP_RE = /°\s*[CF]?\b/i;

  const WRITTEN_NUMBERS = {
    "another": 1, "a": 1, "an": 1,
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "fifteen": 15, "twenty": 20,
    "thirty": 30, "forty": 40, "forty-five": 45, "sixty": 60
  };

  const WRITTEN_RE = /\b(another|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty-five|forty|sixty)\s*(hours?|hr|hrs|minutes?|mins?|min|seconds?|secs?|sec)\b/gi;

  // Matches "4-5 minutes", "4 to 5 minutes" etc.
  // Groups: [1] lower number, [2] separator (e.g. "-" or "to"), [3] upper number, [4] unit
  const RANGE_RE = /\b(\d+)\s*([-–—]|to)\s*(\d+)\s*(hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b/gi;

  // -----------------------------
  // Assets
  // -----------------------------
  const runtimeGetURL =
    (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL)
      ? chrome.runtime.getURL.bind(chrome.runtime)
      : null;

  const alarmUrl = runtimeGetURL ? runtimeGetURL("assets/alarm.mp3") : null;
  const fontUrl = runtimeGetURL
    ? runtimeGetURL("assets/fonts/RobotoCondensed-Regular.ttf")
    : null;

  // Alarm audio (loops until all DONE timers are dismissed)
  const alarmAudio = alarmUrl ? new Audio(alarmUrl) : null;
  if (alarmAudio) {
    alarmAudio.loop = true;
    alarmAudio.preload = "auto";
  }

  /** @type {Array<{id:string,label:string,endTime:number,paused:boolean,remainingMs:number,done:boolean}>} */
  const timers = [];

  async function updateAlarmPlayback() {
    if (!alarmAudio) return;

    const hasUndismissedDoneTimers = timers.some(t => t.done);
    if (hasUndismissedDoneTimers) {
      try {
        await alarmAudio.play();
      } catch {}
    } else {
      alarmAudio.pause();
      alarmAudio.currentTime = 0;
    }
  }

  // -----------------------------
  // Font loading
  // -----------------------------
  let fontLoaded = false;
  async function loadDsegFontOnce() {
    if (fontLoaded) return;
    if (!fontUrl || !("FontFace" in window) || !document.fonts) return;

    try {
      const face = new FontFace("RobotoCondensed", `url(${fontUrl}) format("truetype")`, {
        style: "normal",
        weight: "400"
      });
      await face.load();
      document.fonts.add(face);
      fontLoaded = true;
    } catch {}
  }

  // -----------------------------
  // Draggable (corner-anchored)
  // -----------------------------
  function makeDraggable(host, shadow) {
    let dragging = false;
    let startX, startY, startLeft, startTop;

    function applyCornerAnchor() {
      const rect = host.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const fromLeft = rect.left;
      const fromRight = vw - rect.right;
      const fromTop = rect.top;
      const fromBottom = vh - rect.bottom;

      const anchorRight = fromRight < fromLeft;
      const anchorBottom = fromBottom < fromTop;

      host.style.left = anchorRight ? "auto" : rect.left + "px";
      host.style.right = anchorRight ? fromRight + "px" : "auto";
      host.style.top = anchorBottom ? "auto" : rect.top + "px";
      host.style.bottom = anchorBottom ? fromBottom + "px" : "auto";
    }

    shadow.querySelector(".panel").addEventListener("mousedown", (e) => {
      if (e.target && e.target.closest && e.target.closest("button")) return;

      dragging = true;

      // Convert to left/top for drag math
      const rect = host.getBoundingClientRect();
      host.style.left = rect.left + "px";
      host.style.top = rect.top + "px";
      host.style.right = "auto";
      host.style.bottom = "auto";

      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;

      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      const newLeft = Math.max(0, Math.min(window.innerWidth - host.offsetWidth, startLeft + dx));
      const newTop = Math.max(0, Math.min(window.innerHeight - host.offsetHeight, startTop + dy));

      host.style.left = newLeft + "px";
      host.style.top = newTop + "px";
    });

    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      // Re-anchor to nearest corner after drag ends
      applyCornerAnchor();
    });

    // Re-anchor on window resize so panel doesn't go off screen
    window.addEventListener("resize", () => {
      if (!dragging) applyCornerAnchor();
    });
  }

  // -----------------------------
  // Panel lifecycle (lazy create / auto-destroy)
  // -----------------------------
  let panelHost = null;
  let shadow = null;
  let panelEl = null;
  let listEl = null;

  let tickHandle = null;

  async function createPanelIfNeeded() {
    if (panelHost) return;

    await loadDsegFontOnce();

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
          width: fit-content;
          max-width: min(220px, 86vw);
          border-radius: 20px;
          overflow: hidden;
          transition: max-width 160ms ease 160ms, box-shadow 160ms ease;

          color: rgba(0,0,0,0.85);
          background: linear-gradient(180deg, #f5f2ee 0%, #ede9e3 100%);
          box-shadow:
            0 12px 32px rgba(0,0,0,0.14),
            0 2px 0 rgba(0,0,0,0.04) inset;

          font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
        }

        .panel:hover {
          max-width: min(300px, 86vw);
          transition: max-width 160ms ease 0ms, box-shadow 160ms ease;
        }

        .panel.rt-has-hours {
          max-width: min(240px, 86vw);
        }
        .panel.rt-has-hours:hover {
          max-width: min(320px, 86vw);
        }

        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 6px 10px 6px 12px;
          cursor: grab;

          font-size: clamp(12px, 2.8vw, 18px);
          font-weight: 400;
          letter-spacing: -0.02em;
        }

        .header:active {
          cursor: grabbing;
        }

        .logo {
          height: 18px;
          width: auto;
          display: block;
          color: rgba(0,0,0,0.85);
        }

        .btn-close {
          all: unset;
          cursor: pointer;
          user-select: none;

          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: #1a1a1a;

          display: grid;
          place-items: center;

          flex-shrink: 0;
          transition: background 120ms ease, transform 120ms ease;
        }

        .btn-close:hover {
          background: #444;
          transform: scale(1.12);
        }

        .btn-close:active {
          background: #000;
          transform: scale(0.94);
        }

        .btn-close-icon {
          display: block;
          width: 8px;
          height: 8px;
          position: relative;
        }

        .btn-close-icon::before,
        .btn-close-icon::after {
          content: "";
          position: absolute;
          top: 50%;
          left: 50%;
          width: 9px;
          height: 1.5px;
          background: rgba(255,255,255,0.9);
          border-radius: 1px;
        }

        .btn-close-icon::before {
          transform: translate(-50%, -50%) rotate(45deg);
        }

        .btn-close-icon::after {
          transform: translate(-50%, -50%) rotate(-45deg);
        }

        .divider {
          height: 2px;
          background: rgba(0,0,0,0.08);
        }

        .list {
          padding: 10px 12px 12px 12px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          max-height: 240px;
          overflow: auto;
        }

        .row {
          display: grid;
          grid-template-columns: 1fr auto;
          grid-template-rows: auto auto;
          column-gap: 10px;
          row-gap: 6px;

          align-items: center;

          padding-bottom: 10px;
          border-bottom: 1px solid rgba(0,0,0,0.12);
        }
        .row:last-child {
          padding-bottom: 0;
          border-bottom: none;
        }

        .meta { display: contents; min-width: 0; }

        .label {
          grid-column: 1;
          grid-row: 1;

          font-family: Georgia, 'Times New Roman', serif;
          font-size: clamp(14px, 2.4vw, 18px);
          font-weight: 650;
          letter-spacing: -0.02em;
          opacity: 0;
          transition: opacity 160ms ease;

          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .panel:hover .label {
          opacity: 0.8;
        }

        .panel:not(:hover) .label {
          display: none;
        }

        .time {
          grid-column: 1;
          grid-row: 2;

          font-family: "RobotoCondensed", system-ui, sans-serif;
          font-weight: 400;
          font-variant-numeric: tabular-nums;

          font-size: clamp(36px, 8.5vw, 58px);
          line-height: 1;

          color: rgba(0,0,0,0.88);

          justify-self: end;
        }

        .actions {
          grid-column: 2;
          grid-row: 2;

          align-self: center;

          display: grid;
          grid-template-columns: auto auto;
          grid-template-rows: auto auto;
          gap: 0;
          align-items: stretch;
          justify-items: stretch;

          opacity: 0;
          transition: opacity 160ms ease;
        }

        .panel:hover .actions {
          opacity: 1;
        }

        .panel:not(:hover) .actions {
          display: none;
        }

        .actions button {
          all: unset;
          cursor: pointer;
          user-select: none;

          display: grid;
          place-items: center;

          width: clamp(24px, 5.2vw, 30px);
          height: clamp(24px, 5.2vw, 30px);

          color: rgba(0,0,0,0.85);
          font-size: clamp(12px, 2.6vw, 14px);
          font-weight: 700;
          line-height: 1;
        }

        .actions button:hover { background: rgba(0,0,0,0.06); }
        .actions button:active { background: rgba(0,0,0,0.10); }

        .actions button:nth-child(1),
        .actions button:nth-child(3) {
          border-right: 1px solid rgba(0,0,0,0.10);
        }

        .actions button:nth-child(2) {
          border-bottom: 1px solid rgba(0,0,0,0.10);
        }

        .actions button.btn-x {
          color: rgba(0,0,0,0.85);
        }

        .actions button.btn-x:hover {
          background: rgba(0,0,0,0.06);
        }
        .actions button.btn-x:active {
          background: rgba(0,0,0,0.10);
        }

        .btn-icon {
          font-weight: 800;
          font-size: clamp(13px, 2.8vw, 15px);
        }

        /* ---------- COMPACT MODE (not hovered) ---------- */

        .panel:not(:hover) .row {
          grid-template-columns: 1fr;
          grid-template-rows: auto;
          column-gap: 0;
          row-gap: 0;
          padding-bottom: 6px;
        }

        .panel:not(:hover) .time {
          grid-column: 1;
          grid-row: 1;
          justify-self: center;
          text-align: center;
        }

        .panel:not(:hover) .list {
          padding: 6px 8px 6px 8px;
        }

        .panel:not(:hover) .header {
          padding: 6px 10px 6px 12px;
        }

        .donePulse { animation: donePulse 1.1s ease-in-out infinite; }
        @keyframes donePulse {
          0%, 100% { filter: brightness(1); }
          50% { filter: brightness(0.88); }
        }

        .empty { font-size: 12px; opacity: 0.55; }
      </style>

      <div class="panel">
        <div class="header">
          <svg class="logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 52">
            <text x="4" y="44"
              font-family="Georgia, 'Times New Roman', serif"
              font-size="48" font-weight="700" font-style="italic"
              text-anchor="start" fill="currentColor" letter-spacing="-1">ClickTimer</text>
          </svg>
          <button class="btn-close" id="rt-close" aria-label="Close and cancel all timers">
            <span class="btn-close-icon"></span>
          </button>
        </div>
        <div class="divider"></div>
        <div class="list" id="rt-list"></div>
      </div>
    `;

    panelEl = shadow.querySelector(".panel");
    listEl = shadow.getElementById("rt-list");

    // Close button — cancel all timers and destroy panel
    shadow.getElementById("rt-close").addEventListener("click", () => {
      closeAll();
    });

    shadow.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("button") : null;
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      const id = btn.getAttribute("data-id");
      if (!action || !id) return;

      if (action === "pause") togglePause(id);
      if (action === "remove") removeTimer(id);

      if (action === "plus") adjustTimerBySeconds(id, 60);
      if (action === "minus") adjustTimerBySeconds(id, -60);
    });

    renderPanel();
    makeDraggable(panelHost, shadow);
  }

  function destroyPanel() {
    if (tickHandle) {
      clearInterval(tickHandle);
      tickHandle = null;
    }

    if (alarmAudio) {
      alarmAudio.pause();
      alarmAudio.currentTime = 0;
    }

    if (panelHost) panelHost.remove();

    panelHost = null;
    shadow = null;
    panelEl = null;
    listEl = null;
  }

  function destroyPanelIfEmpty() {
    if (timers.length !== 0) return;
    destroyPanel();
  }

  function closeAll() {
    timers.length = 0;
    destroyPanel();
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
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
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

      if (newlyDone) await updateAlarmPlayback();

      if (!hasRunning) {
        const stillRunning = timers.some(t => !t.done && !t.paused);
        if (!stillRunning) {
          clearInterval(tickHandle);
          tickHandle = null;
        }
      }
    }, 1000);
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  async function adjustTimerBySeconds(id, deltaSeconds) {
    const t = timers.find(x => x.id === id);
    if (!t) return;

    const deltaMs = deltaSeconds * 1000;
    const maxMs = MAX_SECONDS * 1000;

    if (t.done) {
      if (deltaMs <= 0) return;
      t.done = false;
      t.paused = false;
      t.remainingMs = clamp(deltaMs, 0, maxMs);
      t.endTime = Date.now() + t.remainingMs;

      renderPanel();
      ensureTicking();
      await updateAlarmPlayback();
      return;
    }

    if (t.paused) {
      t.remainingMs = clamp(t.remainingMs + deltaMs, 0, maxMs);

      if (t.remainingMs === 0) {
        t.done = true;
        t.paused = false;
      }

      renderPanel();
      await updateAlarmPlayback();
      return;
    }

    t.endTime = t.endTime + deltaMs;

    const remaining = t.endTime - Date.now();
    if (remaining <= 0) {
      t.done = true;
      t.remainingMs = 0;
    } else {
      t.remainingMs = clamp(remaining, 0, maxMs);

      if (t.remainingMs !== remaining) {
        t.endTime = Date.now() + t.remainingMs;
      }
    }

    renderPanel();
    if (!t.done) ensureTicking();
    await updateAlarmPlayback();
  }

  async function addTimer(seconds, label) {
    await createPanelIfNeeded();

    const ms = seconds * 1000;
    const id = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);

    timers.push({
      id,
      label: label || "Timer",
      endTime: Date.now() + ms,
      paused: false,
      remainingMs: ms,
      done: false
    });

    renderPanel();
    ensureTicking();

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
    if (!panelHost || !listEl) return;

    if (panelEl) {
      const now = Date.now();
      const needsHours = timers.some(t => {
        if (t.done) return false;
        const remaining = t.paused ? t.remainingMs : (t.endTime - now);
        return remaining >= 3600 * 1000;
      });
      panelEl.classList.toggle("rt-has-hours", needsHours);
    }

    if (timers.length === 0) {
      listEl.innerHTML = `<div class="empty">Click a time to start a timer.</div>`;
      return;
    }

    listEl.innerHTML = timers.map((t) => {
      const rowClass = t.done ? "row donePulse" : "row";
      const timeText = formatMs(
        t.done ? 0 : (t.paused ? t.remainingMs : Math.max(0, t.endTime - Date.now()))
      );

      const pauseIcon = t.paused ? "▶" : "Ⅱ";

      return `
        <div class="${rowClass}">
          <div class="meta">
            <div class="label">${escapeHtml(t.label)}</div>
            <div class="time">${timeText}</div>
          </div>
          <div class="actions">
            <button data-action="plus" data-id="${t.id}" aria-label="Add 1 minute">+</button>
            <button class="btn-x" data-action="remove" data-id="${t.id}" aria-label="Remove timer">X</button>
            <button data-action="minus" data-id="${t.id}" aria-label="Subtract 1 minute">−</button>
            <button class="btn-icon" data-action="pause" data-id="${t.id}" aria-label="${t.paused ? "Resume" : "Pause"}">${pauseIcon}</button>
          </div>
        </div>
      `;
    }).join("");
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

    const tokenRe = /(\d+)(?:\s+(\d+)\/(\d+))?\s*(hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b/gi;
    let m;
    let total = 0;
    let found = 0;

    while ((m = tokenRe.exec(normalized)) !== null) {
      let n = parseInt(m[1], 10);
      if (m[2] && m[3]) {
        n += parseInt(m[2], 10) / parseInt(m[3], 10);
      }
      const unit = unitToSeconds(m[4]);
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

  function makeClickableSpan(text, seconds, label) {
    const span = document.createElement("span");
    span.className = "rt-time";
    span.textContent = text;
    span.setAttribute("data-rt-seconds", String(seconds));
    span.setAttribute("data-rt-label", label || text);
    span.setAttribute("title", "Click to start a timer");
    return span;
  }

  function processTextNode(textNode) {
    const text = textNode.nodeValue;
    if (!text) return;
    if (!/\d/.test(text) && !WRITTEN_RE.test(text)) return;
    if (text.length > 2000) return;

    CANDIDATE_RE.lastIndex = 0;
    WRITTEN_RE.lastIndex = 0;
    RANGE_RE.lastIndex = 0;

    // Each entry is either a simple match or a range match (two spans)
    const allMatches = [];

    // Collect range matches first — these take priority over CANDIDATE_RE
    const rangeIndexes = new Set();
    let match;
    while ((match = RANGE_RE.exec(text)) !== null) {
      const lower = parseInt(match[1], 10);
      const sep = match[2];
      const upper = parseInt(match[3], 10);
      const unit = unitToSeconds(match[4]);
      if (!unit) continue;

      const lowerSec = lower * unit;
      const upperSec = upper * unit;
      if (upperSec < MIN_SECONDS || upperSec > MAX_SECONDS) continue;
      if (lowerSec < MIN_SECONDS || lowerSec > MAX_SECONDS) continue;

      const fullStart = match.index;
      const fullText = match[0];

      // Lower number span: just the digit(s)
      const lowerText = match[1];
      const lowerEnd = fullStart + lowerText.length;

      // Separator text (with surrounding whitespace) from the full match
      const afterLower = fullText.slice(lowerText.length);
      const sepMatchResult = afterLower.match(/^(\s*(?:[-–—]|to)\s*)/);
      const sepText = sepMatchResult ? sepMatchResult[1] : ` ${sep} `;
      const sepEnd = lowerEnd + sepText.length;

      // Upper number + unit span: remainder of full match
      const upperText = fullText.slice(lowerText.length + sepText.length);

      // Build a descriptive label for the lower span e.g. "4 minutes"
      const lowerLabel = `${match[1]} ${match[4]}`;

      allMatches.push({
        index: fullStart,
        end: fullStart + fullText.length,
        isRange: true,
        lowerText, lowerSec, lowerLabel,
        sepText,
        upperText, upperSec
      });

      for (let i = fullStart; i < fullStart + fullText.length; i++) rangeIndexes.add(i);
    }

    // Collect regular CANDIDATE_RE matches, skipping any covered by a range
    while ((match = CANDIDATE_RE.exec(text)) !== null) {
      if (rangeIndexes.has(match.index)) continue;
      allMatches.push({ index: match.index, end: match.index + match[0].length, text: match[0], seconds: null });
    }

    // Collect written-number matches, skipping any covered by a range
    while ((match = WRITTEN_RE.exec(text)) !== null) {
      if (rangeIndexes.has(match.index)) continue;
      const word = match[1].toLowerCase();
      const n = WRITTEN_NUMBERS[word];
      const unit = unitToSeconds(match[2]);
      if (n && unit) {
        const seconds = n * unit;
        if (seconds >= MIN_SECONDS && seconds <= MAX_SECONDS) {
          allMatches.push({ index: match.index, end: match.index + match[0].length, text: match[0], seconds });
        }
      }
    }

    allMatches.sort((a, b) => a.index - b.index);

    let lastIndex = 0;
    const frag = document.createDocumentFragment();
    let changed = false;

    for (const m of allMatches) {
      const start = m.index;
      const end = m.end;
      if (start < lastIndex) continue;

      if (m.isRange) {
        if (start > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, start)));
        frag.appendChild(makeClickableSpan(m.lowerText, m.lowerSec, m.lowerLabel));
        frag.appendChild(document.createTextNode(m.sepText));
        frag.appendChild(makeClickableSpan(m.upperText, m.upperSec));
        lastIndex = end;
        changed = true;
      } else {
        const seconds = m.seconds !== null ? m.seconds : parseDurationText(m.text);
        if (seconds == null) continue;
        if (start > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, start)));
        frag.appendChild(makeClickableSpan(m.text, seconds));
        lastIndex = end;
        changed = true;
      }
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
          if (!node.nodeValue.match(/\d/) && !WRITTEN_RE.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
          WRITTEN_RE.lastIndex = 0;
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

  // -----------------------------
  // Click handling
  // -----------------------------
  let mouseDownX = 0;
  let mouseDownY = 0;

  document.addEventListener("mousedown", (e) => {
    mouseDownX = e.clientX;
    mouseDownY = e.clientY;
  });

  document.addEventListener("click", (e) => {
    const el = e.target && e.target.closest ? e.target.closest(".rt-time") : null;
    if (!el) return;
    const dx = e.clientX - mouseDownX;
    const dy = e.clientY - mouseDownY;
    if (Math.sqrt(dx * dx + dy * dy) > 4) return;
    if (window.getSelection && window.getSelection().toString().length > 0) return;
    const seconds = parseInt(el.getAttribute("data-rt-seconds") || "", 10);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const label = el.getAttribute('data-rt-label') || el.textContent.trim();
    addTimer(seconds, label);
  });

  // -----------------------------
  // MutationObserver
  // -----------------------------
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

  // -----------------------------
  // Enable / disable messaging
  // -----------------------------
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action !== 'setEnabled') return;

    if (msg.enabled) {
      // Re-scan the page to make times clickable again
      scanAndLinkTimes();
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } else {
      // Stop observing and strip all rt-time spans, restoring original text
      mo.disconnect();
      document.querySelectorAll('.rt-time').forEach(span => {
        span.replaceWith(document.createTextNode(span.textContent));
      });
    }
  });

  // -----------------------------
  // Initialise (respects saved toggle state)
  // -----------------------------
  chrome.storage.local.get(['enabled'], (result) => {
    const isEnabled = result.enabled !== false; // default true
    if (isEnabled) {
      scanAndLinkTimes();
      mo.observe(document.documentElement, { childList: true, subtree: true });
    }
  });

})();