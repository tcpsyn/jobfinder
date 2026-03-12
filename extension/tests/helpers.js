// Helper to load content.js and get the test API
export function loadContentScript() {
  // Reset state for each test
  window.__cpAutofillLoaded = false;
  window.__cpAutofillTest = true;
  window.__cpAutofillTestAPI = undefined;

  // Re-import by clearing module cache — not feasible with static imports.
  // Instead, we eval the content script in a controlled way.
  // For vitest, we load and execute the IIFE directly.
}

// Create a mock form field
export function createInput(attrs = {}) {
  const input = document.createElement('input');
  Object.entries(attrs).forEach(([key, val]) => {
    if (key === 'type' || key === 'name' || key === 'id' || key === 'placeholder' || key === 'value') {
      input[key] = val;
    } else {
      input.setAttribute(key, val);
    }
  });
  document.body.appendChild(input);
  return input;
}

// Create a <select> with options
export function createSelect(attrs = {}, options = []) {
  const select = document.createElement('select');
  Object.entries(attrs).forEach(([key, val]) => {
    if (key === 'name' || key === 'id') {
      select[key] = val;
    } else {
      select.setAttribute(key, val);
    }
  });
  for (const opt of options) {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.text;
    select.appendChild(option);
  }
  document.body.appendChild(select);
  return select;
}

// Create a label for an element
export function createLabel(forId, text) {
  const label = document.createElement('label');
  label.setAttribute('for', forId);
  label.textContent = text;
  document.body.appendChild(label);
  return label;
}

// Create a typeahead dropdown that appears when input gets focus/value
export function createTypeaheadInput(inputAttrs = {}, dropdownOptions = []) {
  const wrapper = document.createElement('div');
  wrapper.className = 'autocomplete-wrapper';

  const input = document.createElement('input');
  Object.entries(inputAttrs).forEach(([key, val]) => {
    if (key === 'type' || key === 'name' || key === 'id' || key === 'placeholder' || key === 'value') {
      input[key] = val;
    } else {
      input.setAttribute(key, val);
    }
  });
  wrapper.appendChild(input);

  const listbox = document.createElement('ul');
  listbox.setAttribute('role', 'listbox');
  listbox.id = inputAttrs.id ? `${inputAttrs.id}-listbox` : 'typeahead-listbox';
  listbox.style.display = 'none';

  for (const opt of dropdownOptions) {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.textContent = opt;
    li.style.height = '30px';
    li.style.display = 'block';
    listbox.appendChild(li);
  }

  wrapper.appendChild(listbox);

  // Wire up: show listbox when input changes
  input.addEventListener('input', () => {
    listbox.style.display = 'block';
    // Simulate offsetParent for visibility check
    Object.defineProperty(listbox, 'offsetParent', { value: wrapper, configurable: true });
    for (const li of listbox.children) {
      Object.defineProperty(li, 'offsetParent', { value: listbox, configurable: true });
      Object.defineProperty(li, 'offsetHeight', { value: 30, configurable: true });
    }
  });

  if (inputAttrs['aria-controls']) {
    input.setAttribute('aria-controls', listbox.id);
  }

  document.body.appendChild(wrapper);
  return { input, listbox, wrapper };
}

// Create a custom (click-to-open) dropdown
export function createCustomDropdown(attrs = {}, options = []) {
  const wrapper = document.createElement('div');
  wrapper.setAttribute('role', 'combobox');
  wrapper.setAttribute('aria-expanded', 'false');
  Object.entries(attrs).forEach(([key, val]) => {
    wrapper.setAttribute(key, val);
  });

  const display = document.createElement('span');
  display.textContent = 'Select...';
  wrapper.appendChild(display);

  const listbox = document.createElement('div');
  listbox.setAttribute('role', 'listbox');
  listbox.style.display = 'none';

  for (const opt of options) {
    const item = document.createElement('div');
    item.setAttribute('role', 'option');
    item.textContent = opt;
    item.style.height = '30px';
    listbox.appendChild(item);
  }

  wrapper.appendChild(listbox);

  // Wire up: show on click
  wrapper.addEventListener('click', () => {
    listbox.style.display = 'block';
    wrapper.setAttribute('aria-expanded', 'true');
    Object.defineProperty(listbox, 'offsetParent', { value: wrapper, configurable: true });
    for (const item of listbox.querySelectorAll('[role="option"]')) {
      Object.defineProperty(item, 'offsetParent', { value: listbox, configurable: true });
      Object.defineProperty(item, 'offsetHeight', { value: 30, configurable: true });
    }
  });

  document.body.appendChild(wrapper);
  return { wrapper, listbox, display };
}

// Create a contenteditable rich text editor
export function createRichTextEditor(attrs = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'editor-wrapper';

  const editor = document.createElement('div');
  editor.setAttribute('contenteditable', 'true');
  editor.setAttribute('role', 'textbox');
  Object.entries(attrs).forEach(([key, val]) => {
    editor.setAttribute(key, val);
  });
  wrapper.appendChild(editor);

  document.body.appendChild(wrapper);
  return { editor, wrapper };
}

// Create a date input
export function createDateInput(attrs = {}) {
  const input = document.createElement('input');
  input.type = attrs.type || 'date';
  Object.entries(attrs).forEach(([key, val]) => {
    if (key !== 'type') {
      if (key === 'name' || key === 'id' || key === 'placeholder' || key === 'value') {
        input[key] = val;
      } else {
        input.setAttribute(key, val);
      }
    }
  });
  document.body.appendChild(input);
  return input;
}

// Create an element inside a shadow DOM
export function createShadowDOMInput(attrs = {}) {
  const host = document.createElement('div');
  host.id = attrs.hostId || 'shadow-host';
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  const input = document.createElement('input');
  Object.entries(attrs).forEach(([key, val]) => {
    if (key === 'hostId') return;
    if (key === 'type' || key === 'name' || key === 'id' || key === 'placeholder' || key === 'value') {
      input[key] = val;
    } else {
      input.setAttribute(key, val);
    }
  });
  shadow.appendChild(input);

  return { host, shadow, input };
}

// Clean up DOM after tests
export function cleanDOM() {
  document.body.innerHTML = '';
}
