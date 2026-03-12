(() => {
  'use strict';

  // Guard against multiple injections
  if (window.__cpAutofillLoaded) return;
  window.__cpAutofillLoaded = true;

  const PREFIX = 'cp-autofill';
  const FIELD_TIMEOUT_MS = 8000;  // Max time per field fill
  const API_TIMEOUT_MS = 30000;   // Max time for API analyze call
  let currentState = 'idle'; // idle | analyzing | filling | done | error

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

  function extractFormData() {
    const fields = [];
    const seen = new Set();

    const selectors = 'input, select, textarea, [contenteditable="true"], [role="combobox"], [role="textbox"], [role="spinbutton"]';

    // Search both light DOM and shadow DOM
    const elements = deepQuerySelectorAll(document, selectors);

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
        if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'image') continue;
        if (el.disabled) continue;

        // Skip our own overlay elements
        if (el.closest(`#${PREFIX}-overlay`) || el.closest(`#${PREFIX}-learn-prompt`)) continue;

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

  // ─── Dropdown / listbox detection ──────────────────────────

  function fuzzyMatchOption(options, targetValue) {
    if (!options || !options.length) return -1;
    const target = targetValue.toLowerCase().trim();

    for (let i = 0; i < options.length; i++) {
      if (options[i].value.toLowerCase() === target) return i;
    }
    for (let i = 0; i < options.length; i++) {
      if (options[i].text.toLowerCase().trim() === target) return i;
    }
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

  function fuzzyMatchDropdownOption(options, targetValue) {
    if (!options.length) return null;
    const target = targetValue.toLowerCase().trim();

    // Exact text match
    for (const opt of options) {
      if (opt.textContent.trim().toLowerCase() === target) return opt;
    }

    // Text starts with target
    for (const opt of options) {
      if (opt.textContent.trim().toLowerCase().startsWith(target)) return opt;
    }

    // Target starts with option text
    for (const opt of options) {
      const text = opt.textContent.trim().toLowerCase();
      if (text.startsWith(target) || target.startsWith(text)) return opt;
    }

    // Contains match
    for (const opt of options) {
      const text = opt.textContent.trim().toLowerCase();
      if (text.includes(target) || target.includes(text)) return opt;
    }

    // Word-level overlap (for "Animas, Hidalgo, NM" matching "Animas")
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

  async function handleCustomDropdown(el, value) {
    // Click to open the dropdown
    el.click();
    dispatchEvents(el, ['click', 'focus']);
    await sleep(300);

    // Look for the dropdown that appeared
    const dropdown = findTypeaheadDropdown(el);
    if (!dropdown) {
      // Try clicking a child button/arrow that might open it
      const trigger = el.querySelector('button, [class*="arrow"], [class*="indicator"], [class*="toggle"]');
      if (trigger) {
        trigger.click();
        await sleep(300);
      }
    }

    const dd = dropdown || findTypeaheadDropdown(el);
    if (!dd) return { success: false, reason: 'no dropdown appeared' };

    const options = getDropdownOptions(dd);
    if (!options.length) return { success: false, reason: 'no options in dropdown' };

    // Try typing to filter first (for searchable dropdowns)
    const searchInput = dd.querySelector('input') || el.querySelector('input');
    if (searchInput) {
      searchInput.focus();
      setNativeValue(searchInput, value);
      dispatchEvents(searchInput, ['input']);
      await sleep(300);

      // Re-fetch filtered options
      const filteredOptions = getDropdownOptions(dd);
      const match = fuzzyMatchDropdownOption(filteredOptions.length ? filteredOptions : options, value);
      if (match) {
        clickOption(match);
        return { success: true, selectedText: match.textContent.trim() };
      }
    }

    // Direct option match without filtering
    const match = fuzzyMatchDropdownOption(options, value);
    if (match) {
      clickOption(match);
      return { success: true, selectedText: match.textContent.trim() };
    }

    // Close the dropdown since we couldn't match
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })
    );

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

  // ─── Typeahead handling ────────────────────────────────────

  async function typeAndSelectDropdown(el, value) {
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

      const match = fuzzyMatchDropdownOption(options, value);
      if (match) {
        clickOption(match);
        await sleep(100);
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
          const retryMatch = fuzzyMatchDropdownOption(retryOptions, value);
          if (retryMatch) {
            clickOption(retryMatch);
            await sleep(100);
            return { success: true, selectedText: retryMatch.textContent.trim() };
          }
        }
      }

      // Last resort: select first option if it seems reasonable
      if (wait >= 4 && options.length <= 3) {
        clickOption(options[0]);
        await sleep(100);
        return { success: true, selectedText: options[0].textContent.trim(), fallback: true };
      }
    }

    // Try keyboard navigation as last resort (ArrowDown + Enter)
    try {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
      await sleep(100);
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      await sleep(100);
      // Check if value changed (something was selected)
      if (el.value !== value && el.value !== '') {
        return { success: true, selectedText: el.value, keyboard: true };
      }
    } catch { /* skip */ }

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

      // Clear existing content
      editorEl.innerHTML = '';

      // Insert as HTML (preserving newlines as <br> or <p>)
      const html = value.replace(/\n/g, '<br>');
      editorEl.innerHTML = html;

      // Dispatch events that editors listen for
      editorEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      editorEl.dispatchEvent(new Event('change', { bubbles: true }));

      // For Draft.js and similar, we may need to use execCommand
      try {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, value);
      } catch { /* skip — not all editors support this */ }

      return true;
    } catch {
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

  async function fillField(selector, value, action) {
    try {
      // Dismiss any stale dropdowns from previous field
      dismissOpenDropdowns();
      await sleep(50);

      const el = resolveElement(selector);
      if (!el) {
        // Selector may have gone stale after DOM mutation; try re-extracting
        return { selector, success: false, reason: 'element not found' };
      }

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

          // 3. Check if this is a custom click-to-open dropdown (not a typeahead)
          if (isCustomDropdownTrigger(el) && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
            const result = await handleCustomDropdown(el, value);
            if (result.success) return { selector, success: true, action, selectedText: result.selectedText };
          }

          // 4. Check if this is a typeahead/autocomplete field (has ARIA hints)
          const isTypeahead = el.getAttribute('role') === 'combobox'
            || el.getAttribute('aria-autocomplete')
            || el.getAttribute('aria-owns')
            || el.getAttribute('aria-controls')
            || el.getAttribute('list')
            || el.closest('[class*="autocomplete"]')
            || el.closest('[class*="typeahead"]')
            || el.closest('[class*="combobox"]');

          if (isTypeahead) {
            const result = await typeAndSelectDropdown(el, value);
            if (result.success) {
              return { selector, success: true, action, selectedText: result.selectedText };
            }
          }

          // 5. Normal text fill
          setNativeValue(el, value);
          dispatchEvents(el, ['input', 'change']);

          // 6. After setting value, check if a dropdown appeared anyway
          await sleep(300);
          const dropdown = findTypeaheadDropdown(el);
          if (dropdown) {
            const options = getDropdownOptions(dropdown);
            if (options.length > 0) {
              const match = fuzzyMatchDropdownOption(options, value);
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

        case 'select_dropdown': {
          // Handle native <select>
          if (el.tagName === 'SELECT') {
            const options = Array.from(el.options || []).map(o => ({ value: o.value, text: o.textContent }));
            const idx = fuzzyMatchOption(options, value);
            if (idx >= 0) {
              el.selectedIndex = idx;
              dispatchEvents(el, ['change', 'blur']);
              return { selector, success: true, action, selectedValue: options[idx].value };
            }
            return { selector, success: false, reason: `no matching option for "${value}"` };
          }

          // Handle custom dropdown (div-based)
          const customResult = await handleCustomDropdown(el, value);
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

  // ─── Iterative form fill ──────────────────────────────────────

  async function fillForm(mappings) {
    const results = [];
    let filledCount = 0;
    const totalMappable = mappings.filter(m => m.action !== 'skip').length;
    const failedSelectors = new Set();

    for (let iteration = 0; iteration < 5; iteration++) {
      const currentMappings = iteration === 0 ? mappings : await getNewMappings();
      if (!currentMappings || !currentMappings.length) break;

      for (const mapping of currentMappings) {
        if (mapping.action === 'skip') continue;
        if (failedSelectors.has(mapping.selector) && iteration > 0) continue;

        let result;
        try {
          result = await withTimeout(
            fillField(mapping.selector, mapping.value, mapping.action),
            FIELD_TIMEOUT_MS,
            `filling ${mapping.selector}`
          );
        } catch (err) {
          result = { selector: mapping.selector, success: false, reason: err.message };
        }

        results.push(result);

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

      // Check if new fields appeared
      const newFields = extractFormData();
      const previousSelectors = new Set(currentMappings.map(m => m.selector));
      const newUnmapped = newFields.filter(f => !previousSelectors.has(f.selector) && !f.currentValue);

      if (newUnmapped.length === 0) break;
    }

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
    } catch { /* skip */ }
    return null;
  }

  // ─── Overlay UI ───────────────────────────────────────────────

  let overlayEl = null;

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

    return overlayEl;
  }

  function updateOverlay(state, message) {
    const overlay = createOverlay();
    const statusEl = overlay.querySelector(`.${PREFIX}-overlay-status`);
    if (statusEl) {
      statusEl.textContent = message || state;
    }
    currentState = state;
  }

  function showOverlay(status) {
    updateOverlay(status, status);
  }

  function removeOverlay() {
    if (overlayEl) {
      overlayEl.remove();
      overlayEl = null;
    }
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

  // ─── Submission detection ─────────────────────────────────────

  function detectSubmission() {
    document.addEventListener('submit', handleSubmission, true);

    const originalPushState = history.pushState;
    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      handleSubmission();
    };

    document.addEventListener('click', (e) => {
      try {
        const btn = e.target.closest('button[type="submit"], input[type="submit"], [role="button"]');
        if (btn && btn.closest('form')) {
          setTimeout(handleSubmission, 1000);
        }
      } catch { /* skip */ }
    }, true);
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
    } catch { /* skip */ }
  }

  // ─── Main fill flow ──────────────────────────────────────────

  async function startFillFlow() {
    try {
      currentState = 'analyzing';
      showOverlay('Analyzing form...');

      preSubmitValues = captureFormValues();

      const formHtml = serializeFormHtml();

      let response;
      try {
        response = await withTimeout(
          chrome.runtime.sendMessage({ type: 'analyzeForm', formHtml }),
          API_TIMEOUT_MS,
          'Form analysis'
        );
      } catch (err) {
        updateOverlay('error', `Timed out analyzing form. Is the server running?`);
        return;
      }

      if (!response || !response.ok) {
        updateOverlay('error', `Error: ${response?.error || 'Analysis failed'}`);
        return;
      }

      const mappings = response.data?.mappings || [];
      if (!mappings.length) {
        updateOverlay('done', 'No fillable fields found');
        return;
      }

      currentState = 'filling';
      const result = await fillForm(mappings);

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
    } catch (err) {
      updateOverlay('error', `Error: ${err.message}`);
    }
  }

  // ─── Message handler ──────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      switch (message.type) {
        case 'startFill':
          startFillFlow().then(() => {
            sendResponse({ ok: true, state: currentState });
          }).catch(err => {
            sendResponse({ ok: false, error: err.message });
          });
          return true;

        case 'getStatus':
          sendResponse({ ok: true, state: currentState });
          return false;

        default:
          return false;
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
      return false;
    }
  });

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
    };
  }

})();
