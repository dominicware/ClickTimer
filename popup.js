const toggleInput = document.getElementById('toggleInput');
const statusText  = document.getElementById('statusText');
const themeBtns   = document.querySelectorAll('.theme-btn');

// ── Load saved state on popup open ──────────────────────────────────────────
chrome.storage.local.get(['enabled', 'theme'], (result) => {
  const isEnabled = result.enabled !== false; // default true
  const theme     = result.theme || 'auto';   // default auto

  setToggleState(isEnabled);
  setThemeState(theme);
});

// ── Extension on/off toggle ──────────────────────────────────────────────────
toggleInput.addEventListener('change', () => {
  const isEnabled = toggleInput.checked;
  chrome.storage.local.set({ enabled: isEnabled });
  chrome.runtime.sendMessage({ action: 'setEnabled', enabled: isEnabled });
  setToggleState(isEnabled);
});

// ── Theme buttons ────────────────────────────────────────────────────────────
themeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const theme = btn.getAttribute('data-theme');
    chrome.storage.local.set({ theme });
    chrome.runtime.sendMessage({ action: 'setTheme', theme });
    setThemeState(theme);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function setToggleState(isEnabled) {
  toggleInput.checked = isEnabled;

  if (isEnabled) {
    statusText.className = 'status-text on';
    statusText.innerHTML = '<span class="pulse-dot"></span>Active';
  } else {
    statusText.className = 'status-text off';
    statusText.innerHTML = '<span class="pulse-dot hidden"></span>Inactive';
  }
}

function setThemeState(theme) {
  themeBtns.forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-theme') === theme);
  });
}