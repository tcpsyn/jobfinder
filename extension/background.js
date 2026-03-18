const DEFAULT_SERVER_URL = 'http://localhost:8085';

async function getServerUrl() {
  const { serverUrl } = await chrome.storage.local.get({ serverUrl: DEFAULT_SERVER_URL });
  const cleaned = serverUrl.replace(/\/+$/, '');
  // Validate URL scheme to prevent fetching non-HTTP URLs
  if (!/^https?:\/\//i.test(cleaned)) {
    throw new Error('Server URL must start with http:// or https://');
  }
  return cleaned;
}

async function apiFetch(path, options = {}) {
  const base = await getServerUrl();
  const url = `${base}${path}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 50000);
  try {
    const resp = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`API ${resp.status}: ${resp.statusText}`);
    }
    return resp;
  } finally {
    clearTimeout(timeoutId);
  }
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

async function analyzeForm(formHtml, adapterFields, structuredFields) {
  try {
    const payload = { form_html: formHtml };
    if (structuredFields?.length) {
      payload.fields = structuredFields;
    } else if (adapterFields?.length) {
      payload.fields = adapterFields;
    }
    const resp = await apiFetch('/api/autofill/analyze', {
      method: 'POST',
      body: JSON.stringify(payload),
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

async function downloadDocument(jobId, docType) {
  try {
    const base = await getServerUrl();
    const endpoint = docType === 'cover-letter'
      ? `/api/jobs/${jobId}/cover-letter.pdf`
      : `/api/jobs/${jobId}/resume.pdf`;
    const resp = await fetch(`${base}${endpoint}`);
    if (!resp.ok) throw new Error(`${resp.status}: ${resp.statusText}`);
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const filename = docType === 'cover-letter'
      ? `cover-letter-${jobId}.pdf`
      : `resume-${jobId}.pdf`;
    await chrome.downloads.download({ url, filename, saveAs: false });
    // Clean up the object URL after a delay
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return { ok: true };
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

async function saveJob(jobData) {
  try {
    const resp = await apiFetch('/api/jobs/save-external', {
      method: 'POST',
      body: JSON.stringify(jobData),
    });
    return { ok: true, data: await resp.json() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function lookupJob(url) {
  try {
    const resp = await apiFetch(`/api/jobs/lookup?url=${encodeURIComponent(url)}`);
    return { ok: true, data: await resp.json() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function markAppliedByUrl(url) {
  try {
    const resp = await apiFetch('/api/jobs/mark-applied-by-url', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
    return { ok: true, data: await resp.json() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function getScoreForUrl(url) {
  try {
    const resp = await apiFetch(`/api/jobs/lookup?url=${encodeURIComponent(url)}`);
    const data = await resp.json();
    return { ok: true, data };
  } catch {
    return { ok: false };
  }
}

// ─── Queue fill orchestration ───────────────────────────────────

let queueState = null; // { items: [], currentIndex: 0, tabId: null }

const QUEUE_STORAGE_KEY = '__cpQueueState';
const TAB_LOAD_TIMEOUT_MS = 30000; // Max wait for tab to reach 'complete'

async function persistQueueState() {
  if (queueState) {
    await chrome.storage.session.set({ [QUEUE_STORAGE_KEY]: queueState });
  } else {
    await chrome.storage.session.remove(QUEUE_STORAGE_KEY);
  }
}

async function restoreQueueState() {
  try {
    const result = await chrome.storage.session.get(QUEUE_STORAGE_KEY);
    if (result[QUEUE_STORAGE_KEY]) {
      queueState = result[QUEUE_STORAGE_KEY];
    }
  } catch { /* session storage may not be available */ }
}

// Restore queue state on service worker wake-up
restoreQueueState();

async function reportFillStatus(queueItemId, status, details = {}) {
  try {
    const resp = await apiFetch(`/api/queue/${queueItemId}/fill-status`, {
      method: 'POST',
      body: JSON.stringify({ status, ...details }),
    });
    return { ok: true, data: await resp.json() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function processNextQueueItem() {
  // Iterative loop instead of recursion to prevent stack overflow on repeated errors
  while (queueState && queueState.currentIndex < queueState.items.length) {
    const item = queueState.items[queueState.currentIndex];

    try {
      const tab = await chrome.tabs.create({ url: item.apply_url, active: true });
      queueState.tabId = tab.id;
      await persistQueueState();

      // Wait for tab to finish loading with timeout fallback
      await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          chrome.tabs.onRemoved.removeListener(removedListener);
          reject(new Error('Tab load timed out'));
        }, TAB_LOAD_TIMEOUT_MS);

        function listener(tabId, changeInfo) {
          if (tabId !== tab.id || changeInfo.status !== 'complete') return;
          chrome.tabs.onUpdated.removeListener(listener);
          chrome.tabs.onRemoved.removeListener(removedListener);
          clearTimeout(timeoutId);
          resolve();
        }

        function removedListener(tabId) {
          if (tabId !== tab.id) return;
          chrome.tabs.onUpdated.removeListener(listener);
          chrome.tabs.onRemoved.removeListener(removedListener);
          clearTimeout(timeoutId);
          reject(new Error('Tab closed before loading'));
        }

        chrome.tabs.onUpdated.addListener(listener);
        chrome.tabs.onRemoved.addListener(removedListener);
      });

      // Send queueFill to content script with delay for SPA hydration
      setTimeout(() => {
        if (!queueState) return;
        chrome.tabs.sendMessage(tab.id, {
          type: 'queueFill',
          queueItemId: item.id,
          jobId: item.job_id,
          jobTitle: item.title || '',
          company: item.company || '',
          queuePosition: queueState.currentIndex + 1,
          queueTotal: queueState.items.length,
        });
      }, 1500);

      // Report that we started filling
      await reportFillStatus(item.id, 'filling');

      return { ok: true, processing: true, position: queueState.currentIndex + 1, total: queueState.items.length };
    } catch (err) {
      // Report error and move to next item (iterative, not recursive)
      await reportFillStatus(item.id, 'error', { error: err.message });
      queueState.currentIndex++;
      await persistQueueState();
    }
  }

  // Queue complete or exhausted
  if (queueState) {
    const completed = queueState.currentIndex;
    const total = queueState.items.length;
    queueState = null;
    await persistQueueState();
    return { ok: true, done: true, completed, total };
  }
  return { ok: false, error: 'No active queue' };
}

async function handleQueueUserAction(queueItemId, action) {
  if (!queueState) return { ok: false, error: 'No active queue' };

  const currentItem = queueState.items[queueState.currentIndex];
  if (!currentItem || currentItem.id !== queueItemId) {
    return { ok: false, error: 'Queue item mismatch' };
  }

  // Report status to backend
  const status = action === 'submitted' ? 'submitted'
    : action === 'skipped' ? 'skipped'
    : 'filled';
  await reportFillStatus(queueItemId, status);

  // Move to next item
  queueState.currentIndex++;
  await persistQueueState();
  return processNextQueueItem();
}

async function startQueueFill(items) {
  if (!items || !items.length) {
    return { ok: false, error: 'No queue items provided' };
  }

  // Cancel any existing queue
  queueState = {
    items,
    currentIndex: 0,
    tabId: null,
  };
  await persistQueueState();

  return processNextQueueItem();
}

async function cancelQueueFill() {
  if (!queueState) return { ok: false, error: 'No active queue' };

  const remaining = queueState.items.length - queueState.currentIndex;
  queueState = null;
  await persistQueueState();
  return { ok: true, cancelled: true, remaining };
}

function getQueueStatus() {
  if (!queueState) return { ok: true, active: false };
  return {
    ok: true,
    active: true,
    position: queueState.currentIndex + 1,
    total: queueState.items.length,
    currentItem: queueState.items[queueState.currentIndex] || null,
  };
}

// Clean up queue state if the active tab is closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (queueState && queueState.tabId === tabId) {
    const currentItem = queueState.items[queueState.currentIndex];
    if (currentItem) {
      reportFillStatus(currentItem.id, 'skipped', { reason: 'tab_closed' });
    }
    queueState.currentIndex++;
    await persistQueueState();
    if (queueState.currentIndex < queueState.items.length) {
      processNextQueueItem();
    } else {
      queueState = null;
      await persistQueueState();
    }
  }
});

// ─── Keyboard shortcut handler ─────────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'start-fill') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'startFill' });
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = async () => {
    try {
      switch (message.type) {
        case 'checkConnection':
          return await checkConnection();
        case 'getFullProfile':
          return await getFullProfile();
        case 'analyzeForm':
          return await analyzeForm(message.formHtml, message.adapterFields, message.structuredFields);
        case 'getResumeForJob':
          return await getResumeForJob(message.jobId);
        case 'saveLearnedData':
          return await saveLearnedData(message.data);
        case 'getCustomQA':
          return await getCustomQA();
        case 'downloadResume':
          return await downloadDocument(message.jobId, 'resume');
        case 'downloadCoverLetter':
          return await downloadDocument(message.jobId, 'cover-letter');
        case 'saveJob':
          return await saveJob(message.jobData);
        case 'lookupJob':
          return await lookupJob(message.url);
        case 'getScoreForUrl':
          return await getScoreForUrl(message.url);
        case 'markAppliedByUrl':
          return await markAppliedByUrl(message.url);
        case 'fillFromQueue':
          return await startQueueFill(message.items);
        case 'queueUserAction':
          return await handleQueueUserAction(message.queueItemId, message.action);
        case 'cancelQueue':
          return await cancelQueueFill();
        case 'getQueueStatus':
          return getQueueStatus();
        case 'reportFillStatus':
          return await reportFillStatus(message.queueItemId, message.status, message.details);
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
