const DEFAULT_SERVER_URL = 'http://localhost:8001';

async function getServerUrl() {
  const { serverUrl } = await chrome.storage.local.get({ serverUrl: DEFAULT_SERVER_URL });
  return serverUrl.replace(/\/+$/, '');
}

async function apiFetch(path, options = {}) {
  const base = await getServerUrl();
  const url = `${base}${path}`;
  const resp = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!resp.ok) {
    throw new Error(`API ${resp.status}: ${resp.statusText}`);
  }
  return resp;
}

async function checkConnection() {
  try {
    const resp = await apiFetch('/api/health');
    const data = await resp.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function getFullProfile() {
  try {
    const resp = await apiFetch('/api/profile/full');
    return { ok: true, data: await resp.json() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function analyzeForm(formHtml) {
  try {
    const resp = await apiFetch('/api/autofill/analyze', {
      method: 'POST',
      body: JSON.stringify({ form_html: formHtml }),
    });
    return { ok: true, data: await resp.json() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function getResumeForJob(jobId) {
  try {
    const base = await getServerUrl();
    const resp = await fetch(`${base}/api/jobs/${jobId}/resume.pdf`);
    if (!resp.ok) throw new Error(`${resp.status}`);
    const blob = await resp.blob();
    return { ok: true, data: blob };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function saveLearnedData(data) {
  try {
    const resp = await apiFetch('/api/profile/learn', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return { ok: true, data: await resp.json() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function getCustomQA() {
  try {
    const resp = await apiFetch('/api/custom-qa');
    return { ok: true, data: await resp.json() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = async () => {
    try {
      switch (message.type) {
        case 'checkConnection':
          return await checkConnection();
        case 'getFullProfile':
          return await getFullProfile();
        case 'analyzeForm':
          return await analyzeForm(message.formHtml);
        case 'getResumeForJob':
          return await getResumeForJob(message.jobId);
        case 'saveLearnedData':
          return await saveLearnedData(message.data);
        case 'getCustomQA':
          return await getCustomQA();
        default:
          return { ok: false, error: `Unknown message type: ${message.type}` };
      }
    } catch (err) {
      return { ok: false, error: err.message };
    }
  };

  handler().then(sendResponse);
  return true; // keep channel open for async response
});
