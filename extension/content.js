(() => {
  'use strict';

  // Guard against multiple injections
  if (window.__cpAutofillLoaded) return;
  window.__cpAutofillLoaded = true;

  const PREFIX = 'cp-autofill';
  const OVERLAY_PREFIX = 'cp-overlay';
  const FIELD_TIMEOUT_MS = 8000;  // Max time per field fill
  const API_TIMEOUT_MS = 60000;   // Max time for API analyze call
  const SCAN_DEBOUNCE_MS = 1500;  // Debounce for MutationObserver re-scans
  let currentState = 'idle'; // idle | analyzing | filling | done | error

  // Track original field values for undo support
  const originalValues = new Map(); // selector -> { originalValue, label, value, confidence, action }
  let overlayMode = 'status'; // status | compact | expanded

  // ─── History interceptor (single patch, multiple callbacks) ──

  const historyCallbacks = { pushState: new Set(), replaceState: new Set() };
  const origPushState = history.pushState;
  const origReplaceState = history.replaceState;

  history.pushState = function (...args) {
    origPushState.apply(this, args);
    for (const cb of historyCallbacks.pushState) cb();
  };
  history.replaceState = function (...args) {
    origReplaceState.apply(this, args);
    for (const cb of historyCallbacks.replaceState) cb();
  };

  // ─── Utilities ──────────────────────────────────────────────

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function withTimeout(promise, ms, label = 'operation') {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      ),
    ]);
  }

  // ─── Shadow DOM traversal ──────────────────────────────────

  function deepQuerySelectorAll(root, selector) {
    const results = [];
    try {
      results.push(...root.querySelectorAll(selector));
    } catch { /* skip */ }

    // Traverse shadow roots
    const walk = (node) => {
      if (node.shadowRoot) {
        try {
          results.push(...node.shadowRoot.querySelectorAll(selector));
          node.shadowRoot.querySelectorAll('*').forEach(walk);
        } catch { /* skip */ }
      }
    };

    try {
      root.querySelectorAll('*').forEach(walk);
    } catch { /* skip */ }
    return results;
  }

  function deepQuerySelector(root, selector) {
    try {
      const direct = root.querySelector(selector);
      if (direct) return direct;
    } catch { /* skip */ }

    // Search shadow roots
    const walk = (node) => {
      if (node.shadowRoot) {
        try {
          const found = node.shadowRoot.querySelector(selector);
          if (found) return found;
          for (const child of node.shadowRoot.querySelectorAll('*')) {
            const result = walk(child);
            if (result) return result;
          }
        } catch { /* skip */ }
      }
      return null;
    };

    try {
      for (const node of root.querySelectorAll('*')) {
        const result = walk(node);
        if (result) return result;
      }
    } catch { /* skip */ }
    return null;
  }

  // ─── Form extraction ─────────────────────────────────────────

  function findLabel(el) {
    try {
      // 1. Explicit <label for="">
      if (el.id) {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label) return label.textContent.trim();
      }

      // 2. aria-labelledby
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const parts = labelledBy.split(/\s+/).map(id => {
          const ref = document.getElementById(id);
          return ref ? ref.textContent.trim() : '';
        }).filter(Boolean);
        if (parts.length) return parts.join(' ');
      }

      // 3. aria-label
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel.trim();

      // 4. Parent label
      const parentLabel = el.closest('label');
      if (parentLabel) {
        const clone = parentLabel.cloneNode(true);
        clone.querySelectorAll('input, select, textarea').forEach(c => c.remove());
        const text = clone.textContent.trim();
        if (text) return text;
      }

      // 5. Preceding sibling or nearby text
      const prev = el.previousElementSibling;
      if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN' || prev.tagName === 'DIV')) {
        const text = prev.textContent.trim();
        if (text && text.length < 200) return text;
      }

      // 6. Google Forms: walk up to question container and find the title
      // Google Forms nests inputs inside [data-params] containers with [role="heading"] titles
      let ancestor = el.parentElement;
      for (let i = 0; i < 15 && ancestor; i++) {
        if (ancestor.hasAttribute('data-params') || ancestor.classList.contains('freebirdFormviewerComponentsQuestionBaseRoot')) {
          const heading = ancestor.querySelector('[role="heading"], .freebirdFormviewerComponentsQuestionBaseTitle');
          if (heading) return heading.textContent.trim();
        }
        ancestor = ancestor.parentElement;
      }

      // 7. Generic: walk up looking for a heading-like element near a form field container
      ancestor = el.parentElement;
      for (let i = 0; i < 8 && ancestor; i++) {
        const heading = ancestor.querySelector('[role="heading"], legend, h3, h4');
        if (heading) {
          const inputs = ancestor.querySelectorAll('input, select, textarea, [role="checkbox"], [role="radio"]');
          if (inputs.length <= 10) return heading.textContent.trim();
        }
        ancestor = ancestor.parentElement;
      }

      return '';
    } catch {
      return '';
    }
  }

  function getNearbyHeading(el) {
    try {
      let node = el;
      for (let i = 0; i < 10; i++) {
        node = node.parentElement;
        if (!node) break;
        const heading = node.querySelector('h1, h2, h3, h4, h5, h6, legend');
        if (heading) return heading.textContent.trim().slice(0, 200);
      }
      return '';
    } catch {
      return '';
    }
  }

  function getSelectOptions(el) {
    try {
      return Array.from(el.options).map(opt => ({
        value: opt.value,
        text: opt.textContent.trim(),
      }));
    } catch {
      return [];
    }
  }

  function getRadioCheckboxGroup(el) {
    try {
      const name = el.getAttribute('name');
      if (!name) return [];
      const group = document.querySelectorAll(`input[name="${CSS.escape(name)}"]`);
      return Array.from(group).map(inp => ({
        value: inp.value,
        label: findLabel(inp) || inp.value,
        checked: inp.checked,
      }));
    } catch {
      return [];
    }
  }

  function buildSelector(el) {
    try {
      if (el.id) return `#${CSS.escape(el.id)}`;
      if (el.name) {
        const tag = el.tagName.toLowerCase();
        const type = el.type ? `[type="${el.type}"]` : '';
        const sel = `${tag}[name="${CSS.escape(el.name)}"]${type}`;
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
      // Fallback: build a path
      const parts = [];
      let cur = el;
      while (cur && cur !== document.body) {
        let seg = cur.tagName.toLowerCase();
        if (cur.id) {
          seg = `#${CSS.escape(cur.id)}`;
          parts.unshift(seg);
          break;
        }
        const parent = cur.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
          if (siblings.length > 1) {
            const idx = siblings.indexOf(cur) + 1;
            seg += `:nth-of-type(${idx})`;
          }
        }
        parts.unshift(seg);
        cur = parent;
      }
      return parts.join(' > ');
    } catch {
      return '';
    }
  }

  function extractFormData(formRoot) {
    const root = formRoot || document;
    const fields = [];
    const seen = new Set();

    const selectors = 'input, select, textarea, [contenteditable="true"], [role="combobox"], [role="textbox"], [role="spinbutton"], button[aria-haspopup], [role="button"][aria-haspopup], [data-automation-id][aria-haspopup], [data-automation-id*="select"], [data-automation-id*="dropdown"], [data-automation-id*="stateProvince"], [data-automation-id*="countryRegion"]';

    // Search both light DOM and shadow DOM
    const elements = deepQuerySelectorAll(root, selectors);

    // Also check iframes we can access
    try {
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const iDoc = iframe.contentDocument || iframe.contentWindow?.document;
          if (iDoc) elements.push(...deepQuerySelectorAll(iDoc, selectors));
        } catch { /* cross-origin, skip */ }
      }
    } catch { /* skip */ }

    for (const el of elements) {
      try {
        const type = (el.type || '').toLowerCase();
        if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'image') {
          // Don't skip dropdown trigger elements (e.g., Workday button dropdowns)
          if (!el.hasAttribute('aria-haspopup')) continue;
        }
        if (el.disabled) continue;

        // Skip our own overlay/badge elements
        if (el.closest(`#${PREFIX}-overlay`) || el.closest(`#${PREFIX}-learn-prompt`) || el.closest('.cp-auto-badge')) continue;

        const selector = buildSelector(el);
        if (!selector || seen.has(selector)) continue;
        seen.add(selector);

        // For radio/checkbox groups, only process once per name
        if ((type === 'radio' || type === 'checkbox') && el.name) {
          const groupKey = `group:${el.name}`;
          if (seen.has(groupKey)) continue;
          seen.add(groupKey);
        }

        const field = {
          selector,
          tag: el.tagName.toLowerCase(),
          type: type || null,
          name: el.name || null,
          id: el.id || null,
          placeholder: el.placeholder || null,
          label: findLabel(el),
          nearbyHeading: getNearbyHeading(el),
          required: el.required || el.getAttribute('aria-required') === 'true',
          currentValue: el.value || el.textContent?.trim() || '',
          isContentEditable: el.isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA',
          role: el.getAttribute('role') || null,
        };

        if (el.tagName === 'SELECT') {
          field.options = getSelectOptions(el);
        } else if (type === 'radio' || type === 'checkbox') {
          field.options = getRadioCheckboxGroup(el);
        }

        fields.push(field);
      } catch {
        // Skip problematic elements
      }
    }

    return fields;
  }

  // ─── Form HTML serialization ──────────────────────────────────

  function serializeFormHtml() {
    try {
      const clone = document.body.cloneNode(true);

      // Remove noisy elements
      const removeSelectors = 'script, style, img, svg, iframe, video, audio, canvas, noscript, link, meta';
      clone.querySelectorAll(removeSelectors).forEach(el => el.remove());

      // Remove data attributes and inline styles
      const allEls = clone.querySelectorAll('*');
      for (const el of allEls) {
        const attrs = Array.from(el.attributes);
        for (const attr of attrs) {
          if (attr.name.startsWith('data-') || attr.name === 'style' || attr.name === 'onclick'
              || attr.name === 'onchange' || attr.name === 'onsubmit') {
            el.removeAttribute(attr.name);
          }
        }
      }

      // Only keep form-relevant sections
      const forms = clone.querySelectorAll('form, [role="form"], main, [role="main"]');
      let html;
      if (forms.length) {
        html = Array.from(forms).map(f => f.outerHTML).join('\n');
      } else {
        html = clone.innerHTML;
      }

      // Truncate to 50KB
      if (html.length > 50000) {
        html = html.slice(0, 50000);
      }

      return html;
    } catch (err) {
      return `<error>${err.message}</error>`;
    }
  }

  // ─── Element resolution ────────────────────────────────────

  function resolveElement(selector) {
    // Handle iframe selectors: "iframe:SELECTOR>>>FIELD_SELECTOR"
    if (selector.startsWith('iframe:')) {
      try {
        const parts = selector.slice(7).split('>>>');
        const iframeSelector = parts[0];
        const fieldSelector = parts[1];
        const iframe = document.querySelector(iframeSelector);
        if (!iframe) return null;
        const iDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!iDoc) return null;
        return iDoc.querySelector(fieldSelector);
      } catch {
        return null;
      }
    }

    // Try standard querySelector first
    try {
      const el = document.querySelector(selector);
      if (el) return el;
    } catch { /* skip */ }

    // Try shadow DOM
    try {
      const el = deepQuerySelector(document, selector);
      if (el) return el;
    } catch { /* skip */ }

    // Fallback: try finding by id/name fragments from the selector
    try {
      const idMatch = selector.match(/#([\w-]+)/);
      if (idMatch) {
        const el = document.getElementById(idMatch[1]);
        if (el) return el;
      }
      const nameMatch = selector.match(/\[name="([^"]+)"\]/);
      if (nameMatch) {
        const el = document.querySelector(`[name="${nameMatch[1]}"]`);
        if (el) return el;
      }
    } catch { /* skip */ }

    return null;
  }

  // ─── Event dispatch ────────────────────────────────────────

  function setNativeValue(el, value) {
    // React-compatible value setting
    const prototype = Object.getPrototypeOf(el);
    const nativeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;

    if (nativeSetter) {
      nativeSetter.call(el, value);
    } else {
      el.value = value;
    }
  }

  function dispatchEvents(el, eventNames) {
    for (const name of eventNames) {
      try {
        if (name === 'input') {
          el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText' }));
        } else if (name === 'change') {
          el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        } else if (name === 'click') {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        } else if (name === 'focus') {
          el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
        } else if (name === 'blur') {
          el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        } else if (name === 'keydown' || name === 'keyup' || name === 'keypress') {
          el.dispatchEvent(new KeyboardEvent(name, { bubbles: true, cancelable: true }));
        }
      } catch { /* skip */ }
    }
  }

  function simulateTyping(el, value) {
    // Simulate realistic key-by-key input for frameworks that need it
    setNativeValue(el, '');
    dispatchEvents(el, ['input']);

    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      try {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: char, code: `Key${char.toUpperCase()}`, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keypress', { key: char, code: `Key${char.toUpperCase()}`, bubbles: true }));
      } catch { /* skip */ }
      setNativeValue(el, value.slice(0, i + 1));
      dispatchEvents(el, ['input']);
      try {
        el.dispatchEvent(new KeyboardEvent('keyup', { key: char, code: `Key${char.toUpperCase()}`, bubbles: true }));
      } catch { /* skip */ }
    }
  }

  // ─── Field hints and phone detection ────────────────────────

  function getFieldHints(el) {
    if (!el) return { label: '', name: '', id: '', placeholder: '' };
    try {
      return {
        label: findLabel(el),
        name: el.getAttribute('name') || '',
        id: el.id || '',
        placeholder: el.getAttribute('placeholder') || '',
      };
    } catch {
      return { label: '', name: '', id: '', placeholder: '' };
    }
  }

  function isPhoneExtensionField(el) {
    if (!el) return false;
    try {
      const hints = getFieldHints(el);
      const combined = `${hints.label} ${hints.name} ${hints.id} ${hints.placeholder}`;
      return /\bext(ension)?\b/i.test(combined);
    } catch {
      return false;
    }
  }

  function isPhoneField(el) {
    if (!el) return false;
    try {
      // Phone extension fields are NOT phone number fields
      if (isPhoneExtensionField(el)) return false;
      if ((el.type || '').toLowerCase() === 'tel') return true;
      const hints = getFieldHints(el);
      const combined = `${hints.label} ${hints.name} ${hints.id} ${hints.placeholder}`;
      return /phone|tel|mobile|cell/i.test(combined);
    } catch {
      return false;
    }
  }

  // ─── Dropdown / listbox detection ──────────────────────────

  function fuzzyMatchOption(options, targetValue, fieldHints) {
    if (!options || !options.length) return -1;
    const target = targetValue.toLowerCase().trim();

    // Pass 1: exact match on value
    for (let i = 0; i < options.length; i++) {
      if (options[i].value.toLowerCase() === target) return i;
    }
    // Pass 2: exact match on text
    for (let i = 0; i < options.length; i++) {
      if (options[i].text.toLowerCase().trim() === target) return i;
    }

    // Pass 3: normalization via lookup tables
    if (window.__cpNormalize) {
      try {
        const norm = window.__cpNormalize;
        const hints = fieldHints || {};
        const hintValues = [hints.label, hints.name, hints.id, hints.placeholder].filter(Boolean);
        const tables = norm.detectFieldCategory(hintValues);

        // Try normalizedMatch against option text values
        const optionTexts = options.map(o => o.text.trim());
        const normIdx = norm.normalizedMatch(optionTexts, targetValue, tables.length ? tables : undefined);
        if (normIdx >= 0) return normIdx;

        // Try normalizedMatch against option value attributes
        const optionValues = options.map(o => o.value);
        const normValIdx = norm.normalizedMatch(optionValues, targetValue, tables.length ? tables : undefined);
        if (normValIdx >= 0) return normValIdx;

        // Boolean equivalence (yes/true/1, no/false/0)
        const boolIdx = norm.normalizedMatch(optionTexts, targetValue, [norm.BOOLEAN_YES_NO]);
        if (boolIdx >= 0) return boolIdx;
        const boolValIdx = norm.normalizedMatch(optionValues, targetValue, [norm.BOOLEAN_YES_NO]);
        if (boolValIdx >= 0) return boolValIdx;
      } catch { /* normalization unavailable, continue */ }
    }

    // Pass 4: contains / substring match
    for (let i = 0; i < options.length; i++) {
      if (options[i].value.toLowerCase().includes(target) || options[i].text.toLowerCase().includes(target)) return i;
      if (target.includes(options[i].value.toLowerCase()) || target.includes(options[i].text.toLowerCase().trim())) return i;
    }
    return -1;
  }

  function dismissOpenDropdowns() {
    // Close any stale dropdowns from previous field fills
    const dropdownSelectors = [
      '[role="listbox"]',
      '.autocomplete-results',
      '.autocomplete-dropdown',
      '.suggestions',
      '.tt-menu',
      '.select2-results__options',
      '[class*="MenuList"]',
      '[class*="menu-list"]',
    ];

    for (const sel of dropdownSelectors) {
      try {
        const dropdowns = document.querySelectorAll(sel);
        for (const dd of dropdowns) {
          if (dd.offsetParent !== null && dd.children.length > 0) {
            // Press Escape to close it
            document.activeElement?.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })
            );
            // Also click the body to dismiss
            document.body.click();
            return;
          }
        }
      } catch { /* skip */ }
    }
  }

  function isElementVisible(el) {
    if (!el) return false;
    try {
      // Check offsetParent (null for hidden elements, but also null for position:fixed)
      if (el.offsetParent === null) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (style.position !== 'fixed' && style.position !== 'sticky') return false;
      }
      if (el.offsetHeight === 0 && el.offsetWidth === 0) return false;
      return true;
    } catch {
      return false;
    }
  }

  function findTypeaheadDropdown(el) {
    const searchSelectors = [
      '[role="listbox"]',
      '[role="option"]',
      '.autocomplete-results',
      '.autocomplete-dropdown',
      '.suggestions',
      '.tt-menu',
      '.select2-results',
      '.css-1nmdiq5-menu',
      '[class*="menu-list"]',
      '[class*="MenuList"]',
      '[class*="listbox"]',
      '[class*="dropdown"] ul',
      '[class*="suggestion"]',
      '[class*="typeahead"]',
      '[class*="autocomplete"]',
      'ul[id*="listbox"]',
      'ul[id*="options"]',
      'div[id*="listbox"]',
      'datalist',
    ];

    // Check aria-owns / aria-controls on the input first
    for (const attr of ['aria-owns', 'aria-controls', 'aria-activedescendant', 'list']) {
      const refId = el.getAttribute(attr);
      if (refId) {
        const ref = document.getElementById(refId);
        if (ref && isElementVisible(ref)) return ref;
      }
    }

    // Search near the input (parent containers, then document-wide)
    let container = el.parentElement;
    for (let depth = 0; depth < 8 && container; depth++) {
      for (const sel of searchSelectors) {
        try {
          const found = container.querySelector(sel);
          if (found && isElementVisible(found) && found !== el) return found;
        } catch { /* invalid selector, skip */ }
      }
      container = container.parentElement;
    }

    // Document-wide search for visible listboxes/dropdowns
    for (const sel of searchSelectors) {
      try {
        const all = document.querySelectorAll(sel);
        for (const node of all) {
          if (isElementVisible(node) && node !== el) return node;
        }
      } catch { /* skip */ }
    }

    // Shadow DOM search
    try {
      const shadowDropdowns = deepQuerySelectorAll(document, '[role="listbox"], [role="option"]');
      for (const node of shadowDropdowns) {
        if (isElementVisible(node)) return node;
      }
    } catch { /* skip */ }

    return null;
  }

  function getDropdownOptions(dropdownEl) {
    const optionSelectors = [
      '[role="option"]',
      '[data-automation-id="promptOption"]',
      '[data-automation-id="menuItem"]',
      'li:not([role="presentation"])',
      '[class*="option"]',
      '[class*="item"]:not([class*="menu-item"])',
      '[class*="suggestion"]',
      '[class*="result"]',
    ];

    for (const sel of optionSelectors) {
      try {
        const options = dropdownEl.querySelectorAll(sel);
        if (options.length > 0) {
          const visible = Array.from(options).filter(o => isElementVisible(o) || o.offsetHeight > 0);
          if (visible.length > 0) return visible;
        }
      } catch { /* skip */ }
    }

    // Fallback: direct children that look clickable
    const children = Array.from(dropdownEl.children).filter(c =>
      c.offsetHeight > 0 && c.tagName !== 'STYLE' && c.tagName !== 'SCRIPT'
    );
    if (children.length > 0) return children;

    return [];
  }

  function fuzzyMatchDropdownOption(options, targetValue, fieldHints) {
    if (!options.length) return null;
    const target = targetValue.toLowerCase().trim();

    // Pass 1: Exact text match
    for (const opt of options) {
      if (opt.textContent.trim().toLowerCase() === target) return opt;
    }

    // Pass 2: Text starts with target
    for (const opt of options) {
      if (opt.textContent.trim().toLowerCase().startsWith(target)) return opt;
    }

    // Pass 2b: Target starts with option text
    for (const opt of options) {
      const text = opt.textContent.trim().toLowerCase();
      if (text.startsWith(target) || target.startsWith(text)) return opt;
    }

    // Pass 3: Normalization via lookup tables
    if (window.__cpNormalize) {
      try {
        const norm = window.__cpNormalize;
        const hints = fieldHints || {};
        const hintValues = [hints.label, hints.name, hints.id, hints.placeholder].filter(Boolean);
        const tables = norm.detectFieldCategory(hintValues);

        const optionTexts = options.map(o => o.textContent.trim());
        const normIdx = norm.normalizedMatch(optionTexts, targetValue, tables.length ? tables : undefined);
        if (normIdx >= 0) return options[normIdx];

        // Boolean equivalence
        const boolIdx = norm.normalizedMatch(optionTexts, targetValue, [norm.BOOLEAN_YES_NO]);
        if (boolIdx >= 0) return options[boolIdx];
      } catch { /* normalization unavailable, continue */ }
    }

    // Pass 4: Contains match
    for (const opt of options) {
      const text = opt.textContent.trim().toLowerCase();
      if (text.includes(target) || target.includes(text)) return opt;
    }

    // Pass 5: Word-level overlap (for "Animas, Hidalgo, NM" matching "Animas")
    const targetWords = target.split(/[\s,]+/).filter(Boolean);
    let bestMatch = null;
    let bestScore = 0;
    for (const opt of options) {
      const text = opt.textContent.trim().toLowerCase();
      const words = text.split(/[\s,]+/).filter(Boolean);
      let score = 0;
      for (const tw of targetWords) {
        if (words.some(w => w.startsWith(tw) || tw.startsWith(w))) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = opt;
      }
    }
    if (bestMatch && bestScore > 0) return bestMatch;

    // If only one option visible, select it
    if (options.length === 1) return options[0];

    return null;
  }

  // ─── Custom (click-to-open) dropdown handling ──────────────

  function isCustomDropdownTrigger(el) {
    // Detect elements that are styled as dropdowns but aren't native <select>
    const role = el.getAttribute('role');
    if (role === 'combobox' || role === 'listbox') return true;

    const ariaHaspopup = el.getAttribute('aria-haspopup');
    if (ariaHaspopup === 'listbox' || ariaHaspopup === 'true') return true;

    const ariaExpanded = el.getAttribute('aria-expanded');
    if (ariaExpanded !== null) return true;

    // Check for common custom dropdown class patterns
    const className = (el.className || '').toString().toLowerCase();
    if (/select|dropdown|combobox|picker/.test(className)) return true;

    return false;
  }

  async function handleCustomDropdown(el, value, fieldHints) {
    // Snapshot existing visible listboxes BEFORE clicking, so we can find the new one
    const preExisting = new Set();
    try {
      for (const lb of document.querySelectorAll('[role="listbox"]')) {
        const rect = lb.getBoundingClientRect();
        if (rect.height > 0 && rect.width > 0) preExisting.add(lb);
      }
    } catch { /* skip */ }

    // Click to open the dropdown
    el.click();
    dispatchEvents(el, ['click', 'focus']);

    // Wait for the new dropdown to appear (retry with increasing delays)
    let dd = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      await sleep(attempt < 2 ? 200 : 300);

      // Prefer newly-appeared listboxes (not in the pre-existing set)
      try {
        for (const lb of document.querySelectorAll('[role="listbox"]')) {
          const rect = lb.getBoundingClientRect();
          if (rect.height > 0 && rect.width > 0 && !preExisting.has(lb)) {
            const opts = lb.querySelectorAll('[role="option"], [data-automation-id="promptOption"]');
            if (opts.length > 1) { dd = lb; break; }
          }
        }
      } catch { /* skip */ }

      if (dd) break;

      // Fallback: use findTypeaheadDropdown but prefer listboxes with multiple options
      const candidate = findTypeaheadDropdown(el);
      if (candidate) {
        const opts = getDropdownOptions(candidate);
        if (opts.length > 1) { dd = candidate; break; }
      }

      // On first failure, try clicking a child trigger
      if (attempt === 1) {
        const trigger = el.querySelector('button, [class*="arrow"], [class*="indicator"], [class*="toggle"]');
        if (trigger && trigger !== el) {
          trigger.click();
        }
      }
    }

    if (!dd) {
      closeOpenDropdowns();
      return { success: false, reason: 'no dropdown appeared' };
    }

    const options = getDropdownOptions(dd);
    if (!options.length) {
      closeOpenDropdowns();
      return { success: false, reason: 'no options in dropdown' };
    }

    // Try typing to filter first (for searchable dropdowns)
    // Workday uses [data-automation-id="searchBox"] for dropdown search inputs
    const searchInput = dd.querySelector('[data-automation-id="searchBox"]') || dd.querySelector('input');
    if (searchInput) {
      searchInput.focus();
      setNativeValue(searchInput, value);
      dispatchEvents(searchInput, ['input']);
      await sleep(300);

      // Re-fetch filtered options
      const filteredOptions = getDropdownOptions(dd);
      const match = fuzzyMatchDropdownOption(filteredOptions.length ? filteredOptions : options, value, fieldHints);
      if (match) {
        clickOption(match);
        await sleep(200);
        closeOpenDropdowns();
        return { success: true, selectedText: match.textContent.trim() };
      }
    }

    // Direct option match without filtering
    const match = fuzzyMatchDropdownOption(options, value, fieldHints);
    if (match) {
      clickOption(match);
      await sleep(200);
      closeOpenDropdowns();
      return { success: true, selectedText: match.textContent.trim() };
    }

    closeOpenDropdowns();
    return { success: false, reason: `no matching option for "${value}"` };
  }

  function clickOption(optionEl) {
    optionEl.scrollIntoView?.({ block: 'nearest' });
    optionEl.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    optionEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    optionEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    optionEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    optionEl.click();
  }

  function closeOpenDropdowns() {
    try {
      const active = document.activeElement;
      if (!active || active === document.body) return;

      // Strategy 1: Tab away — this is what real users do to dismiss dropdowns.
      // Frameworks (React, Angular, Workday) handle Tab to close dropdowns and move focus.
      active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', keyCode: 9, which: 9, bubbles: true, cancelable: true }));
      active.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', code: 'Tab', keyCode: 9, which: 9, bubbles: true, cancelable: true }));

      // Strategy 2: Pointer events (React 17+ uses pointer events, not mouse events)
      // Click outside the dropdown at a neutral position
      const neutralEl = document.querySelector('h1, h2, h3, [role="heading"], header, main') || document.body;
      const rect = neutralEl.getBoundingClientRect?.() || { left: 0, top: 0 };
      const x = rect.left + 5;
      const y = rect.top + 5;
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        neutralEl.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, composed: true,
          clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse',
        }));
      }

      // Strategy 3: Blur active element
      active.blur();
    } catch { /* ignore errors in test/headless environments */ }
  }

  // ─── Typeahead handling ────────────────────────────────────

  async function typeAndSelectDropdown(el, value, fieldHints) {
    // Clear existing value first
    setNativeValue(el, '');
    dispatchEvents(el, ['input']);
    await sleep(50);

    // Type the value — use simulated typing for better framework compat
    simulateTyping(el, value);

    // Wait for dropdown to appear (check multiple times with increasing delay)
    for (let wait = 0; wait < 6; wait++) {
      await sleep(wait < 3 ? 200 : 400);

      const dropdown = findTypeaheadDropdown(el);
      if (!dropdown) continue;

      const options = getDropdownOptions(dropdown);
      if (!options.length) continue;

      const match = fuzzyMatchDropdownOption(options, value, fieldHints);
      if (match) {
        clickOption(match);
        await sleep(200);
        closeOpenDropdowns();
        return { success: true, selectedText: match.textContent.trim() };
      }

      // If dropdown is open but no good match, try with just the first word
      // (e.g., typing "United States" but dropdown expects just typing "United" first)
      if (wait === 2 && value.includes(' ')) {
        const firstWord = value.split(/[\s,]+/)[0];
        setNativeValue(el, firstWord);
        dispatchEvents(el, ['input']);
        await sleep(300);

        const retryDropdown = findTypeaheadDropdown(el);
        if (retryDropdown) {
          const retryOptions = getDropdownOptions(retryDropdown);
          const retryMatch = fuzzyMatchDropdownOption(retryOptions, value, fieldHints);
          if (retryMatch) {
            clickOption(retryMatch);
            await sleep(200);
            closeOpenDropdowns();
            return { success: true, selectedText: retryMatch.textContent.trim() };
          }
        }
      }

      // Last resort: select first option if it seems reasonable
      if (wait >= 4 && options.length <= 3) {
        clickOption(options[0]);
        await sleep(200);
        closeOpenDropdowns();
        return { success: true, selectedText: options[0].textContent.trim(), fallback: true };
      }
    }

    // Try keyboard navigation as last resort (ArrowDown + Enter)
    try {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
      await sleep(100);
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      await sleep(100);
      closeOpenDropdowns();
      // Check if value changed (something was selected)
      if (el.value !== value && el.value !== '') {
        return { success: true, selectedText: el.value, keyboard: true };
      }
    } catch { /* skip */ }

    closeOpenDropdowns();
    return { success: false };
  }

  // ─── Contenteditable / Rich text editor handling ───────────

  function isRichTextEditor(el) {
    if (el.isContentEditable) return true;
    if (el.getAttribute('role') === 'textbox' && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return true;

    // Check for known WYSIWYG editor wrappers
    const className = (el.className || '').toString().toLowerCase();
    if (/ql-editor|tox-edit-area|ck-editor|fr-element|note-editable|ProseMirror|DraftEditor/.test(className)) return true;

    return false;
  }

  function findRichTextEditor(el) {
    // The element itself might be the editor
    if (el.isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return el;

    // Check if there's an iframe with a contenteditable body (TinyMCE, CKEditor classic)
    const wrapper = el.closest('[class*="editor"], [class*="wysiwyg"], [class*="rich-text"]') || el.parentElement;
    if (wrapper) {
      const iframe = wrapper.querySelector('iframe');
      if (iframe) {
        try {
          const iDoc = iframe.contentDocument || iframe.contentWindow?.document;
          if (iDoc?.body?.isContentEditable) return iDoc.body;
        } catch { /* cross-origin */ }
      }

      // Check for contenteditable div inside the wrapper
      const editable = wrapper.querySelector('[contenteditable="true"]');
      if (editable) return editable;
    }

    return null;
  }

  function fillRichText(editorEl, value) {
    try {
      editorEl.focus();

      // Clear existing content safely
      while (editorEl.firstChild) editorEl.removeChild(editorEl.firstChild);

      // Insert as text nodes with <br> for newlines (no innerHTML to avoid XSS)
      const lines = value.split('\n');
      lines.forEach((line, i) => {
        editorEl.appendChild(document.createTextNode(line));
        if (i < lines.length - 1) editorEl.appendChild(document.createElement('br'));
      });

      // Dispatch events that editors listen for
      editorEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      editorEl.dispatchEvent(new Event('change', { bubbles: true }));

      // For Draft.js and similar, we may need to use execCommand
      try {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, value);
      } catch { /* skip — not all editors support this */ }

      return true;
    } catch (err) {
      console.warn('[CareerPulse] fillRichText failed:', err.message);
      return false;
    }
  }

  // ─── Date picker handling ──────────────────────────────────

  function isDateField(el) {
    const type = (el.type || '').toLowerCase();
    if (type === 'date' || type === 'month') return true;

    const name = (el.name || '').toLowerCase();
    const id = (el.id || '').toLowerCase();
    const label = findLabel(el).toLowerCase();
    const placeholder = (el.placeholder || '').toLowerCase();

    return /date|month|year|start.?date|end.?date|graduation|from.?date|to.?date/.test(
      `${name} ${id} ${label} ${placeholder}`
    );
  }

  function fillDateField(el, value) {
    try {
      const type = (el.type || '').toLowerCase();

      if (type === 'date') {
        // Native date input: needs YYYY-MM-DD format
        const parsed = parseFlexibleDate(value);
        if (parsed) {
          setNativeValue(el, parsed);
          dispatchEvents(el, ['input', 'change']);
          return true;
        }
      }

      if (type === 'month') {
        // Native month input: needs YYYY-MM format
        const parsed = parseFlexibleDate(value);
        if (parsed) {
          setNativeValue(el, parsed.slice(0, 7));
          dispatchEvents(el, ['input', 'change']);
          return true;
        }
      }

      // For text inputs that are date fields, just set the value directly
      setNativeValue(el, value);
      dispatchEvents(el, ['input', 'change']);
      return true;
    } catch {
      return false;
    }
  }

  function parseFlexibleDate(value) {
    // Try to parse various date formats into YYYY-MM-DD
    if (!value) return null;

    // Already YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

    // YYYY-MM
    if (/^\d{4}-\d{2}$/.test(value)) return `${value}-01`;

    // MM/DD/YYYY or MM-DD-YYYY
    const mdyMatch = value.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (mdyMatch) {
      return `${mdyMatch[3]}-${mdyMatch[1].padStart(2, '0')}-${mdyMatch[2].padStart(2, '0')}`;
    }

    // Month YYYY (e.g., "January 2024")
    const monthNames = ['january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december'];
    const monthYearMatch = value.match(/^(\w+)\s+(\d{4})$/);
    if (monthYearMatch) {
      const monthIdx = monthNames.indexOf(monthYearMatch[1].toLowerCase());
      if (monthIdx >= 0) {
        return `${monthYearMatch[2]}-${String(monthIdx + 1).padStart(2, '0')}-01`;
      }
    }

    // Just a year
    if (/^\d{4}$/.test(value)) return `${value}-01-01`;

    // Try native Date parsing as last resort
    try {
      const d = new Date(value);
      if (!isNaN(d.getTime())) {
        return d.toISOString().slice(0, 10);
      }
    } catch { /* skip */ }

    return null;
  }

  // ─── Field filling (main) ──────────────────────────────────

  async function fillField(selector, value, action, confidence, label) {
    try {
      // Dismiss any stale dropdowns from previous field
      dismissOpenDropdowns();
      await sleep(50);

      const el = resolveElement(selector);
      if (!el) {
        // Selector may have gone stale after DOM mutation; try re-extracting
        return { selector, success: false, reason: 'element not found' };
      }

      // Compute field hints once for normalization throughout this fill
      const fieldHints = getFieldHints(el);

      // Guard: skip phone extension fields when AI sends a phone number
      if (isPhoneExtensionField(el)) {
        const digits = String(value).replace(/\D/g, '');
        if (digits.length >= 7) {
          return { selector, success: true, skipped: true, reason: 'phone extension field — value looks like a phone number' };
        }
      }

      // Capture original value before filling (for undo support)
      const origVal = el.value || el.textContent?.trim() || '';
      const fieldLabel = label || findLabel(el) || el.name || el.id || selector;
      originalValues.set(selector, {
        originalValue: origVal,
        label: fieldLabel,
        value: String(value),
        confidence: confidence || 1,
        action,
        undone: false,
      });

      // Scroll element into view so it's interactable
      try {
        el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      } catch { /* skip */ }

      el.focus();
      dispatchEvents(el, ['focus']);

      switch (action) {
        case 'fill_text': {
          // 1. Check if this is a rich text / contenteditable editor
          const richEditor = findRichTextEditor(el);
          if (richEditor && richEditor !== el) {
            const filled = fillRichText(richEditor, value);
            if (filled) return { selector, success: true, action, richText: true };
          }
          if (isRichTextEditor(el)) {
            const filled = fillRichText(el, value);
            if (filled) return { selector, success: true, action, richText: true };
          }

          // 2. Check if this is a date field
          if (isDateField(el)) {
            const filled = fillDateField(el, value);
            if (filled) return { selector, success: true, action, dateField: true };
          }

          // 3. Phone formatting — normalize and format before text fill
          let fillValue = value;
          if (isPhoneField(el) && window.__cpNormalize) {
            try {
              const digits = window.__cpNormalize.normalizePhone(value);
              if (digits) {
                fillValue = window.__cpNormalize.formatPhoneLike(digits, fieldHints.placeholder);
              }
            } catch { /* skip, use original value */ }
          }

          // 4. Check if this is a custom click-to-open dropdown (not a typeahead)
          if (isCustomDropdownTrigger(el) && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
            const result = await handleCustomDropdown(el, fillValue, fieldHints);
            if (result.success) return { selector, success: true, action, selectedText: result.selectedText };
          }

          // 5. Check if this is a typeahead/autocomplete field (has ARIA hints)
          const isTypeahead = el.getAttribute('role') === 'combobox'
            || el.getAttribute('aria-autocomplete')
            || el.getAttribute('aria-owns')
            || el.getAttribute('aria-controls')
            || el.getAttribute('list')
            || el.closest('[class*="autocomplete"]')
            || el.closest('[class*="typeahead"]')
            || el.closest('[class*="combobox"]');

          if (isTypeahead) {
            const result = await typeAndSelectDropdown(el, fillValue, fieldHints);
            if (result.success) {
              return { selector, success: true, action, selectedText: result.selectedText };
            }
          }

          // 6. Normal text fill
          setNativeValue(el, fillValue);
          dispatchEvents(el, ['input', 'change']);

          // 7. After setting value, check if a dropdown appeared anyway
          await sleep(300);
          const dropdown = findTypeaheadDropdown(el);
          if (dropdown) {
            const options = getDropdownOptions(dropdown);
            if (options.length > 0) {
              const match = fuzzyMatchDropdownOption(options, fillValue, fieldHints);
              if (match) {
                clickOption(match);
                await sleep(100);
                return { selector, success: true, action, selectedText: match.textContent.trim() };
              }
            }
          }

          dispatchEvents(el, ['blur']);
          return { selector, success: true, action };
        }

        case 'select_dropdown_safe':
        case 'select_dropdown': {
          // For 'select_dropdown_safe': check if the field already contains the
          // desired value before interacting — avoids opening dropdowns unnecessarily
          if (action === 'select_dropdown_safe') {
            let container = el.closest('[data-automation-id], [class*="combobox"], [role="combobox"], [role="listbox"]') || el.parentElement;
            // Walk up to find chip/pill/tag elements that indicate an already-selected value
            // (e.g., Workday shows "× United States of America (+1)" as a chip)
            let searchEl = container;
            for (let i = 0; i < 5 && searchEl && searchEl !== document.body; i++) {
              // Check for chip elements by selector
              const hasChip = searchEl.querySelector(
                '[data-automation-id*="delete"], [data-automation-id*="Delete"], ' +
                '[data-automation-id*="selectedItem"], [data-automation-id*="SelectedItem"], ' +
                '[class*="chip"], [class*="pill"], [class*="tag-item"], ' +
                '[aria-selected="true"]'
              );
              if (hasChip) {
                container = searchEl;
                break;
              }
              // Also detect chips by text pattern: "×" or "✕" followed by a value
              // (Workday renders chips as plain elements with a close button + text)
              const childText = searchEl.textContent || '';
              if (/[\u00d7\u2715\u2716\u2717\u2718×✕✖]\s*\S/.test(childText)) {
                container = searchEl;
                break;
              }
              searchEl = searchEl.parentElement;
            }
            const existingText = (container?.textContent || el.value || '').toLowerCase();
            const valueLower = value.toLowerCase();
            // Check if the value (or a key part) is already present
            const valueWords = valueLower.split(/[\s()]+/).filter(w => w.length > 2);
            const alreadySet = valueWords.length > 0 && valueWords.every(w => existingText.includes(w));
            if (alreadySet) {
              return { selector, success: true, action, skipped: true, reason: 'already set' };
            }
          }

          // Handle native <select>
          if (el.tagName === 'SELECT') {
            const options = Array.from(el.options || []).map(o => ({ value: o.value, text: o.textContent }));
            const idx = fuzzyMatchOption(options, value, fieldHints);
            if (idx >= 0) {
              el.selectedIndex = idx;
              dispatchEvents(el, ['change', 'blur']);
              return { selector, success: true, action, selectedValue: options[idx].value };
            }
            return { selector, success: false, reason: `no matching option for "${value}"` };
          }

          // Handle custom dropdown (div-based)
          const customResult = await handleCustomDropdown(el, value, fieldHints);
          if (customResult.success) {
            return { selector, success: true, action, selectedText: customResult.selectedText };
          }
          return { selector, success: false, reason: customResult.reason || `no matching option for "${value}"` };
        }

        case 'click_radio': {
          const name = el.name || el.getAttribute('name');
          if (name) {
            const root = el.closest('form') || el.getRootNode();
            const radios = root.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`);
            const target = value.toLowerCase().trim();

            // Pass 1: exact match on value or label
            for (const radio of radios) {
              const radioLabel = findLabel(radio).toLowerCase().trim();
              const radioValue = radio.value.toLowerCase();
              if (radioValue === target || radioLabel === target) {
                radio.click();
                return { selector, success: true, action, selectedValue: radio.value };
              }
            }
            // Pass 2: label contains target (but only if target is long enough to be meaningful)
            if (target.length >= 3) {
              for (const radio of radios) {
                const radioLabel = findLabel(radio).toLowerCase().trim();
                if (radioLabel.includes(target)) {
                  radio.click();
                  return { selector, success: true, action, selectedValue: radio.value };
                }
              }
            }
          }
          el.click();
          return { selector, success: true, action };
        }

        case 'check_checkbox': {
          const shouldCheck = value === true || value === 'true' || value === 'yes' || value === '1';
          if (el.checked !== shouldCheck) {
            el.click(); // .click() toggles checked and fires events
          }
          return { selector, success: true, action };
        }

        case 'upload_file': {
          return { selector, success: false, reason: 'file upload requires user interaction' };
        }

        case 'skip':
          return { selector, success: true, action: 'skip', skipped: true };

        default:
          // Best-effort: try setting value
          setNativeValue(el, value);
          dispatchEvents(el, ['input', 'change', 'blur']);
          return { selector, success: true, action: 'fallback' };
      }
    } catch (err) {
      return { selector, success: false, reason: err.message };
    }
  }

  // ─── File upload helper ──────────────────────────────────────

  let currentJobId = null;

  function getFieldLabel(fileInput) {
    const label = findLabel(fileInput);
    if (label) return label;
    const name = (fileInput.name || '').toLowerCase();
    const id = (fileInput.id || '').toLowerCase();
    return `${name} ${id}`;
  }

  function detectUploadType(fileInput) {
    const text = getFieldLabel(fileInput).toLowerCase();
    if (/cover.?letter/i.test(text)) return 'cover-letter';
    if (/resume|cv|curriculum/i.test(text)) return 'resume';

    // Also check accept attribute for document types
    const accept = (fileInput.getAttribute('accept') || '').toLowerCase();
    if (accept && /pdf|doc|rtf/.test(accept)) {
      // Could be resume or cover letter; check nearby context
      const parent = fileInput.closest('div, fieldset, section, li');
      const parentText = parent ? parent.textContent.toLowerCase() : '';
      if (/cover.?letter/i.test(parentText)) return 'cover-letter';
      if (/resume|cv|curriculum/i.test(parentText)) return 'resume';
    }

    return null;
  }

  function detectFileUploadFields() {
    const fileInputs = deepQuerySelectorAll(document, 'input[type="file"]');

    for (const fileInput of fileInputs) {
      // Skip if already processed
      if (fileInput.dataset.cpUploadHelper) continue;

      const uploadType = detectUploadType(fileInput);
      if (!uploadType) continue;

      fileInput.dataset.cpUploadHelper = uploadType;
      showUploadHelper(fileInput, uploadType);
    }
  }

  function showUploadHelper(fileInput, type) {
    const label = type === 'cover-letter' ? 'Cover letter' : 'Tailored resume';
    const messageType = type === 'cover-letter' ? 'downloadCoverLetter' : 'downloadResume';

    // Highlight the file input
    fileInput.classList.add(`${PREFIX}-upload-highlight`);

    // Create tooltip container
    const helper = document.createElement('div');
    helper.className = `${PREFIX}-upload-helper`;

    const text = document.createElement('span');
    text.className = `${PREFIX}-upload-helper-text`;
    text.textContent = `${label} ready -- download from CareerPulse, then upload here`;

    const btn = document.createElement('button');
    btn.className = `${PREFIX}-upload-helper-btn`;
    btn.textContent = `Download ${label}`;
    btn.type = 'button';

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (!currentJobId) {
        text.textContent = 'No job ID available. Open this page from CareerPulse first.';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Downloading...';

      try {
        const response = await chrome.runtime.sendMessage({
          type: messageType,
          jobId: currentJobId,
        });

        if (response && response.ok) {
          helper.classList.add(`${PREFIX}-upload-helper-downloaded`);
          text.textContent = 'Downloaded! Now upload it above.';
          btn.textContent = 'Downloaded';
        } else {
          text.textContent = `Download failed: ${response?.error || 'unknown error'}`;
          btn.disabled = false;
          btn.textContent = `Retry Download`;
        }
      } catch (err) {
        text.textContent = `Download failed: ${err.message}`;
        btn.disabled = false;
        btn.textContent = `Retry Download`;
      }
    });

    helper.appendChild(text);
    helper.appendChild(btn);

    // Position the helper near the file input
    const parent = fileInput.parentElement;
    if (parent) {
      // Ensure parent has relative positioning for absolute placement
      const parentPos = getComputedStyle(parent).position;
      if (parentPos === 'static') {
        parent.style.position = 'relative';
      }
      parent.appendChild(helper);
    } else {
      fileInput.insertAdjacentElement('afterend', helper);
    }
  }

  // ─── Iterative form fill ──────────────────────────────────────

  async function fillForm(mappings, atsAdapter) {
    const results = [];
    let filledCount = 0;
    const totalMappable = mappings.filter(m => m.action !== 'skip').length;
    const failedSelectors = new Set();
    const atsFormRoot = atsAdapter?.getFormRoot?.(document) || null;

    for (let iteration = 0; iteration < 2; iteration++) {
      const currentMappings = iteration === 0 ? mappings : await getNewMappings();
      if (!currentMappings || !currentMappings.length) break;

      for (const mapping of currentMappings) {
        if (mapping.action === 'skip') continue;
        if (failedSelectors.has(mapping.selector) && iteration > 0) continue;

        let result;
        try {
          result = await withTimeout(
            fillField(mapping.selector, mapping.value, mapping.action, mapping.confidence, mapping.label),
            FIELD_TIMEOUT_MS,
            `filling ${mapping.selector}`
          );
        } catch (err) {
          result = { selector: mapping.selector, success: false, reason: err.message };
        }

        results.push(result);

        // Close any dropdowns left open by the previous fill
        closeOpenDropdowns();
        await sleep(100);

        if (result.success && !result.skipped) {
          filledCount++;
          updateOverlay('filling', `Filling ${filledCount}/${totalMappable} fields...`);

          try {
            const el = resolveElement(mapping.selector);
            if (el) {
              const confidence = mapping.confidence || 1;
              el.classList.add(confidence >= 0.8 ? `${PREFIX}-filled` : `${PREFIX}-review`);
            }
          } catch { /* skip */ }
        } else if (!result.success) {
          failedSelectors.add(mapping.selector);
        }
      }

      // Wait for dynamic fields
      await sleep(500);

      // Check if new fields appeared (use ATS form root if available)
      const newFields = extractFormData(atsFormRoot);
      const previousSelectors = new Set(currentMappings.map(m => m.selector));
      const newUnmapped = newFields.filter(f => !previousSelectors.has(f.selector) && !f.currentValue);

      if (newUnmapped.length === 0) break;
    }

    // After filling, detect file upload fields that need user help
    detectFileUploadFields();

    return { results, filledCount, total: totalMappable };
  }

  async function getNewMappings() {
    try {
      const formHtml = serializeFormHtml();
      const response = await withTimeout(
        chrome.runtime.sendMessage({ type: 'analyzeForm', formHtml }),
        API_TIMEOUT_MS,
        'API form analysis'
      );
      if (response && response.ok && response.data?.mappings) {
        return response.data.mappings;
      }
    } catch (err) {
      console.warn('[CareerPulse] Re-analysis failed:', err?.message || err);
    }
    return null;
  }

  // ─── Overlay UI ───────────────────────────────────────────────

  let overlayEl = null;
  let dragState = null;

  function createOverlay() {
    if (overlayEl) return overlayEl;

    overlayEl = document.createElement('div');
    overlayEl.id = `${PREFIX}-overlay`;
    overlayEl.innerHTML = `
      <div class="${PREFIX}-overlay-header">
        <span class="${PREFIX}-overlay-title">CareerPulse</span>
        <div class="${PREFIX}-overlay-actions">
          <button class="${PREFIX}-overlay-minimize" title="Minimize">&#x2013;</button>
          <button class="${PREFIX}-overlay-close" title="Close">&#x2715;</button>
        </div>
      </div>
      <div class="${PREFIX}-overlay-body">
        <span class="${PREFIX}-overlay-status">Initializing...</span>
      </div>
    `;

    document.body.appendChild(overlayEl);

    overlayEl.querySelector(`.${PREFIX}-overlay-close`).addEventListener('click', () => {
      removeOverlay();
    });

    overlayEl.querySelector(`.${PREFIX}-overlay-minimize`).addEventListener('click', () => {
      const body = overlayEl.querySelector(`.${PREFIX}-overlay-body`);
      body.style.display = body.style.display === 'none' ? 'block' : 'none';
    });

    // Drag support on header
    const header = overlayEl.querySelector(`.${PREFIX}-overlay-header`);
    header.addEventListener('mousedown', onDragStart);

    return overlayEl;
  }

  // ─── Drag handling ───────────────────────────────────────────

  function onDragStart(e) {
    // Don't drag when clicking buttons
    if (e.target.closest('button')) return;
    e.preventDefault();

    const rect = overlayEl.getBoundingClientRect();
    dragState = {
      startX: e.clientX,
      startY: e.clientY,
      origLeft: rect.left,
      origTop: rect.top,
    };

    // Switch from bottom/right positioning to top/left for drag
    overlayEl.style.left = rect.left + 'px';
    overlayEl.style.top = rect.top + 'px';
    overlayEl.style.right = 'auto';
    overlayEl.style.bottom = 'auto';

    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
  }

  function onDragMove(e) {
    if (!dragState) return;
    e.preventDefault();

    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;

    const newLeft = Math.max(0, Math.min(window.innerWidth - 60, dragState.origLeft + dx));
    const newTop = Math.max(0, Math.min(window.innerHeight - 40, dragState.origTop + dy));

    overlayEl.style.left = newLeft + 'px';
    overlayEl.style.top = newTop + 'px';
  }

  function onDragEnd() {
    dragState = null;
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
  }

  // ─── Overlay mode rendering ──────────────────────────────────

  function getOverlayCounts() {
    let filled = 0;
    let review = 0;
    let undone = 0;
    for (const [, entry] of originalValues) {
      if (entry.undone) {
        undone++;
      } else if (entry.confidence < 0.8) {
        review++;
      } else {
        filled++;
      }
    }
    return { filled, review, undone, total: originalValues.size };
  }

  function renderCompactPill() {
    if (!overlayEl) return;

    const { filled, review } = getOverlayCounts();
    const body = overlayEl.querySelector(`.${PREFIX}-overlay-body`);
    if (!body) return;

    overlayEl.classList.add(`${PREFIX}-overlay-compact`);
    overlayEl.classList.remove(`${PREFIX}-overlay-expanded`);
    overlayMode = 'compact';

    const parts = [];
    if (filled > 0) parts.push(`${filled} filled`);
    if (review > 0) parts.push(`${review} review`);
    if (!parts.length) parts.push('0 fields');

    body.innerHTML = `
      <div class="${PREFIX}-overlay-pill" title="Click to expand field list">
        <span class="${PREFIX}-overlay-pill-check">&#x2713;</span>
        <span class="${PREFIX}-overlay-pill-text">${parts.join(' \u00B7 ')}</span>
        <span class="${PREFIX}-overlay-pill-expand">&#x25BC;</span>
      </div>
    `;

    body.style.display = 'block';
    body.querySelector(`.${PREFIX}-overlay-pill`).addEventListener('click', () => {
      renderExpandedList();
    });
  }

  function renderExpandedList() {
    if (!overlayEl) return;

    const body = overlayEl.querySelector(`.${PREFIX}-overlay-body`);
    if (!body) return;

    overlayEl.classList.remove(`${PREFIX}-overlay-compact`);
    overlayEl.classList.add(`${PREFIX}-overlay-expanded`);
    overlayMode = 'expanded';

    const entries = Array.from(originalValues.entries());
    if (!entries.length) {
      body.innerHTML = `<span class="${PREFIX}-overlay-status">No fields tracked.</span>`;
      return;
    }

    const rows = entries.map(([selector, entry]) => {
      const dotClass = entry.undone ? 'gray' : (entry.confidence < 0.8 ? 'yellow' : 'green');
      const displayValue = entry.undone ? `(undone) ${entry.originalValue || 'empty'}` : entry.value;
      const truncatedValue = displayValue.length > 50 ? displayValue.slice(0, 47) + '...' : displayValue;
      const truncatedLabel = entry.label.length > 30 ? entry.label.slice(0, 27) + '...' : entry.label;
      const undoBtnHtml = entry.undone
        ? ''
        : `<button class="${PREFIX}-undo-btn" data-selector="${escapeHtml(selector)}" title="Undo">&#x21A9;</button>`;

      return `
        <div class="${PREFIX}-overlay-field-row" data-selector="${escapeHtml(selector)}">
          <span class="${PREFIX}-status-dot ${dotClass}"></span>
          <div class="${PREFIX}-overlay-field-info">
            <span class="${PREFIX}-overlay-field-label">${escapeHtml(truncatedLabel)}</span>
            <span class="${PREFIX}-overlay-field-value">${escapeHtml(truncatedValue)}</span>
          </div>
          ${undoBtnHtml}
        </div>
      `;
    }).join('');

    body.innerHTML = `
      <div class="${PREFIX}-overlay-field-list">
        ${rows}
      </div>
      <div class="${PREFIX}-overlay-collapse" title="Click to collapse">
        <span>&#x25B2; Collapse</span>
      </div>
    `;

    body.style.display = 'block';

    // Undo button handlers
    body.querySelectorAll(`.${PREFIX}-undo-btn`).forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        undoField(btn.dataset.selector);
      });
    });

    // Collapse handler
    body.querySelector(`.${PREFIX}-overlay-collapse`).addEventListener('click', () => {
      renderCompactPill();
    });
  }

  function undoField(selector) {
    const entry = originalValues.get(selector);
    if (!entry || entry.undone) return;

    const el = resolveElement(selector);
    if (!el) return;

    // Restore original value
    setNativeValue(el, entry.originalValue);
    dispatchEvents(el, ['input', 'change']);

    // Remove highlight classes
    el.classList.remove(`${PREFIX}-filled`);
    el.classList.remove(`${PREFIX}-review`);

    entry.undone = true;

    // Re-render the current overlay mode
    if (overlayMode === 'expanded') {
      renderExpandedList();
    } else if (overlayMode === 'compact') {
      renderCompactPill();
    }
  }

  function updateOverlay(state, message) {
    const overlay = createOverlay();
    currentState = state;

    // During active operations (analyzing, filling, error), show status text
    if (state === 'done' && originalValues.size > 0) {
      // Switch to compact pill when fill is complete
      overlayMode = 'compact';
      renderCompactPill();
      return;
    }

    // Status mode: show text message
    overlayEl.classList.remove(`${PREFIX}-overlay-compact`);
    overlayEl.classList.remove(`${PREFIX}-overlay-expanded`);
    overlayMode = 'status';

    const body = overlay.querySelector(`.${PREFIX}-overlay-body`);
    if (body) {
      body.style.display = 'block';
      body.innerHTML = `<span class="${PREFIX}-overlay-status">${escapeHtml(message || state)}</span>`;
    }
  }

  function showOverlay(status) {
    updateOverlay(status, status);
  }

  function removeOverlay() {
    if (overlayEl) {
      overlayEl.remove();
      overlayEl = null;
    }
    // Clean up drag listeners
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    dragState = null;
  }

  // ─── Learn prompt (post-submission) ───────────────────────────

  let preSubmitValues = {};

  function captureFormValues() {
    const values = {};
    const fields = extractFormData();
    for (const field of fields) {
      if (field.currentValue) {
        values[field.selector] = {
          value: field.currentValue,
          label: field.label,
          name: field.name,
        };
      }
    }
    return values;
  }

  function showLearnPrompt(newData) {
    if (!newData.length) return;

    const promptEl = document.createElement('div');
    promptEl.id = `${PREFIX}-learn-prompt`;
    promptEl.innerHTML = `
      <div class="${PREFIX}-learn-backdrop"></div>
      <div class="${PREFIX}-learn-modal">
        <h3 class="${PREFIX}-learn-title">Save ${newData.length} new answer${newData.length > 1 ? 's' : ''} to CareerPulse?</h3>
        <div class="${PREFIX}-learn-list">
          ${newData.map((item, i) => `
            <label class="${PREFIX}-learn-item">
              <input type="checkbox" checked data-index="${i}">
              <div class="${PREFIX}-learn-item-detail">
                <span class="${PREFIX}-learn-item-label">${escapeHtml(item.label || item.name || 'Unknown field')}</span>
                <span class="${PREFIX}-learn-item-value">${escapeHtml(String(item.value).slice(0, 100))}</span>
              </div>
            </label>
          `).join('')}
        </div>
        <div class="${PREFIX}-learn-actions">
          <button class="${PREFIX}-learn-save">Save Selected</button>
          <button class="${PREFIX}-learn-dismiss">Dismiss</button>
        </div>
      </div>
    `;

    document.body.appendChild(promptEl);

    promptEl.querySelector(`.${PREFIX}-learn-save`).addEventListener('click', async () => {
      const checkboxes = promptEl.querySelectorAll('input[type="checkbox"]');
      const selectedData = [];
      checkboxes.forEach(cb => {
        if (cb.checked) {
          selectedData.push(newData[parseInt(cb.dataset.index)]);
        }
      });
      if (selectedData.length) {
        try {
          await chrome.runtime.sendMessage({
            type: 'saveLearnedData',
            data: { learned_fields: selectedData },
          });
        } catch { /* skip */ }
      }
      promptEl.remove();
    });

    promptEl.querySelector(`.${PREFIX}-learn-dismiss`).addEventListener('click', () => {
      promptEl.remove();
    });

    promptEl.querySelector(`.${PREFIX}-learn-backdrop`).addEventListener('click', () => {
      promptEl.remove();
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── Toast notifications ─────────────────────────────────────

  function showToast(message, type = 'success') {
    const existing = document.getElementById(`${PREFIX}-toast`);
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = `${PREFIX}-toast`;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    const bgColor = type === 'success' ? '#22c55e' : type === 'error' ? '#ef4444' : '#3b82f6';
    toast.style.cssText = `
      position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
      background: ${bgColor}; color: white; padding: 12px 20px;
      border-radius: 8px; font: 14px/1.4 system-ui, sans-serif;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15); max-width: 360px;
      opacity: 0; transform: translateY(12px);
      transition: opacity 0.3s, transform 0.3s;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
    });

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(12px)';
      setTimeout(() => toast.remove(), 300);
    }, 4000);

    return toast;
  }

  // ─── Auto-track applied jobs ────────────────────────────────

  let autoTrackFired = false;

  async function autoTrackApplied() {
    if (autoTrackFired) return;
    autoTrackFired = true;

    try {
      const pageUrl = location.href;
      const result = await chrome.runtime.sendMessage({ type: 'markAppliedByUrl', url: pageUrl });
      if (result && result.ok) {
        showToast('Job marked as applied in CareerPulse', 'success');
      }
    } catch (err) {
      console.warn('[CareerPulse] autoTrackApplied failed:', err.message);
    }
  }

  // ─── Submission detection ─────────────────────────────────────

  function detectSubmission() {
    document.addEventListener('submit', handleSubmission, true);

    // Register pushState callback via central interceptor
    historyCallbacks.pushState.add(handleSubmission);

    document.addEventListener('click', (e) => {
      try {
        const btn = e.target.closest('button[type="submit"], input[type="submit"], [role="button"]');
        if (btn && btn.closest('form')) {
          setTimeout(handleSubmission, 1000);
        }
      } catch { /* skip */ }
    }, true);

    // MutationObserver: detect form removal or "thank you" confirmation pages
    const observer = new MutationObserver((mutations) => {
      try {
        for (const mutation of mutations) {
          // Check removed nodes for form elements
          for (const node of mutation.removedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.tagName === 'FORM' || node.querySelector?.('form')) {
              setTimeout(handleSubmission, 500);
              return;
            }
          }

          // Check added nodes for success/confirmation indicators
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue;
            const text = (node.textContent || '').toLowerCase();
            if (text.includes('application submitted') ||
                text.includes('thank you for applying') ||
                text.includes('application received') ||
                text.includes('successfully submitted')) {
              handleSubmission();
              return;
            }
          }
        }
      } catch { /* skip */ }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  function handleSubmission() {
    try {
      if (Object.keys(preSubmitValues).length === 0) return;

      const postValues = captureFormValues();
      const newData = [];

      for (const [selector, post] of Object.entries(postValues)) {
        const pre = preSubmitValues[selector];
        if (!pre || pre.value !== post.value) {
          if (post.value && post.value.trim()) {
            newData.push({
              selector,
              label: post.label,
              name: post.name,
              value: post.value,
              previousValue: pre ? pre.value : null,
            });
          }
        }
      }

      if (newData.length > 0) {
        showLearnPrompt(newData);
      }

      // Auto-track this job as applied
      autoTrackApplied();
    } catch (err) {
      console.warn('[CareerPulse] handleSubmission failed:', err.message);
    }
  }

  // ─── Custom Q&A matching ─────────────────────────────────────

  function fuzzyMatchQA(fieldLabel, qaEntries) {
    if (!fieldLabel || !qaEntries || !qaEntries.length) return null;
    const label = fieldLabel.toLowerCase().trim();
    if (!label) return null;

    const labelWords = label.split(/\s+/).filter(w => w.length > 2);

    let bestMatch = null;
    let bestScore = 0;

    for (const qa of qaEntries) {
      const pattern = (qa.question_pattern || '').toLowerCase().trim();
      if (!pattern) continue;

      // Exact match
      if (label === pattern) return qa;

      // Substring: label contains pattern or pattern contains label
      if (label.includes(pattern) || pattern.includes(label)) {
        const score = 3;
        if (score > bestScore) { bestScore = score; bestMatch = qa; }
        continue;
      }

      // Keyword overlap: count shared words
      const patternWords = pattern.split(/\s+/).filter(w => w.length > 2);
      if (patternWords.length > 0 && labelWords.length > 0) {
        const shared = patternWords.filter(pw => labelWords.some(lw => lw.includes(pw) || pw.includes(lw)));
        const score = shared.length / Math.max(patternWords.length, labelWords.length);
        if (score >= 0.5 && score > bestScore) {
          bestScore = score;
          bestMatch = qa;
        }
      }
    }

    return bestMatch;
  }

  async function applyCustomQA(mappings) {
    let qaEntries;
    try {
      const qaResult = await chrome.runtime.sendMessage({ type: 'getCustomQA' });
      if (!qaResult || !qaResult.ok || !Array.isArray(qaResult.data)) return mappings;
      qaEntries = qaResult.data;
    } catch (err) {
      console.warn('[CareerPulse] applyCustomQA failed:', err.message);
      return mappings;
    }

    if (!qaEntries.length) return mappings;

    return mappings.map(mapping => {
      if (mapping.action !== 'skip') return mapping;

      const label = mapping.field_label || '';
      const match = fuzzyMatchQA(label, qaEntries);
      if (match && match.answer) {
        return { ...mapping, action: 'fill_text', value: match.answer, qa_matched: true };
      }
      return mapping;
    });
  }

  // ─── Main fill flow ──────────────────────────────────────────

  const OVERALL_TIMEOUT_MS = 90000; // Max time for entire fill flow

  async function startFillFlow() {
    try {
      // Remove the auto-detection badge if present
      removeBadge();

      // If we're in the top frame and there are ATS embed/iframe signals, bail
      // silently — the iframe's content script handles filling.
      if (!isInIframe() && (hasAtsIframe() || hasAtsEmbedContainer() || hasAtsUrlParam())) {
        return;
      }

      currentState = 'analyzing';

      // Detect ATS-specific adapter
      const atsAdapter = window.__cpAtsAdapters
        ? window.__cpAtsAdapters.detectATS(location.href, document)
        : null;

      if (atsAdapter) {
        showOverlay(`Detected ${atsAdapter.name} \u2014 analyzing form...`);
      } else {
        showOverlay('Analyzing form...');
      }

      await withTimeout((async () => {
        preSubmitValues = captureFormValues();

        // Use ATS adapter's form root if available
        const formRoot = atsAdapter?.getFormRoot?.(document) || null;

        const formHtml = serializeFormHtml();

        // If adapter provides extra field extraction (e.g. Google Forms), merge them
        let adapterFields = [];
        if (atsAdapter?.getExtraFields) {
          try {
            adapterFields = atsAdapter.getExtraFields(document);
          } catch (err) {
            console.warn('[CareerPulse] ATS getExtraFields failed:', err.message);
          }
        }

        // Extract structured fields for more reliable AI analysis
        const structuredFields = extractFormData(formRoot);

        // Debug: log extracted fields so we can diagnose fill issues
        console.log('[CareerPulse] Extracted fields:', structuredFields.map(f => ({
          selector: f.selector, tag: f.tag, type: f.type, label: f.label,
          name: f.name, role: f.role, currentValue: f.currentValue,
          hasOptions: !!(f.options && f.options.length),
          optionCount: f.options?.length || 0,
        })));

        // Include ATS metadata in the analysis request
        const analyzePayload = { type: 'analyzeForm', formHtml, structuredFields };
        if (atsAdapter) {
          analyzePayload.atsName = atsAdapter.name;
          analyzePayload.atsFieldMap = atsAdapter.getFieldMap?.() || {};
          if (adapterFields.length) {
            analyzePayload.adapterFields = adapterFields;
          }
        }

        let response;
        try {
          response = await withTimeout(
            chrome.runtime.sendMessage(analyzePayload),
            API_TIMEOUT_MS,
            'Form analysis'
          );
        } catch (err) {
          updateOverlay('error', `Timed out analyzing form. Is the server running?`);
          return;
        }

        console.log('[CareerPulse] Analyze response:', JSON.stringify(response?.data?.mappings || [], null, 2));

        if (!response || !response.ok) {
          updateOverlay('error', `Error: ${response?.error || 'Analysis failed'}`);
          return;
        }

        let mappings = response.data?.mappings || [];
        if (!mappings.length) {
          updateOverlay('done', 'No fillable fields found');
          return;
        }

        // Post-process: fill skipped fields that match custom Q&A
        mappings = await applyCustomQA(mappings);

        currentState = 'filling';
        const result = await fillForm(mappings, atsAdapter);

        const failedCount = result.results.filter(r => !r.success).length;
        let statusMsg = `Filled ${result.filledCount}/${result.total} fields.`;
        if (failedCount > 0) {
          statusMsg += ` ${failedCount} field${failedCount > 1 ? 's' : ''} need manual review.`;
        } else {
          statusMsg += ' Review highlighted fields.';
        }
        updateOverlay('done', statusMsg);

        preSubmitValues = captureFormValues();
        detectSubmission();

        // Start multi-page tracking or update cumulative progress
        if (multiPageState && multiPageState.currentPage > 1) {
          updateMultiPageProgress(result.filledCount);
        } else {
          startMultiPageTracking(result.filledCount);
        }
      })(), OVERALL_TIMEOUT_MS, 'Autofill operation');
    } catch (err) {
      if (err.message && err.message.includes('timed out')) {
        updateOverlay('error', 'Autofill timed out. The operation took too long — please try again or fill remaining fields manually.');
      } else {
        updateOverlay('error', `Error: ${err.message}`);
      }
    }
  }

  // ─── ATS iframe / embed detection ───────────────────────────

  const ATS_IFRAME_PATTERNS = [
    /(?:boards|job-boards)\.greenhouse\.io/i,
    /jobs\.lever\.co/i,
    /icims\.com/i,
    /taleo\.net/i,
  ];

  const ATS_EMBED_URL_PARAMS = ['gh_jid']; // Greenhouse job ID in parent page URL

  function hasAtsIframe() {
    try {
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        const src = iframe.src || '';
        for (const pattern of ATS_IFRAME_PATTERNS) {
          if (pattern.test(src)) return true;
        }
      }
    } catch { /* skip */ }
    return false;
  }

  function hasAtsEmbedContainer() {
    return !!(document.getElementById('grnhse_app')
      || document.querySelector('[class*="greenhouse"]')
      || document.querySelector('iframe[id*="grnhse"]'));
  }

  function hasAtsUrlParam() {
    try {
      const params = new URLSearchParams(window.location.search);
      return ATS_EMBED_URL_PARAMS.some(p => params.has(p));
    } catch { return false; }
  }

  function isInIframe() {
    try { return window.self !== window.top; } catch { return true; }
  }

  // ─── Application form auto-detection ────────────────────────

  function detectApplicationForm() {
    const url = window.location.href;
    let confidence = 'none';

    // URL patterns (high confidence)
    const highConfidenceUrls = [
      /myworkdayjobs\.com\/.*\/job\//i,
      /(?:boards|job-boards)\.greenhouse\.io/i,
      /jobs\.lever\.co\/.*\/apply/i,
      /icims\.com\/.*\/job\//i,
      /taleo\.net\/.*\/apply/i,
      /\/careers?\/.*(apply|application)/i,
    ];

    // Parent page with ATS embed signals (e.g. ?gh_jid= for Greenhouse)
    if (hasAtsUrlParam() || hasAtsEmbedContainer()) {
      confidence = 'high';
    }

    for (const pattern of highConfidenceUrls) {
      if (pattern.test(url)) {
        confidence = 'high';
        break;
      }
    }

    // Form field signals — require job-specific fields within actual forms
    if (confidence !== 'high') {
      // Only consider fields inside <form> elements or known ATS containers
      const forms = document.querySelectorAll('form, [role="form"], [data-testid*="application"], .application-form');
      if (forms.length === 0) return 'none';

      const inputs = document.querySelectorAll('form input, form select, form textarea, form [role="textbox"], [role="form"] input, [role="form"] select, [role="form"] textarea');
      if (inputs.length === 0) return 'none';

      // Negative signals: password fields indicate login/registration
      for (const el of inputs) {
        if (el.type === 'password') return 'none';
      }

      // Negative signals: search forms
      for (const form of forms) {
        const formAction = form.getAttribute('action') || '';
        if (form.getAttribute('role') === 'search' || formAction.includes('search')) return 'none';
      }

      // Job-specific signals — fields that only appear on job applications
      const jobSpecificPatterns = /resum[eé]|cv[\b\s_\-.]upload|cover.?letter|work.?auth|visa.?status|salary.?expect|desired.?salary|years?.?of?.?experience|how.?did.?you.?(hear|find)|willing.?to.?relocate|security.?clearance|equal.?opportunity|eeo\b|start.?date|available.?start/i;
      // Generic contact fields
      const genericPatterns = /first.?name|last.?name|email|phone|address|city|state|zip/i;

      let jobSignals = 0;
      let genericSignals = 0;

      for (const el of inputs) {
        if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') continue;
        const name = el.name || '';
        const id = el.id || '';
        const label = findLabel(el);
        const placeholder = el.placeholder || '';
        const combined = `${name} ${id} ${label} ${placeholder}`;

        if (jobSpecificPatterns.test(combined)) {
          jobSignals++;
        } else if (genericPatterns.test(combined)) {
          genericSignals++;
        }

        // Resume/CV file upload is a very strong signal
        if (el.type === 'file' && /resum[eé]|cv[\b\s_\-.]|upload.?cv/i.test(combined)) {
          jobSignals += 2;
        }
      }

      // Page title must contain job-application-specific terms (not just "career")
      const pageText = document.title;
      const titleMatch = /\bapply\b|application.?form|job.?application|submit.?your.?application/i.test(pageText);

      // Require strong job-specific evidence
      if (jobSignals >= 2) {
        confidence = 'high';
      } else if (jobSignals >= 1 && genericSignals >= 2) {
        confidence = 'high';
      } else if (jobSignals >= 1 && titleMatch) {
        confidence = 'medium';
      } else if (genericSignals >= 3 && titleMatch) {
        confidence = 'medium';
      }
    }

    return confidence;
  }

  // ─── Auto-detection badge ──────────────────────────────────────

  let badgeEl = null;

  function removeBadge() {
    if (badgeEl) {
      badgeEl.remove();
      badgeEl = null;
    }
  }

  function showBadge(confidence) {
    if (badgeEl) return;

    badgeEl = document.createElement('div');
    badgeEl.className = 'cp-auto-badge' + (confidence === 'medium' ? ' cp-badge-medium' : '');
    badgeEl.innerHTML = `
      <span class="cp-auto-badge-main">
        <svg class="cp-auto-badge-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
          <polyline points="10 9 9 9 8 9"/>
        </svg>
        Fill with CareerPulse
      </span>
      <button class="cp-auto-badge-dismiss" title="Dismiss">\u00d7</button>
    `;

    document.body.appendChild(badgeEl);

    // Click main area to start fill
    badgeEl.querySelector('.cp-auto-badge-main').addEventListener('click', () => {
      removeBadge();
      // If we're on a parent page with an ATS iframe, broadcast startFill via
      // the background script so the iframe's content script picks it up.
      if (!isInIframe() && (hasAtsIframe() || hasAtsEmbedContainer() || hasAtsUrlParam())) {
        chrome.runtime.sendMessage({ type: 'broadcastStartFill' });
      } else {
        startFillFlow();
      }
    });

    // Dismiss button: suppress for this hostname
    badgeEl.querySelector('.cp-auto-badge-dismiss').addEventListener('click', async (e) => {
      e.stopPropagation();
      const host = window.location.hostname;
      try {
        const result = await chrome.storage.local.get({ dismissedHosts: [] });
        const hosts = result.dismissedHosts;
        if (!hosts.includes(host)) {
          hosts.push(host);
          // Cap dismissed hosts to prevent unbounded storage growth
          if (hosts.length > 500) hosts.splice(0, hosts.length - 500);
          await chrome.storage.local.set({ dismissedHosts: hosts });
        }
      } catch (err) {
        console.warn('[CareerPulse] Failed to save dismissed host:', err.message);
      }
      removeBadge();
    });
  }

  async function tryShowBadge() {
    const confidence = detectApplicationForm();
    if (confidence === 'none') return;

    try {
      const result = await chrome.storage.local.get({ dismissedHosts: [] });
      const host = window.location.hostname;
      if (result.dismissedHosts.includes(host)) return;
      showBadge(confidence);
    } catch (err) {
      console.warn('[CareerPulse] Failed to check dismissed hosts:', err.message);
    }
  }

  // Run detection after page load (with delay for SPA content)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(tryShowBadge, 500));
  } else {
    setTimeout(tryShowBadge, 500);
  }

  // Watch for SPA navigation via debounced DOM mutations
  let badgeObserverTimeout = null;
  const badgeObserver = new MutationObserver(() => {
    if (badgeObserverTimeout) clearTimeout(badgeObserverTimeout);
    badgeObserverTimeout = setTimeout(() => {
      if (!badgeEl && currentState === 'idle') {
        tryShowBadge();
      }
    }, 1000);
  });
  badgeObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });


  // ─── Multi-page form tracking ────────────────────────────────

  let multiPageState = null;

  function startMultiPageTracking(filledOnThisPage) {
    stopMultiPageTracking();

    const origin = location.origin;
    multiPageState = {
      origin,
      currentPage: 1,
      totalFilled: filledOnThisPage || 0,
      lastUrl: location.href,
      observer: null,
      debounceTimer: null,
      origPushState: null,
      origReplaceState: null,
      popstateHandler: null,
      hashchangeHandler: null,
    };

    function onPageChange() {
      if (!multiPageState) return;
      if (location.origin !== multiPageState.origin) {
        stopMultiPageTracking();
        return;
      }
      clearTimeout(multiPageState.debounceTimer);
      multiPageState.debounceTimer = setTimeout(() => checkForNewPage(), 1000);
    }

    function checkForNewPage() {
      if (!multiPageState) return;
      // Only detect a new page if the URL actually changed
      const currentUrl = location.href;
      if (currentUrl === multiPageState.lastUrl) return;
      const fields = extractFormData();
      const unfilled = fields.filter(f => f.required && !f.currentValue);
      if (unfilled.length >= 2) {
        multiPageState.lastUrl = currentUrl;
        multiPageState.currentPage++;
        showMultiPageBadge(multiPageState.currentPage);
      }
    }

    // MutationObserver on body for DOM changes (SPA page transitions)
    multiPageState.observer = new MutationObserver(() => onPageChange());
    multiPageState.observer.observe(document.body, { childList: true, subtree: true });

    // Popstate and hashchange for URL-based navigation
    multiPageState.popstateHandler = () => onPageChange();
    multiPageState.hashchangeHandler = () => onPageChange();
    window.addEventListener('popstate', multiPageState.popstateHandler);
    window.addEventListener('hashchange', multiPageState.hashchangeHandler);

    // Register history callbacks via central interceptor
    multiPageState.pushStateCallback = () => onPageChange();
    multiPageState.replaceStateCallback = () => onPageChange();
    historyCallbacks.pushState.add(multiPageState.pushStateCallback);
    historyCallbacks.replaceState.add(multiPageState.replaceStateCallback);
  }

  function stopMultiPageTracking() {
    if (!multiPageState) return;

    if (multiPageState.observer) {
      multiPageState.observer.disconnect();
    }
    clearTimeout(multiPageState.debounceTimer);

    if (multiPageState.popstateHandler) {
      window.removeEventListener('popstate', multiPageState.popstateHandler);
    }
    if (multiPageState.hashchangeHandler) {
      window.removeEventListener('hashchange', multiPageState.hashchangeHandler);
    }

    // Unregister history callbacks
    if (multiPageState.pushStateCallback) {
      historyCallbacks.pushState.delete(multiPageState.pushStateCallback);
    }
    if (multiPageState.replaceStateCallback) {
      historyCallbacks.replaceState.delete(multiPageState.replaceStateCallback);
    }

    multiPageState = null;
  }

  function showMultiPageBadge(pageNum) {
    const existing = document.getElementById(`${PREFIX}-multipage-badge`);
    if (existing) existing.remove();

    const badge = document.createElement('div');
    badge.id = `${PREFIX}-multipage-badge`;
    badge.textContent = `Page ${pageNum} detected \u2014 fill?`;
    badge.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;'
      + 'padding:10px 18px;background:#1a73e8;color:#fff;border-radius:8px;'
      + 'font:14px/1.4 -apple-system,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);';

    badge.addEventListener('click', async () => {
      badge.remove();
      await startFillFlow();
    });
    document.body.appendChild(badge);
  }

  function updateMultiPageProgress(filledOnThisPage) {
    if (!multiPageState) return;
    multiPageState.totalFilled += filledOnThisPage;
    const total = multiPageState.totalFilled;
    const pages = multiPageState.currentPage;
    updateOverlay('done', `Filled ${total} fields across ${pages} page${pages > 1 ? 's' : ''}.`);
  }

  // ─── Queue fill orchestration (content side) ─────────────────

  let queueContext = null; // { queueItemId, jobId, jobTitle, company, position, total }
  let queueBannerEl = null;

  function showQueueBanner(position, total, jobTitle, company) {
    removeQueueBanner();

    queueBannerEl = document.createElement('div');
    queueBannerEl.id = `${PREFIX}-queue-banner`;

    const label = jobTitle
      ? `${jobTitle}${company ? ' at ' + company : ''}`
      : `Application ${position} of ${total}`;

    queueBannerEl.innerHTML = `
      <div class="${PREFIX}-queue-banner-inner">
        <span class="${PREFIX}-queue-banner-progress">${position}/${total}</span>
        <span class="${PREFIX}-queue-banner-label">${escapeHtml(label)}</span>
        <div class="${PREFIX}-queue-banner-actions">
          <button class="${PREFIX}-queue-done-btn" title="Mark as submitted and move to next">Done</button>
          <button class="${PREFIX}-queue-skip-btn" title="Skip this job and move to next">Skip</button>
          <button class="${PREFIX}-queue-cancel-btn" title="Cancel the entire queue">Cancel</button>
        </div>
      </div>
    `;

    document.body.appendChild(queueBannerEl);

    queueBannerEl.querySelector(`.${PREFIX}-queue-done-btn`).addEventListener('click', () => {
      handleQueueAction('submitted');
    });

    queueBannerEl.querySelector(`.${PREFIX}-queue-skip-btn`).addEventListener('click', () => {
      handleQueueAction('skipped');
    });

    queueBannerEl.querySelector(`.${PREFIX}-queue-cancel-btn`).addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'cancelQueue' });
      removeQueueBanner();
      queueContext = null;
    });
  }

  function removeQueueBanner() {
    if (queueBannerEl) {
      queueBannerEl.remove();
      queueBannerEl = null;
    }
  }

  function handleQueueAction(action) {
    if (!queueContext) return;

    chrome.runtime.sendMessage({
      type: 'queueUserAction',
      queueItemId: queueContext.queueItemId,
      action,
    });

    removeQueueBanner();
    queueContext = null;
  }

  async function startQueueFill(message) {
    queueContext = {
      queueItemId: message.queueItemId,
      jobId: message.jobId,
      jobTitle: message.jobTitle || '',
      company: message.company || '',
      position: message.queuePosition,
      total: message.queueTotal,
    };

    showQueueBanner(
      queueContext.position,
      queueContext.total,
      queueContext.jobTitle,
      queueContext.company
    );

    // Set jobId and trigger the normal fill flow
    if (message.jobId) currentJobId = message.jobId;
    await startFillFlow();

    // Report fill completed (NOT submitted — user must explicitly submit)
    try {
      await chrome.runtime.sendMessage({
        type: 'reportFillStatus',
        queueItemId: queueContext.queueItemId,
        status: 'filled',
        details: { state: currentState },
      });
    } catch { /* skip */ }
  }

  // ─── Message handler ──────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Validate message origin — only accept messages from this extension
    if (sender.id !== chrome.runtime.id) return false;

    try {
      switch (message.type) {
        case 'startFill':
          if (message.jobId) currentJobId = message.jobId;
          startFillFlow().then(() => {
            sendResponse({ ok: true, state: currentState });
          }).catch(err => {
            sendResponse({ ok: false, error: err.message });
          });
          return true;

        case 'queueFill':
          startQueueFill(message).then(() => {
            sendResponse({ ok: true, state: currentState });
          }).catch(err => {
            sendResponse({ ok: false, error: err.message });
          });
          return true;

        case 'getStatus':
          sendResponse({ ok: true, state: currentState, queueActive: !!queueContext });
          return false;

        default:
          return false;
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
      return false;
    }
  });

  // ─── Keyboard shortcut: Escape to dismiss overlay ─────────────

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;

    // Don't intercept Escape when user is focused on a form field
    const active = document.activeElement;
    if (active) {
      const tag = active.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (active.isContentEditable) return;
    }

    // Dismiss overlay if present
    if (overlayEl) {
      removeOverlay();
      currentState = 'idle';
    }
  });

  // ─── Job Board Detection & Overlay ──────────────────────────────

  const JOB_BOARD_CONFIGS = {
    'linkedin.com': {
      name: 'LinkedIn',
      listingSelector: '.job-card-container, .jobs-search-results__list-item, .scaffold-layout__list-item',
      titleSelector: '.job-card-list__title, .job-card-container__link, a.job-card-list__title--link',
      companySelector: '.job-card-container__primary-description, .artdeco-entity-lockup__subtitle',
      locationSelector: '.job-card-container__metadata-item, .artdeco-entity-lockup__caption',
      getJobUrl: (card) => {
        const link = card.querySelector('a[href*="/jobs/view/"], a[href*="/jobs/collections/"]');
        if (!link) return null;
        try {
          const url = new URL(link.href, window.location.origin);
          url.search = '';
          url.hash = '';
          return url.href;
        } catch { return null; }
      },
    },
    'indeed.com': {
      name: 'Indeed',
      listingSelector: '.job_seen_beacon, .jobsearch-ResultsList .result, .tapItem',
      titleSelector: '.jobTitle a, h2.jobTitle span, .jcs-JobTitle span',
      companySelector: '.companyName, [data-testid="company-name"], .company_location .companyName',
      locationSelector: '.companyLocation, [data-testid="text-location"]',
      getJobUrl: (card) => {
        const link = card.querySelector('a[href*="/viewjob"], a[href*="/rc/clk"], a.jcs-JobTitle');
        if (!link) return null;
        try {
          const url = new URL(link.href, window.location.origin);
          url.search = '';
          url.hash = '';
          return url.href;
        } catch { return null; }
      },
    },
    'dice.com': {
      name: 'Dice',
      listingSelector: '[data-cy="search-card"], .card-content, dhi-search-card',
      titleSelector: 'a.card-title-link, [data-cy="card-title-link"]',
      companySelector: 'a[data-cy="search-result-company-name"], .card-company a',
      locationSelector: 'span[data-cy="search-result-location"], .card-posted-date',
      getJobUrl: (card) => {
        const link = card.querySelector('a[href*="/job-detail/"], a.card-title-link');
        if (!link) return null;
        try {
          const url = new URL(link.href, window.location.origin);
          url.search = '';
          url.hash = '';
          return url.href;
        } catch { return null; }
      },
    },
    'glassdoor.com': {
      name: 'Glassdoor',
      listingSelector: '.JobsList_jobListItem__wjTHv, li[data-test="jobListing"]',
      titleSelector: 'a[data-test="job-title"], .JobCard_jobTitle__GLyJ1',
      companySelector: '.EmployerProfile_compactEmployerName__9MGiV, .JobCard_companyName__N1YM5',
      locationSelector: '.JobCard_location__N_iYE, [data-test="emp-location"]',
      getJobUrl: (card) => {
        const link = card.querySelector('a[href*="/job-listing/"], a[data-test="job-title"]');
        if (!link) return null;
        try {
          const url = new URL(link.href, window.location.origin);
          url.search = '';
          url.hash = '';
          return url.href;
        } catch { return null; }
      },
    },
  };

  function detectJobBoard() {
    const hostname = window.location.hostname;
    for (const [domain, config] of Object.entries(JOB_BOARD_CONFIGS)) {
      if (hostname.includes(domain)) {
        return config;
      }
    }
    return null;
  }

  function parseJobCard(card, config) {
    const titleEl = card.querySelector(config.titleSelector);
    const companyEl = card.querySelector(config.companySelector);
    const locationEl = card.querySelector(config.locationSelector);
    const url = config.getJobUrl(card);

    if (!titleEl || !url) return null;

    return {
      title: titleEl.textContent.trim(),
      company: companyEl ? companyEl.textContent.trim() : '',
      location: locationEl ? locationEl.textContent.trim() : '',
      url,
      source: config.name,
    };
  }

  function createSaveButton(jobData, card) {
    const existing = card.querySelector(`.${OVERLAY_PREFIX}-save-btn`);
    if (existing) return existing;

    const btn = document.createElement('button');
    btn.className = `${OVERLAY_PREFIX}-save-btn`;
    btn.textContent = 'Save to CareerPulse';
    btn.title = 'Save this job to CareerPulse';

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      btn.disabled = true;
      btn.textContent = 'Saving...';
      btn.classList.add(`${OVERLAY_PREFIX}-saving`);

      try {
        const response = await chrome.runtime.sendMessage({
          type: 'saveJob',
          jobData,
        });

        if (response && response.ok) {
          btn.textContent = 'Saved';
          btn.classList.remove(`${OVERLAY_PREFIX}-saving`);
          btn.classList.add(`${OVERLAY_PREFIX}-saved`);
          btn.disabled = true;

          if (response.data?.score != null) {
            showScoreBadge(card, response.data.score);
          }
        } else {
          btn.textContent = 'Error — Retry';
          btn.classList.remove(`${OVERLAY_PREFIX}-saving`);
          btn.classList.add(`${OVERLAY_PREFIX}-error`);
          btn.disabled = false;
        }
      } catch {
        btn.textContent = 'Error — Retry';
        btn.classList.remove(`${OVERLAY_PREFIX}-saving`);
        btn.classList.add(`${OVERLAY_PREFIX}-error`);
        btn.disabled = false;
      }
    });

    const wrapper = document.createElement('div');
    wrapper.className = `${OVERLAY_PREFIX}-actions`;
    wrapper.appendChild(btn);
    card.style.position = card.style.position || 'relative';
    card.appendChild(wrapper);

    return btn;
  }

  function showScoreBadge(card, score) {
    let badge = card.querySelector(`.${OVERLAY_PREFIX}-score-badge`);
    if (!badge) {
      badge = document.createElement('span');
      badge.className = `${OVERLAY_PREFIX}-score-badge`;
      card.style.position = card.style.position || 'relative';
      card.appendChild(badge);
    }

    const numScore = Math.round(Number(score));
    badge.textContent = `${numScore}%`;
    badge.title = `CareerPulse match score: ${numScore}%`;

    badge.classList.remove(
      `${OVERLAY_PREFIX}-score-high`,
      `${OVERLAY_PREFIX}-score-mid`,
      `${OVERLAY_PREFIX}-score-low`
    );

    if (numScore >= 75) {
      badge.classList.add(`${OVERLAY_PREFIX}-score-high`);
    } else if (numScore >= 50) {
      badge.classList.add(`${OVERLAY_PREFIX}-score-mid`);
    } else {
      badge.classList.add(`${OVERLAY_PREFIX}-score-low`);
    }
  }

  async function processJobCards(config) {
    const cards = document.querySelectorAll(config.listingSelector);
    if (!cards.length) return;

    for (const card of cards) {
      if (card.dataset.cpProcessed) continue;
      card.dataset.cpProcessed = 'true';

      const jobData = parseJobCard(card, config);
      if (!jobData) continue;

      try {
        const lookupResp = await chrome.runtime.sendMessage({
          type: 'getScoreForUrl',
          url: jobData.url,
        });

        if (lookupResp && lookupResp.ok && lookupResp.data) {
          const btn = createSaveButton(jobData, card);
          btn.textContent = 'Saved';
          btn.classList.add(`${OVERLAY_PREFIX}-saved`);
          btn.disabled = true;

          if (lookupResp.data.score != null) {
            showScoreBadge(card, lookupResp.data.score);
          }
        } else {
          createSaveButton(jobData, card);
        }
      } catch {
        createSaveButton(jobData, card);
      }
    }
  }

  let scanTimer = null;

  function scheduleScan(config) {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => processJobCards(config), SCAN_DEBOUNCE_MS);
  }

  function initJobBoardOverlay() {
    const config = detectJobBoard();
    if (!config) return;

    processJobCards(config);

    const observer = new MutationObserver(() => scheduleScan(config));
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Run job board overlay detection (separate from the auto-fill badge)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initJobBoardOverlay);
  } else {
    setTimeout(initJobBoardOverlay, 300);
  }

  // ─── Export for testing ────────────────────────────────────────

  if (typeof window !== 'undefined' && window.__cpAutofillTest) {
    window.__cpAutofillTestAPI = {
      extractFormData,
      resolveElement,
      fillField,
      findTypeaheadDropdown,
      getDropdownOptions,
      fuzzyMatchDropdownOption,
      fuzzyMatchOption,
      getFieldHints,
      isPhoneField,
      isPhoneExtensionField,
      isDateField,
      parseFlexibleDate,
      fillDateField,
      isRichTextEditor,
      findRichTextEditor,
      fillRichText,
      isCustomDropdownTrigger,
      handleCustomDropdown,
      typeAndSelectDropdown,
      dismissOpenDropdowns,
      deepQuerySelectorAll,
      deepQuerySelector,
      simulateTyping,
      isElementVisible,
      buildSelector,
      findLabel,
      setNativeValue,
      dispatchEvents,
      clickOption,
      serializeFormHtml,
      fillForm,
      fuzzyMatchQA,
      applyCustomQA,
      detectApplicationForm,
      showBadge,
      removeBadge,
      tryShowBadge,
      undoField,
      originalValues,
      detectFileUploadFields,
      showUploadHelper,
      detectUploadType,

      startMultiPageTracking,
      stopMultiPageTracking,

      // Auto-track API
      showToast,
      autoTrackApplied,
      get autoTrackFired() { return autoTrackFired; },
      set autoTrackFired(v) { autoTrackFired = v; },

      // Job board overlay API
      detectJobBoard,
      parseJobCard,
      createSaveButton,
      showScoreBadge,
      processJobCards,
      initJobBoardOverlay,
      JOB_BOARD_CONFIGS,

      // Queue fill API
      showQueueBanner,
      removeQueueBanner,
      handleQueueAction,
      startQueueFill,
      get queueContext() { return queueContext; },
      set queueContext(v) { queueContext = v; },

      // Timeout / flow internals for testing
      get API_TIMEOUT_MS() { return API_TIMEOUT_MS; },
      withTimeout,
      startFillFlow,
      getNewMappings,
      updateOverlay,
    };
  }

})();
