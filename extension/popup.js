const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const fillBtn = document.getElementById('fillBtn');
const serverUrlInput = document.getElementById('serverUrl');
const saveUrlBtn = document.getElementById('saveUrlBtn');
const settingsLink = document.getElementById('settingsLink');

let isConnected = false;

async function init() {
  const { serverUrl } = await chrome.storage.local.get({ serverUrl: 'http://localhost:8085' });
  serverUrlInput.value = serverUrl;
  settingsLink.href = `${serverUrl}/#/settings`;
  await checkConnection();
}

async function checkConnection() {
  statusDot.className = 'status-dot';
  statusText.textContent = 'Checking...';
  fillBtn.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({ type: 'checkConnection' });
    if (response && response.ok) {
      statusDot.classList.add('connected');
      statusText.textContent = 'Connected to CareerPulse';
      fillBtn.disabled = false;
      isConnected = true;
    } else {
      statusDot.classList.add('disconnected');
      statusText.textContent = response?.error || 'Cannot reach server';
      isConnected = false;
    }
  } catch (err) {
    statusDot.classList.add('disconnected');
    statusText.textContent = 'Extension error';
    isConnected = false;
  }
}

fillBtn.addEventListener('click', async () => {
  if (!isConnected) return;

  fillBtn.disabled = true;
  fillBtn.textContent = 'Filling...';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      await chrome.tabs.sendMessage(tab.id, { type: 'startFill' });
    }
  } catch (err) {
    console.error('Fill error:', err);
  } finally {
    fillBtn.textContent = 'Fill Application';
    fillBtn.disabled = false;
    window.close();
  }
});

saveUrlBtn.addEventListener('click', async () => {
  let url = serverUrlInput.value.trim().replace(/\/+$/, '');
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) {
    statusDot.className = 'status-dot disconnected';
    statusText.textContent = 'URL must start with http:// or https://';
    return;
  }
  await chrome.storage.local.set({ serverUrl: url });
  settingsLink.href = `${url}/#/settings`;
  await checkConnection();
});

settingsLink.addEventListener('click', async (e) => {
  e.preventDefault();
  const { serverUrl } = await chrome.storage.local.get({ serverUrl: 'http://localhost:8085' });
  chrome.tabs.create({ url: `${serverUrl}/#/settings` });
});

init();
