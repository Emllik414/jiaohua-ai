const toggle = document.getElementById('caption-toggle');
const status = document.getElementById('status');

function render(enabled, saved) {
  toggle.checked = enabled;
  status.textContent = saved ? (enabled ? '已开启' : '已关闭，网站原生字幕已恢复') : '';
}

chrome.storage.sync.get({ selectableCaptionsEnabled: true }, (stored) => {
  render(stored.selectableCaptionsEnabled !== false, false);
});

toggle.addEventListener('change', () => {
  const enabled = toggle.checked;
  chrome.storage.sync.set({ selectableCaptionsEnabled: enabled }, () => render(enabled, true));
});
