import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

let originalFetch;
let onRemovedCallback;
let onMessageHandler;

let onUpdatedCallbacks;

function loadBackground() {
  onUpdatedCallbacks = [];

  globalThis.chrome = {
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({ serverUrl: 'http://localhost:8085' }),
      },
      session: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    },
    tabs: {
      onRemoved: {
        addListener: vi.fn((cb) => { onRemovedCallback = cb; }),
        removeListener: vi.fn(),
      },
      onUpdated: {
        addListener: vi.fn((cb) => { onUpdatedCallbacks.push(cb); }),
        removeListener: vi.fn((cb) => {
          onUpdatedCallbacks = onUpdatedCallbacks.filter(c => c !== cb);
        }),
      },
      query: vi.fn().mockResolvedValue([{ id: 42 }]),
      create: vi.fn().mockImplementation(async (opts) => {
        const tab = { id: Math.floor(Math.random() * 1000) + 10 };
        // Simulate tab completing load after a short delay to allow listener registration
        setTimeout(() => {
          for (const cb of [...onUpdatedCallbacks]) {
            cb(tab.id, { status: 'complete' });
          }
        }, 5);
        return tab;
      }),
      sendMessage: vi.fn(),
    },
    commands: {
      onCommand: { addListener: vi.fn() },
    },
    runtime: {
      onMessage: {
        addListener: vi.fn((handler) => { onMessageHandler = handler; }),
      },
    },
    downloads: {
      download: vi.fn().mockResolvedValue(undefined),
    },
  };

  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
  globalThis.URL.revokeObjectURL = vi.fn();

  const code = readFileSync(join(__dirname, '..', 'background.js'), 'utf-8');
  (0, eval)(code);
}

function mockFetchOk(data) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(data),
    blob: () => Promise.resolve(new Blob(['test'])),
  });
}

function mockFetchFail(status = 500) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: 'Server Error',
  });
}

function sendMessage(message) {
  return new Promise((resolve) => {
    onMessageHandler(message, {}, resolve);
  });
}

// ═══════════════════════════════════════════════════════════════
// apiFetch
// ═══════════════════════════════════════════════════════════════

describe('apiFetch timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    originalFetch = globalThis.fetch;
    loadBackground();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('aborts fetch after 50 seconds if backend hangs', async () => {
    globalThis.fetch = vi.fn((url, opts) => {
      return new Promise((resolve, reject) => {
        if (opts?.signal) {
          opts.signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }
      });
    });

    const fetchPromise = globalThis.apiFetch('/api/health').catch(e => e);
    await vi.advanceTimersByTimeAsync(51000);

    const error = await fetchPromise;
    expect(error).toBeTruthy();
    expect(error.message).toMatch(/aborted/i);
  });

  it('passes AbortSignal to fetch', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });

    await globalThis.apiFetch('/api/test');

    const callArgs = globalThis.fetch.mock.calls[0];
    expect(callArgs[1]).toHaveProperty('signal');
    expect(callArgs[1].signal).toBeInstanceOf(AbortSignal);
  });
});

// ═══════════════════════════════════════════════════════════════
// API functions via onMessage router
// ═══════════════════════════════════════════════════════════════

