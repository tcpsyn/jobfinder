(() => {
  'use strict';

  // Guard against multiple injections
  if (window.__cpAtsAdapters) return;

  // ─── Helper: safe iframe contentDocument access ──────────────

  function getIframeDoc(iframe) {
    try {
      return iframe.contentDocument || iframe.contentWindow?.document;
    } catch {
      // Cross-origin — blocked by same-origin policy
      return null;
    }
  }

  // ─── Workday Adapter ──────────────────────────────────────────

  const workday = {
    name: 'Workday',

    match(url, doc) {
      if (/myworkdayjobs\.com/i.test(url)) return true;
      try {
        return doc.querySelector('[data-automation-id]') !== null;
      } catch {
        return false;
      }
    },

    getFormRoot(doc) {
      return doc;
    },

    getFieldMap() {
      return {
        '[data-automation-id="legalNameSection_firstName"]': 'first_name',
        '[data-automation-id="legalNameSection_lastName"]': 'last_name',
        '[data-automation-id="addressSection_addressLine1"]': 'address_line_1',
        '[data-automation-id="addressSection_city"]': 'city',
        '[data-automation-id="addressSection_countryRegion"]': 'country',
        '[data-automation-id="addressSection_stateProvince"]': 'state',
        '[data-automation-id="addressSection_postalCode"]': 'postal_code',
        '[data-automation-id="phone-number"]': 'phone',
        '[data-automation-id="email"]': 'email',
        '[data-automation-id="linkedinQuestion"]': 'linkedin_url',
        '[data-automation-id="websiteQuestion"]': 'website',
      };
    },

    getNextButton(doc) {
      try {
        return doc.querySelector('[data-automation-id="bottom-navigation-next-button"]');
      } catch {
        return null;
      }
    },

    enhanceExtraction(fields) {
      // Map data-automation-id attributes to more descriptive labels
      for (const field of fields) {
        if (!field.label && field.selector) {
          try {
            const el = document.querySelector(field.selector);
            if (el) {
              const autoId = el.getAttribute('data-automation-id');
              if (autoId) {
                field.atsHint = autoId;
                field.label = field.label || autoId.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim();
              }
            }
          } catch { /* skip */ }
        }
      }
      return fields;
    },

    getDropdownHandler() {
      // Workday uses custom search-based dropdowns with data-automation-id
      return {
        detect(el) {
          try {
            const autoId = el.getAttribute('data-automation-id');
            return autoId && (el.getAttribute('role') === 'combobox' || el.closest('[data-automation-id*="Dropdown"]'));
          } catch {
            return false;
          }
        },
        async fill(el, value) {
          // Workday dropdowns: click to open, type to search, select from results
          el.click();
          await new Promise(r => setTimeout(r, 300));
          const input = el.querySelector('input') || el;
          if (input.tagName === 'INPUT') {
            input.focus();
            input.value = '';
            input.dispatchEvent(new InputEvent('input', { bubbles: true }));
            for (const char of value) {
              input.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
              input.value += char;
              input.dispatchEvent(new InputEvent('input', { bubbles: true }));
            }
            await new Promise(r => setTimeout(r, 500));
          }
          return null; // Let the generic dropdown handler pick up from here
        },
      };
    },
  };

  // ─── Greenhouse Adapter ───────────────────────────────────────

  const greenhouse = {
    name: 'Greenhouse',

    match(url, doc) {
      if (/boards\.greenhouse\.io/i.test(url)) return true;
      try {
        return doc.querySelector('#app_form') !== null
          || doc.querySelector('#application_form') !== null;
      } catch {
        return false;
      }
    },

    getFormRoot(doc) {
      try {
        return doc.querySelector('#app_form')
          || doc.querySelector('#application_form')
          || doc;
      } catch {
        return doc;
      }
    },

    getFieldMap() {
      return {
        '#first_name': 'first_name',
        '#last_name': 'last_name',
        '#email': 'email',
        '#phone': 'phone',
        '#job_application_location': 'location',
        '#job_application_answers_attributes_0_text_value': 'linkedin_url',
        '#resume_text': 'resume',
        '#cover_letter_text': 'cover_letter',
        'input[name="job_application[first_name]"]': 'first_name',
        'input[name="job_application[last_name]"]': 'last_name',
        'input[name="job_application[email]"]': 'email',
        'input[name="job_application[phone]"]': 'phone',
      };
    },

    getNextButton(_doc) {
      // Greenhouse typically uses single-page forms, no next button
      return null;
    },

    enhanceExtraction(fields) {
      // Greenhouse uses #resume_text for resume upload detection
      for (const field of fields) {
        if (field.id === 'resume' || field.id === 'resume_text'
            || (field.name && field.name.includes('resume'))) {
          field.atsHint = 'resume_upload';
        }
        if (field.id === 'cover_letter' || field.id === 'cover_letter_text'
            || (field.name && field.name.includes('cover_letter'))) {
          field.atsHint = 'cover_letter';
        }
      }
      return fields;
    },

    getDropdownHandler() {
      return null; // Greenhouse uses standard HTML selects
    },
  };

  // ─── Lever Adapter ────────────────────────────────────────────

  const lever = {
    name: 'Lever',

    match(url, _doc) {
      return /jobs\.lever\.co/i.test(url);
    },

    getFormRoot(doc) {
      try {
        return doc.querySelector('.application-form')
          || doc.querySelector('[class*="application"]')
          || doc;
      } catch {
        return doc;
      }
    },

    getFieldMap() {
      return {
        'input[name="name"]': 'full_name',
        'input[name="email"]': 'email',
        'input[name="phone"]': 'phone',
        'input[name="org"]': 'current_company',
        'input[name="urls[LinkedIn]"]': 'linkedin_url',
        'input[name="urls[GitHub]"]': 'github_url',
        'input[name="urls[Portfolio]"]': 'website',
        'input[name="urls[Twitter]"]': 'twitter_url',
        'input[name="urls[Other]"]': 'website',
        'textarea[name="comments"]': 'additional_info',
        'input[name="resume"]': 'resume',
      };
    },

    getNextButton(_doc) {
      // Lever uses single-page forms
      return null;
    },

    enhanceExtraction(fields) {
      // Lever has a "Custom Questions" section that uses dynamic field names
      for (const field of fields) {
        if (field.name && field.name.startsWith('cards[')) {
          field.atsHint = 'lever_custom_question';
        }
      }
      return fields;
    },

    getDropdownHandler() {
      return null; // Lever uses standard HTML elements
    },
  };

  // ─── iCIMS Adapter ────────────────────────────────────────────

  const icims = {
    name: 'iCIMS',

    match(url, doc) {
      if (/icims\.com/i.test(url)) return true;
      try {
        return doc.querySelector('#iCIMS_MainWrapper') !== null;
      } catch {
        return false;
      }
    },

    getFormRoot(doc) {
      // iCIMS uses heavy iframes — try to resolve the content iframe
      try {
        const wrapper = doc.querySelector('#iCIMS_MainWrapper');
        if (wrapper) {
          const iframe = wrapper.querySelector('iframe');
          if (iframe) {
            const iDoc = getIframeDoc(iframe);
            if (iDoc) return iDoc;
          }
        }
        // Also check for the common iCIMS content iframe directly
        const contentFrame = doc.querySelector('iframe[id*="icims"], iframe[name*="icims"], iframe[src*="icims"]');
        if (contentFrame) {
          const iDoc = getIframeDoc(contentFrame);
          if (iDoc) return iDoc;
        }
      } catch { /* skip */ }
      return doc;
    },

    getFieldMap() {
      return {
        '#firstName': 'first_name',
        '#lastName': 'last_name',
        '#email': 'email',
        '#phone': 'phone',
        '#addressStreet1': 'address_line_1',
        '#addressCity': 'city',
        '#addressState': 'state',
        '#addressZip': 'postal_code',
      };
    },

    getNextButton(doc) {
      try {
        // iCIMS typically has a "Continue" or "Next" button
        const formRoot = this.getFormRoot(doc);
        return formRoot.querySelector('input[type="submit"][value*="Next"], input[type="submit"][value*="Continue"], button[type="submit"]');
      } catch {
        return null;
      }
    },

    enhanceExtraction(fields) {
      return fields;
    },

    getDropdownHandler() {
      return null; // iCIMS mostly uses standard HTML form elements
    },
  };

  // ─── Taleo Adapter ────────────────────────────────────────────

  const taleo = {
    name: 'Taleo',

    match(url, doc) {
      if (/taleo\.net/i.test(url)) return true;
      try {
        return doc.querySelector('.taleo') !== null
          || doc.querySelector('[class*="taleo"]') !== null;
      } catch {
        return false;
      }
    },

    getFormRoot(doc) {
      // Taleo also uses iframes for multi-step wizards
      try {
        const contentFrame = doc.querySelector('iframe[id*="content"], iframe[name*="content"], iframe[src*="taleo"]');
        if (contentFrame) {
          const iDoc = getIframeDoc(contentFrame);
          if (iDoc) return iDoc;
        }
      } catch { /* skip */ }
      return doc;
    },

    getFieldMap() {
      return {
        '#FirstName': 'first_name',
        '#LastName': 'last_name',
        '#Email': 'email',
        '#Phone': 'phone',
        '#Address': 'address_line_1',
        '#City': 'city',
        '#State': 'state',
        '#ZipCode': 'postal_code',
      };
    },

    getNextButton(doc) {
      try {
        const formRoot = this.getFormRoot(doc);
        return formRoot.querySelector(
          '#next, #btnNext, input[value="Next"], button:not([type="button"])[class*="next"], '
          + 'a[class*="next"], [id*="btnNext"], [id*="nextBtn"]'
        );
      } catch {
        return null;
      }
    },

    enhanceExtraction(fields) {
      return fields;
    },

    getDropdownHandler() {
      // Taleo uses custom dropdown elements (not native selects)
      return {
        detect(el) {
          try {
            const className = (el.className || '').toString().toLowerCase();
            return className.includes('taleo') && (
              el.getAttribute('role') === 'listbox'
              || el.getAttribute('role') === 'combobox'
              || className.includes('dropdown')
            );
          } catch {
            return false;
          }
        },
        async fill(el, value) {
          // Taleo dropdowns: click to expand, then find the matching option
          el.click();
          await new Promise(r => setTimeout(r, 300));
          return null; // Let generic dropdown handler finish
        },
      };
    },
  };

  // ─── Google Forms Adapter ────────────────────────────────────

  const googleForms = {
    name: 'Google Forms',

    match(url) {
      return /docs\.google\.com\/forms/i.test(url);
    },

    getFormRoot(doc) {
      return doc.querySelector('[role="form"]') || doc.querySelector('form') || doc;
    },

    getFieldMap() {
      return {}; // Google Forms uses dynamic IDs, rely on label extraction
    },

    enhanceExtraction(fields) {
      // Google Forms checkboxes use <div role="checkbox"> or <div role="option">
      // which aren't picked up by standard extractFormData
      return fields;
    },

    getExtraFields(doc) {
      // Extract Google Forms question blocks that standard extraction might miss
      const fields = [];
      const questionBlocks = doc.querySelectorAll('[data-params], .freebirdFormviewerComponentsQuestionBaseRoot');

      for (const block of questionBlocks) {
        const heading = block.querySelector('[role="heading"], .freebirdFormviewerComponentsQuestionBaseTitle');
        if (!heading) continue;
        const label = heading.textContent.trim();
        const required = block.querySelector('[aria-label*="Required"]') !== null
          || block.textContent.includes('*');

        // Text inputs
        const textInput = block.querySelector('input[type="text"], input[type="email"], textarea');
        if (textInput) {
          const selector = buildSelectorForEl(textInput);
          if (selector) {
            fields.push({
              selector,
              tag: textInput.tagName.toLowerCase(),
              type: textInput.type || 'text',
              name: textInput.name || null,
              id: textInput.id || null,
              placeholder: textInput.placeholder || null,
              label,
              nearbyHeading: label,
              required,
              currentValue: textInput.value || '',
              role: textInput.getAttribute('role') || null,
            });
          }
          continue;
        }

        // Checkbox groups — Google Forms uses <div role="list"> with <div role="listitem">
        const checkboxes = block.querySelectorAll('[role="checkbox"], input[type="checkbox"]');
        if (checkboxes.length > 0) {
          const options = Array.from(checkboxes).map(cb => {
            const optLabel = cb.getAttribute('aria-label')
              || cb.closest('[role="listitem"]')?.textContent?.trim()
              || cb.parentElement?.textContent?.trim()
              || cb.value || '';
            return {
              value: cb.getAttribute('data-answer-value') || optLabel,
              label: optLabel,
              checked: cb.getAttribute('aria-checked') === 'true' || cb.checked,
            };
          });

          // Use the first checkbox as the selector anchor
          const first = checkboxes[0];
          const isNativeInput = first.tagName === 'INPUT';
          const selector = isNativeInput
            ? buildSelectorForEl(first)
            : buildSelectorForEl(first);

          if (selector) {
            fields.push({
              selector,
              tag: first.tagName.toLowerCase(),
              type: 'checkbox',
              name: first.getAttribute('name') || null,
              id: first.id || null,
              placeholder: null,
              label,
              nearbyHeading: label,
              required,
              currentValue: '',
              role: first.getAttribute('role') || null,
              options,
            });
          }
          continue;
        }

        // Radio groups
        const radios = block.querySelectorAll('[role="radio"], input[type="radio"]');
        if (radios.length > 0) {
          const options = Array.from(radios).map(rb => {
            const optLabel = rb.getAttribute('aria-label')
              || rb.closest('[role="listitem"]')?.textContent?.trim()
              || rb.parentElement?.textContent?.trim()
              || rb.value || '';
            return {
              value: rb.getAttribute('data-answer-value') || optLabel,
              label: optLabel,
              checked: rb.getAttribute('aria-checked') === 'true' || rb.checked,
            };
          });

          const first = radios[0];
          const selector = buildSelectorForEl(first);
          if (selector) {
            fields.push({
              selector,
              tag: first.tagName.toLowerCase(),
              type: 'radio',
              name: first.getAttribute('name') || null,
              id: first.id || null,
              placeholder: null,
              label,
              nearbyHeading: label,
              required,
              currentValue: '',
              role: first.getAttribute('role') || null,
              options,
            });
          }
          continue;
        }

        // Dropdowns — Google Forms uses <div role="listbox">
        const dropdown = block.querySelector('[role="listbox"], select');
        if (dropdown) {
          const selector = buildSelectorForEl(dropdown);
          const options = dropdown.tagName === 'SELECT'
            ? Array.from(dropdown.options).map(o => ({ value: o.value, text: o.textContent.trim() }))
            : Array.from(dropdown.querySelectorAll('[role="option"]')).map(o => ({
                value: o.getAttribute('data-value') || o.textContent.trim(),
                text: o.textContent.trim(),
              }));
          if (selector) {
            fields.push({
              selector,
              tag: dropdown.tagName.toLowerCase(),
              type: 'select',
              name: null,
              id: dropdown.id || null,
              placeholder: null,
              label,
              nearbyHeading: label,
              required,
              currentValue: '',
              role: dropdown.getAttribute('role') || null,
              options,
            });
          }
        }
      }

      return fields;
    },
  };

  // Helper to build a CSS selector for an element (simplified version)
  function buildSelectorForEl(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.name) return `[name="${CSS.escape(el.name)}"]`;
    // Build a path-based selector
    const tag = el.tagName.toLowerCase();
    const parent = el.parentElement;
    if (!parent) return null;
    const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
    if (siblings.length === 1) {
      const parentSel = buildSelectorForEl(parent);
      return parentSel ? `${parentSel} > ${tag}` : null;
    }
    const idx = siblings.indexOf(el) + 1;
    const parentSel = buildSelectorForEl(parent);
    return parentSel ? `${parentSel} > ${tag}:nth-of-type(${idx})` : null;
  }

  // ─── Registry ─────────────────────────────────────────────────

  const atsAdapters = [workday, greenhouse, lever, icims, taleo, googleForms];

  function detectATS(url, doc) {
    try {
      return atsAdapters.find(a => a.match(url, doc)) || null;
    } catch {
      return null;
    }
  }

  function listAdapters() {
    return atsAdapters.map(a => a.name);
  }

  // ─── Export ───────────────────────────────────────────────────

  window.__cpAtsAdapters = {
    detectATS,
    listAdapters,
    adapters: atsAdapters,
  };

})();
