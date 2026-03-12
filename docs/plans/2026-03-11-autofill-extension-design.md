# Autofill Browser Extension & Profile System Design

## Overview

Chrome extension that auto-fills job application forms on any ATS (Workday, Greenhouse, Lever, iCIMS, Taleo, custom) using AI to interpret form fields dynamically. Profile data lives in CareerPulse, extension is a thin client.

## Architecture

### Components

1. **Chrome Extension** — content script reads DOM, fills fields, learns new data
2. **CareerPulse API** — stores profile, analyzes forms via AI, serves files
3. **Structured Profile DB** — comprehensive profile data parsed from resume + user edits
4. **Settings UI** — tabbed interface for managing all profile and configuration data

### Extension Flow

1. User clicks extension button on application page
2. Extension sends form HTML to `POST /api/autofill/analyze`
3. AI maps profile data to form fields, returns `[{selector, value, action, confidence}]`
4. Extension fills iteratively (handles dynamic/conditional fields)
5. Highlights filled (green) and uncertain (yellow) fields for review
6. After user submits, extension scans for new data and prompts to save

### AI Analysis

- Receives sanitized form DOM + full profile data
- Uses configured AI backend (Ollama local or cloud)
- Returns field mappings with actions: fill_text, select_dropdown, click_radio, check_checkbox, upload_file, skip
- Handles country code formats, phone formats, date formats automatically

## Profile Data Model

### Personal Info (expanded user_profile table)
- first_name, middle_name, last_name, preferred_name
- email, phone (with country code), phone_type, additional_phone
- address_street1, address_street2, address_city, address_state, address_zip, address_country_code, address_country_name
- permanent_address (same fields, if different)
- date_of_birth, pronouns
- linkedin_url, github_url, portfolio_url, website_url
- drivers_license (yes/no), drivers_license_class, drivers_license_state

### Work Authorization
- country_of_citizenship
- authorized_to_work_us (yes/no)
- requires_sponsorship (yes/no)
- authorization_type (citizen, permanent_resident, h1b, opt, ead, tn, other)
- security_clearance (none, public_trust, secret, top_secret, ts_sci)
- clearance_status (active, inactive, expired)

### Work History (work_history table)
- company, job_title, location_city, location_state, location_country
- start_month, start_year, end_month, end_year, is_current
- description, salary_at_position

### Education (education table)
- school, degree_type (high_school, associates, bachelors, masters, mba, jd, md, phd, other)
- field_of_study, minor, start_month, start_year, grad_month, grad_year
- gpa, honors

### Certifications & Licenses (certifications table)
- name, issuing_org, cert_type (certification, license)
- license_number, state, date_obtained, expiration_date

### Skills (skills table)
- name, years_experience, proficiency

### Languages (languages table)
- language, proficiency (native, fluent, conversational, basic)

### References (references table)
- name, title, company, phone, email, relationship, years_known

### Military Service (military_service table)
- branch, rank, specialty, start_date, end_date

### Voluntary Self-ID (eeo_responses table)
- gender, race_ethnicity, disability_status, veteran_status, veteran_categories (JSON), sexual_orientation
- All default to "decline"

### Job Search Preferences (in search_config or new table)
- desired_salary_min, desired_salary_max, salary_period
- availability_date, notice_period
- willing_to_relocate
- how_heard_default, cover_letter_template
- background_check_consent

### Custom Q&A Bank (custom_qa table)
- question_pattern, category, answer, times_used, last_used

## Settings Tabs

### Tab 1: Profile
Personal info, work authorization, military, EEO self-ID

### Tab 2: Work History
Work experience, education, certs/licenses, skills, languages, references

### Tab 3: Job Search
Search terms, resume, salary, availability, cover letter template, custom Q&A bank

### Tab 4: AI & Integrations
AI backend, scraper API keys, extension settings

### Tab 5: Data Management
Clear data, reset, export/import profile, autofill history

## Extension Architecture

### Files
- manifest.json (Manifest V3)
- popup.html/js — connection status, activate button, settings link
- content.js — DOM reading, field filling, learning prompt
- background.js — service worker, API communication

### Permissions
- activeTab, scripting (to inject content script)
- Host permission for localhost:8001 (CareerPulse API)

### Content Script Behavior
1. Read all form elements, labels, placeholders, aria attributes
2. Serialize to clean HTML (strip scripts, styles, images)
3. Send to CareerPulse for AI analysis
4. Receive field mappings
5. Fill fields using appropriate DOM APIs (input events, change events, React-compatible)
6. Wait 500ms after each batch for dynamic fields
7. Re-analyze if new fields detected
8. Show overlay with progress and review state

### Learning Loop
After form submission detected:
1. Collect all form field values
2. Diff against what was auto-filled vs what user changed
3. Diff against stored profile data
4. Prompt: "Save N new answers?"
5. POST /api/profile/learn with new data

## New API Endpoints

- GET /api/profile/full — complete structured profile
- PUT /api/profile/full — update any profile section
- POST /api/profile/parse-resume — AI parse resume into structured data
- POST /api/profile/learn — save new data learned from form fill
- POST /api/autofill/analyze — analyze form HTML, return field mappings
- GET /api/autofill/history — list of past autofill sessions
- GET/POST /api/custom-qa — manage Q&A bank
