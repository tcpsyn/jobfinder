(() => {
  'use strict';

  // Guard against multiple injections
  if (window.__cpAutofillLoaded) return;
  window.__cpAutofillLoaded = true;

  const PREFIX = 'cp-autofill';
  let currentState = 'idle'; // idle | analyzing | filling | done | error

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

    const selectors = 'input, select, textarea, [contenteditable="true"]';
    const elements = document.querySelectorAll(selectors);

    for (const el of elements) {
      try {
        // Skip hidden/disabled fields and submit buttons
        const type = (el.type || '').toLowerCase();
        if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'image') continue;
        if (el.disabled) continue;

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
          currentValue: el.value || '',
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

    // Also check iframes we can access
    try {
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const iDoc = iframe.contentDocument || iframe.contentWindow?.document;
          if (!iDoc) continue;
          const iElements = iDoc.querySelectorAll(selectors);
          for (const el of iElements) {
            try {
              const type = (el.type || '').toLowerCase();
              if (type === 'hidden' || type === 'submit' || type === 'button') continue;
              if (el.disabled) continue;

              const iframeSelector = buildSelector(iframe);
              const fieldSelector = buildSelector(el);
              const selector = `iframe:${iframeSelector}>>>${fieldSelector}`;

              if (seen.has(selector)) continue;
              seen.add(selector);

              if ((type === 'radio' || type === 'checkbox') && el.name) {
                const groupKey = `iframe-group:${el.name}`;
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
                currentValue: el.value || '',
                iframe: true,
              };

              if (el.tagName === 'SELECT') {
                field.options = getSelectOptions(el);
              } else if (type === 'radio' || type === 'checkbox') {
                field.options = getRadioCheckboxGroup(el);
              }

              fields.push(field);
            } catch { /* skip */ }
          }
        } catch { /* cross-origin, skip */ }
      }
    } catch { /* skip */ }

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
        // Remove data- attributes and style
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

  // ─── Field filling ────────────────────────────────────────────

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
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

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
          el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        } else if (name === 'change') {
          el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        } else if (name === 'click') {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        } else if (name === 'focus') {
          el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
        } else if (name === 'blur') {
          el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        }
      } catch { /* skip */ }
    }
  }

  function fuzzyMatchOption(options, targetValue) {
    if (!options || !options.length) return -1;
    const target = targetValue.toLowerCase().trim();

    // Exact match on value
    for (let i = 0; i < options.length; i++) {
      if (options[i].value.toLowerCase() === target) return i;
    }
    // Exact match on text
    for (let i = 0; i < options.length; i++) {
      if (options[i].text.toLowerCase().trim() === target) return i;
    }
    // Contains match
    for (let i = 0; i < options.length; i++) {
      if (options[i].value.toLowerCase().includes(target) || options[i].text.toLowerCase().includes(target)) return i;
      if (target.includes(options[i].value.toLowerCase()) || target.includes(options[i].text.toLowerCase().trim())) return i;
    }
    return -1;
  }

  function fillField(selector, value, action) {
    try {
      const el = resolveElement(selector);
      if (!el) return { selector, success: false, reason: 'element not found' };

      el.focus();
      dispatchEvents(el, ['focus']);

      switch (action) {
        case 'fill_text': {
          setNativeValue(el, value);
          dispatchEvents(el, ['input', 'change', 'blur']);
          return { selector, success: true, action };
        }

        case 'select_dropdown': {
          const options = Array.from(el.options || []).map(o => ({ value: o.value, text: o.textContent }));
          const idx = fuzzyMatchOption(options, value);
          if (idx >= 0) {
            el.selectedIndex = idx;
            dispatchEvents(el, ['change', 'blur']);
            return { selector, success: true, action, selectedValue: options[idx].value };
          }
          return { selector, success: false, reason: `no matching option for "${value}"` };
        }

        case 'click_radio': {
          const name = el.name || el.getAttribute('name');
          if (name) {
            const root = el.closest('form') || el.getRootNode();
            const radios = root.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`);
            const target = value.toLowerCase().trim();
            for (const radio of radios) {
              const radioLabel = findLabel(radio).toLowerCase();
              const radioValue = radio.value.toLowerCase();
              if (radioValue === target || radioLabel.includes(target) || target.includes(radioLabel)) {
                radio.checked = true;
                dispatchEvents(radio, ['click', 'change']);
                return { selector, success: true, action, selectedValue: radio.value };
              }
            }
          }
          // Fallback: click the element directly
          el.checked = true;
          dispatchEvents(el, ['click', 'change']);
          return { selector, success: true, action };
        }

        case 'check_checkbox': {
          const shouldCheck = value === true || value === 'true' || value === 'yes' || value === '1';
          if (el.checked !== shouldCheck) {
            el.checked = shouldCheck;
            dispatchEvents(el, ['click', 'change']);
          }
          return { selector, success: true, action };
        }

        case 'upload_file': {
          // File uploads can't be programmatically set for security reasons
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

    for (let iteration = 0; iteration < 5; iteration++) {
      const currentMappings = iteration === 0 ? mappings : await getNewMappings();
      if (!currentMappings || !currentMappings.length) break;

      for (const mapping of currentMappings) {
        if (mapping.action === 'skip') continue;

        const result = fillField(mapping.selector, mapping.value, mapping.action);
        results.push(result);

        if (result.success && !result.skipped) {
          filledCount++;
          updateOverlay('filling', `Filling ${filledCount}/${totalMappable} fields...`);

          // Highlight the field
          try {
            const el = resolveElement(mapping.selector);
            if (el) {
              const confidence = mapping.confidence || 1;
              el.classList.add(confidence >= 0.8 ? `${PREFIX}-filled` : `${PREFIX}-review`);
            }
          } catch { /* skip */ }
        }
      }

      // Wait for dynamic fields
      await sleep(500);

      // Check if new fields appeared
      const newFields = extractFormData();
      const previousSelectors = new Set(currentMappings.map(m => m.selector));
      const newUnmapped = newFields.filter(f => !previousSelectors.has(f.selector) && !f.currentValue);

      if (newUnmapped.length === 0) break;

      // Will re-analyze on next iteration
    }

    return { results, filledCount, total: totalMappable };
  }

  async function getNewMappings() {
    try {
      const formHtml = serializeFormHtml();
      const response = await chrome.runtime.sendMessage({
        type: 'analyzeForm',
        formHtml,
      });
      if (response && response.ok && response.data?.mappings) {
        return response.data.mappings;
      }
    } catch { /* skip */ }
    return null;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
    // Listen for form submits
    document.addEventListener('submit', handleSubmission, true);

    // Listen for navigation (SPA form submits)
    const originalPushState = history.pushState;
    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      handleSubmission();
    };

    // Also track clicks on submit-like buttons
    document.addEventListener('click', (e) => {
      try {
        const btn = e.target.closest('button[type="submit"], input[type="submit"], [role="button"]');
        if (btn && btn.closest('form')) {
          // Delay to let form values settle
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
        // If the value changed from what we filled, or is new
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

      // Capture current values before filling
      preSubmitValues = captureFormValues();

      // Serialize and send to API
      const formHtml = serializeFormHtml();
      const response = await chrome.runtime.sendMessage({
        type: 'analyzeForm',
        formHtml,
      });

      if (!response || !response.ok) {
        updateOverlay('error', `Error: ${response?.error || 'Analysis failed'}`);
        return;
      }

      const mappings = response.data?.mappings || [];
      if (!mappings.length) {
        updateOverlay('done', 'No fillable fields found');
        return;
      }

      // Fill the form
      currentState = 'filling';
      const result = await fillForm(mappings);

      // Show result
      updateOverlay('done', `Filled ${result.filledCount}/${result.total} fields. Review highlighted fields.`);

      // Update pre-submit values to track what we filled
      preSubmitValues = captureFormValues();

      // Start submission detection
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
          return true; // async

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

})();