describe('onMessage router', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    loadBackground();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('routes checkConnection and returns ok on success', async () => {
    mockFetchOk({ status: 'healthy' });
    const result = await sendMessage({ type: 'checkConnection' });
    expect(result.ok).toBe(true);
    expect(result.data.status).toBe('healthy');
  });

  it('routes checkConnection and returns error on failure', async () => {
    mockFetchFail(500);
    const result = await sendMessage({ type: 'checkConnection' });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('routes getFullProfile', async () => {
    mockFetchOk({ name: 'Test User', email: 'test@example.com' });
    const result = await sendMessage({ type: 'getFullProfile' });
    expect(result.ok).toBe(true);
    expect(result.data.name).toBe('Test User');
  });

  it('routes analyzeForm with form HTML', async () => {
    mockFetchOk({ mappings: [{ selector: '#name', value: 'John' }] });
    const result = await sendMessage({
      type: 'analyzeForm',
      formHtml: '<form><input name="name"></form>',
    });
    expect(result.ok).toBe(true);
    expect(result.data.mappings).toHaveLength(1);
  });

  it('routes analyzeForm with structured fields', async () => {
    mockFetchOk({ mappings: [] });
    const result = await sendMessage({
      type: 'analyzeForm',
      formHtml: '<form></form>',
      structuredFields: [{ selector: '#f1', label: 'Name' }],
    });
    expect(result.ok).toBe(true);
    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.fields).toHaveLength(1);
  });

  it('routes analyzeForm with adapter fields when no structured fields', async () => {
    mockFetchOk({ mappings: [] });
    const result = await sendMessage({
      type: 'analyzeForm',
      formHtml: '<form></form>',
      adapterFields: [{ selector: '#f1', label: 'Name' }],
    });
    expect(result.ok).toBe(true);
    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.fields).toHaveLength(1);
  });

  it('routes getCustomQA', async () => {
    mockFetchOk({ qa_pairs: [] });
    const result = await sendMessage({ type: 'getCustomQA' });
    expect(result.ok).toBe(true);
  });

  it('routes saveJob', async () => {
    mockFetchOk({ id: 1 });
    const result = await sendMessage({
      type: 'saveJob',
      jobData: { title: 'Dev', company: 'Acme', url: 'https://example.com/job/1' },
    });
    expect(result.ok).toBe(true);
    expect(result.data.id).toBe(1);
  });

  it('routes lookupJob', async () => {
    mockFetchOk({ id: 5, title: 'Dev' });
    const result = await sendMessage({ type: 'lookupJob', url: 'https://example.com/job/5' });
    expect(result.ok).toBe(true);
    expect(result.data.id).toBe(5);
  });

  it('routes markAppliedByUrl', async () => {
    mockFetchOk({ updated: true });
    const result = await sendMessage({ type: 'markAppliedByUrl', url: 'https://example.com/job/1' });
    expect(result.ok).toBe(true);
  });

  it('routes getScoreForUrl', async () => {
    mockFetchOk({ id: 1, match_score: 85 });
    const result = await sendMessage({ type: 'getScoreForUrl', url: 'https://example.com/job/1' });
    expect(result.ok).toBe(true);
    expect(result.data.match_score).toBe(85);
  });

  it('routes saveLearnedData', async () => {
    mockFetchOk({ saved: true });
    const result = await sendMessage({
      type: 'saveLearnedData',
      data: { field: 'phone', value: '555-1234' },
    });
    expect(result.ok).toBe(true);
  });

  it('routes downloadResume', async () => {
    mockFetchOk({});
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['pdf-data'])),
    });
    const result = await sendMessage({ type: 'downloadResume', jobId: 1 });
    expect(result.ok).toBe(true);
    expect(globalThis.chrome.downloads.download).toHaveBeenCalled();
    const dlArgs = globalThis.chrome.downloads.download.mock.calls[0][0];
    expect(dlArgs.filename).toContain('resume-1.pdf');
  });

  it('routes downloadCoverLetter', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['pdf-data'])),
    });
    const result = await sendMessage({ type: 'downloadCoverLetter', jobId: 2 });
    expect(result.ok).toBe(true);
    const dlArgs = globalThis.chrome.downloads.download.mock.calls[0][0];
    expect(dlArgs.filename).toContain('cover-letter-2.pdf');
  });

  it('returns error for unknown message type', async () => {
    const result = await sendMessage({ type: 'unknownType' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown message type');
  });

  it('routes getQueueStatus when no queue active', async () => {
    const result = await sendMessage({ type: 'getQueueStatus' });
    expect(result.ok).toBe(true);
    expect(result.active).toBe(false);
  });

  it('routes cancelQueue when no queue active', async () => {
    const result = await sendMessage({ type: 'cancelQueue' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No active queue');
  });
});

// ═══════════════════════════════════════════════════════════════
// Queue orchestration
// ═══════════════════════════════════════════════════════════════

describe('queue orchestration', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    loadBackground();
    mockFetchOk({ status: 'ok' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('startQueueFill returns error for empty items', async () => {
    const result = await sendMessage({ type: 'fillFromQueue', items: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No queue items');
  });

  it('startQueueFill returns error for null items', async () => {
    const result = await sendMessage({ type: 'fillFromQueue', items: null });
    expect(result.ok).toBe(false);
  });

  it('startQueueFill processes first item and opens tab', async () => {
    const items = [
      { id: 'q1', job_id: 1, apply_url: 'https://example.com/apply/1', title: 'Dev', company: 'Acme' },
      { id: 'q2', job_id: 2, apply_url: 'https://example.com/apply/2', title: 'PM', company: 'Beta' },
    ];
    const result = await sendMessage({ type: 'fillFromQueue', items });
    expect(result.ok).toBe(true);
    expect(result.processing).toBe(true);
    expect(result.position).toBe(1);
    expect(result.total).toBe(2);
    expect(globalThis.chrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://example.com/apply/1',
      active: true,
    });
  });

  it('getQueueStatus shows active queue after start', async () => {
    const items = [
      { id: 'q1', job_id: 1, apply_url: 'https://example.com/apply/1' },
    ];
    await sendMessage({ type: 'fillFromQueue', items });
    const status = await sendMessage({ type: 'getQueueStatus' });
    expect(status.ok).toBe(true);
    expect(status.active).toBe(true);
    expect(status.position).toBe(1);
    expect(status.total).toBe(1);
  });

  it('cancelQueueFill cancels active queue', async () => {
    const items = [
      { id: 'q1', job_id: 1, apply_url: 'https://example.com/apply/1' },
      { id: 'q2', job_id: 2, apply_url: 'https://example.com/apply/2' },
    ];
    await sendMessage({ type: 'fillFromQueue', items });
    const result = await sendMessage({ type: 'cancelQueue' });
    expect(result.ok).toBe(true);
    expect(result.cancelled).toBe(true);

    const status = await sendMessage({ type: 'getQueueStatus' });
    expect(status.active).toBe(false);
  });

  it('queueUserAction advances to next item', async () => {
    const items = [
      { id: 'q1', job_id: 1, apply_url: 'https://example.com/apply/1' },
      { id: 'q2', job_id: 2, apply_url: 'https://example.com/apply/2' },
    ];
    await sendMessage({ type: 'fillFromQueue', items });

    const result = await sendMessage({ type: 'queueUserAction', queueItemId: 'q1', action: 'submitted' });
    expect(result.ok).toBe(true);
    // Should have opened a second tab
    expect(globalThis.chrome.tabs.create).toHaveBeenCalledTimes(2);
  });

  it('queueUserAction returns error on item mismatch', async () => {
    const items = [
      { id: 'q1', job_id: 1, apply_url: 'https://example.com/apply/1' },
    ];
    await sendMessage({ type: 'fillFromQueue', items });

    const result = await sendMessage({ type: 'queueUserAction', queueItemId: 'wrong-id', action: 'submitted' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('mismatch');
  });

  it('queueUserAction reports done when all items processed', async () => {
    const items = [
      { id: 'q1', job_id: 1, apply_url: 'https://example.com/apply/1' },
    ];
    await sendMessage({ type: 'fillFromQueue', items });

    const result = await sendMessage({ type: 'queueUserAction', queueItemId: 'q1', action: 'submitted' });
    expect(result.ok).toBe(true);
    expect(result.done).toBe(true);
    expect(result.completed).toBe(1);
  });

  it('reports fill status to backend API', async () => {
    mockFetchOk({ status: 'ok' });
    const result = await sendMessage({
      type: 'reportFillStatus',
      queueItemId: 'q1',
      status: 'filling',
      details: {},
    });
    expect(result.ok).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalled();
    const url = globalThis.fetch.mock.calls[0][0];
    expect(url).toContain('/api/queue/q1/fill-status');
  });
});

// ═══════════════════════════════════════════════════════════════
// Tab lifecycle cleanup
// ═══════════════════════════════════════════════════════════════

describe('tab lifecycle cleanup', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    loadBackground();
    mockFetchOk({ status: 'ok' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('registers a tabs.onRemoved listener', () => {
    expect(globalThis.chrome.tabs.onRemoved.addListener).toHaveBeenCalled();
  });

  it('advances queue when active tab is closed', async () => {
    const items = [
      { id: 'q1', job_id: 1, apply_url: 'https://example.com/apply/1' },
      { id: 'q2', job_id: 2, apply_url: 'https://example.com/apply/2' },
    ];
    const startResult = await sendMessage({ type: 'fillFromQueue', items });
    expect(startResult.ok).toBe(true);

    // Get the tab ID that was stored in queueState
    const firstTabId = (await globalThis.chrome.tabs.create.mock.results[0].value).id;

    // Simulate the tab being closed — the handler is async and calls processNextQueueItem
    // The onRemovedCallback stored by the mock is the queue cleanup listener
    const queueCleanupCallback = globalThis.chrome.tabs.onRemoved.addListener.mock.calls[0][0];
    await queueCleanupCallback(firstTabId);

    // Wait for the async chain to complete
    await vi.waitFor(() => {
      expect(globalThis.chrome.tabs.create).toHaveBeenCalledTimes(2);
    }, { timeout: 1000 });
  });
});

// ═══════════════════════════════════════════════════════════════
// Keyboard shortcut handler
// ═══════════════════════════════════════════════════════════════

describe('keyboard shortcut handler', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    loadBackground();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('registers a commands listener', () => {
    expect(globalThis.chrome.commands.onCommand.addListener).toHaveBeenCalled();
  });

  it('sends startFill message on start-fill command', async () => {
    const commandHandler = globalThis.chrome.commands.onCommand.addListener.mock.calls[0][0];
    await commandHandler('start-fill');
    expect(globalThis.chrome.tabs.sendMessage).toHaveBeenCalledWith(42, { type: 'startFill' });
  });
});

// ═══════════════════════════════════════════════════════════════
// getServerUrl
// ═══════════════════════════════════════════════════════════════

describe('getServerUrl', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    loadBackground();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('strips trailing slashes from server URL', async () => {
    globalThis.chrome.storage.local.get.mockResolvedValue({ serverUrl: 'http://localhost:8085///' });
    mockFetchOk({ status: 'healthy' });

    await sendMessage({ type: 'checkConnection' });

    const url = globalThis.fetch.mock.calls[0][0];
    expect(url).toBe('http://localhost:8085/api/health');
  });

  it('rejects non-http/https URLs', async () => {
    globalThis.chrome.storage.local.get.mockResolvedValue({ serverUrl: 'ftp://example.com' });
    const result = await sendMessage({ type: 'checkConnection' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('http');
  });

  it('rejects javascript: URLs', async () => {
    globalThis.chrome.storage.local.get.mockResolvedValue({ serverUrl: 'javascript:alert(1)' });
    const result = await sendMessage({ type: 'checkConnection' });
    expect(result.ok).toBe(false);
  });

  it('accepts https URLs', async () => {
    globalThis.chrome.storage.local.get.mockResolvedValue({ serverUrl: 'https://myserver.com' });
    mockFetchOk({ status: 'healthy' });
    const result = await sendMessage({ type: 'checkConnection' });
    expect(result.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Queue state persistence
// ═══════════════════════════════════════════════════════════════

describe('queue state persistence', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    loadBackground();
    mockFetchOk({ status: 'ok' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('persists queue state to session storage on start', async () => {
    const items = [
      { id: 'q1', job_id: 1, apply_url: 'https://example.com/apply/1' },
    ];
    await sendMessage({ type: 'fillFromQueue', items });
    expect(globalThis.chrome.storage.session.set).toHaveBeenCalled();
  });

  it('clears session storage when queue completes', async () => {
    const items = [
      { id: 'q1', job_id: 1, apply_url: 'https://example.com/apply/1' },
    ];
    await sendMessage({ type: 'fillFromQueue', items });
    await sendMessage({ type: 'queueUserAction', queueItemId: 'q1', action: 'submitted' });
    expect(globalThis.chrome.storage.session.remove).toHaveBeenCalled();
  });

  it('clears session storage on cancel', async () => {
    const items = [
      { id: 'q1', job_id: 1, apply_url: 'https://example.com/apply/1' },
    ];
    await sendMessage({ type: 'fillFromQueue', items });
    await sendMessage({ type: 'cancelQueue' });
    expect(globalThis.chrome.storage.session.remove).toHaveBeenCalled();
  });
});
