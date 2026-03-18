const toggleInput = document.getElementById('toggleInput');
const statusText = document.getElementById('statusText');
const pulseDot = document.getElementById('pulseDot');

// Load saved state on popup open (default: enabled)
chrome.storage.local.get(['enabled'], (result) => {
  const isEnabled = result.enabled !== false; // default true
  setToggleState(isEnabled);
});

// Handle toggle change
toggleInput.addEventListener('change', () => {
  const isEnabled = toggleInput.checked;
  chrome.storage.local.set({ enabled: isEnabled });

  // Notify the active tab's content script
  chrome.runtime.sendMessage({ action: 'setEnabled', enabled: isEnabled });

  setToggleState(isEnabled);
});

function setToggleState(isEnabled) {
  toggleInput.checked = isEnabled;

  if (isEnabled) {
    statusText.className = 'status-text on';
    statusText.innerHTML = '<span class="pulse-dot" id="pulseDot"></span>Active';
  } else {
    statusText.className = 'status-text off';
    statusText.innerHTML = '<span class="pulse-dot hidden" id="pulseDot"></span>Inactive';
  }
}