import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

function createPopupDOM() {
  document.body.innerHTML = `
    <div class="popup">
      <div class="status-row">
        <span class="status-dot" id="statusDot"></span>
        <span class="status-text" id="statusText">Checking...</span>
      </div>
      <button class="btn-primary" id="fillBtn" disabled>Fill Application</button>
      <div class="settings-section">
        <label for="serverUrl">Server URL</label>
        <div class="input-row">
          <input type="text" id="serverUrl" value="http://localhost:8085" spellcheck="false">
          <button class="btn-small" id="saveUrlBtn">Save</button>
        </div>
      </div>
      <a class="settings-link" id="settingsLink" href="#">Open CareerPulse Settings</a>
    </div>
  `;
}

function loadPopup() {
  createPopupDOM();
  // Prevent window.close() from destroying the jsdom document
  window.close = vi.fn();
  const code = readFileSync(join(__dirname, '..', 'popup.js'), 'utf-8');
  eval(code);
}

// ═══════════════════════════════════════════════════════════════
// Init and connection
// ═══════════════════════════════════════════════════════════════

describe('popup init and connection', () => {
  beforeEach(() => {
    globalThis.chrome = {
      runtime: {
        sendMessage: vi.fn(),
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({ serverUrl: 'http://localhost:8085' }),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 1 }]),
        sendMessage: vi.fn(),
        create: vi.fn(),
      },
    };
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('loads server URL from storage on init', async () => {
    globalThis.chrome.runtime.sendMessage.mockResolvedValue({ ok: true, data: {} });
    loadPopup();
    await vi.waitFor(() => {
      expect(document.getElementById('serverUrl').value).toBe('http://localhost:8085');
    });
  });

  it('shows connected status when server responds ok', async () => {
    globalThis.chrome.runtime.sendMessage.mockResolvedValue({ ok: true, data: { status: 'healthy' } });
    loadPopup();
    await vi.waitFor(() => {
      const dot = document.getElementById('statusDot');
      expect(dot.classList.contains('connected')).toBe(true);
    });
  });

  it('enables fill button when connected', async () => {
    globalThis.chrome.runtime.sendMessage.mockResolvedValue({ ok: true, data: {} });
    loadPopup();
    await vi.waitFor(() => {
      expect(document.getElementById('fillBtn').disabled).toBe(false);
    });
  });

  it('shows disconnected status on error', async () => {
    globalThis.chrome.runtime.sendMessage.mockResolvedValue({ ok: false, error: 'Connection refused' });
    loadPopup();
    await vi.waitFor(() => {
      const dot = document.getElementById('statusDot');
      expect(dot.classList.contains('disconnected')).toBe(true);
    });
  });

  it('shows error message in status text', async () => {
    globalThis.chrome.runtime.sendMessage.mockResolvedValue({ ok: false, error: 'ECONNREFUSED' });
    loadPopup();
    await vi.waitFor(() => {
      expect(document.getElementById('statusText').textContent).toBe('ECONNREFUSED');
    });
  });

  it('keeps fill button disabled when disconnected', async () => {
    globalThis.chrome.runtime.sendMessage.mockResolvedValue({ ok: false, error: 'fail' });
    loadPopup();
    await vi.waitFor(() => {
      expect(document.getElementById('fillBtn').disabled).toBe(true);
    });
  });

  it('handles sendMessage exception gracefully', async () => {
    globalThis.chrome.runtime.sendMessage.mockRejectedValue(new Error('Extension error'));
    loadPopup();
    await vi.waitFor(() => {
      const dot = document.getElementById('statusDot');
      expect(dot.classList.contains('disconnected')).toBe(true);
      expect(document.getElementById('statusText').textContent).toBe('Extension error');
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Save URL button
// ═══════════════════════════════════════════════════════════════

describe('save URL', () => {
  beforeEach(() => {
    globalThis.chrome = {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({ serverUrl: 'http://localhost:8085' }),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 1 }]),
        sendMessage: vi.fn(),
        create: vi.fn(),
      },
    };
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('saves new URL to chrome.storage', async () => {
    loadPopup();
    await vi.waitFor(() => {
      expect(document.getElementById('fillBtn').disabled).toBe(false);
    });

    const urlInput = document.getElementById('serverUrl');
    urlInput.value = 'http://myserver:9000';
    document.getElementById('saveUrlBtn').click();

    await vi.waitFor(() => {
      expect(globalThis.chrome.storage.local.set).toHaveBeenCalledWith({
        serverUrl: 'http://myserver:9000',
      });
    });
  });

  it('strips trailing slashes from URL', async () => {
    loadPopup();
    await vi.waitFor(() => {
      expect(document.getElementById('fillBtn').disabled).toBe(false);
    });

    const urlInput = document.getElementById('serverUrl');
    urlInput.value = 'http://myserver:9000///';
    document.getElementById('saveUrlBtn').click();

    await vi.waitFor(() => {
      expect(globalThis.chrome.storage.local.set).toHaveBeenCalledWith({
        serverUrl: 'http://myserver:9000',
      });
    });
  });

  it('does not save empty URL', async () => {
    loadPopup();
    await vi.waitFor(() => {
      expect(document.getElementById('fillBtn').disabled).toBe(false);
    });

    const urlInput = document.getElementById('serverUrl');
    urlInput.value = '';
    document.getElementById('saveUrlBtn').click();

    // set should not be called for empty URL
    // Wait a tick and check no call was made
    await new Promise(r => setTimeout(r, 50));
    const setCalls = globalThis.chrome.storage.local.set.mock.calls;
    expect(setCalls).toHaveLength(0);
  });

  it('rejects non-http URL and shows error', async () => {
    loadPopup();
    await vi.waitFor(() => {
      expect(document.getElementById('fillBtn').disabled).toBe(false);
    });

    const urlInput = document.getElementById('serverUrl');
    urlInput.value = 'ftp://evil.com';
    document.getElementById('saveUrlBtn').click();

    await new Promise(r => setTimeout(r, 50));
    // Should NOT save
    expect(globalThis.chrome.storage.local.set).not.toHaveBeenCalled();
    // Should show error message
    const statusText = document.getElementById('statusText');
    expect(statusText.textContent).toMatch(/http.*https/i);
  });

  it('updates settings link href after save', async () => {
    loadPopup();
    await vi.waitFor(() => {
      expect(document.getElementById('fillBtn').disabled).toBe(false);
    });

    const urlInput = document.getElementById('serverUrl');
    urlInput.value = 'http://myserver:9000';
    document.getElementById('saveUrlBtn').click();

    await vi.waitFor(() => {
      expect(document.getElementById('settingsLink').href).toContain('http://myserver:9000');
    });
  });

  it('re-checks connection after saving URL', async () => {
    loadPopup();
    await vi.waitFor(() => {
      expect(document.getElementById('fillBtn').disabled).toBe(false);
    });

    globalThis.chrome.runtime.sendMessage.mockClear();
    const urlInput = document.getElementById('serverUrl');
    urlInput.value = 'http://myserver:9000';
    document.getElementById('saveUrlBtn').click();

    await vi.waitFor(() => {
      const calls = globalThis.chrome.runtime.sendMessage.mock.calls;
      const connCalls = calls.filter(c => c[0].type === 'checkConnection');
      expect(connCalls.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Fill button
// ═══════════════════════════════════════════════════════════════

describe('fill button', () => {
  beforeEach(() => {
    globalThis.chrome = {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({ serverUrl: 'http://localhost:8085' }),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 42 }]),
        sendMessage: vi.fn(),
        create: vi.fn(),
      },
    };
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('sends startFill message to active tab on click', async () => {
    loadPopup();
    await vi.waitFor(() => {
      expect(document.getElementById('fillBtn').disabled).toBe(false);
    });

    document.getElementById('fillBtn').click();

    await vi.waitFor(() => {
      expect(globalThis.chrome.tabs.sendMessage).toHaveBeenCalledWith(42, { type: 'startFill' });
    });
  });

  it('shows "Filling..." text while in progress', async () => {
    loadPopup();
    await vi.waitFor(() => {
      expect(document.getElementById('fillBtn').disabled).toBe(false);
    });

    // Make sendMessage to tab hang briefly
    globalThis.chrome.tabs.sendMessage.mockImplementation(() => new Promise(r => setTimeout(r, 100)));
    document.getElementById('fillBtn').click();

    expect(document.getElementById('fillBtn').textContent).toBe('Filling...');
  });

  it('restores button text after fill completes', async () => {
    loadPopup();
    await vi.waitFor(() => {
      expect(document.getElementById('fillBtn').disabled).toBe(false);
    });

    globalThis.chrome.tabs.sendMessage.mockResolvedValue(undefined);
    document.getElementById('fillBtn').click();

    await vi.waitFor(() => {
      expect(document.getElementById('fillBtn').textContent).toBe('Fill Application');
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Settings link
// ═══════════════════════════════════════════════════════════════

describe('settings link', () => {
  beforeEach(() => {
    globalThis.chrome = {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({ serverUrl: 'http://localhost:8085' }),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 1 }]),
        sendMessage: vi.fn(),
        create: vi.fn(),
      },
    };
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens settings in a new tab', async () => {
    loadPopup();
    await vi.waitFor(() => {
      expect(document.getElementById('fillBtn').disabled).toBe(false);
    });

    document.getElementById('settingsLink').click();

    await vi.waitFor(() => {
      expect(globalThis.chrome.tabs.create).toHaveBeenCalledWith({
        url: 'http://localhost:8085/#/settings',
      });
    });
  });

  it('sets href on init', async () => {
    loadPopup();
    await vi.waitFor(() => {
      const link = document.getElementById('settingsLink');
      expect(link.href).toContain('http://localhost:8085/#/settings');
    });
  });
});
