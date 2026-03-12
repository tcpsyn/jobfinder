// Mock Chrome extension APIs
globalThis.chrome = {
  runtime: {
    sendMessage: vi.fn().mockResolvedValue({ ok: true, data: { mappings: [] } }),
    onMessage: {
      addListener: vi.fn(),
    },
  },
  storage: {
    local: {
      get: vi.fn().mockResolvedValue({ serverUrl: 'http://localhost:8001' }),
      set: vi.fn().mockResolvedValue(undefined),
    },
  },
};

// Mock CSS.escape (not available in jsdom)
if (!globalThis.CSS) {
  globalThis.CSS = {};
}
if (!CSS.escape) {
  CSS.escape = function (str) {
    return str.replace(/([^\w-])/g, '\\$1');
  };
}

// Enable test exports from content.js
window.__cpAutofillTest = true;
window.__cpAutofillLoaded = false;
