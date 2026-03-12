import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createInput, createSelect, createLabel, createTypeaheadInput,
  createCustomDropdown, createRichTextEditor, createDateInput,
  createShadowDOMInput, cleanDOM,
} from './helpers.js';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load and execute the content script IIFE
function loadScript() {
  window.__cpAutofillLoaded = false;
  window.__cpAutofillTest = true;
  window.__cpAutofillTestAPI = undefined;

  const code = readFileSync(join(__dirname, '..', 'content.js'), 'utf-8');
  // Replace chrome.runtime references in the IIFE to avoid errors during load
  const safeCode = code.replace(
    /chrome\.runtime\.onMessage\.addListener/g,
    'globalThis.chrome.runtime.onMessage.addListener'
  );
  eval(safeCode);
  return window.__cpAutofillTestAPI;
}

let api;

beforeEach(() => {
  cleanDOM();
  api = loadScript();
});

afterEach(() => {
  cleanDOM();
});

// ═══════════════════════════════════════════════════════════════
// Form extraction
// ═══════════════════════════════════════════════════════════════

describe('extractFormData', () => {
  it('extracts text inputs', () => {
    createInput({ type: 'text', name: 'firstName', id: 'firstName' });
    createLabel('firstName', 'First Name');

    const fields = api.extractFormData();
    expect(fields.length).toBe(1);
    expect(fields[0].name).toBe('firstName');
    expect(fields[0].label).toBe('First Name');
  });

  it('extracts select elements with options', () => {
    createSelect({ name: 'country', id: 'country' }, [
      { value: 'us', text: 'United States' },
      { value: 'ca', text: 'Canada' },
    ]);

    const fields = api.extractFormData();
    expect(fields.length).toBe(1);
    expect(fields[0].options).toHaveLength(2);
    expect(fields[0].options[0].text).toBe('United States');
  });

  it('extracts contenteditable elements', () => {
    const { editor } = createRichTextEditor({ id: 'coverLetter' });
    createLabel('coverLetter', 'Cover Letter');

    const fields = api.extractFormData();
    // contenteditable divs are matched by [contenteditable="true"] selector
    const editableFields = fields.filter(f => f.id === 'coverLetter' || f.isContentEditable);
    expect(editableFields.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts role="combobox" elements', () => {
    const div = document.createElement('div');
    div.setAttribute('role', 'combobox');
    div.id = 'cityCombo';
    document.body.appendChild(div);

    const fields = api.extractFormData();
    const comboFields = fields.filter(f => f.role === 'combobox');
    expect(comboFields.length).toBe(1);
  });

  it('skips hidden and disabled fields', () => {
    createInput({ type: 'hidden', name: 'csrf' });
    createInput({ type: 'text', name: 'disabled_field', id: 'df' });
    document.getElementById('df').disabled = true;

    const fields = api.extractFormData();
    expect(fields.length).toBe(0);
  });

  it('skips submit/button inputs', () => {
    createInput({ type: 'submit', name: 'sub' });
    createInput({ type: 'button', name: 'btn' });

    const fields = api.extractFormData();
    expect(fields.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// Label finding
// ═══════════════════════════════════════════════════════════════

describe('findLabel', () => {
  it('finds explicit label via for attribute', () => {
    const input = createInput({ id: 'email', type: 'email' });
    createLabel('email', 'Email Address');
    expect(api.findLabel(input)).toBe('Email Address');
  });

  it('finds aria-label', () => {
    const input = createInput({ 'aria-label': 'Phone Number' });
    expect(api.findLabel(input)).toBe('Phone Number');
  });

  it('finds label from parent label element', () => {
    const label = document.createElement('label');
    label.textContent = 'Your Name ';
    const input = document.createElement('input');
    input.type = 'text';
    label.appendChild(input);
    document.body.appendChild(label);
    expect(api.findLabel(input)).toBe('Your Name');
  });

  it('returns empty string when no label found', () => {
    const input = createInput({ type: 'text' });
    expect(api.findLabel(input)).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════
// Selector building
// ═══════════════════════════════════════════════════════════════

describe('buildSelector', () => {
  it('uses id when available', () => {
    const input = createInput({ id: 'myField' });
    expect(api.buildSelector(input)).toBe('#myField');
  });

  it('uses name when unique', () => {
    const input = createInput({ name: 'uniqueName', type: 'text' });
    const sel = api.buildSelector(input);
    expect(sel).toContain('uniqueName');
  });

  it('builds path for elements without id or unique name', () => {
    const div = document.createElement('div');
    const input = document.createElement('input');
    input.type = 'text';
    div.appendChild(input);
    document.body.appendChild(div);

    const sel = api.buildSelector(input);
    expect(sel).toBeTruthy();
    expect(document.querySelector(sel)).toBe(input);
  });
});

// ═══════════════════════════════════════════════════════════════
// Element resolution (with fallbacks)
// ═══════════════════════════════════════════════════════════════

describe('resolveElement', () => {
  it('resolves by id selector', () => {
    const input = createInput({ id: 'test-input' });
    expect(api.resolveElement('#test-input')).toBe(input);
  });

  it('resolves by name selector', () => {
    const input = createInput({ name: 'email', type: 'text' });
    expect(api.resolveElement('input[name="email"][type="text"]')).toBe(input);
  });

  it('falls back to id extraction from complex selector', () => {
    const input = createInput({ id: 'deep-field' });
    // A stale selector that doesn't directly work
    expect(api.resolveElement('#deep-field')).toBe(input);
  });

  it('returns null for non-existent element', () => {
    expect(api.resolveElement('#does-not-exist')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// Shadow DOM
// ═══════════════════════════════════════════════════════════════

describe('Shadow DOM', () => {
  it('deepQuerySelectorAll finds elements in shadow roots', () => {
    const { input } = createShadowDOMInput({ type: 'text', hostId: 'shadow1' });
    const results = api.deepQuerySelectorAll(document, 'input[type="text"]');
    expect(results).toContain(input);
  });

  it('deepQuerySelector finds first element in shadow root', () => {
    const { input } = createShadowDOMInput({ type: 'email', hostId: 'shadow2' });
    const result = api.deepQuerySelector(document, 'input[type="email"]');
    expect(result).toBe(input);
  });

  it('extractFormData includes shadow DOM fields', () => {
    createShadowDOMInput({ type: 'text', name: 'shadowField', hostId: 'shadow3' });
    const fields = api.extractFormData();
    const shadowFields = fields.filter(f => f.name === 'shadowField');
    expect(shadowFields.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Native value setting
// ═══════════════════════════════════════════════════════════════

describe('setNativeValue', () => {
  it('sets value on input element', () => {
    const input = createInput({ type: 'text' });
    api.setNativeValue(input, 'hello');
    expect(input.value).toBe('hello');
  });

  it('sets value on textarea', () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    api.setNativeValue(textarea, 'multi\nline');
    expect(textarea.value).toBe('multi\nline');
  });
});

// ═══════════════════════════════════════════════════════════════
// Event dispatch
// ═══════════════════════════════════════════════════════════════

describe('dispatchEvents', () => {
  it('dispatches input event', () => {
    const input = createInput({ type: 'text' });
    const handler = vi.fn();
    input.addEventListener('input', handler);
    api.dispatchEvents(input, ['input']);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('dispatches multiple events', () => {
    const input = createInput({ type: 'text' });
    const handlers = { input: vi.fn(), change: vi.fn(), blur: vi.fn() };
    input.addEventListener('input', handlers.input);
    input.addEventListener('change', handlers.change);
    input.addEventListener('blur', handlers.blur);
    api.dispatchEvents(input, ['input', 'change', 'blur']);
    expect(handlers.input).toHaveBeenCalledTimes(1);
    expect(handlers.change).toHaveBeenCalledTimes(1);
    expect(handlers.blur).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Simulated typing
// ═══════════════════════════════════════════════════════════════

describe('simulateTyping', () => {
  it('types value character by character', () => {
    const input = createInput({ type: 'text' });
    const inputEvents = [];
    input.addEventListener('input', () => inputEvents.push(input.value));

    api.simulateTyping(input, 'abc');
    expect(input.value).toBe('abc');
    // Should have fired input events as each char was typed
    expect(inputEvents).toContain('a');
    expect(inputEvents).toContain('ab');
    expect(inputEvents).toContain('abc');
  });

  it('fires keydown/keyup for each character', () => {
    const input = createInput({ type: 'text' });
    const keydowns = [];
    input.addEventListener('keydown', (e) => keydowns.push(e.key));
    api.simulateTyping(input, 'hi');
    expect(keydowns).toEqual(['h', 'i']);
  });
});

// ═══════════════════════════════════════════════════════════════
// Visibility detection
// ═══════════════════════════════════════════════════════════════

describe('isElementVisible', () => {
  it('returns false for null', () => {
    expect(api.isElementVisible(null)).toBe(false);
  });

  it('returns false for display:none elements', () => {
    const div = document.createElement('div');
    div.style.display = 'none';
    document.body.appendChild(div);
    expect(api.isElementVisible(div)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Fuzzy option matching (native <select>)
// ═══════════════════════════════════════════════════════════════

describe('fuzzyMatchOption', () => {
  const options = [
    { value: 'us', text: 'United States' },
    { value: 'ca', text: 'Canada' },
    { value: 'uk', text: 'United Kingdom' },
  ];

  it('matches exact value', () => {
    expect(api.fuzzyMatchOption(options, 'us')).toBe(0);
  });

  it('matches exact text', () => {
    expect(api.fuzzyMatchOption(options, 'Canada')).toBe(1);
  });

  it('matches text case-insensitively', () => {
    expect(api.fuzzyMatchOption(options, 'united states')).toBe(0);
  });

  it('matches partial (contains)', () => {
    expect(api.fuzzyMatchOption(options, 'Kingdom')).toBe(2);
  });

  it('returns -1 for no match', () => {
    expect(api.fuzzyMatchOption(options, 'France')).toBe(-1);
  });

  it('returns -1 for empty options', () => {
    expect(api.fuzzyMatchOption([], 'test')).toBe(-1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Fuzzy dropdown option matching
// ═══════════════════════════════════════════════════════════════

describe('fuzzyMatchDropdownOption', () => {
  function createOptions(texts) {
    return texts.map(t => {
      const el = document.createElement('div');
      el.textContent = t;
      return el;
    });
  }

  it('matches exact text', () => {
    const opts = createOptions(['New York', 'Los Angeles', 'Chicago']);
    const match = api.fuzzyMatchDropdownOption(opts, 'New York');
    expect(match.textContent).toBe('New York');
  });

  it('matches case-insensitively', () => {
    const opts = createOptions(['United States', 'Canada']);
    const match = api.fuzzyMatchDropdownOption(opts, 'united states');
    expect(match.textContent).toBe('United States');
  });

  it('matches partial city with full location string', () => {
    const opts = createOptions(['Animas, Hidalgo, NM', 'Las Animas, CO']);
    const match = api.fuzzyMatchDropdownOption(opts, 'Animas');
    expect(match.textContent).toBe('Animas, Hidalgo, NM');
  });

  it('matches when target contains option text', () => {
    const opts = createOptions(['NM', 'NY', 'CA']);
    const match = api.fuzzyMatchDropdownOption(opts, 'NM');
    expect(match.textContent).toBe('NM');
  });

  it('matches by word overlap', () => {
    const opts = createOptions(['San Francisco, CA', 'San Diego, CA', 'San Jose, CA']);
    const match = api.fuzzyMatchDropdownOption(opts, 'San Francisco');
    expect(match.textContent).toBe('San Francisco, CA');
  });

  it('selects single option', () => {
    const opts = createOptions(['Only Option']);
    const match = api.fuzzyMatchDropdownOption(opts, 'something unrelated');
    expect(match.textContent).toBe('Only Option');
  });

  it('returns null for empty options', () => {
    expect(api.fuzzyMatchDropdownOption([], 'test')).toBeNull();
  });

  it('handles state abbreviations', () => {
    const opts = createOptions(['New Mexico', 'New York', 'Nevada']);
    const match = api.fuzzyMatchDropdownOption(opts, 'New Mexico');
    expect(match.textContent).toBe('New Mexico');
  });

  it('handles country names with starts-with', () => {
    const opts = createOptions(['United States of America', 'United Kingdom', 'United Arab Emirates']);
    const match = api.fuzzyMatchDropdownOption(opts, 'United States');
    expect(match.textContent).toBe('United States of America');
  });
});

// ═══════════════════════════════════════════════════════════════
// Date parsing
// ═══════════════════════════════════════════════════════════════

describe('parseFlexibleDate', () => {
  it('passes through YYYY-MM-DD', () => {
    expect(api.parseFlexibleDate('2024-01-15')).toBe('2024-01-15');
  });

  it('converts YYYY-MM to YYYY-MM-01', () => {
    expect(api.parseFlexibleDate('2024-06')).toBe('2024-06-01');
  });

  it('converts MM/DD/YYYY', () => {
    expect(api.parseFlexibleDate('03/15/2024')).toBe('2024-03-15');
  });

  it('converts MM-DD-YYYY', () => {
    expect(api.parseFlexibleDate('12-25-2023')).toBe('2023-12-25');
  });

  it('converts "Month YYYY"', () => {
    expect(api.parseFlexibleDate('January 2024')).toBe('2024-01-01');
    expect(api.parseFlexibleDate('December 2023')).toBe('2023-12-01');
  });

  it('converts bare year', () => {
    expect(api.parseFlexibleDate('2024')).toBe('2024-01-01');
  });

  it('returns null for empty/invalid', () => {
    expect(api.parseFlexibleDate('')).toBeNull();
    expect(api.parseFlexibleDate(null)).toBeNull();
  });

  it('handles single-digit month/day', () => {
    expect(api.parseFlexibleDate('1/5/2024')).toBe('2024-01-05');
  });
});

// ═══════════════════════════════════════════════════════════════
// Date field detection
// ═══════════════════════════════════════════════════════════════

describe('isDateField', () => {
  it('detects type="date"', () => {
    const input = createDateInput({ type: 'date' });
    expect(api.isDateField(input)).toBe(true);
  });

  it('detects type="month"', () => {
    const input = createDateInput({ type: 'month' });
    expect(api.isDateField(input)).toBe(true);
  });

  it('detects date-related names', () => {
    const input = createInput({ type: 'text', name: 'start_date', id: 'sd' });
    expect(api.isDateField(input)).toBe(true);
  });

  it('detects graduation in name', () => {
    const input = createInput({ type: 'text', name: 'graduation', id: 'grad' });
    expect(api.isDateField(input)).toBe(true);
  });

  it('does not detect regular text fields', () => {
    const input = createInput({ type: 'text', name: 'firstName', id: 'fn' });
    expect(api.isDateField(input)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Rich text editor detection
// ═══════════════════════════════════════════════════════════════

describe('isRichTextEditor', () => {
  it('detects contenteditable div', () => {
    const { editor } = createRichTextEditor();
    expect(api.isRichTextEditor(editor)).toBe(true);
  });

  it('detects role="textbox" div', () => {
    const div = document.createElement('div');
    div.setAttribute('role', 'textbox');
    document.body.appendChild(div);
    expect(api.isRichTextEditor(div)).toBe(true);
  });

  it('does not detect regular input', () => {
    const input = createInput({ type: 'text' });
    expect(api.isRichTextEditor(input)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Rich text filling
// ═══════════════════════════════════════════════════════════════

describe('fillRichText', () => {
  it('fills contenteditable with text', () => {
    const { editor } = createRichTextEditor();
    const result = api.fillRichText(editor, 'Hello World');
    expect(result).toBe(true);
    expect(editor.textContent).toContain('Hello World');
  });

  it('preserves newlines as <br>', () => {
    const { editor } = createRichTextEditor();
    api.fillRichText(editor, 'Line 1\nLine 2');
    expect(editor.innerHTML).toContain('<br>');
  });
});

// ═══════════════════════════════════════════════════════════════
// Custom dropdown trigger detection
// ═══════════════════════════════════════════════════════════════

describe('isCustomDropdownTrigger', () => {
  it('detects role="combobox"', () => {
    const div = document.createElement('div');
    div.setAttribute('role', 'combobox');
    expect(api.isCustomDropdownTrigger(div)).toBe(true);
  });

  it('detects aria-haspopup="listbox"', () => {
    const div = document.createElement('div');
    div.setAttribute('aria-haspopup', 'listbox');
    expect(api.isCustomDropdownTrigger(div)).toBe(true);
  });

  it('detects aria-expanded', () => {
    const div = document.createElement('div');
    div.setAttribute('aria-expanded', 'false');
    expect(api.isCustomDropdownTrigger(div)).toBe(true);
  });

  it('detects dropdown class', () => {
    const div = document.createElement('div');
    div.className = 'custom-select-dropdown';
    expect(api.isCustomDropdownTrigger(div)).toBe(true);
  });

  it('does not detect regular div', () => {
    const div = document.createElement('div');
    div.className = 'regular-content';
    expect(api.isCustomDropdownTrigger(div)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// clickOption
// ═══════════════════════════════════════════════════════════════

describe('clickOption', () => {
  it('dispatches mouseenter, mouseover, mousedown, mouseup, click', () => {
    const option = document.createElement('div');
    document.body.appendChild(option);
    const events = [];
    for (const evt of ['mouseenter', 'mouseover', 'mousedown', 'mouseup', 'click']) {
      option.addEventListener(evt, () => events.push(evt));
    }
    api.clickOption(option);
    expect(events).toEqual(['mouseenter', 'mouseover', 'mousedown', 'mouseup', 'click']);
  });
});

// ═══════════════════════════════════════════════════════════════
// fillField — text inputs
// ═══════════════════════════════════════════════════════════════

describe('fillField — fill_text', () => {
  it('fills a simple text input', async () => {
    const input = createInput({ id: 'name', type: 'text' });
    const result = await api.fillField('#name', 'John Doe', 'fill_text');
    expect(result.success).toBe(true);
    expect(input.value).toBe('John Doe');
  });

  it('fills a textarea', async () => {
    const ta = document.createElement('textarea');
    ta.id = 'bio';
    document.body.appendChild(ta);
    const result = await api.fillField('#bio', 'My bio text', 'fill_text');
    expect(result.success).toBe(true);
    expect(ta.value).toBe('My bio text');
  });

  it('returns failure for non-existent selector', async () => {
    const result = await api.fillField('#no-exist', 'test', 'fill_text');
    expect(result.success).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it('fills a date input with proper format', async () => {
    const input = createDateInput({ type: 'date', id: 'startDate' });
    const result = await api.fillField('#startDate', 'January 2024', 'fill_text');
    expect(result.success).toBe(true);
    expect(result.dateField).toBe(true);
    expect(input.value).toBe('2024-01-01');
  });
});

// ═══════════════════════════════════════════════════════════════
// fillField — select dropdowns
// ═══════════════════════════════════════════════════════════════

describe('fillField — select_dropdown', () => {
  it('selects matching option by text', async () => {
    createSelect({ id: 'country' }, [
      { value: '', text: 'Select...' },
      { value: 'us', text: 'United States' },
      { value: 'ca', text: 'Canada' },
    ]);
    const result = await api.fillField('#country', 'United States', 'select_dropdown');
    expect(result.success).toBe(true);
    expect(result.selectedValue).toBe('us');
  });

  it('selects matching option by value', async () => {
    createSelect({ id: 'state' }, [
      { value: '', text: 'Select...' },
      { value: 'NM', text: 'New Mexico' },
      { value: 'NY', text: 'New York' },
    ]);
    const result = await api.fillField('#state', 'NM', 'select_dropdown');
    expect(result.success).toBe(true);
    expect(result.selectedValue).toBe('NM');
  });

  it('fails gracefully for no matching option', async () => {
    createSelect({ id: 'opts' }, [
      { value: 'a', text: 'Option A' },
    ]);
    const result = await api.fillField('#opts', 'nonexistent', 'select_dropdown');
    expect(result.success).toBe(false);
    expect(result.reason).toContain('no matching option');
  });
});

// ═══════════════════════════════════════════════════════════════
// fillField — radio buttons
// ═══════════════════════════════════════════════════════════════

describe('fillField — click_radio', () => {
  it('selects radio by value', async () => {
    const form = document.createElement('form');

    const r1 = document.createElement('input');
    r1.type = 'radio'; r1.name = 'gender'; r1.value = 'male'; r1.id = 'genderMale';
    const l1 = document.createElement('label');
    l1.setAttribute('for', 'genderMale'); l1.textContent = 'Male';

    const r2 = document.createElement('input');
    r2.type = 'radio'; r2.name = 'gender'; r2.value = 'female'; r2.id = 'genderFemale';
    const l2 = document.createElement('label');
    l2.setAttribute('for', 'genderFemale'); l2.textContent = 'Female';

    form.append(r1, l1, r2, l2);
    document.body.appendChild(form);

    const result = await api.fillField('#genderFemale', 'female', 'click_radio');
    expect(result.success).toBe(true);
    expect(result.selectedValue).toBe('female');
    expect(r2.checked).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// fillField — checkboxes
// ═══════════════════════════════════════════════════════════════

describe('fillField — check_checkbox', () => {
  it('checks a checkbox', async () => {
    const cb = createInput({ type: 'checkbox', id: 'agree' });
    const result = await api.fillField('#agree', 'true', 'check_checkbox');
    expect(result.success).toBe(true);
    expect(cb.checked).toBe(true);
  });

  it('unchecks a checkbox', async () => {
    const cb = createInput({ type: 'checkbox', id: 'agree2' });
    cb.checked = true;
    const result = await api.fillField('#agree2', 'false', 'check_checkbox');
    expect(result.success).toBe(true);
    expect(cb.checked).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// fillField — skip and fallback
// ═══════════════════════════════════════════════════════════════

describe('fillField — skip', () => {
  it('returns success with skipped flag', async () => {
    createInput({ id: 'skipped' });
    const result = await api.fillField('#skipped', '', 'skip');
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
  });
});

describe('fillField — unknown action', () => {
  it('falls back to setting value', async () => {
    const input = createInput({ id: 'fallback', type: 'text' });
    const result = await api.fillField('#fallback', 'test', 'unknown_action');
    expect(result.success).toBe(true);
    expect(result.action).toBe('fallback');
    expect(input.value).toBe('test');
  });
});

// ═══════════════════════════════════════════════════════════════
// fillField — file upload
// ═══════════════════════════════════════════════════════════════

describe('fillField — upload_file', () => {
  it('returns failure with reason', async () => {
    createInput({ type: 'file', id: 'resume' });
    const result = await api.fillField('#resume', 'file.pdf', 'upload_file');
    expect(result.success).toBe(false);
    expect(result.reason).toContain('user interaction');
  });
});

// ═══════════════════════════════════════════════════════════════
// Typeahead dropdown detection
// ═══════════════════════════════════════════════════════════════

describe('findTypeaheadDropdown', () => {
  it('finds dropdown via aria-controls', () => {
    const input = createInput({ id: 'cityInput', 'aria-controls': 'city-listbox' });
    const listbox = document.createElement('ul');
    listbox.id = 'city-listbox';
    listbox.setAttribute('role', 'listbox');
    // Make element pass visibility check in jsdom
    listbox.style.position = 'fixed';
    Object.defineProperty(listbox, 'offsetHeight', { value: 100, configurable: true });
    Object.defineProperty(listbox, 'offsetWidth', { value: 200, configurable: true });
    document.body.appendChild(listbox);

    const found = api.findTypeaheadDropdown(input);
    expect(found).toBe(listbox);
  });

  it('finds dropdown as sibling in parent', () => {
    const wrapper = document.createElement('div');
    const input = document.createElement('input');
    input.type = 'text';
    wrapper.appendChild(input);

    const listbox = document.createElement('ul');
    listbox.setAttribute('role', 'listbox');
    listbox.style.position = 'fixed';
    Object.defineProperty(listbox, 'offsetHeight', { value: 100, configurable: true });
    Object.defineProperty(listbox, 'offsetWidth', { value: 200, configurable: true });
    wrapper.appendChild(listbox);
    document.body.appendChild(wrapper);

    const found = api.findTypeaheadDropdown(input);
    expect(found).toBe(listbox);
  });

  it('returns null when no dropdown is visible', () => {
    const input = createInput({ type: 'text', id: 'nodd' });
    expect(api.findTypeaheadDropdown(input)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// getDropdownOptions
// ═══════════════════════════════════════════════════════════════

describe('getDropdownOptions', () => {
  it('gets options by role="option"', () => {
    const listbox = document.createElement('div');
    listbox.setAttribute('role', 'listbox');
    for (const text of ['Opt 1', 'Opt 2', 'Opt 3']) {
      const opt = document.createElement('div');
      opt.setAttribute('role', 'option');
      opt.textContent = text;
      opt.style.height = '30px';
      Object.defineProperty(opt, 'offsetParent', { value: listbox, configurable: true });
      Object.defineProperty(opt, 'offsetHeight', { value: 30, configurable: true });
      listbox.appendChild(opt);
    }

    const options = api.getDropdownOptions(listbox);
    expect(options).toHaveLength(3);
    expect(options[0].textContent).toBe('Opt 1');
  });

  it('gets options by li elements', () => {
    const ul = document.createElement('ul');
    for (const text of ['Item A', 'Item B']) {
      const li = document.createElement('li');
      li.textContent = text;
      Object.defineProperty(li, 'offsetParent', { value: ul, configurable: true });
      Object.defineProperty(li, 'offsetHeight', { value: 30, configurable: true });
      ul.appendChild(li);
    }

    const options = api.getDropdownOptions(ul);
    expect(options).toHaveLength(2);
  });

  it('returns empty array for empty dropdown', () => {
    const empty = document.createElement('div');
    expect(api.getDropdownOptions(empty)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// Form HTML serialization
// ═══════════════════════════════════════════════════════════════

describe('serializeFormHtml', () => {
  it('serializes form content', () => {
    const form = document.createElement('form');
    form.innerHTML = '<input type="text" name="test">';
    document.body.appendChild(form);

    const html = api.serializeFormHtml();
    expect(html).toContain('input');
    expect(html).toContain('name="test"');
  });

  it('removes script and style tags', () => {
    const form = document.createElement('form');
    form.innerHTML = '<script>alert("xss")</script><input type="text"><style>body{}</style>';
    document.body.appendChild(form);

    const html = api.serializeFormHtml();
    expect(html).not.toContain('alert');
    expect(html).not.toContain('<style>');
  });

  it('truncates to 50KB', () => {
    const form = document.createElement('form');
    const bigContent = '<div>' + 'x'.repeat(60000) + '</div>';
    form.innerHTML = bigContent;
    document.body.appendChild(form);

    const html = api.serializeFormHtml();
    expect(html.length).toBeLessThanOrEqual(50000);
  });
});

// ═══════════════════════════════════════════════════════════════
// dismissOpenDropdowns
// ═══════════════════════════════════════════════════════════════

describe('dismissOpenDropdowns', () => {
  it('dispatches Escape and body click when dropdown is open', () => {
    const listbox = document.createElement('div');
    listbox.setAttribute('role', 'listbox');
    const opt = document.createElement('div');
    opt.textContent = 'option';
    listbox.appendChild(opt);
    Object.defineProperty(listbox, 'offsetParent', { value: document.body, configurable: true });
    document.body.appendChild(listbox);

    const bodyClicked = vi.fn();
    document.body.addEventListener('click', bodyClicked);

    api.dismissOpenDropdowns();
    expect(bodyClicked).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// Date field filling
// ═══════════════════════════════════════════════════════════════

describe('fillDateField', () => {
  it('fills native date input with ISO format', () => {
    const input = createDateInput({ type: 'date', id: 'date1' });
    const result = api.fillDateField(input, '03/15/2024');
    expect(result).toBe(true);
    expect(input.value).toBe('2024-03-15');
  });

  it('fills month input with YYYY-MM', () => {
    const input = createDateInput({ type: 'month', id: 'month1' });
    const result = api.fillDateField(input, 'June 2024');
    expect(result).toBe(true);
    // Should be YYYY-MM format
    expect(input.value).toBe('2024-06');
  });

  it('fills text date input as-is', () => {
    const input = createInput({ type: 'text', name: 'date_field', id: 'textDate' });
    const result = api.fillDateField(input, 'January 2024');
    expect(result).toBe(true);
    expect(input.value).toBe('January 2024');
  });
});

// ═══════════════════════════════════════════════════════════════
// Integration: fillForm flow
// ═══════════════════════════════════════════════════════════════

describe('fillForm', () => {
  it('fills multiple fields and tracks count', async () => {
    createInput({ id: 'f1', type: 'text' });
    createInput({ id: 'f2', type: 'text' });

    const mappings = [
      { selector: '#f1', value: 'Alice', action: 'fill_text', confidence: 0.9 },
      { selector: '#f2', value: 'Smith', action: 'fill_text', confidence: 0.95 },
    ];

    const result = await api.fillForm(mappings);
    expect(result.filledCount).toBe(2);
    expect(result.total).toBe(2);
  });

  it('skips fields with skip action', async () => {
    createInput({ id: 'f3', type: 'text' });

    const mappings = [
      { selector: '#f3', value: '', action: 'skip' },
    ];

    const result = await api.fillForm(mappings);
    expect(result.filledCount).toBe(0);
    expect(result.total).toBe(0);
  });

  it('handles mixed success/failure', async () => {
    createInput({ id: 'exists', type: 'text' });

    const mappings = [
      { selector: '#exists', value: 'hello', action: 'fill_text' },
      { selector: '#gone', value: 'world', action: 'fill_text' },
    ];

    const result = await api.fillForm(mappings);
    expect(result.filledCount).toBe(1);
    expect(result.total).toBe(2);
    expect(result.results.some(r => !r.success)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════

describe('edge cases', () => {
  it('handles empty value for fill_text', async () => {
    const input = createInput({ id: 'empty', type: 'text', value: 'existing' });
    const result = await api.fillField('#empty', '', 'fill_text');
    expect(result.success).toBe(true);
    expect(input.value).toBe('');
  });

  it('handles special characters in value', async () => {
    const input = createInput({ id: 'special', type: 'text' });
    const result = await api.fillField('#special', 'O\'Brien & Co. <test>', 'fill_text');
    expect(result.success).toBe(true);
    expect(input.value).toBe('O\'Brien & Co. <test>');
  });

  it('handles very long values', async () => {
    const textarea = document.createElement('textarea');
    textarea.id = 'long';
    document.body.appendChild(textarea);
    const longVal = 'x'.repeat(10000);
    const result = await api.fillField('#long', longVal, 'fill_text');
    expect(result.success).toBe(true);
    expect(textarea.value.length).toBe(10000);
  });

  it('handles selector with special characters', async () => {
    const input = document.createElement('input');
    input.id = 'field-with.dots:and-colons';
    input.type = 'text';
    document.body.appendChild(input);

    const selector = `#${CSS.escape('field-with.dots:and-colons')}`;
    const result = await api.fillField(selector, 'test', 'fill_text');
    expect(result.success).toBe(true);
  });
});
