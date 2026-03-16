// === API Client ===
const api = {
    async request(method, path, body = null) {
        const opts = { method, headers: {} };
        if (body) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const res = await fetch(path, opts);
        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: res.statusText }));
            throw new Error(err.detail || `Request failed: ${res.status}`);
        }
        return res.json();
    },

    getJobs(params = {}) {
        const qs = new URLSearchParams();
        Object.entries(params).forEach(([k, v]) => {
            if (v !== null && v !== undefined && v !== '') qs.set(k, v);
        });
        return this.request('GET', `/api/jobs?${qs}`);
    },

    getJob(id) {
        return this.request('GET', `/api/jobs/${id}`);
    },

    getStats() {
        return this.request('GET', '/api/stats');
    },

    dismissJob(id) {
        return this.request('POST', `/api/jobs/${id}/dismiss`);
    },

    getNotifications(unread = false) {
        return this.request('GET', `/api/notifications?unread=${unread}`);
    },

    markNotificationRead(id) {
        return this.request('POST', `/api/notifications/${id}/read`);
    },

    markAllNotificationsRead() {
        return this.request('POST', '/api/notifications/read-all');
    },

    prepareApplication(id, resumeId = null) {
        const body = resumeId ? { resume_id: resumeId } : null;
        return this.request('POST', `/api/jobs/${id}/prepare`, body);
    },

    updateApplication(id, status, notes = '') {
        const qs = new URLSearchParams({ status, notes });
        return this.request('POST', `/api/jobs/${id}/application?${qs}`);
    },

    triggerScrape() {
        return this.request('POST', '/api/scrape');
    },

    draftEmail(id) {
        return this.request('POST', `/api/jobs/${id}/email`);
    },

    generateCoverLetter(id) {
        return this.request('POST', `/api/jobs/${id}/generate-cover-letter`);
    },

    addEvent(id, detail) {
        return this.request('POST', `/api/jobs/${id}/events`, { detail });
    },

    getSearchConfig() {
        return this.request('GET', '/api/search-config');
    },

    updateSearchTerms(terms) {
        return this.request('POST', '/api/search-config/terms', { search_terms: terms });
    },

    async uploadResume(file) {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch('/api/resume/upload', { method: 'POST', body: formData });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: res.statusText }));
            throw new Error(err.detail || `Upload failed: ${res.status}`);
        }
        return res.json();
    },

    getAISettings() {
        return this.request('GET', '/api/ai-settings');
    },

    updateAISettings(settings) {
        return this.request('POST', '/api/ai-settings', settings);
    },

    testAIConnection(settings) {
        return this.request('POST', '/api/ai-settings/test', settings);
    },

    getOllamaModels(baseUrl) {
        const qs = new URLSearchParams({ base_url: baseUrl || 'http://localhost:11434' });
        return this.request('GET', `/api/ai-settings/models?${qs}`);
    },
};

// === Utilities ===
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('toast-dismiss');
        toast.addEventListener('animationend', () => toast.remove());
    }, 3000);
}

async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        showToast('Copied to clipboard!', 'info');
    } catch {
        showToast('Failed to copy', 'error');
    }
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const now = new Date();
    const diff = now - d;
    const days = Math.floor(diff / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days}d ago`;
    if (days < 30) return `${Math.floor(days / 7)}w ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatSalary(min, max) {
    if (!min && !max) return null;
    const fmt = (n) => {
        if (n >= 1000) return `$${Math.round(n / 1000)}k`;
        return `$${n}`;
    };
    if (min && max) return `${fmt(min)} - ${fmt(max)}`;
    if (min) return `${fmt(min)}+`;
    return `Up to ${fmt(max)}`;
}

function getScoreClass(score) {
    if (score === null || score === undefined) return 'score-badge-none';
    if (score >= 80) return 'score-badge-green';
    if (score >= 60) return 'score-badge-amber';
    return 'score-badge-gray';
}

function escapeHtml(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

function isNew(createdAt) {
    const lastVisit = localStorage.getItem('jf_last_visit');
    if (!lastVisit) return false;
    return new Date(createdAt) > new Date(lastVisit);
}

function getFreshness(job) {
    const date = job.posted_date || job.created_at;
    if (!date) return null;
    const days = Math.floor((Date.now() - new Date(date)) / 86400000);
    if (days <= 1) return { label: "Fresh", class: "freshness-hot", days };
    if (days <= 3) return { label: "New", class: "freshness-new", days };
    if (days <= 7) return { label: `${days}d ago`, class: "freshness-recent", days };
    if (days <= 14) return { label: `${days}d ago`, class: "freshness-aging", days };
    if (days <= 30) return { label: `${days}d ago`, class: "freshness-old", days };
    return { label: "Stale", class: "freshness-stale", days };
}

// === State ===
let currentJobs = [];
let currentOffset = 0;
const PAGE_SIZE = 50;
let selectedJobIds = new Set();
let selectMode = false;

// === Router ===
function getRoute() {
    const hash = window.location.hash || '#/';
    if (hash.startsWith('#/job/')) {
        const id = hash.slice(6);
        return { view: 'detail', id: parseInt(id, 10) };
    }
    if (hash === '#/stats') return { view: 'stats' };
    if (hash === '#/pipeline') return { view: 'pipeline' };
    if (hash === '#/queue') return { view: 'queue' };
    if (hash === '#/network') return { view: 'network' };
    if (hash === '#/settings') return { view: 'settings' };
    if (hash === '#/calculator') return { view: 'calculator' };
    return { view: 'feed' };
}

function navigate(hash) {
    window.location.hash = hash;
}

function updateActiveNav() {
    const route = getRoute();
    document.querySelectorAll('.nav-link').forEach(link => {
        const r = link.dataset.route;
        link.classList.toggle('active',
            (r === 'feed' && route.view === 'feed') ||
            (r === 'stats' && route.view === 'stats') ||
            (r === 'pipeline' && route.view === 'pipeline') ||
            (r === 'queue' && route.view === 'queue') ||
            (r === 'network' && route.view === 'network') ||
            (r === 'calculator' && route.view === 'calculator') ||
            (r === 'settings' && route.view === 'settings')
        );
    });
}

async function handleRoute() {
    const route = getRoute();
    updateActiveNav();
    const app = document.getElementById('app');

    if (route.view === 'detail') {
        await renderJobDetail(app, route.id);
    } else if (route.view === 'stats') {
        await renderStats(app);
    } else if (route.view === 'pipeline') {
        await renderPipeline(app);
    } else if (route.view === 'queue') {
        await renderQueue(app);
    } else if (route.view === 'network') {
        await renderNetwork(app);
    } else if (route.view === 'settings') {
        await renderSettings(app);
    } else if (route.view === 'calculator') {
        await renderSalaryCalculator(app);
    } else {
        await renderFeed(app);
    }
}

// === Filter Persistence & Smart Views ===
const FILTER_IDS = ['filter-search', 'filter-score', 'filter-sort', 'filter-work-type', 'filter-employment', 'filter-location', 'filter-region', 'filter-posted-within', 'filter-clearance'];
const FILTER_STORAGE_KEY = 'careerpulse_filters';
const SMART_VIEWS_KEY = 'careerpulse_saved_views';

function getFilterState() {
    const state = {};
    FILTER_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) state[id] = el.value;
    });
    return state;
}

function applyFilterState(state) {
    FILTER_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el && state[id] !== undefined) el.value = state[id];
    });
}

function saveFilterState() {
    try { localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(getFilterState())); } catch {}
}

function loadSavedFilterState() {
    try {
        const raw = localStorage.getItem(FILTER_STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

let _cachedViews = null;

async function getSmartViews() {
    if (_cachedViews) return _cachedViews;
    try {
        const data = await api.request('GET', '/api/saved-views');
        _cachedViews = data.views || [];
        // Migrate localStorage views on first load
        try {
            const raw = localStorage.getItem(SMART_VIEWS_KEY);
            if (raw) {
                const localViews = JSON.parse(raw);
                if (localViews.length > 0) {
                    const existingNames = new Set(_cachedViews.map(v => v.name));
                    for (const lv of localViews) {
                        if (!existingNames.has(lv.name)) {
                            await api.request('POST', '/api/saved-views', { name: lv.name, filters: lv.filters });
                        }
                    }
                    localStorage.removeItem(SMART_VIEWS_KEY);
                    _cachedViews = null;
                    return getSmartViews();
                }
            }
        } catch {}
        return _cachedViews;
    } catch {
        return [];
    }
}

function invalidateViewsCache() {
    _cachedViews = null;
}

async function renderSmartViewChips(reloadFn) {
    const container = document.getElementById('smart-views');
    if (!container) return;
    const views = await getSmartViews();
    container.innerHTML = views.map(v => `
        <button class="smart-view-chip" data-view-id="${v.id}" title="Apply: ${escapeHtml(v.name)}">
            ${escapeHtml(v.name)}
            <span class="smart-view-delete" data-view-id="${v.id}">&times;</span>
        </button>
    `).join('');

    container.querySelectorAll('.smart-view-chip').forEach(chip => {
        chip.addEventListener('click', (e) => {
            if (e.target.classList.contains('smart-view-delete')) return;
            const viewId = parseInt(chip.dataset.viewId);
            const view = views.find(v => v.id === viewId);
            if (view) {
                applyFilterState(view.filters);
                saveFilterState();
                container.querySelectorAll('.smart-view-chip').forEach(c => c.classList.remove('smart-view-chip-active'));
                chip.classList.add('smart-view-chip-active');
                reloadFn();
            }
        });
    });

    container.querySelectorAll('.smart-view-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const viewId = parseInt(btn.dataset.viewId);
            try {
                await api.request('DELETE', `/api/saved-views/${viewId}`);
                invalidateViewsCache();
                renderSmartViewChips(reloadFn);
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    });
}

// === Feed View ===
async function renderFeed(container) {
    focusedJobIndex = -1;
    currentOffset = 0;
    container.innerHTML = `
        <div id="smart-views" class="smart-views-bar"></div>
        <div class="filter-bar">
            <input type="text" class="search-input" id="filter-search" placeholder="Search jobs...">
            <select class="filter-select" id="filter-score">
                <option value="">All scores</option>
                <option value="40">40+</option>
                <option value="60">60+</option>
                <option value="80">80+</option>
            </select>
            <select class="filter-select" id="filter-sort">
                <option value="score">Sort by score</option>
                <option value="date">Sort by date</option>
                <option value="freshest">Freshest</option>
            </select>
            <select class="filter-select" id="filter-work-type">
                <option value="">All work types</option>
                <option value="remote">Remote</option>
                <option value="onsite">On-site</option>
                <option value="hybrid">Hybrid</option>
            </select>
            <select class="filter-select" id="filter-employment">
                <option value="">All employment</option>
                <option value="fulltime">Full-time</option>
                <option value="contract">Contract</option>
                <option value="parttime">Part-time</option>
            </select>
            <input type="text" class="search-input" id="filter-location" placeholder="Location..." style="max-width:160px">
            <select class="filter-select" id="filter-region">
                <option value="">All regions</option>
                <option value="us">US</option>
                <option value="europe">Europe</option>
                <option value="uk">UK</option>
                <option value="canada">Canada</option>
                <option value="latam">Latin America</option>
                <option value="apac">Asia-Pacific</option>
            </select>
            <select class="filter-select" id="filter-posted-within">
                <option value="">Any date</option>
                <option value="24h">Last 24 hours</option>
                <option value="3d">Last 3 days</option>
                <option value="7d">Last 7 days</option>
                <option value="14d">Last 2 weeks</option>
                <option value="30d">Last 30 days</option>
            </select>
            <select class="filter-select" id="filter-clearance">
                <option value="">Any clearance</option>
                <option value="hide">Hide clearance/visa required</option>
                <option value="only">Only clearance/visa required</option>
            </select>
            <button class="btn btn-secondary btn-sm" id="save-view-btn" style="white-space:nowrap">Save View</button>
            <button class="btn btn-secondary btn-sm" id="create-alert-btn" style="white-space:nowrap">Create Alert</button>
            <button class="btn btn-secondary btn-sm" id="select-mode-btn" style="white-space:nowrap">Select</button>
        </div>
        <div id="batch-bar" style="display:none;position:sticky;top:0;z-index:50;background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:10px 16px;margin-bottom:12px;display:none;align-items:center;gap:12px;box-shadow:0 2px 8px rgba(0,0,0,0.15)">
            <span id="batch-count" style="font-weight:600;font-size:0.875rem">0 selected</span>
            <button class="btn btn-primary btn-sm" id="batch-compare-btn" style="display:none">Compare</button>
            <button class="btn btn-primary btn-sm" id="batch-prepare-btn">Prepare Selected</button>
            <button class="btn btn-secondary btn-sm" id="batch-dismiss-btn">Dismiss Selected</button>
            <button class="btn btn-ghost btn-sm" id="batch-select-all-btn">Select All</button>
            <button class="btn btn-ghost btn-sm" id="batch-clear-btn">Clear</button>
        </div>
        <div class="job-list" id="job-list"></div>
        <div id="load-more-container" style="padding:24px 0;text-align:center;display:none">
            <button class="btn btn-secondary" id="load-more-btn">Load More</button>
        </div>
    `;

    const searchInput = document.getElementById('filter-search');
    const scoreSelect = document.getElementById('filter-score');
    const sortSelect = document.getElementById('filter-sort');
    const workTypeSelect = document.getElementById('filter-work-type');
    const employmentSelect = document.getElementById('filter-employment');
    const locationInput = document.getElementById('filter-location');
    const regionSelect = document.getElementById('filter-region');
    const clearanceSelect = document.getElementById('filter-clearance');
    const postedWithinSelect = document.getElementById('filter-posted-within');
    const loadMoreBtn = document.getElementById('load-more-btn');

    // Restore saved filter state (or apply defaults)
    const savedState = loadSavedFilterState();
    if (savedState) {
        applyFilterState(savedState);
    } else {
        scoreSelect.value = '60';
    }

    let debounceTimer;
    const reload = () => {
        currentOffset = 0;
        saveFilterState();
        loadJobs(false);
    };

    searchInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(reload, 300);
    });
    locationInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(reload, 300);
    });
    scoreSelect.addEventListener('change', reload);
    sortSelect.addEventListener('change', reload);
    workTypeSelect.addEventListener('change', reload);
    employmentSelect.addEventListener('change', reload);
    regionSelect.addEventListener('change', reload);
    clearanceSelect.addEventListener('change', reload);
    postedWithinSelect.addEventListener('change', reload);

    // Smart views
    await renderSmartViewChips(reload);

    // Save View button
    document.getElementById('save-view-btn').addEventListener('click', async () => {
        const name = prompt('Name for this saved view:');
        if (!name || !name.trim()) return;
        try {
            const views = await getSmartViews();
            const existing = views.find(v => v.name === name.trim());
            if (existing) {
                await api.request('PUT', `/api/saved-views/${existing.id}`, { filters: getFilterState() });
            } else {
                await api.request('POST', '/api/saved-views', { name: name.trim(), filters: getFilterState() });
            }
            invalidateViewsCache();
            renderSmartViewChips(reload);
            showToast(`Saved view "${name.trim()}"`, 'success');
        } catch (err) {
            showToast(err.message, 'error');
        }
    });
    document.getElementById('create-alert-btn').addEventListener('click', async () => {
        const name = prompt('Name for this alert:');
        if (!name || !name.trim()) return;
        try {
            await api.request('POST', '/api/alerts', {
                name: name.trim(),
                filters: getFilterState(),
                min_score: parseInt(document.getElementById('filter-score')?.value || '0') || 0,
            });
            showToast(`Alert "${name.trim()}" created`, 'success');
        } catch (err) { showToast(err.message, 'error'); }
    });
    loadMoreBtn.addEventListener('click', () => loadJobs(true));

    // Select mode
    const selectModeBtn = document.getElementById('select-mode-btn');
    selectModeBtn.addEventListener('click', () => {
        selectMode = !selectMode;
        selectedJobIds.clear();
        selectModeBtn.textContent = selectMode ? 'Cancel Select' : 'Select';
        selectModeBtn.classList.toggle('btn-primary', selectMode);
        selectModeBtn.classList.toggle('btn-secondary', !selectMode);
        updateBatchBar();
        loadJobs(false);
    });

    document.getElementById('batch-compare-btn').addEventListener('click', () => {
        const ids = [...selectedJobIds];
        if (ids.length < 2 || ids.length > 3) return;
        selectedJobIds.clear();
        selectMode = false;
        const sBtn = document.getElementById('select-mode-btn');
        if (sBtn) { sBtn.textContent = 'Select'; sBtn.classList.remove('btn-primary'); sBtn.classList.add('btn-secondary'); }
        renderComparison(document.getElementById('app'), ids);
    });
    document.getElementById('batch-prepare-btn').addEventListener('click', batchPrepare);
    document.getElementById('batch-dismiss-btn').addEventListener('click', batchDismiss);
    document.getElementById('batch-select-all-btn').addEventListener('click', () => {
        document.querySelectorAll('.job-card-checkbox').forEach(cb => {
            cb.checked = true;
            selectedJobIds.add(parseInt(cb.dataset.jobId));
        });
        updateBatchBar();
    });
    document.getElementById('batch-clear-btn').addEventListener('click', () => {
        selectedJobIds.clear();
        document.querySelectorAll('.job-card-checkbox').forEach(cb => cb.checked = false);
        updateBatchBar();
    });

    await loadJobs(false);

    // Save last visit after loading
    localStorage.setItem('jf_last_visit', new Date().toISOString());
}

async function loadJobs(append) {
    const list = document.getElementById('job-list');
    const loadMoreContainer = document.getElementById('load-more-container');

    if (!append) {
        currentOffset = 0;
        list.innerHTML = `<div class="loading-container"><div class="spinner spinner-lg"></div><span>Loading jobs...</span></div>`;
    }

    const params = {
        limit: PAGE_SIZE,
        offset: currentOffset,
        search: document.getElementById('filter-search')?.value || '',
        min_score: document.getElementById('filter-score')?.value || '',
        sort: document.getElementById('filter-sort')?.value || 'score',
        work_type: document.getElementById('filter-work-type')?.value || '',
        employment_type: document.getElementById('filter-employment')?.value || '',
        location: document.getElementById('filter-location')?.value || '',
        region: document.getElementById('filter-region')?.value || '',
        clearance: document.getElementById('filter-clearance')?.value || '',
        posted_within: document.getElementById('filter-posted-within')?.value || '',
    };

    try {
        const data = await api.getJobs(params);
        const jobs = data.jobs || [];

        if (!append) list.innerHTML = '';

        if (jobs.length === 0 && currentOffset === 0) {
            list.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">&#128270;</div>
                    <div class="empty-state-title">No jobs found</div>
                    <div class="empty-state-desc">Try adjusting your filters or click "Scrape Now" to fetch new listings.</div>
                </div>
            `;
            loadMoreContainer.style.display = 'none';
            return;
        }

        jobs.forEach(job => {
            list.appendChild(createJobCard(job));
        });

        currentOffset += jobs.length;
        loadMoreContainer.style.display = jobs.length >= PAGE_SIZE ? '' : 'none';
    } catch (err) {
        showToast(err.message, 'error');
        if (!append) list.innerHTML = '';
    }
}

function updateBatchBar() {
    const bar = document.getElementById('batch-bar');
    if (!bar) return;
    const count = selectedJobIds.size;
    bar.style.display = selectMode && count > 0 ? 'flex' : 'none';
    const countEl = document.getElementById('batch-count');
    if (countEl) countEl.textContent = `${count} selected`;
    const compareBtn = document.getElementById('batch-compare-btn');
    if (compareBtn) compareBtn.style.display = (count >= 2 && count <= 3) ? '' : 'none';
}

async function batchPrepare() {
    const ids = [...selectedJobIds];
    if (!ids.length) return;
    const btn = document.getElementById('batch-prepare-btn');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Preparing 0/${ids.length}...`;
    let done = 0;
    let failed = 0;
    for (const id of ids) {
        try {
            await api.prepareApplication(id);
            done++;
        } catch {
            failed++;
        }
        btn.innerHTML = `<span class="spinner"></span> Preparing ${done + failed}/${ids.length}...`;
    }
    btn.disabled = false;
    btn.textContent = 'Prepare Selected';
    const msg = failed ? `Prepared ${done}/${ids.length} (${failed} failed)` : `Prepared ${done} applications`;
    showToast(msg, failed ? 'error' : 'success');
    selectedJobIds.clear();
    selectMode = false;
    const selectBtn = document.getElementById('select-mode-btn');
    if (selectBtn) { selectBtn.textContent = 'Select'; selectBtn.classList.remove('btn-primary'); selectBtn.classList.add('btn-secondary'); }
    updateBatchBar();
    loadJobs(false);
}

async function batchDismiss() {
    const ids = [...selectedJobIds];
    if (!ids.length) return;
    if (!confirm(`Dismiss ${ids.length} jobs?`)) return;
    for (const id of ids) {
        try { await api.dismissJob(id); } catch {}
    }
    showToast(`Dismissed ${ids.length} jobs`, 'info');
    selectedJobIds.clear();
    selectMode = false;
    const selectBtn = document.getElementById('select-mode-btn');
    if (selectBtn) { selectBtn.textContent = 'Select'; selectBtn.classList.remove('btn-primary'); selectBtn.classList.add('btn-secondary'); }
    updateBatchBar();
    loadJobs(false);
}

async function renderComparison(container, jobIds) {
    container.innerHTML = `<div class="loading-container"><div class="spinner spinner-lg"></div><span>Loading comparison...</span></div>`;

    try {
        const jobs = await Promise.all(jobIds.map(id => api.getJob(id)));

        const rows = [
            {
                label: 'Score',
                render: job => {
                    const s = job.score?.match_score;
                    return `<span class="score-badge score-large ${getScoreClass(s)}">${s ?? '--'}</span>`;
                }
            },
            {
                label: 'Company',
                render: job => escapeHtml(job.company)
            },
            {
                label: 'Location',
                render: job => escapeHtml(job.location || 'Not specified')
            },
            {
                label: 'Salary',
                render: job => {
                    if (job.salary_min || job.salary_max) return formatSalary(job.salary_min, job.salary_max);
                    if (job.salary_estimate_min && job.salary_estimate_max)
                        return `<span style="opacity:0.7">~${formatSalary(job.salary_estimate_min, job.salary_estimate_max)}</span>`;
                    return '<span style="color:var(--text-tertiary)">Not listed</span>';
                }
            },
            {
                label: 'Work Type',
                render: job => escapeHtml(job.work_type || 'Not specified')
            },
            {
                label: 'Employment',
                render: job => escapeHtml(job.employment_type || 'Not specified')
            },
            {
                label: 'Posted',
                render: job => formatDate(job.posted_date || job.created_at)
            },
            {
                label: 'Status',
                render: job => {
                    const s = job.application?.status;
                    return s ? `<span class="status-badge status-${s}">${s}</span>` : '<span style="color:var(--text-tertiary)">None</span>';
                }
            },
            {
                label: 'Match Reasons',
                render: job => {
                    const reasons = job.score?.match_reasons || [];
                    if (!reasons.length) return '<span style="color:var(--text-tertiary)">No score data</span>';
                    return `<ul class="score-reasons">${reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`;
                }
            },
            {
                label: 'Concerns',
                render: job => {
                    const concerns = job.score?.concerns || [];
                    if (!concerns.length) return '<span style="color:var(--text-tertiary)">None</span>';
                    return `<ul class="score-concerns">${concerns.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>`;
                }
            },
        ];

        const colCount = jobs.length;

        container.innerHTML = `
            <div class="detail-header">
                <a class="detail-back" id="compare-back-btn">&larr; Back to jobs</a>
                <h1 class="detail-title">Compare Jobs</h1>
            </div>
            <div class="card comparison-table-wrap">
                <table class="comparison-table">
                    <thead>
                        <tr>
                            <th class="comparison-label-col"></th>
                            ${jobs.map(job => `
                                <th class="comparison-job-col">
                                    <a href="#/job/${job.id}" class="comparison-job-title">${escapeHtml(job.title)}</a>
                                    <div class="comparison-job-company">${escapeHtml(job.company)}</div>
                                </th>
                            `).join('')}
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map(row => `
                            <tr>
                                <td class="comparison-label">${row.label}</td>
                                ${jobs.map(job => `<td class="comparison-cell">${row.render(job)}</td>`).join('')}
                            </tr>
                        `).join('')}
                        <tr>
                            <td class="comparison-label">Actions</td>
                            ${jobs.map(job => `
                                <td class="comparison-cell">
                                    <div style="display:flex;flex-direction:column;gap:6px">
                                        <a href="#/job/${job.id}" class="btn btn-primary btn-sm">View Details</a>
                                        <a href="${escapeHtml(job.url)}" target="_blank" class="btn btn-secondary btn-sm">Open Listing</a>
                                    </div>
                                </td>
                            `).join('')}
                        </tr>
                    </tbody>
                </table>
            </div>
        `;

        document.getElementById('compare-back-btn').addEventListener('click', (e) => {
            e.preventDefault();
            navigate('#/');
        });
    } catch (err) {
        showToast(err.message, 'error');
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-title">Comparison failed</div>
                <div class="empty-state-desc">${escapeHtml(err.message)}</div>
            </div>
        `;
    }
}

function createJobCard(job) {
    const card = document.createElement('div');
    card.className = 'card card-interactive job-card';
    card.dataset.jobId = job.id;

    const score = job.match_score;
    const salary = formatSalary(job.salary_min, job.salary_max);
    const scoreClass = getScoreClass(score);
    const newTag = isNew(job.created_at) ? `<span class="new-indicator">New</span>` : '';
    const statusTag = job.app_status ? `<span class="status-badge status-${job.app_status}">${job.app_status}</span>` : '';
    const freshness = getFreshness(job);
    const freshnessHtml = freshness ? `<span class="freshness-badge ${freshness.class}">${freshness.label}</span>` : '';

    let cardSalaryHtml = '';
    if (salary) {
        cardSalaryHtml = `<span>${salary}</span>`;
    } else if (job.salary_estimate_min && job.salary_estimate_max) {
        cardSalaryHtml = `<span style="opacity:0.8">~${formatSalary(job.salary_estimate_min, job.salary_estimate_max)}</span>`;
    }

    if (selectMode) card.classList.add('job-card-selecting');

    card.innerHTML = `
        ${selectMode ? `<div class="job-card-check"><input type="checkbox" class="job-card-checkbox" data-job-id="${job.id}"${selectedJobIds.has(job.id) ? ' checked' : ''}></div>` : ''}
        <div class="job-card-content">
            <div class="job-card-header">
                <span class="job-card-title text-truncate">${escapeHtml(job.title)}</span>
                ${newTag}
                ${statusTag}
            </div>
            <span class="job-card-company">${escapeHtml(job.company)}</span>
            <div class="job-card-meta">
                ${job.location ? `<span>${escapeHtml(job.location)}</span>` : ''}
                ${cardSalaryHtml}
                <span>${formatDate(job.created_at)}</span>
                ${freshnessHtml}
            </div>
        </div>
        <div class="job-card-actions">
            <span class="score-badge ${scoreClass}">${score !== null && score !== undefined ? score : '--'}</span>
            <div class="job-card-quick-actions">
                <button class="btn btn-danger btn-sm dismiss-btn" title="Dismiss">Dismiss</button>
            </div>
        </div>
    `;

    const checkbox = card.querySelector('.job-card-checkbox');
    if (checkbox) {
        checkbox.addEventListener('click', (e) => {
            e.stopPropagation();
            if (checkbox.checked) selectedJobIds.add(job.id);
            else selectedJobIds.delete(job.id);
            updateBatchBar();
        });
    }

    card.addEventListener('click', (e) => {
        if (e.target.closest('.dismiss-btn') || e.target.closest('.job-card-checkbox')) return;
        if (selectMode && checkbox) {
            checkbox.checked = !checkbox.checked;
            if (checkbox.checked) selectedJobIds.add(job.id);
            else selectedJobIds.delete(job.id);
            updateBatchBar();
            return;
        }
        navigate(`#/job/${job.id}`);
    });

    card.querySelector('.dismiss-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
            await api.dismissJob(job.id);
            card.classList.add('job-card-dismiss');
            card.addEventListener('animationend', () => card.remove());
            showToast('Job dismissed', 'info');
        } catch (err) {
            showToast(err.message, 'error');
        }
    });

    return card;
}

// === Job Detail View ===
async function renderJobDetail(container, jobId) {
    container.innerHTML = `<div class="loading-container"><div class="spinner spinner-lg"></div><span>Loading job details...</span></div>`;

    try {
        const [job, profile, resumesData] = await Promise.all([
            api.getJob(jobId),
            api.request('GET', '/api/profile'),
            api.request('GET', '/api/resumes'),
        ]);
        let companyInfo = null;
        try {
            companyInfo = await api.request('GET', `/api/companies/${encodeURIComponent(job.company)}`);
        } catch (e) {
            // silently ignore
        }
        renderJobDetailContent(container, job, profile, companyInfo, resumesData.resumes || []);
    } catch (err) {
        showToast(err.message, 'error');
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-title">Job not found</div>
                <div class="empty-state-desc">${escapeHtml(err.message)}</div>
            </div>
        `;
    }
}

function renderJobDetailContent(container, job, profile = {}, companyInfo = null, resumes = []) {
    const score = job.score;
    const matchScore = score?.match_score;
    const scoreClass = getScoreClass(matchScore);
    const salary = formatSalary(job.salary_min, job.salary_max);
    const sources = job.sources || [];
    const application = job.application;

    const hasSalary = job.salary_min && job.salary_max;
    const hasEstimate = job.salary_estimate_min && job.salary_estimate_max;
    let salaryHtml = '';
    if (hasSalary) {
        salaryHtml = `<span>${formatSalary(job.salary_min, job.salary_max)}</span>`;
    } else if (hasEstimate) {
        const conf = job.salary_confidence || 'low';
        const confColor = conf === 'high' ? '#22c55e' : conf === 'medium' ? '#f59e0b' : '#94a3b8';
        salaryHtml = `
            <span style="opacity:0.8">~${formatSalary(job.salary_estimate_min, job.salary_estimate_max)}</span>
            <span style="font-size:0.75rem;color:${confColor};margin-left:4px">(${conf} confidence)</span>
        `;
    } else {
        salaryHtml = `<button class="btn btn-ghost btn-sm" id="estimate-salary-btn" style="font-size:0.8125rem">Estimate Salary</button>`;
    }

    const reasonsHtml = (score?.match_reasons || []).map(r => `<li>${escapeHtml(r)}</li>`).join('');
    const concernsHtml = (score?.concerns || []).map(c => `<li>${escapeHtml(c)}</li>`).join('');

    const freshness = getFreshness(job);
    const freshnessHtml = freshness ? `<span class="freshness-badge ${freshness.class}">${freshness.label}</span>` : '';
    const staleWarning = freshness && freshness.class === 'freshness-stale' ? '<span style="font-size:0.8125rem;color:#ef4444;">This listing may be expired.</span>' : '';

    const descriptionContent = job.description
        ? (job.description.includes('<') && job.description.includes('>') ? job.description : `<p>${escapeHtml(job.description).replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`)
        : '<p class="text-tertiary">No description available.</p>';

    const appStatus = application?.status || 'interested';

    container.innerHTML = `
        <div class="detail-header">
            <a class="detail-back" id="back-btn">&larr; Back to jobs</a>
            <h1 class="detail-title">${escapeHtml(job.title)}</h1>
            <div class="detail-company">${escapeHtml(job.company)}</div>
            <div class="detail-meta">
                ${job.location ? `<span>${escapeHtml(job.location)}</span>` : ''}
                ${salaryHtml}
                <span>${formatDate(job.posted_date || job.created_at)}</span>
                ${freshnessHtml}
                ${staleWarning}
                ${sources.map(s => `<a href="${escapeHtml(s.source_url || job.url)}" target="_blank" class="source-tag">${escapeHtml(s.source_name)}</a>`).join('')}
            </div>
        </div>
        <div class="detail-layout">
            <div class="card detail-description">
                <h2>Job Description</h2>
                <div class="detail-description-content">${descriptionContent}</div>
            </div>
            <div class="detail-sidebar">
                ${score ? `
                <div class="card sidebar-section">
                    <h3>Match Score</h3>
                    <div class="score-display">
                        <span class="score-badge score-large ${scoreClass}">${matchScore}</span>
                        <div id="prediction-badge-container"></div>
                    </div>
                    ${reasonsHtml ? `<ul class="score-reasons">${reasonsHtml}</ul>` : ''}
                    ${concernsHtml ? `<div class="concerns-label">Concerns</div><ul class="score-concerns">${concernsHtml}</ul>` : ''}
                    <button class="btn btn-ghost btn-sm" id="predict-success-btn" style="margin-top:8px;font-size:0.75rem">Predict Success</button>
                    <div id="prediction-detail" style="display:none;margin-top:8px;font-size:0.8125rem;color:var(--text-secondary)"></div>
                </div>
                ` : ''}
                <div class="card sidebar-section">
                    <h3>Actions</h3>
                    ${resumes.length > 1 ? `
                    <div style="margin-bottom:10px">
                        <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Resume</label>
                        <select class="filter-select" id="resume-select" style="width:100%">
                            ${resumes.map(r => `<option value="${r.id}"${r.is_default ? ' selected' : ''}>${escapeHtml(r.name)}${r.is_default ? ' (default)' : ''}</option>`).join('')}
                        </select>
                    </div>
                    ` : ''}
                    <div class="action-buttons">
                        <button class="btn btn-primary" id="prepare-btn">
                            Prepare Application
                        </button>
                        ${job.apply_url
                            ? `<button class="btn btn-success" id="apply-now-btn" style="width:100%;background:#22c55e;color:white;font-weight:600">Apply Now →</button>`
                            : `<button class="btn btn-secondary btn-sm" id="find-apply-btn" style="width:100%">Find Apply Link</button>`
                        }
                        <a href="${escapeHtml(job.url)}" target="_blank" class="btn btn-secondary">
                            Open Job Listing
                        </a>
                        <button class="btn btn-secondary" id="copy-listing-link-btn">Copy Listing Link</button>
                        <button class="btn btn-secondary" id="add-to-queue-btn">Add to Queue</button>
                        ${(job.hiring_manager_email || job.contact_email) ? `<button class="btn btn-secondary" id="email-btn">Draft Email</button>` : ''}
                    </div>
                    ${application?.status !== 'applied' ? `
                        <button class="btn" id="mark-applied-btn" style="width:100%;background:#22c55e;color:white;font-weight:600;margin-top:8px">
                            Mark as Applied
                        </button>
                    ` : `
                        <div style="text-align:center;color:#22c55e;font-weight:600;font-size:0.875rem;margin-top:8px">
                            Applied ${application.applied_at ? formatDate(application.applied_at) : ''}
                        </div>
                    `}
                    <div class="mt-16">
                        <label class="mb-8" style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary)">Status</label>
                        <select class="status-select" id="status-select">
                            ${['interested', 'prepared', 'applied', 'interviewing', 'rejected'].map(s =>
                                `<option value="${s}" ${s === appStatus ? 'selected' : ''}>${s}</option>`
                            ).join('')}
                        </select>
                    </div>
                    <div class="mt-16">
                        <button class="btn btn-secondary btn-sm" id="save-status-btn">Save Status</button>
                    </div>
                    ${appStatus === 'applied' || appStatus === 'interviewing' ? `
                    <div class="mt-16" style="padding-top:12px;border-top:1px solid var(--border)">
                        <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Log Response</label>
                        ${application?.response_type ? `
                            <div style="font-size:0.8125rem;color:var(--text-secondary);padding:8px 12px;background:var(--bg-surface-secondary);border-radius:var(--radius-sm)">
                                Response: <strong style="text-transform:capitalize">${escapeHtml(application.response_type.replace('_', ' '))}</strong>
                                ${application.response_received_at ? ` &middot; ${formatDate(application.response_received_at)}` : ''}
                            </div>
                        ` : `
                            <div style="display:flex;gap:6px">
                                <select class="filter-select" id="response-type-select" style="flex:1">
                                    <option value="">Select type...</option>
                                    <option value="interview_invite">Interview Invite</option>
                                    <option value="rejection">Rejection</option>
                                    <option value="callback">Callback</option>
                                    <option value="ghosted">Ghosted</option>
                                </select>
                                <button class="btn btn-primary btn-sm" id="log-response-btn">Log</button>
                            </div>
                        `}
                    </div>
                    ` : ''}
                </div>
                ${(() => {
                    const contactEmail = job.hiring_manager_email || job.contact_email || '';
                    const contactName = job.hiring_manager_name || '';
                    const lookupDone = job.contact_lookup_done;
                    return `
                    <div class="card sidebar-section">
                        <h3>Contact Info</h3>
                        ${contactEmail ? `
                            <div style="display:flex;flex-direction:column;gap:6px">
                                ${contactName ? `<div style="font-weight:600;font-size:0.875rem">${escapeHtml(contactName)}</div>` : ''}
                                <div style="display:flex;align-items:center;gap:8px">
                                    <span style="font-size:0.875rem;color:var(--text-secondary)">${escapeHtml(contactEmail)}</span>
                                    <button class="btn btn-ghost btn-sm copy-btn" data-copy="${escapeHtml(contactEmail)}" title="Copy email">&#128203;</button>
                                </div>
                            </div>
                        ` : lookupDone ? `
                            <div style="font-size:0.8125rem;color:var(--text-tertiary);margin-bottom:8px">No contact found</div>
                            <button class="btn btn-secondary btn-sm" id="find-contact-btn">Retry Search</button>
                        ` : `
                            <button class="btn btn-secondary btn-sm" id="find-contact-btn">Find Contact</button>
                        `}
                    </div>`;
                })()}
                ${(() => {
                    const profileFields = [
                        {label: 'Name', key: 'full_name'},
                        {label: 'Email', key: 'email'},
                        {label: 'Phone', key: 'phone'},
                        {label: 'Location', key: 'location'},
                        {label: 'LinkedIn', key: 'linkedin_url'},
                        {label: 'GitHub', key: 'github_url'},
                        {label: 'Portfolio', key: 'portfolio_url'},
                    ];
                    const hasProfile = profile && Object.values(profile).some(v => v && v !== '');
                    if (!hasProfile) return '';
                    const items = profileFields
                        .filter(f => profile[f.key])
                        .map(f => `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0">
                            <span style="font-size:0.8125rem;color:var(--text-tertiary)">${f.label}</span>
                            <span style="display:flex;align-items:center;gap:4px">
                                <span style="font-size:0.8125rem;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(profile[f.key])}">${escapeHtml(profile[f.key])}</span>
                                <button class="btn btn-secondary btn-sm quick-copy-btn" data-value="${escapeHtml(profile[f.key])}" title="Copy" style="padding:2px 6px;min-width:auto;font-size:0.75rem">&#128203;</button>
                            </span>
                        </div>`).join('');
                    return `<div class="card sidebar-section">
                        <details open>
                            <summary style="cursor:pointer;font-weight:600;font-size:0.9375rem;margin-bottom:8px">Quick Copy</summary>
                            ${items}
                        </details>
                    </div>`;
                })()}
                <div class="card sidebar-section">
                    <h3>Timeline</h3>
                    <div class="flex gap-8 mb-16">
                        <input type="text" class="search-input" id="add-note-input" placeholder="Add a note..." style="flex:1">
                        <button class="btn btn-primary btn-sm" id="add-note-btn">Add</button>
                    </div>
                    <div class="timeline" id="timeline-container">
                        ${renderTimeline(job.events || [])}
                    </div>
                </div>
                ${(job.similar && job.similar.length > 0) ? `
                <div class="card sidebar-section">
                    <h3>Similar Listings (${job.similar.length})</h3>
                    <div style="display:flex;flex-direction:column;gap:8px">
                        ${job.similar.map(s => `
                            <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--bg-surface-secondary);border-radius:var(--radius-sm)">
                                <div>
                                    <a href="#/job/${s.id}" style="font-size:0.875rem;font-weight:500;color:var(--accent)">${escapeHtml(s.title)}</a>
                                    <div style="font-size:0.75rem;color:var(--text-tertiary)">${escapeHtml(s.company)}</div>
                                </div>
                                ${s.match_score ? `<span class="score-badge ${getScoreClass(s.match_score)}" style="font-size:0.75rem">${s.match_score}</span>` : ''}
                            </div>
                        `).join('')}
                    </div>
                    <button class="btn btn-secondary btn-sm" id="dismiss-dupes-btn" style="margin-top:12px;width:100%">Dismiss Duplicates</button>
                </div>
                ` : ''}
                ${companyInfo && (companyInfo.description || companyInfo.glassdoor_rating) ? `
                <div class="card sidebar-section">
                    <h3>About ${escapeHtml(job.company)}</h3>
                    ${companyInfo.description ? `<p style="font-size:0.8125rem;color:var(--text-secondary);line-height:1.5;margin-bottom:8px">${escapeHtml(companyInfo.description.substring(0, 200))}${companyInfo.description.length > 200 ? '...' : ''}</p>` : ''}
                    ${companyInfo.glassdoor_rating ? `
                        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
                            <span style="font-weight:600;font-size:0.875rem">${companyInfo.glassdoor_rating}</span>
                            <span style="color:#f59e0b">★</span>
                            <span style="font-size:0.75rem;color:var(--text-tertiary)">Glassdoor</span>
                        </div>
                    ` : ''}
                    ${companyInfo.website ? `<a href="${escapeHtml(companyInfo.website)}" target="_blank" style="font-size:0.8125rem;color:var(--accent)">Company Website →</a>` : ''}
                </div>
                ` : ''}
                <div id="prepared-container">
                    ${application?.tailored_resume ? renderPreparedSection(application, job.id) : ''}
                </div>
                <div id="cover-letter-container">
                    ${application?.cover_letter ? renderCoverLetterSection(application.cover_letter, job.id) : `
                    <div class="card sidebar-section">
                        <h3>Cover Letter</h3>
                        <button class="btn btn-secondary" id="generate-cover-letter-btn" style="width:100%">Generate Cover Letter</button>
                    </div>
                    `}
                </div>
                <div id="email-container">
                    ${application?.email_draft ? renderEmailPreview(JSON.parse(application.email_draft)) : ''}
                </div>
                <div id="interview-prep-container">
                    ${job.interview_prep ? renderInterviewPrep(job.interview_prep) : (appStatus === 'interviewing' ? `
                    <div class="card sidebar-section">
                        <h3>Interview Prep</h3>
                        <button class="btn btn-primary" id="generate-interview-prep-btn" style="width:100%">Generate Interview Prep</button>
                    </div>
                    ` : '')}
                </div>
            </div>
        </div>
    `;

    // Wire up events
    document.querySelectorAll('.quick-copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            copyToClipboard(btn.dataset.value);
        });
    });

    document.getElementById('back-btn').addEventListener('click', (e) => {
        e.preventDefault();
        navigate('#/');
    });

    const predictBtn = document.getElementById('predict-success-btn');
    if (predictBtn) {
        predictBtn.addEventListener('click', async () => {
            predictBtn.disabled = true;
            predictBtn.innerHTML = '<span class="spinner"></span> Predicting...';
            try {
                const pred = await api.request('GET', `/api/jobs/${job.id}/predict-success`);
                const pct = Math.round((pred.probability || 0) * 100);
                const color = pct >= 60 ? '#22c55e' : pct >= 40 ? '#f59e0b' : '#ef4444';
                const badgeContainer = document.getElementById('prediction-badge-container');
                if (badgeContainer) {
                    badgeContainer.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:999px;font-size:0.8125rem;font-weight:600;background:${color}22;color:${color}">${pct}% likely</span>`;
                }
                const detail = document.getElementById('prediction-detail');
                if (detail) {
                    detail.style.display = '';
                    detail.innerHTML = `
                        <div style="font-size:0.75rem;color:var(--text-tertiary);margin-bottom:4px">Confidence: ${pred.confidence || 'N/A'}</div>
                        ${pred.reasoning ? `<div>${escapeHtml(pred.reasoning)}</div>` : ''}
                    `;
                }
                predictBtn.style.display = 'none';
            } catch (err) {
                showToast(err.message, 'error');
                predictBtn.disabled = false;
                predictBtn.textContent = 'Predict Success';
            }
        });
    }

    const estSalaryBtn = document.getElementById('estimate-salary-btn');
    if (estSalaryBtn) {
        estSalaryBtn.addEventListener('click', async () => {
            estSalaryBtn.disabled = true;
            estSalaryBtn.innerHTML = '<span class="spinner"></span>';
            try {
                const result = await api.request('POST', `/api/jobs/${job.id}/estimate-salary`);
                if (result.min && result.min > 0) {
                    showToast(`Estimated: ${formatSalary(result.min, result.max)} (${result.confidence})`, 'success');
                    const updated = await api.getJob(job.id);
                    renderJobDetailContent(container, updated, profile, companyInfo, resumes);
                } else {
                    showToast('Could not estimate salary', 'info');
                    estSalaryBtn.disabled = false;
                    estSalaryBtn.textContent = 'Estimate Salary';
                }
            } catch (err) {
                showToast(err.message, 'error');
                estSalaryBtn.disabled = false;
                estSalaryBtn.textContent = 'Estimate Salary';
            }
        });
    }

    const logResponseBtn = document.getElementById('log-response-btn');
    if (logResponseBtn) {
        logResponseBtn.addEventListener('click', async () => {
            const typeSelect = document.getElementById('response-type-select');
            const responseType = typeSelect?.value;
            if (!responseType) { showToast('Select a response type', 'error'); return; }
            logResponseBtn.disabled = true;
            logResponseBtn.innerHTML = '<span class="spinner"></span>';
            try {
                await api.request('POST', `/api/jobs/${job.id}/response`, { response_type: responseType });
                showToast('Response logged', 'success');
                const updated = await api.getJob(job.id);
                renderJobDetailContent(container, updated, profile, companyInfo, resumes);
            } catch (err) {
                showToast(err.message, 'error');
                logResponseBtn.disabled = false;
                logResponseBtn.textContent = 'Log';
            }
        });
    }

    document.getElementById('prepare-btn').addEventListener('click', async () => {
        const btn = document.getElementById('prepare-btn');
        const resumeSelect = document.getElementById('resume-select');
        const resumeId = resumeSelect ? parseInt(resumeSelect.value) : null;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Preparing...';
        try {
            const result = await api.prepareApplication(job.id, resumeId);
            document.getElementById('prepared-container').innerHTML = renderPreparedSection(result, job.id);
            attachPreparedListeners();
            showToast('Application prepared!', 'success');
        } catch (err) {
            showToast(err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Prepare Application';
        }
    });

    const findApplyBtn = document.getElementById('find-apply-btn');
    if (findApplyBtn) {
        findApplyBtn.addEventListener('click', async () => {
            findApplyBtn.disabled = true;
            findApplyBtn.innerHTML = '<span class="spinner"></span> Searching...';
            try {
                const result = await api.request('POST', `/api/jobs/${job.id}/find-apply-link`);
                if (result.apply_url) {
                    showToast('Apply link found!', 'success');
                    const updated = await api.getJob(job.id);
                    renderJobDetailContent(container, updated, profile, companyInfo, resumes);
                } else {
                    showToast('No apply link found on the page', 'info');
                    findApplyBtn.disabled = false;
                    findApplyBtn.textContent = 'Find Apply Link';
                }
            } catch (err) {
                showToast(err.message, 'error');
                findApplyBtn.disabled = false;
                findApplyBtn.textContent = 'Find Apply Link';
            }
        });
    }

    const applyNowBtn = document.getElementById('apply-now-btn');
    if (applyNowBtn) {
        applyNowBtn.addEventListener('click', async () => {
            applyNowBtn.disabled = true;
            applyNowBtn.innerHTML = '<span class="spinner"></span> Applying...';
            try {
                const result = await api.request('POST', `/api/jobs/${job.id}/apply`);
                window.open(result.url, '_blank');
                showToast('Marked as applied!', 'success');
                const updated = await api.getJob(job.id);
                renderJobDetailContent(container, updated, profile, companyInfo, resumes);
            } catch (err) {
                showToast(err.message, 'error');
                applyNowBtn.disabled = false;
                applyNowBtn.textContent = 'Apply Now →';
            }
        });
    }

    document.getElementById('save-status-btn').addEventListener('click', async () => {
        const status = document.getElementById('status-select').value;
        try {
            await api.updateApplication(job.id, status);
            showToast('Status updated', 'success');
        } catch (err) {
            showToast(err.message, 'error');
        }
    });

    const copyLinkBtn = document.getElementById('copy-listing-link-btn');
    if (copyLinkBtn) {
        copyLinkBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(job.url);
                showToast('Link copied!', 'success');
            } catch {
                showToast('Failed to copy link', 'error');
            }
        });
    }

    document.getElementById('add-to-queue-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('add-to-queue-btn');
        const resumeSelect = document.getElementById('resume-select');
        const resumeId = resumeSelect ? parseInt(resumeSelect.value) : null;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>';
        try {
            await api.request('POST', '/api/queue/add', { job_id: job.id, resume_id: resumeId });
            showToast('Added to queue', 'success');
            btn.textContent = 'In Queue';
        } catch (err) {
            showToast(err.message, 'error');
            btn.disabled = false;
            btn.textContent = 'Add to Queue';
        }
    });

    const markAppliedBtn = document.getElementById('mark-applied-btn');
    if (markAppliedBtn) {
        markAppliedBtn.addEventListener('click', async () => {
            markAppliedBtn.disabled = true;
            try {
                await api.updateApplication(job.id, 'applied');
                showToast('Marked as applied!', 'success');
                const updated = await api.getJob(job.id);
                renderJobDetailContent(container, updated, profile, companyInfo, resumes);
            } catch (err) {
                showToast(err.message, 'error');
                markAppliedBtn.disabled = false;
            }
        });
    }

    const addNoteBtn = document.getElementById('add-note-btn');
    const addNoteInput = document.getElementById('add-note-input');
    addNoteBtn.addEventListener('click', async () => {
        const detail = addNoteInput.value.trim();
        if (!detail) return;
        try {
            await api.addEvent(job.id, detail);
            addNoteInput.value = '';
            const updated = await api.getJob(job.id);
            document.getElementById('timeline-container').innerHTML = renderTimeline(updated.events || []);
            showToast('Note added', 'success');
        } catch (err) {
            showToast(err.message, 'error');
        }
    });
    addNoteInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addNoteBtn.click();
    });

    const emailBtn = document.getElementById('email-btn');
    if (emailBtn) {
        emailBtn.addEventListener('click', async () => {
            emailBtn.disabled = true;
            emailBtn.innerHTML = '<span class="spinner"></span> Drafting...';
            try {
                const result = await api.draftEmail(job.id);
                document.getElementById('email-container').innerHTML = renderEmailPreview(result.email);
                wireSendEmailBtn(job.id);
                showToast('Email drafted', 'success');
            } catch (err) {
                showToast(err.message, 'error');
            } finally {
                emailBtn.disabled = false;
                emailBtn.textContent = 'Draft Email';
            }
        });
    }

    wireSendEmailBtn(job.id);

    const genCoverLetterBtn = document.getElementById('generate-cover-letter-btn');
    if (genCoverLetterBtn) {
        genCoverLetterBtn.addEventListener('click', async () => {
            genCoverLetterBtn.disabled = true;
            genCoverLetterBtn.innerHTML = '<span class="spinner"></span> Generating...';
            try {
                const result = await api.generateCoverLetter(job.id);
                document.getElementById('cover-letter-container').innerHTML = renderCoverLetterSection(result.cover_letter, job.id);
                attachCoverLetterListeners(job.id);
                showToast('Cover letter generated!', 'success');
            } catch (err) {
                showToast(err.message, 'error');
                genCoverLetterBtn.disabled = false;
                genCoverLetterBtn.textContent = 'Generate Cover Letter';
            }
        });
    }

    attachCoverLetterListeners(job.id);

    document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            copyToClipboard(btn.dataset.copy);
        });
    });

    const findContactBtn = document.getElementById('find-contact-btn');
    if (findContactBtn) {
        findContactBtn.addEventListener('click', async () => {
            findContactBtn.disabled = true;
            findContactBtn.innerHTML = '<span class="spinner"></span> Searching...';
            try {
                const result = await api.request('POST', `/api/jobs/${job.id}/find-contact`);
                if (result.contact && result.contact.email) {
                    showToast(`Found: ${result.contact.email}`, 'success');
                } else {
                    showToast('No contact found', 'info');
                }
                // Refresh the job detail
                const updated = await api.getJob(job.id);
                renderJobDetailContent(container, updated, profile, companyInfo, resumes);
            } catch (err) {
                showToast(err.message, 'error');
                findContactBtn.disabled = false;
                findContactBtn.textContent = 'Find Contact';
            }
        });
    }

    attachPreparedListeners();

    const dismissDupesBtn = document.getElementById('dismiss-dupes-btn');
    if (dismissDupesBtn) {
        dismissDupesBtn.addEventListener('click', async () => {
            if (!confirm('Dismiss all similar listings? This keeps only the current job.')) return;
            for (const s of job.similar) {
                await api.dismissJob(s.id);
            }
            showToast(`Dismissed ${job.similar.length} similar listings`, 'success');
            await renderJobDetail(container, job.id);
        });
    }

    const genPrepBtn = document.getElementById('generate-interview-prep-btn');
    if (genPrepBtn) {
        genPrepBtn.addEventListener('click', async () => {
            genPrepBtn.disabled = true;
            genPrepBtn.innerHTML = '<span class="spinner"></span> Generating...';
            try {
                const result = await api.request('POST', `/api/jobs/${job.id}/interview-prep`);
                document.getElementById('interview-prep-container').innerHTML = renderInterviewPrep(result.prep);
                showToast('Interview prep generated', 'success');
            } catch (err) {
                showToast(err.message, 'error');
                genPrepBtn.disabled = false;
                genPrepBtn.textContent = 'Generate Interview Prep';
            }
        });
    }
}

function renderInterviewPrep(prep) {
    const section = (title, items) => {
        if (!items || items.length === 0) return '';
        return `
            <details open style="margin-bottom:12px">
                <summary style="cursor:pointer;font-weight:600;font-size:0.875rem;margin-bottom:6px">${title}</summary>
                <ul style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:4px">
                    ${items.map(item => `<li style="font-size:0.8125rem;color:var(--text-secondary);line-height:1.5">${escapeHtml(item)}</li>`).join('')}
                </ul>
            </details>
        `;
    };
    return `
        <div class="card sidebar-section">
            <h3>Interview Prep</h3>
            ${section('Behavioral Questions', prep.behavioral_questions)}
            ${section('Technical Questions', prep.technical_questions)}
            ${section('STAR Stories', prep.star_stories)}
            ${section('Talking Points', prep.talking_points)}
            <button class="btn btn-secondary btn-sm" id="generate-interview-prep-btn" style="width:100%;margin-top:8px">Regenerate</button>
        </div>
    `;
}

function renderTimeline(events) {
    if (!events || events.length === 0) {
        return '<div style="font-size:0.8125rem;color:var(--text-tertiary)">No events yet.</div>';
    }
    const icons = {
        note: '\u{1F4DD}',
        status_change: '\u{1F504}',
        prepared: '\u{1F4C4}',
        email_drafted: '\u2709\uFE0F',
        pdf_downloaded: '\u2B07\uFE0F',
    };
    return events.map(e => `
        <div class="timeline-event">
            <span class="timeline-icon">${icons[e.event_type] || '\u{1F4DD}'}</span>
            <div>
                <div class="timeline-detail">${escapeHtml(e.detail)}</div>
                <div class="timeline-time">${formatDate(e.created_at)}</div>
            </div>
        </div>
    `).join('');
}

function renderPreparedSection(data, jobId) {
    return `
        <div class="card sidebar-section">
            <h3>Tailored Resume</h3>
            <div class="doc-download-row">
                <div class="pdf-download-card">
                    <a href="/api/jobs/${jobId}/resume.pdf" download class="pdf-file-link" draggable="true">
                        <span class="pdf-icon">PDF</span>
                        <span class="pdf-label">Resume</span>
                    </a>
                </div>
                <div class="pdf-download-card">
                    <a href="/api/jobs/${jobId}/resume.docx" download class="pdf-file-link docx-file-link" draggable="true">
                        <span class="pdf-icon docx-icon">DOCX</span>
                        <span class="pdf-label">Resume</span>
                    </a>
                </div>
            </div>
            <div class="prepared-section">
                <textarea class="textarea-styled" id="resume-textarea">${escapeHtml(data.tailored_resume || '')}</textarea>
                <div class="prepared-actions">
                    <button class="btn btn-secondary btn-sm" id="copy-resume-btn">Copy Resume</button>
                </div>
            </div>
        </div>
        <div class="card sidebar-section">
            <h3>Cover Letter</h3>
            <div class="doc-download-row">
                <div class="pdf-download-card">
                    <a href="/api/jobs/${jobId}/cover-letter.pdf" download class="pdf-file-link" draggable="true">
                        <span class="pdf-icon">PDF</span>
                        <span class="pdf-label">Cover Letter</span>
                    </a>
                </div>
                <div class="pdf-download-card">
                    <a href="/api/jobs/${jobId}/cover-letter.docx" download class="pdf-file-link docx-file-link" draggable="true">
                        <span class="pdf-icon docx-icon">DOCX</span>
                        <span class="pdf-label">Cover Letter</span>
                    </a>
                </div>
            </div>
            <div class="prepared-section">
                <textarea class="textarea-styled" id="cover-textarea">${escapeHtml(data.cover_letter || '')}</textarea>
                <div class="prepared-actions">
                    <button class="btn btn-secondary btn-sm" id="copy-cover-btn">Copy Cover Letter</button>
                </div>
            </div>
        </div>
    `;
}

function attachPreparedListeners() {
    const copyResume = document.getElementById('copy-resume-btn');
    const copyCover = document.getElementById('copy-cover-btn');
    if (copyResume) {
        copyResume.addEventListener('click', () => {
            copyToClipboard(document.getElementById('resume-textarea').value);
        });
    }
    if (copyCover) {
        copyCover.addEventListener('click', () => {
            copyToClipboard(document.getElementById('cover-textarea').value);
        });
    }
}

function renderCoverLetterSection(coverLetterText, jobId) {
    if (!coverLetterText) return '';
    return `
        <div class="card sidebar-section">
            <h3>Cover Letter</h3>
            <div class="prepared-section">
                <textarea class="textarea-styled" id="standalone-cover-textarea" rows="12">${escapeHtml(coverLetterText)}</textarea>
                <div class="prepared-actions" style="display:flex;gap:8px;margin-top:8px">
                    <button class="btn btn-primary btn-sm" id="save-cover-letter-btn">Save Edits</button>
                    <button class="btn btn-secondary btn-sm" id="copy-cover-letter-btn">Copy</button>
                    <button class="btn btn-secondary btn-sm" id="regenerate-cover-letter-btn">Regenerate</button>
                </div>
            </div>
        </div>
    `;
}

function attachCoverLetterListeners(jobId) {
    const saveBtn = document.getElementById('save-cover-letter-btn');
    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const text = document.getElementById('standalone-cover-textarea').value;
            saveBtn.disabled = true;
            saveBtn.innerHTML = '<span class="spinner"></span>';
            try {
                await api.request('PUT', `/api/jobs/${jobId}/cover-letter`, { cover_letter: text });
                showToast('Cover letter saved', 'success');
            } catch (err) {
                showToast(err.message, 'error');
            } finally {
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save Edits';
            }
        });
    }

    const copyBtn = document.getElementById('copy-cover-letter-btn');
    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            copyToClipboard(document.getElementById('standalone-cover-textarea').value);
        });
    }

    const regenBtn = document.getElementById('regenerate-cover-letter-btn');
    if (regenBtn) {
        regenBtn.addEventListener('click', async () => {
            regenBtn.disabled = true;
            regenBtn.innerHTML = '<span class="spinner"></span> Regenerating...';
            try {
                const result = await api.generateCoverLetter(jobId);
                document.getElementById('cover-letter-container').innerHTML = renderCoverLetterSection(result.cover_letter, jobId);
                attachCoverLetterListeners(jobId);
                showToast('Cover letter regenerated!', 'success');
            } catch (err) {
                showToast(err.message, 'error');
                regenBtn.disabled = false;
                regenBtn.textContent = 'Regenerate';
            }
        });
    }
}

function wireSendEmailBtn(jobId) {
    const sendBtn = document.getElementById('send-email-btn');
    if (!sendBtn) return;
    sendBtn.addEventListener('click', async () => {
        sendBtn.disabled = true;
        sendBtn.innerHTML = '<span class="spinner"></span> Sending...';
        try {
            await api.request('POST', `/api/jobs/${jobId}/send-email`);
            showToast('Email sent', 'success');
            sendBtn.textContent = 'Sent!';
        } catch (err) {
            showToast(err.message, 'error');
            sendBtn.disabled = false;
            sendBtn.textContent = 'Send Email';
        }
    });
}

function renderEmailPreview(email) {
    if (!email) return '';
    return `
        <div class="card sidebar-section">
            <h3>Email Draft</h3>
            <div class="email-preview">
                <div class="email-field"><span class="email-label">To:</span> ${escapeHtml(email.to || '')}</div>
                <div class="email-field"><span class="email-label">Subject:</span> ${escapeHtml(email.subject || '')}</div>
                <div class="email-body">${escapeHtml(email.body || '')}</div>
            </div>
            <div class="prepared-actions">
                <button class="btn btn-primary btn-sm" id="send-email-btn">Send Email</button>
                <button class="btn btn-secondary btn-sm" onclick="copyToClipboard(document.querySelector('.email-body')?.textContent || '')">Copy Email</button>
            </div>
        </div>
    `;
}

// === Pipeline View ===
let pipelineActiveTab = 'board';

async function renderPipeline(container) {
    container.innerHTML = `<div class="loading-container"><div class="spinner spinner-lg"></div><span>Loading pipeline...</span></div>`;

    const statuses = ['interested', 'prepared', 'applied', 'interviewing', 'offered', 'rejected'];
    const statusLabels = {
        interested: 'Interested', prepared: 'Prepared', applied: 'Applied',
        interviewing: 'Interviewing', offered: 'Offered', rejected: 'Rejected'
    };
    const statusColors = {
        interested: 'var(--text-secondary)', prepared: 'var(--accent)',
        applied: 'var(--score-green)', interviewing: 'var(--score-amber)',
        offered: '#22c55e', rejected: 'var(--danger)'
    };

    try {
        const [pipelineResults, offersData] = await Promise.all([
            Promise.all(statuses.map(s => api.request('GET', `/api/pipeline/${s}`))),
            api.request('GET', '/api/offers')
        ]);
        const results = pipelineResults;
        const hasOffers = offersData.offers && offersData.offers.length > 0;
        const offeredIdx = statuses.indexOf('offered');
        const hasOfferedJobs = results[offeredIdx] && results[offeredIdx].count > 0;

        container.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
                <h1 style="font-size:1.5rem;font-weight:700;letter-spacing:-0.02em;margin:0">Pipeline</h1>
                <div class="tab-bar">
                    <button class="tab-btn ${pipelineActiveTab === 'board' ? 'active' : ''}" data-pipeline-tab="board">Board</button>
                    <button class="tab-btn ${pipelineActiveTab === 'offers' ? 'active' : ''}" data-pipeline-tab="offers">
                        Offers${hasOffers ? ` <span class="badge badge-sm">${offersData.offers.length}</span>` : ''}
                    </button>
                </div>
            </div>
            <div id="pipeline-tab-content"></div>
        `;

        container.querySelectorAll('[data-pipeline-tab]').forEach(btn => {
            btn.addEventListener('click', () => {
                pipelineActiveTab = btn.dataset.pipelineTab;
                container.querySelectorAll('[data-pipeline-tab]').forEach(b => b.classList.toggle('active', b === btn));
                if (pipelineActiveTab === 'board') {
                    renderPipelineBoard(container.querySelector('#pipeline-tab-content'), results, statuses, statusLabels, statusColors, container);
                } else {
                    renderOffersTab(container.querySelector('#pipeline-tab-content'), offersData.offers, results[offeredIdx]?.jobs || []);
                }
            });
        });

        const tabContent = container.querySelector('#pipeline-tab-content');
        if (pipelineActiveTab === 'offers') {
            renderOffersTab(tabContent, offersData.offers, results[offeredIdx]?.jobs || []);
        } else {
            renderPipelineBoard(tabContent, results, statuses, statusLabels, statusColors, container);
        }
    } catch (err) {
        container.innerHTML = `<div class="empty-state"><div class="empty-state-title">Failed to load pipeline</div><div class="empty-state-desc">${escapeHtml(err.message)}</div></div>`;
    }
}

function renderPipelineBoard(tabContent, results, statuses, statusLabels, statusColors, container) {
    tabContent.innerHTML = `
            <div class="pipeline-board">
                ${statuses.map((status, i) => `
                    <div class="pipeline-column" data-status="${status}">
                        <div class="pipeline-column-header" style="border-top: 3px solid ${statusColors[status]}">
                            <span>${statusLabels[status]}</span>
                            <span class="pipeline-count">${results[i].count}</span>
                        </div>
                        <div class="pipeline-cards" data-status="${status}">
                            ${results[i].jobs.map(job => `
                                <div class="card pipeline-card" draggable="true" data-job-id="${job.id}" data-status="${status}">
                                    <div class="pipeline-card-title">${escapeHtml(job.title)}</div>
                                    <div class="pipeline-card-company">${escapeHtml(job.company)}</div>
                                    ${job.match_score ? `<span class="score-badge ${getScoreClass(job.match_score)}" style="font-size:0.7rem">${job.match_score}</span>` : ''}
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `).join('')}
            </div>
        `;

        // Drag-and-drop handlers
        let draggedCard = null;

        tabContent.querySelectorAll('.pipeline-card[draggable]').forEach(card => {
            card.addEventListener('dragstart', (e) => {
                draggedCard = card;
                card.classList.add('pipeline-card-dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', card.dataset.jobId);
            });

            card.addEventListener('dragend', () => {
                card.classList.remove('pipeline-card-dragging');
                draggedCard = null;
                tabContent.querySelectorAll('.pipeline-cards').forEach(zone => {
                    zone.classList.remove('pipeline-drop-target');
                });
            });

            card.addEventListener('click', () => {
                navigate(`#/job/${card.dataset.jobId}`);
            });
        });

        tabContent.querySelectorAll('.pipeline-cards').forEach(dropZone => {
            dropZone.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                dropZone.classList.add('pipeline-drop-target');
            });

            dropZone.addEventListener('dragleave', (e) => {
                if (!dropZone.contains(e.relatedTarget)) {
                    dropZone.classList.remove('pipeline-drop-target');
                }
            });

            dropZone.addEventListener('drop', async (e) => {
                e.preventDefault();
                dropZone.classList.remove('pipeline-drop-target');
                if (!draggedCard) return;

                const jobId = draggedCard.dataset.jobId;
                const oldStatus = draggedCard.dataset.status;
                const newStatus = dropZone.dataset.status;
                if (oldStatus === newStatus) return;

                // Optimistic move
                dropZone.appendChild(draggedCard);
                draggedCard.dataset.status = newStatus;

                // Update column counts
                const oldCol = tabContent.querySelector(`.pipeline-column[data-status="${oldStatus}"] .pipeline-count`);
                const newCol = tabContent.querySelector(`.pipeline-column[data-status="${newStatus}"] .pipeline-count`);
                if (oldCol) oldCol.textContent = parseInt(oldCol.textContent) - 1;
                if (newCol) newCol.textContent = parseInt(newCol.textContent) + 1;

                try {
                    await api.updateApplication(jobId, newStatus);
                    showToast(`Moved to ${statusLabels[newStatus]}`, 'success');
                } catch (err) {
                    showToast(`Failed to move: ${err.message}`, 'error');
                    await renderPipeline(container);
                }
            });
        });
}

// === Offers Tab ===

function formatCurrency(val) {
    if (!val && val !== 0) return '-';
    return '$' + Number(val).toLocaleString();
}

async function renderOffersTab(tabContent, offers, offeredJobs) {
    const jobMap = {};
    offeredJobs.forEach(j => { jobMap[j.id] = j; });
    offers.forEach(o => { if (o.title) jobMap[o.job_id] = { id: o.job_id, title: o.title, company: o.company }; });

    tabContent.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
            <p style="color:var(--text-secondary);margin:0">${offers.length} offer${offers.length !== 1 ? 's' : ''} tracked</p>
            <div style="display:flex;gap:8px">
                ${offers.length >= 2 ? `<button id="compare-offers-btn" class="btn btn-primary btn-sm">Compare Offers</button>` : ''}
                <button id="add-offer-btn" class="btn btn-primary btn-sm">+ Add Offer</button>
            </div>
        </div>
        <div id="offers-list"></div>
        <div id="offer-form-container" style="display:none"></div>
        <div id="offer-comparison-container" style="display:none"></div>
    `;

    renderOffersList(tabContent, offers, jobMap);

    tabContent.querySelector('#add-offer-btn')?.addEventListener('click', () => {
        showOfferForm(tabContent, null, offeredJobs, offers, jobMap);
    });

    tabContent.querySelector('#compare-offers-btn')?.addEventListener('click', async () => {
        await showOfferComparison(tabContent);
    });
}

function renderOffersList(tabContent, offers, jobMap) {
    const listEl = tabContent.querySelector('#offers-list');
    if (!offers.length) {
        listEl.innerHTML = `<div class="empty-state"><div class="empty-state-title">No offers yet</div><div class="empty-state-desc">Add an offer when a job reaches the "offered" stage</div></div>`;
        return;
    }

    listEl.innerHTML = offers.map(offer => {
        const job = jobMap[offer.job_id] || {};
        const base = offer.base || 0;
        const equity = offer.equity || 0;
        const bonus = offer.bonus || 0;
        const totalCash = base + bonus;
        return `
            <div class="card offer-card" style="margin-bottom:12px;padding:16px">
                <div style="display:flex;justify-content:space-between;align-items:flex-start">
                    <div>
                        <div style="font-weight:600;font-size:0.95rem">${escapeHtml(job.title || 'Unknown Position')}</div>
                        <div style="color:var(--text-secondary);font-size:0.85rem">${escapeHtml(job.company || '')}${offer.location ? ` \u2022 ${escapeHtml(offer.location)}` : ''}</div>
                    </div>
                    <div style="display:flex;gap:6px">
                        <button class="btn btn-ghost btn-sm offer-edit-btn" data-offer-id="${offer.id}" title="Edit">Edit</button>
                        <button class="btn btn-ghost btn-sm offer-delete-btn" data-offer-id="${offer.id}" title="Delete" style="color:var(--danger)">Delete</button>
                    </div>
                </div>
                <div class="offer-comp-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-top:12px">
                    <div><div style="font-size:0.75rem;color:var(--text-secondary)">Base</div><div style="font-weight:600">${formatCurrency(base)}</div></div>
                    <div><div style="font-size:0.75rem;color:var(--text-secondary)">Bonus</div><div style="font-weight:600">${formatCurrency(bonus)}</div></div>
                    <div><div style="font-size:0.75rem;color:var(--text-secondary)">Equity</div><div style="font-weight:600">${formatCurrency(equity)}</div></div>
                    <div><div style="font-size:0.75rem;color:var(--text-secondary)">Total Cash</div><div style="font-weight:600;color:var(--accent)">${formatCurrency(totalCash)}</div></div>
                    ${offer.pto_days ? `<div><div style="font-size:0.75rem;color:var(--text-secondary)">PTO</div><div style="font-weight:600">${offer.pto_days} days</div></div>` : ''}
                    ${offer.remote_days ? `<div><div style="font-size:0.75rem;color:var(--text-secondary)">Remote</div><div style="font-weight:600">${offer.remote_days} days/wk</div></div>` : ''}
                </div>
                ${offer.notes ? `<div style="margin-top:8px;font-size:0.85rem;color:var(--text-secondary)">${escapeHtml(offer.notes)}</div>` : ''}
            </div>
        `;
    }).join('');

    listEl.querySelectorAll('.offer-edit-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const offerId = parseInt(btn.dataset.offerId);
            const offer = offers.find(o => o.id === offerId);
            if (offer) showOfferForm(tabContent, offer, Object.values(jobMap), offers, jobMap);
        });
    });

    listEl.querySelectorAll('.offer-delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm('Delete this offer?')) return;
            try {
                await api.request('DELETE', `/api/offers/${btn.dataset.offerId}`);
                showToast('Offer deleted', 'success');
                const refreshed = await api.request('GET', '/api/offers');
                offers.length = 0;
                refreshed.offers.forEach(o => offers.push(o));
                renderOffersList(tabContent, offers, jobMap);
            } catch (err) {
                showToast(`Failed to delete: ${err.message}`, 'error');
            }
        });
    });
}

function showOfferForm(tabContent, existingOffer, availableJobs, offers, jobMap) {
    const formContainer = tabContent.querySelector('#offer-form-container');
    formContainer.style.display = 'block';
    const isEdit = !!existingOffer;

    const jobOptions = (Array.isArray(availableJobs) ? availableJobs : []).map(j => {
        const job = j.id ? j : { id: j.job_id, title: j.title, company: j.company };
        const selected = existingOffer && existingOffer.job_id === job.id ? 'selected' : '';
        return `<option value="${job.id}" ${selected}>${escapeHtml(job.title || '')} - ${escapeHtml(job.company || '')}</option>`;
    }).join('');

    formContainer.innerHTML = `
        <div class="card" style="padding:20px;margin-bottom:16px;border:2px solid var(--accent)">
            <h3 style="margin:0 0 16px;font-size:1rem">${isEdit ? 'Edit' : 'Add'} Offer</h3>
            <form id="offer-form">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                    <div style="grid-column:1/-1">
                        <label class="form-label">Job</label>
                        <select name="job_id" class="form-input" required>${jobOptions}</select>
                    </div>
                    <div>
                        <label class="form-label">Base Salary ($)</label>
                        <input type="number" name="base" class="form-input" value="${existingOffer?.base || ''}" placeholder="120000">
                    </div>
                    <div>
                        <label class="form-label">Bonus ($)</label>
                        <input type="number" name="bonus" class="form-input" value="${existingOffer?.bonus || ''}" placeholder="15000">
                    </div>
                    <div>
                        <label class="form-label">Equity ($/yr)</label>
                        <input type="number" name="equity" class="form-input" value="${existingOffer?.equity || ''}" placeholder="25000">
                    </div>
                    <div>
                        <label class="form-label">Health Value ($/yr)</label>
                        <input type="number" name="health_value" class="form-input" value="${existingOffer?.health_value || ''}" placeholder="8000">
                    </div>
                    <div>
                        <label class="form-label">Retirement Match (%)</label>
                        <input type="number" name="retirement_match" class="form-input" step="0.1" value="${existingOffer?.retirement_match || ''}" placeholder="6">
                    </div>
                    <div>
                        <label class="form-label">Relocation ($)</label>
                        <input type="number" name="relocation" class="form-input" value="${existingOffer?.relocation || ''}" placeholder="5000">
                    </div>
                    <div>
                        <label class="form-label">PTO Days</label>
                        <input type="number" name="pto_days" class="form-input" value="${existingOffer?.pto_days || ''}" placeholder="20">
                    </div>
                    <div>
                        <label class="form-label">Remote Days/Week</label>
                        <input type="number" name="remote_days" class="form-input" value="${existingOffer?.remote_days || ''}" placeholder="3">
                    </div>
                    <div style="grid-column:1/-1">
                        <label class="form-label">Location</label>
                        <input type="text" name="location" class="form-input" value="${escapeHtml(existingOffer?.location || '')}" placeholder="City, State">
                    </div>
                    <div style="grid-column:1/-1">
                        <label class="form-label">Notes</label>
                        <textarea name="notes" class="form-input" rows="2" placeholder="Additional details...">${escapeHtml(existingOffer?.notes || '')}</textarea>
                    </div>
                </div>
                <div style="display:flex;gap:8px;margin-top:16px">
                    <button type="submit" class="btn btn-primary btn-sm">${isEdit ? 'Update' : 'Add'} Offer</button>
                    <button type="button" id="cancel-offer-form" class="btn btn-ghost btn-sm">Cancel</button>
                </div>
            </form>
        </div>
    `;

    formContainer.querySelector('#cancel-offer-form').addEventListener('click', () => {
        formContainer.style.display = 'none';
        formContainer.innerHTML = '';
    });

    formContainer.querySelector('#offer-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const body = {};
        for (const [k, v] of fd.entries()) {
            if (v === '') continue;
            body[k] = ['job_id', 'base', 'bonus', 'equity', 'health_value', 'retirement_match', 'relocation', 'pto_days', 'remote_days'].includes(k)
                ? Number(v) : v;
        }

        try {
            if (isEdit) {
                await api.request('PUT', `/api/offers/${existingOffer.id}`, body);
                showToast('Offer updated', 'success');
            } else {
                await api.request('POST', '/api/offers', body);
                showToast('Offer added', 'success');
            }
            formContainer.style.display = 'none';
            formContainer.innerHTML = '';
            const refreshed = await api.request('GET', '/api/offers');
            offers.length = 0;
            refreshed.offers.forEach(o => offers.push(o));
            refreshed.offers.forEach(o => { if (o.title) jobMap[o.job_id] = { id: o.job_id, title: o.title, company: o.company }; });
            renderOffersList(tabContent, offers, jobMap);
            // Update compare button visibility
            const btnArea = tabContent.querySelector('#compare-offers-btn');
            if (!btnArea && offers.length >= 2) {
                const addBtn = tabContent.querySelector('#add-offer-btn');
                if (addBtn) {
                    const cmpBtn = document.createElement('button');
                    cmpBtn.id = 'compare-offers-btn';
                    cmpBtn.className = 'btn btn-primary btn-sm';
                    cmpBtn.textContent = 'Compare Offers';
                    cmpBtn.addEventListener('click', () => showOfferComparison(tabContent));
                    addBtn.parentElement.insertBefore(cmpBtn, addBtn);
                }
            }
        } catch (err) {
            showToast(`Failed to save offer: ${err.message}`, 'error');
        }
    });
}

async function showOfferComparison(tabContent) {
    const compContainer = tabContent.querySelector('#offer-comparison-container');
    compContainer.style.display = 'block';
    compContainer.innerHTML = `<div class="loading-container"><div class="spinner"></div><span>Calculating...</span></div>`;

    try {
        const { comparison } = await api.request('GET', '/api/offers/compare');
        if (!comparison || !comparison.length) {
            compContainer.innerHTML = `<div class="empty-state"><div class="empty-state-desc">No offers to compare</div></div>`;
            return;
        }

        const compFields = [
            { key: 'base', label: 'Base Salary' },
            { key: 'bonus', label: 'Bonus' },
            { key: 'equity', label: 'Equity' },
            { key: 'health_value', label: 'Health Benefits' },
            { key: 'retirement_value', label: 'Retirement (calc)' },
            { key: 'relocation', label: 'Relocation' },
            { key: 'pto_value', label: 'PTO Value' },
            { key: 'total_cash', label: 'Total Cash' },
            { key: 'total_comp', label: 'Total Comp' },
            { key: 'total_with_pto', label: 'Total + PTO Value' },
        ];

        const bestTotal = comparison[0]?.total_comp || 0;

        compContainer.innerHTML = `
            <div class="card" style="padding:20px;margin-top:16px;overflow-x:auto">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
                    <h3 style="margin:0;font-size:1rem">Offer Comparison</h3>
                    <button id="close-comparison" class="btn btn-ghost btn-sm">Close</button>
                </div>
                <table class="comparison-table" style="width:100%">
                    <thead>
                        <tr>
                            <th style="text-align:left;padding:8px 12px;min-width:140px">Component</th>
                            ${comparison.map((c, i) => `
                                <th style="text-align:right;padding:8px 12px;min-width:140px">
                                    <div style="font-weight:600">${escapeHtml(c.location || `Offer ${i + 1}`)}</div>
                                    ${i === 0 ? '<span class="badge badge-sm" style="background:var(--score-green);color:#fff;font-size:0.65rem">Best</span>' : ''}
                                </th>
                            `).join('')}
                        </tr>
                    </thead>
                    <tbody>
                        ${compFields.map(f => {
                            const isTotal = f.key.startsWith('total');
                            return `
                                <tr style="${isTotal ? 'font-weight:600;border-top:2px solid var(--border)' : ''}">
                                    <td style="padding:8px 12px;color:var(--text-secondary);font-size:0.85rem">${f.label}</td>
                                    ${comparison.map(c => {
                                        const val = c[f.key] || 0;
                                        const isBest = isTotal && val === bestTotal && f.key === 'total_comp';
                                        return `<td style="padding:8px 12px;text-align:right;${isBest ? 'color:var(--score-green)' : ''}">${formatCurrency(val)}</td>`;
                                    }).join('')}
                                </tr>
                            `;
                        }).join('')}
                        <tr style="border-top:2px solid var(--border)">
                            <td style="padding:8px 12px;color:var(--text-secondary);font-size:0.85rem">vs Best</td>
                            ${comparison.map(c => {
                                const diff = c.vs_best || 0;
                                const color = diff === 0 ? 'var(--score-green)' : 'var(--danger)';
                                return `<td style="padding:8px 12px;text-align:right;color:${color};font-weight:600">${diff === 0 ? '-' : formatCurrency(diff)}</td>`;
                            }).join('')}
                        </tr>
                    </tbody>
                </table>

                ${comparison.length > 0 ? `
                    <div style="margin-top:20px">
                        <h4 style="font-size:0.9rem;margin-bottom:12px">Compensation Breakdown</h4>
                        <div style="display:flex;gap:16px;flex-wrap:wrap">
                            ${comparison.map((c, i) => {
                                const total = c.total_comp || 1;
                                const segments = [
                                    { label: 'Base', val: c.base, color: 'var(--accent)' },
                                    { label: 'Bonus', val: c.bonus, color: 'var(--score-green)' },
                                    { label: 'Equity', val: c.equity, color: 'var(--score-amber)' },
                                    { label: 'Benefits', val: (c.health_value || 0) + (c.retirement_value || 0) + (c.relocation || 0), color: '#8b5cf6' },
                                ];
                                return `
                                    <div style="flex:1;min-width:200px">
                                        <div style="font-size:0.8rem;font-weight:600;margin-bottom:6px">${escapeHtml(c.location || `Offer ${i + 1}`)}</div>
                                        <div style="height:24px;display:flex;border-radius:6px;overflow:hidden;background:var(--bg-secondary)">
                                            ${segments.filter(s => s.val > 0).map(s => `
                                                <div title="${s.label}: ${formatCurrency(s.val)}" style="width:${(s.val / total * 100).toFixed(1)}%;background:${s.color};min-width:2px"></div>
                                            `).join('')}
                                        </div>
                                        <div style="display:flex;gap:8px;margin-top:4px;flex-wrap:wrap">
                                            ${segments.filter(s => s.val > 0).map(s => `
                                                <span style="font-size:0.7rem;color:var(--text-secondary);display:flex;align-items:center;gap:3px">
                                                    <span style="width:8px;height:8px;border-radius:50%;background:${s.color};display:inline-block"></span>
                                                    ${s.label}
                                                </span>
                                            `).join('')}
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                ` : ''}
            </div>
        `;

        compContainer.querySelector('#close-comparison').addEventListener('click', () => {
            compContainer.style.display = 'none';
            compContainer.innerHTML = '';
        });
    } catch (err) {
        compContainer.innerHTML = `<div class="empty-state"><div class="empty-state-desc">Failed to compare: ${escapeHtml(err.message)}</div></div>`;
    }
}

// === Triage Mode ===
let triageActive = false;
let triageJobs = [];
let triageIndex = 0;
let triageUndoStack = [];

async function enterTriageMode() {
    if (triageActive) return;
    triageActive = true;
    triageUndoStack = [];

    const savedState = loadSavedFilterState();
    const params = {
        limit: 200,
        offset: 0,
        min_score: savedState?.['filter-score'] || '',
        sort: 'score',
        search: savedState?.['filter-search'] || '',
        work_type: savedState?.['filter-work-type'] || '',
        employment_type: savedState?.['filter-employment'] || '',
        location: savedState?.['filter-location'] || '',
        region: savedState?.['filter-region'] || '',
        clearance: savedState?.['filter-clearance'] || '',
        posted_within: savedState?.['filter-posted-within'] || '',
    };

    try {
        const data = await api.getJobs(params);
        triageJobs = (data.jobs || []).filter(j => !j.app_status);
        triageIndex = 0;
        if (triageJobs.length === 0) {
            showToast('No jobs to triage', 'info');
            triageActive = false;
            return;
        }
        renderTriageCard();
    } catch (err) {
        showToast(`Failed to load triage: ${err.message}`, 'error');
        triageActive = false;
    }
}

function exitTriageMode() {
    triageActive = false;
    triageJobs = [];
    triageIndex = 0;
    triageUndoStack = [];
    handleRoute();
}

function renderTriageCard() {
    const container = document.getElementById('app');
    if (triageIndex >= triageJobs.length) {
        container.innerHTML = `
            <div class="triage-container">
                <div class="triage-done">
                    <div class="empty-state-icon">&#9989;</div>
                    <div class="empty-state-title">Triage complete!</div>
                    <div class="empty-state-desc">You reviewed ${triageJobs.length} jobs.</div>
                    <button class="btn btn-primary" style="margin-top:16px" onclick="exitTriageMode()">Back to Feed</button>
                </div>
            </div>
        `;
        return;
    }

    const job = triageJobs[triageIndex];
    const score = job.match_score;
    const reasons = job.match_reasons ? JSON.parse(job.match_reasons) : [];
    const concerns = job.concerns ? JSON.parse(job.concerns) : [];
    const salary = formatSalary(job.salary_min, job.salary_max, job.salary_estimate_min, job.salary_estimate_max);

    container.innerHTML = `
        <div class="triage-container">
            <div class="triage-header">
                <span class="triage-progress">${triageIndex + 1} of ${triageJobs.length}</span>
                <div class="triage-progress-bar">
                    <div class="triage-progress-fill" style="width:${((triageIndex + 1) / triageJobs.length) * 100}%"></div>
                </div>
                <button class="btn btn-ghost btn-sm" onclick="exitTriageMode()">Exit Triage</button>
            </div>
            <div class="triage-card card">
                <div class="triage-card-body">
                    <div class="triage-score-row">
                        ${score != null ? `<span class="score-badge score-large ${getScoreClass(score)}">${score}</span>` : '<span class="score-badge score-large score-badge-none">--</span>'}
                        <div>
                            <div class="triage-title">${escapeHtml(job.title)}</div>
                            <div class="triage-company">${escapeHtml(job.company)}${job.location ? ` &mdash; ${escapeHtml(job.location)}` : ''}</div>
                        </div>
                    </div>
                    ${salary ? `<div class="triage-salary">${salary}</div>` : ''}
                    ${reasons.length ? `
                        <div class="triage-section">
                            <div class="triage-section-label">Match Reasons</div>
                            <ul class="score-reasons">${reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
                        </div>
                    ` : ''}
                    ${concerns.length ? `
                        <div class="triage-section">
                            <div class="triage-section-label">Concerns</div>
                            <ul class="score-concerns">${concerns.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
                        </div>
                    ` : ''}
                    <div class="triage-actions">
                        <button class="btn btn-primary" id="triage-keep-btn">Keep &amp; Prepare &rarr;</button>
                        <button class="btn btn-secondary" id="triage-skip-btn">Skip &rarr;</button>
                        <button class="btn btn-danger" id="triage-dismiss-btn">Dismiss</button>
                        <button class="btn btn-ghost" id="triage-view-btn">View Details</button>
                        ${triageUndoStack.length ? '<button class="btn btn-ghost" id="triage-undo-btn">Undo</button>' : ''}
                    </div>
                    <div class="triage-shortcuts-hint">
                        <kbd>&rarr;</kbd> Keep &nbsp; <kbd>&larr;</kbd> Dismiss &nbsp; <kbd>&darr;</kbd> Skip &nbsp; <kbd>Enter</kbd> View &nbsp; <kbd>z</kbd> Undo &nbsp; <kbd>Esc</kbd> Exit
                    </div>
                </div>
            </div>
        </div>
    `;

    document.getElementById('triage-keep-btn').addEventListener('click', triageKeep);
    document.getElementById('triage-skip-btn').addEventListener('click', triageSkip);
    document.getElementById('triage-dismiss-btn').addEventListener('click', triageDismiss);
    document.getElementById('triage-view-btn').addEventListener('click', () => navigate(`#/job/${job.id}`));
    const undoBtn = document.getElementById('triage-undo-btn');
    if (undoBtn) undoBtn.addEventListener('click', triageUndo);
}

function formatSalary(min, max, estMin, estMax) {
    const lo = min || estMin;
    const hi = max || estMax;
    if (!lo && !hi) return '';
    const fmt = (n) => '$' + (n / 1000).toFixed(0) + 'k';
    if (lo && hi) return `${fmt(lo)} - ${fmt(hi)}`;
    if (lo) return `${fmt(lo)}+`;
    return `Up to ${fmt(hi)}`;
}

async function triageKeep() {
    const job = triageJobs[triageIndex];
    triageUndoStack.push({ index: triageIndex, action: 'keep', jobId: job.id });
    try {
        await api.prepareApplication(job.id);
    } catch {}
    triageIndex++;
    renderTriageCard();
}

function triageSkip() {
    triageUndoStack.push({ index: triageIndex, action: 'skip' });
    triageIndex++;
    renderTriageCard();
}

async function triageDismiss() {
    const job = triageJobs[triageIndex];
    triageUndoStack.push({ index: triageIndex, action: 'dismiss', jobId: job.id });
    try {
        await api.dismissJob(job.id);
    } catch {}
    triageIndex++;
    renderTriageCard();
}

async function triageUndo() {
    if (!triageUndoStack.length) return;
    const last = triageUndoStack.pop();
    triageIndex = last.index;
    // No API undo for dismiss/keep — the card just goes back in view
    renderTriageCard();
}

// === Stats Dashboard View ===
async function renderStats(container) {
    container.innerHTML = `<div class="loading-container"><div class="spinner spinner-lg"></div><span>Loading stats...</span></div>`;

    try {
        const stats = await api.getStats();
        container.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
                <h1 style="font-size:1.5rem;font-weight:700;letter-spacing:-0.02em">Dashboard</h1>
                <div style="display:flex;gap:8px">
                    <button class="btn btn-primary" id="stats-scrape-btn">Scrape Now</button>
                    <button class="btn btn-secondary" id="stats-score-btn">${stats.total_jobs - stats.total_scored > 0 ? `Score ${stats.total_jobs - stats.total_scored} Unscored` : 'All Scored'}</button>
                    <button class="btn btn-secondary" id="stats-export-btn">Export CSV</button>
                </div>
            </div>
            <div class="stats-grid">
                <div class="card stat-card">
                    <div class="stat-number">${stats.total_jobs || 0}</div>
                    <div class="stat-label">Total Jobs</div>
                </div>
                <div class="card stat-card">
                    <div class="stat-number">${stats.total_scored || 0}</div>
                    <div class="stat-label">Scored</div>
                </div>
                <div class="card stat-card">
                    <div class="stat-number">${stats.total_applied || 0}</div>
                    <div class="stat-label">Applied</div>
                </div>
                <div class="card stat-card">
                    <div class="stat-number">${stats.total_interviewing || 0}</div>
                    <div class="stat-label">Interviewing</div>
                </div>
            </div>
            <div class="pipeline-section">
                <h2>Pipeline</h2>
                <div class="pipeline-funnel">
                    <div class="card pipeline-stage">
                        <div class="stage-count">${stats.total_interested || 0}</div>
                        <div class="stage-label">Interested</div>
                    </div>
                    <div class="card pipeline-stage">
                        <div class="stage-count">${stats.total_prepared || 0}</div>
                        <div class="stage-label">Prepared</div>
                    </div>
                    <div class="card pipeline-stage">
                        <div class="stage-count">${stats.total_applied || 0}</div>
                        <div class="stage-label">Applied</div>
                    </div>
                    <div class="card pipeline-stage">
                        <div class="stage-count">${stats.total_interviewing || 0}</div>
                        <div class="stage-label">Interviewing</div>
                    </div>
                </div>
            </div>
            <div class="card" style="padding:24px;margin-top:24px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
                    <h2 style="font-size:1.125rem;font-weight:600;margin:0">Daily Digest</h2>
                    <button class="btn btn-secondary btn-sm" id="copy-digest-btn">Copy to Clipboard</button>
                </div>
                <div id="digest-container">
                    <div class="loading-container"><span class="spinner"></span></div>
                </div>
            </div>
            <div class="card" style="padding:24px;margin-top:24px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
                    <h2 style="font-size:1.125rem;font-weight:600;margin:0">Follow-Up Reminders</h2>
                </div>
                <div id="reminders-container">
                    <div class="loading-container"><span class="spinner"></span></div>
                </div>
            </div>
            <div class="card" style="padding:24px;margin-top:24px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
                    <h2 style="font-size:1.125rem;font-weight:600;margin:0">Skill Gap Analysis</h2>
                    <button class="btn btn-primary btn-sm" id="analyze-skills-btn">Analyze with AI</button>
                </div>
                <p style="color:var(--text-secondary);font-size:0.875rem;margin-bottom:12px">Skills that would unlock more job matches (from jobs scoring 50-80).</p>
                <div id="skill-gaps-container">
                    <div class="loading-container"><span class="spinner"></span></div>
                </div>
            </div>
            <div class="card" style="padding:24px;margin-top:24px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
                    <h2 style="font-size:1.125rem;font-weight:600;margin:0">Application Analytics</h2>
                </div>
                <div id="analytics-container">
                    <div class="loading-container"><span class="spinner"></span></div>
                </div>
            </div>
            <div class="card" style="padding:24px;margin-top:24px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
                    <h2 style="font-size:1.125rem;font-weight:600;margin:0">Response Tracking</h2>
                </div>
                <div id="response-analytics-container">
                    <div class="loading-container"><span class="spinner"></span></div>
                </div>
            </div>
            <div class="card" style="padding:24px;margin-top:24px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
                    <h2 style="font-size:1.125rem;font-weight:600;margin:0">Career Advisor</h2>
                    <button class="btn btn-primary btn-sm" id="career-analyze-btn">Analyze Career</button>
                </div>
                <p style="font-size:0.875rem;color:var(--text-secondary);margin-bottom:12px">AI-powered career trajectory analysis with actionable suggestions.</p>
                <div id="career-advisor-container">
                    <div class="loading-container"><span class="spinner"></span></div>
                </div>
            </div>
        `;

        document.getElementById('stats-scrape-btn').addEventListener('click', handleScrape);
        const scoreBtn = document.getElementById('stats-score-btn');
        let scoringPollInterval = null;
        function stopScoringPoll() {
            if (scoringPollInterval) { clearInterval(scoringPollInterval); scoringPollInterval = null; }
        }
        function startScoringPoll() {
            stopScoringPoll();
            scoringPollInterval = setInterval(async () => {
                try {
                    const p = await api.request('GET', '/api/score/progress');
                    if (p.active && p.total > 0) {
                        const pct = Math.round((p.scored / p.total) * 100);
                        scoreBtn.innerHTML = `<span class="spinner"></span> ${p.scored}/${p.total} (${pct}%)`;
                    } else if (!p.active && p.total > 0) {
                        stopScoringPoll();
                        scoreBtn.disabled = false;
                        scoreBtn.textContent = 'All Scored';
                        showToast(`Scored ${p.scored} jobs`, 'success');
                        loadPage('stats');
                    }
                } catch {}
            }, 2000);
        }
        scoreBtn.addEventListener('click', async () => {
            scoreBtn.disabled = true;
            scoreBtn.innerHTML = '<span class="spinner"></span> Starting...';
            try {
                await api.request('POST', '/api/score');
                startScoringPoll();
            } catch (err) {
                scoreBtn.disabled = false;
                scoreBtn.textContent = 'Score';
                showToast(err.message, 'error');
            }
        });
        // Check if scoring is already in progress
        try {
            const p = await api.request('GET', '/api/score/progress');
            if (p.active) {
                scoreBtn.disabled = true;
                scoreBtn.innerHTML = `<span class="spinner"></span> ${p.scored}/${p.total}`;
                startScoringPoll();
            }
        } catch {}
        // Check if scraping is already in progress
        try {
            const sp = await api.request('GET', '/api/scrape/progress');
            if (sp.active) {
                const scrapeBtn = document.getElementById('stats-scrape-btn');
                if (scrapeBtn) {
                    scrapeBtn.disabled = true;
                    const label = sp.current ? `${sp.current} (${sp.completed}/${sp.total})` : `${sp.completed}/${sp.total}`;
                    scrapeBtn.innerHTML = `<span class="spinner"></span> ${label}`;
                }
                startScrapePoll();
            }
        } catch {}
        document.getElementById('stats-export-btn').addEventListener('click', () => {
            window.location.href = '/api/export/csv';
        });

        // Fetch digest
        try {
            const digest = await api.request('GET', '/api/digest');
            const digestContainer = document.getElementById('digest-container');
            if (digest.job_count === 0) {
                digestContainer.innerHTML = '<div style="font-size:0.875rem;color:var(--text-tertiary)">No new matches in the last 24 hours.</div>';
            } else {
                digestContainer.innerHTML = `
                    <div style="font-size:0.875rem;color:var(--text-secondary);margin-bottom:12px">${digest.job_count} new match${digest.job_count !== 1 ? 'es' : ''} in the last 24 hours</div>
                    <div style="display:flex;flex-direction:column;gap:8px">
                        ${digest.jobs.map(j => `
                            <a href="#/job/${j.id}" style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--bg-surface-secondary);border-radius:var(--radius-sm);text-decoration:none">
                                <div>
                                    <div style="font-size:0.875rem;font-weight:500;color:var(--text-primary)">${escapeHtml(j.title)}</div>
                                    <div style="font-size:0.75rem;color:var(--text-tertiary)">${escapeHtml(j.company)}${j.location ? ' · ' + escapeHtml(j.location) : ''}</div>
                                </div>
                                <span class="score-badge ${getScoreClass(j.match_score)}" style="font-size:0.75rem">${j.match_score}</span>
                            </a>
                        `).join('')}
                    </div>
                `;
            }

            // Copy digest button
            document.getElementById('copy-digest-btn').addEventListener('click', () => {
                copyToClipboard(digest.body);
                showToast('Digest copied to clipboard', 'success');
            });
        } catch (err) {
            document.getElementById('digest-container').innerHTML = '<div style="font-size:0.8125rem;color:var(--text-tertiary)">Could not load digest.</div>';
        }

        // Fetch reminders
        try {
            const reminderData = await api.request('GET', '/api/reminders/due');
            const allReminders = await api.request('GET', '/api/reminders?status=pending');
            const due = reminderData.reminders || [];
            const upcoming = (allReminders.reminders || []).filter(r => !due.find(d => d.id === r.id));
            const remindersContainer = document.getElementById('reminders-container');
            if (due.length === 0 && upcoming.length === 0) {
                remindersContainer.innerHTML = '<div style="font-size:0.875rem;color:var(--text-tertiary)">No pending follow-up reminders.</div>';
            } else {
                const renderReminder = (r, isDue) => `
                    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:${isDue ? 'var(--score-red-bg, #fef2f2)' : 'var(--bg-surface-secondary)'};border-radius:var(--radius-sm);border-left:3px solid ${isDue ? 'var(--danger, #ef4444)' : 'var(--accent)'}">
                        <div>
                            <a href="#/job/${r.job_id}" style="font-size:0.875rem;font-weight:500;color:var(--text-primary);text-decoration:none">${escapeHtml(r.title || 'Unknown')}</a>
                            <div style="font-size:0.75rem;color:var(--text-tertiary)">${escapeHtml(r.company || '')} &middot; ${isDue ? 'Overdue' : formatDate(r.remind_at)}</div>
                        </div>
                        <div style="display:flex;gap:6px">
                            <button class="btn btn-sm" onclick="completeReminder(${r.id})" style="font-size:0.75rem;padding:4px 8px">Done</button>
                            <button class="btn btn-sm btn-secondary" onclick="dismissReminder(${r.id})" style="font-size:0.75rem;padding:4px 8px">Dismiss</button>
                        </div>
                    </div>
                `;
                remindersContainer.innerHTML = `
                    ${due.length > 0 ? `<div style="font-size:0.8125rem;font-weight:600;color:var(--danger, #ef4444);margin-bottom:6px">${due.length} overdue</div>` : ''}
                    <div style="display:flex;flex-direction:column;gap:6px">
                        ${due.map(r => renderReminder(r, true)).join('')}
                        ${upcoming.slice(0, 5).map(r => renderReminder(r, false)).join('')}
                    </div>
                `;
            }
        } catch {
            document.getElementById('reminders-container').innerHTML = '<div style="font-size:0.8125rem;color:var(--text-tertiary)">Could not load reminders.</div>';
        }

        // Fetch skill gap data
        try {
            const gapData = await api.request('GET', '/api/skill-gaps');
            const gapsContainer = document.getElementById('skill-gaps-container');
            if (gapData.job_count === 0) {
                gapsContainer.innerHTML = '<div style="font-size:0.875rem;color:var(--text-tertiary)">No near-match jobs to analyze yet. Score some jobs first.</div>';
            } else {
                const keywords = (gapData.top_keywords || []).slice(0, 8);
                const concerns = (gapData.top_concerns || []).slice(0, 5);
                gapsContainer.innerHTML = `
                    <div style="font-size:0.875rem;color:var(--text-secondary);margin-bottom:12px">${gapData.job_count} jobs in the 50-80 score range</div>
                    ${keywords.length > 0 ? `
                        <div style="margin-bottom:12px">
                            <div style="font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:6px">Most requested skills you're missing:</div>
                            <div style="display:flex;flex-wrap:wrap;gap:6px">
                                ${keywords.map(([k, n]) => `<span style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;background:var(--accent-surface, #eff6ff);color:var(--accent);border-radius:999px;font-size:0.8125rem;font-weight:500">${escapeHtml(k)} <span style="color:var(--text-tertiary);font-size:0.75rem">${n}</span></span>`).join('')}
                            </div>
                        </div>
                    ` : ''}
                    ${concerns.length > 0 ? `
                        <div>
                            <div style="font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:6px">Common concerns:</div>
                            <div style="display:flex;flex-direction:column;gap:4px">
                                ${concerns.map(([c, n]) => `<div style="font-size:0.8125rem;color:var(--text-secondary)">&bull; ${escapeHtml(c)} <span style="color:var(--text-tertiary)">(${n})</span></div>`).join('')}
                            </div>
                        </div>
                    ` : ''}
                    <div id="ai-skill-analysis" style="margin-top:16px"></div>
                `;
            }
        } catch {
            document.getElementById('skill-gaps-container').innerHTML = '<div style="font-size:0.8125rem;color:var(--text-tertiary)">Could not load skill gaps.</div>';
        }

        // Analyze skills with AI button
        document.getElementById('analyze-skills-btn')?.addEventListener('click', async () => {
            const btn = document.getElementById('analyze-skills-btn');
            const resultDiv = document.getElementById('ai-skill-analysis');
            if (!resultDiv) return;
            btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Analyzing...';
            try {
                const result = await api.request('POST', '/api/skill-gaps/analyze');
                if (!result.skills || result.skills.length === 0) {
                    resultDiv.innerHTML = '<div style="font-size:0.875rem;color:var(--text-tertiary)">No skill recommendations available.</div>';
                } else {
                    resultDiv.innerHTML = `
                        <div style="font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:8px">AI Recommended Skills (by ROI):</div>
                        <div style="display:flex;flex-direction:column;gap:8px">
                            ${result.skills.map((s, i) => `
                                <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;background:var(--bg-surface-secondary);border-radius:var(--radius-sm);border-left:3px solid var(--accent)">
                                    <div style="font-size:1.25rem;font-weight:700;color:var(--accent);min-width:24px">${i + 1}</div>
                                    <div style="flex:1">
                                        <div style="font-weight:600;font-size:0.875rem">${escapeHtml(s.name)}</div>
                                        <div style="font-size:0.8125rem;color:var(--text-secondary);margin-top:2px">${escapeHtml(s.reason)}</div>
                                        <div style="display:flex;gap:12px;margin-top:4px;font-size:0.75rem;color:var(--text-tertiary)">
                                            <span>~${s.jobs_unlocked} jobs</span>
                                            <span>Difficulty: ${escapeHtml(s.difficulty)}</span>
                                            <span>${escapeHtml(s.time_estimate)}</span>
                                        </div>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    `;
                }
            } catch (err) {
                resultDiv.innerHTML = `<div style="color:var(--danger, #ef4444);font-size:0.875rem">${escapeHtml(err.message)}</div>`;
            }
            finally { btn.disabled = false; btn.textContent = 'Analyze with AI'; }
        });

        // Fetch analytics
        try {
            const analytics = await api.request('GET', '/api/analytics');
            const analyticsContainer = document.getElementById('analytics-container');
            const funnelEntries = Object.entries(analytics.funnel || {});
            const hasAnyFunnel = funnelEntries.some(([, v]) => v > 0);
            const maxFunnel = Math.max(...funnelEntries.map(([, v]) => v), 1);
            const calibration = analytics.score_calibration || {};
            const sources = analytics.sources || [];
            const maxSourceJobs = Math.max(...sources.map(s => s.jobs), 1);
            const velocity = analytics.weekly_velocity || [];
            const maxVelocity = Math.max(...velocity.map(v => v.count), 1);

            if (!hasAnyFunnel && sources.length === 0 && velocity.length === 0) {
                analyticsContainer.innerHTML = '<div style="font-size:0.875rem;color:var(--text-tertiary)">No application data yet. Start applying to jobs to see analytics.</div>';
            } else {
                const statusColors = {
                    interested: 'var(--accent, #3b82f6)',
                    prepared: '#8b5cf6',
                    applied: '#10b981',
                    interviewing: '#f59e0b',
                    offered: '#22c55e',
                    rejected: 'var(--danger, #ef4444)',
                };
                analyticsContainer.innerHTML = `
                    ${hasAnyFunnel ? `
                        <div style="margin-bottom:24px">
                            <div style="font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:8px">Application Funnel</div>
                            <div style="display:flex;flex-direction:column;gap:6px">
                                ${funnelEntries.map(([status, count]) => `
                                    <div style="display:flex;align-items:center;gap:8px">
                                        <div style="width:90px;font-size:0.8125rem;color:var(--text-secondary);text-transform:capitalize">${status}</div>
                                        <div style="flex:1;height:20px;background:var(--bg-surface-secondary);border-radius:var(--radius-sm);overflow:hidden">
                                            <div style="height:100%;width:${Math.round((count / maxFunnel) * 100)}%;background:${statusColors[status] || 'var(--accent)'};border-radius:var(--radius-sm);transition:width 0.3s"></div>
                                        </div>
                                        <div style="width:30px;text-align:right;font-size:0.8125rem;font-weight:600;color:var(--text-primary)">${count}</div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    ` : ''}
                    ${Object.values(calibration).some(v => v !== null) ? `
                        <div style="margin-bottom:24px">
                            <div style="font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:8px">Score Calibration (avg match score by status)</div>
                            <div style="display:flex;gap:12px;flex-wrap:wrap">
                                ${Object.entries(calibration).filter(([, v]) => v !== null).map(([status, avg]) => `
                                    <div style="flex:1;min-width:120px;padding:12px;background:var(--bg-surface-secondary);border-radius:var(--radius-sm);text-align:center">
                                        <div style="font-size:1.25rem;font-weight:700;color:${statusColors[status] || 'var(--text-primary)'}">${avg}</div>
                                        <div style="font-size:0.75rem;color:var(--text-tertiary);text-transform:capitalize;margin-top:4px">${status}</div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    ` : ''}
                    ${sources.length > 0 ? `
                        <div style="margin-bottom:24px">
                            <div style="font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:8px">Source Effectiveness</div>
                            <div style="display:flex;flex-direction:column;gap:6px">
                                ${sources.map(s => `
                                    <div style="display:flex;align-items:center;gap:8px">
                                        <div style="width:100px;font-size:0.8125rem;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(s.source)}">${escapeHtml(s.source)}</div>
                                        <div style="flex:1;height:20px;background:var(--bg-surface-secondary);border-radius:var(--radius-sm);overflow:hidden">
                                            <div style="height:100%;width:${Math.round((s.jobs / maxSourceJobs) * 100)}%;background:var(--accent, #3b82f6);border-radius:var(--radius-sm)"></div>
                                        </div>
                                        <div style="width:70px;text-align:right;font-size:0.75rem;color:var(--text-tertiary)">${s.jobs} jobs${s.avg_score ? ' · ' + s.avg_score : ''}</div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    ` : ''}
                    ${velocity.length > 0 ? `
                        <div>
                            <div style="font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:8px">Weekly Job Velocity</div>
                            <div style="display:flex;align-items:flex-end;gap:4px;height:80px">
                                ${velocity.map(v => `
                                    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%">
                                        <div style="width:100%;background:var(--accent, #3b82f6);border-radius:var(--radius-sm) var(--radius-sm) 0 0;height:${Math.round((v.count / maxVelocity) * 100)}%;min-height:2px" title="${v.week}: ${v.count} jobs"></div>
                                        <div style="font-size:0.625rem;color:var(--text-tertiary);margin-top:4px;writing-mode:vertical-lr;transform:rotate(180deg)">${v.week.replace(/^\d{4}-/, '')}</div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    ` : ''}
                `;
            }
        } catch {
            document.getElementById('analytics-container').innerHTML = '<div style="font-size:0.8125rem;color:var(--text-tertiary)">Could not load analytics.</div>';
        }

        // Fetch response analytics
        try {
            const ra = await api.request('GET', '/api/analytics/response-rates');
            const raContainer = document.getElementById('response-analytics-container');
            if (ra.total_applied === 0) {
                raContainer.innerHTML = '<div style="font-size:0.875rem;color:var(--text-tertiary)">No applications yet. Apply to jobs to see response analytics.</div>';
            } else {
                const typeLabels = { interview_invite: 'Interview Invites', rejection: 'Rejections', callback: 'Callbacks', ghosted: 'Ghosted' };
                const typeColors = { interview_invite: '#22c55e', rejection: '#ef4444', callback: '#3b82f6', ghosted: '#94a3b8' };
                const breakdown = ra.type_breakdown || {};
                const maxBreakdown = Math.max(...Object.values(breakdown), 1);
                const byScore = ra.by_score_range || [];
                const maxScoreApplied = Math.max(...byScore.map(s => s.applied), 1);

                raContainer.innerHTML = `
                    <div class="stats-grid" style="margin-bottom:20px">
                        <div class="card stat-card">
                            <div class="stat-number">${ra.response_rate}%</div>
                            <div class="stat-label">Response Rate</div>
                        </div>
                        <div class="card stat-card">
                            <div class="stat-number">${ra.total_responses}/${ra.total_applied}</div>
                            <div class="stat-label">Responses / Applied</div>
                        </div>
                        <div class="card stat-card">
                            <div class="stat-number">${ra.avg_days_to_response != null ? ra.avg_days_to_response + 'd' : '--'}</div>
                            <div class="stat-label">Avg Days to Response</div>
                        </div>
                    </div>
                    ${Object.keys(breakdown).length > 0 ? `
                        <div style="margin-bottom:20px">
                            <div style="font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:8px">Response Types</div>
                            <div style="display:flex;flex-direction:column;gap:6px">
                                ${Object.entries(breakdown).map(([type, count]) => `
                                    <div style="display:flex;align-items:center;gap:8px">
                                        <div style="width:120px;font-size:0.8125rem;color:var(--text-secondary);text-transform:capitalize">${typeLabels[type] || type}</div>
                                        <div style="flex:1;height:20px;background:var(--bg-surface-secondary);border-radius:var(--radius-sm);overflow:hidden">
                                            <div style="height:100%;width:${Math.round((count / maxBreakdown) * 100)}%;background:${typeColors[type] || 'var(--accent)'};border-radius:var(--radius-sm)"></div>
                                        </div>
                                        <div style="width:30px;text-align:right;font-size:0.8125rem;font-weight:600">${count}</div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    ` : ''}
                    ${byScore.length > 0 ? `
                        <div>
                            <div style="font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:8px">Response Rate by Score</div>
                            <div style="display:flex;flex-direction:column;gap:6px">
                                ${byScore.map(s => `
                                    <div style="display:flex;align-items:center;gap:8px">
                                        <div style="width:60px;font-size:0.8125rem;font-weight:600;color:var(--text-secondary)">${s.range}</div>
                                        <div style="flex:1;height:20px;background:var(--bg-surface-secondary);border-radius:var(--radius-sm);overflow:hidden">
                                            <div style="height:100%;width:${Math.round((s.applied / maxScoreApplied) * 100)}%;background:var(--accent);border-radius:var(--radius-sm);position:relative">
                                                ${s.responded > 0 ? `<div style="position:absolute;right:0;top:0;bottom:0;width:${Math.round((s.responded / s.applied) * 100)}%;background:#22c55e;border-radius:var(--radius-sm)"></div>` : ''}
                                            </div>
                                        </div>
                                        <div style="width:80px;text-align:right;font-size:0.75rem;color:var(--text-secondary)">${s.responded}/${s.applied} (${s.rate}%)</div>
                                    </div>
                                `).join('')}
                            </div>
                            <div style="display:flex;gap:12px;margin-top:6px;font-size:0.75rem;color:var(--text-tertiary)">
                                <span><span style="display:inline-block;width:10px;height:10px;background:var(--accent);border-radius:2px;vertical-align:middle"></span> Applied</span>
                                <span><span style="display:inline-block;width:10px;height:10px;background:#22c55e;border-radius:2px;vertical-align:middle"></span> Responded</span>
                            </div>
                        </div>
                    ` : ''}
                `;
            }
        } catch {
            document.getElementById('response-analytics-container').innerHTML = '<div style="font-size:0.8125rem;color:var(--text-tertiary)">Could not load response analytics.</div>';
        }

        // Career Advisor
        try {
            const careerData = await api.request('GET', '/api/career/suggestions');
            const suggestions = careerData.suggestions || [];
            const careerContainer = document.getElementById('career-advisor-container');
            if (suggestions.length === 0) {
                careerContainer.innerHTML = '<div style="font-size:0.875rem;color:var(--text-tertiary)">No suggestions yet. Click "Analyze Career" to get AI-powered recommendations.</div>';
            } else {
                careerContainer.innerHTML = `
                    <div style="display:flex;flex-direction:column;gap:8px">
                        ${suggestions.map(s => `
                            <div style="padding:12px;background:var(--bg-surface-secondary);border-radius:var(--radius-sm);border-left:3px solid ${s.accepted ? '#22c55e' : 'var(--accent)'}">
                                <div style="display:flex;justify-content:space-between;align-items:flex-start">
                                    <div style="flex:1">
                                        <div style="font-weight:600;font-size:0.875rem">${escapeHtml(s.title || s.suggestion || '')}</div>
                                        ${s.reasoning ? `<div style="font-size:0.8125rem;color:var(--text-secondary);margin-top:4px">${escapeHtml(s.reasoning)}</div>` : ''}
                                        ${s.gap ? `<div style="font-size:0.75rem;color:var(--text-tertiary);margin-top:2px">Gap: ${escapeHtml(s.gap)}</div>` : ''}
                                    </div>
                                    ${!s.accepted ? `<button class="btn btn-primary btn-sm career-accept-btn" data-id="${s.id}" style="flex-shrink:0;margin-left:8px">Accept</button>` : `<span style="font-size:0.75rem;color:#22c55e;font-weight:600">Accepted</span>`}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                `;
                careerContainer.querySelectorAll('.career-accept-btn').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        try {
                            await api.request('POST', `/api/career/suggestions/${btn.dataset.id}/accept`);
                            showToast('Suggestion accepted — search terms updated', 'success');
                            await renderStats(container);
                        } catch (err) { showToast(err.message, 'error'); }
                    });
                });
            }
        } catch {
            document.getElementById('career-advisor-container').innerHTML = '<div style="font-size:0.8125rem;color:var(--text-tertiary)">Could not load career suggestions.</div>';
        }

        // Career analyze button
        document.getElementById('career-analyze-btn')?.addEventListener('click', async () => {
            const btn = document.getElementById('career-analyze-btn');
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span> Analyzing...';
            try {
                await api.request('POST', '/api/career/analyze');
                showToast('Career analysis complete', 'success');
                await renderStats(container);
            } catch (err) {
                showToast(err.message, 'error');
                btn.disabled = false;
                btn.textContent = 'Analyze Career';
            }
        });
    } catch (err) {
        showToast(err.message, 'error');
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-title">Could not load stats</div>
                <div class="empty-state-desc">${escapeHtml(err.message)}</div>
            </div>
        `;
    }
}

// === Scrape Handler ===
let scrapePollInterval = null;
function stopScrapePoll() {
    if (scrapePollInterval) { clearInterval(scrapePollInterval); scrapePollInterval = null; }
}
function startScrapePoll() {
    stopScrapePoll();
    const btn = document.getElementById('scrape-btn') || document.getElementById('stats-scrape-btn');
    scrapePollInterval = setInterval(async () => {
        try {
            const p = await api.request('GET', '/api/scrape/progress');
            if (p.active && btn) {
                const label = p.current ? `${p.current} (${p.completed}/${p.total})` : `${p.completed}/${p.total}`;
                btn.innerHTML = `<span class="spinner"></span> ${label}`;
            } else if (!p.active) {
                stopScrapePoll();
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = 'Scrape Now';
                }
                if (p.total > 0) {
                    showToast(`Scrape done — ${p.new_jobs} new jobs found`, 'success');
                    loadPage('stats');
                }
            }
        } catch {}
    }, 2000);
}
async function handleScrape() {
    const btn = document.getElementById('scrape-btn') || document.getElementById('stats-scrape-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Starting...';
    }
    try {
        await api.triggerScrape();
        startScrapePoll();
    } catch (err) {
        showToast(err.message, 'error');
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Scrape Now';
        }
    }
}

// === Network View ===
async function renderNetwork(container) {
    container.innerHTML = `<div class="loading-container"><div class="spinner spinner-lg"></div><span>Loading contacts...</span></div>`;

    try {
        const data = await api.request('GET', '/api/contacts');
        const contacts = data.contacts || [];

        container.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
                <h1 style="font-size:1.5rem;font-weight:700;letter-spacing:-0.02em">Network</h1>
                <button class="btn btn-primary btn-sm" id="add-contact-btn">Add Contact</button>
            </div>
            <div style="margin-bottom:16px">
                <input type="text" class="search-input" id="contact-search" placeholder="Search contacts..." style="width:100%;max-width:400px">
            </div>
            <div id="contacts-list">
                ${contacts.length === 0 ? `
                    <div class="empty-state">
                        <div class="empty-state-icon">&#128101;</div>
                        <div class="empty-state-title">No contacts yet</div>
                        <div class="empty-state-desc">Add contacts to track your professional network and link them to job applications.</div>
                    </div>
                ` : `
                    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px">
                        ${contacts.map(c => `
                            <div class="card card-interactive contact-card" style="padding:16px;cursor:pointer" data-contact-id="${c.id}" data-name="${escapeHtml(c.name).toLowerCase()}" data-company="${escapeHtml(c.company || '').toLowerCase()}">
                                <div style="font-weight:600;font-size:0.9375rem">${escapeHtml(c.name)}</div>
                                ${c.role ? `<div style="font-size:0.8125rem;color:var(--text-secondary)">${escapeHtml(c.role)}</div>` : ''}
                                ${c.company ? `<div style="font-size:0.8125rem;color:var(--text-tertiary)">${escapeHtml(c.company)}</div>` : ''}
                                <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
                                    ${c.email ? `<span style="font-size:0.75rem;color:var(--accent)">${escapeHtml(c.email)}</span>` : ''}
                                    ${c.linkedin_url ? `<a href="${escapeHtml(c.linkedin_url)}" target="_blank" style="font-size:0.75rem">LinkedIn</a>` : ''}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                `}
            </div>
            <div id="contact-detail-panel" style="display:none"></div>
            <div id="contact-form-panel" style="display:none">
                <div class="card" style="padding:24px;margin-top:16px">
                    <h3 style="font-size:1rem;font-weight:600;margin-bottom:12px" id="contact-form-title">Add Contact</h3>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                        <div><label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Name *</label><input type="text" class="search-input" id="contact-name" style="width:100%"></div>
                        <div><label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Email</label><input type="email" class="search-input" id="contact-email" style="width:100%"></div>
                        <div><label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Company</label><input type="text" class="search-input" id="contact-company" style="width:100%"></div>
                        <div><label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Role</label><input type="text" class="search-input" id="contact-role" style="width:100%"></div>
                        <div><label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Phone</label><input type="text" class="search-input" id="contact-phone" style="width:100%"></div>
                        <div><label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">LinkedIn URL</label><input type="text" class="search-input" id="contact-linkedin" style="width:100%"></div>
                    </div>
                    <div style="margin-top:12px"><label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Notes</label><textarea class="textarea-styled textarea-notes" id="contact-notes"></textarea></div>
                    <div style="display:flex;gap:8px;margin-top:12px">
                        <button class="btn btn-primary btn-sm" id="contact-save-btn">Save</button>
                        <button class="btn btn-secondary btn-sm" id="contact-cancel-btn">Cancel</button>
                    </div>
                </div>
            </div>
        `;

        let editingContactId = null;

        // Search filter
        document.getElementById('contact-search').addEventListener('input', (e) => {
            const q = e.target.value.toLowerCase();
            document.querySelectorAll('.contact-card').forEach(card => {
                const name = card.dataset.name || '';
                const company = card.dataset.company || '';
                card.style.display = (name.includes(q) || company.includes(q)) ? '' : 'none';
            });
        });

        // Add contact
        document.getElementById('add-contact-btn').addEventListener('click', () => {
            editingContactId = null;
            document.getElementById('contact-form-title').textContent = 'Add Contact';
            ['contact-name', 'contact-email', 'contact-company', 'contact-role', 'contact-phone', 'contact-linkedin', 'contact-notes'].forEach(id => { document.getElementById(id).value = ''; });
            document.getElementById('contact-form-panel').style.display = '';
            document.getElementById('contact-detail-panel').style.display = 'none';
        });

        document.getElementById('contact-cancel-btn').addEventListener('click', () => {
            document.getElementById('contact-form-panel').style.display = 'none';
        });

        document.getElementById('contact-save-btn').addEventListener('click', async () => {
            const name = document.getElementById('contact-name').value.trim();
            if (!name) { showToast('Name is required', 'error'); return; }
            const body = { name, email: document.getElementById('contact-email').value.trim(), company: document.getElementById('contact-company').value.trim(), role: document.getElementById('contact-role').value.trim(), phone: document.getElementById('contact-phone').value.trim(), linkedin_url: document.getElementById('contact-linkedin').value.trim(), notes: document.getElementById('contact-notes').value };
            try {
                if (editingContactId) {
                    await api.request('PUT', `/api/contacts/${editingContactId}`, body);
                    showToast('Contact updated', 'success');
                } else {
                    await api.request('POST', '/api/contacts', body);
                    showToast('Contact added', 'success');
                }
                await renderNetwork(container);
            } catch (err) { showToast(err.message, 'error'); }
        });

        // Click contact card to see detail + interactions
        container.querySelectorAll('.contact-card').forEach(card => {
            card.addEventListener('click', async () => {
                const contactId = parseInt(card.dataset.contactId);
                const contact = contacts.find(c => c.id === contactId);
                if (!contact) return;
                document.getElementById('contact-form-panel').style.display = 'none';
                const detailPanel = document.getElementById('contact-detail-panel');
                detailPanel.style.display = '';
                detailPanel.innerHTML = '<div class="loading-container"><span class="spinner"></span></div>';

                try {
                    const intData = await api.request('GET', `/api/contacts/${contactId}/interactions`);
                    const interactions = intData.interactions || [];
                    detailPanel.innerHTML = `
                        <div class="card" style="padding:24px;margin-top:16px">
                            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
                                <div>
                                    <h2 style="font-size:1.25rem;font-weight:700">${escapeHtml(contact.name)}</h2>
                                    ${contact.role ? `<div style="color:var(--text-secondary)">${escapeHtml(contact.role)}${contact.company ? ` at ${escapeHtml(contact.company)}` : ''}</div>` : ''}
                                    <div style="display:flex;gap:12px;margin-top:8px;font-size:0.8125rem">
                                        ${contact.email ? `<span>${escapeHtml(contact.email)}</span>` : ''}
                                        ${contact.phone ? `<span>${escapeHtml(contact.phone)}</span>` : ''}
                                        ${contact.linkedin_url ? `<a href="${escapeHtml(contact.linkedin_url)}" target="_blank">LinkedIn</a>` : ''}
                                    </div>
                                    ${contact.notes ? `<div style="margin-top:8px;font-size:0.8125rem;color:var(--text-secondary)">${escapeHtml(contact.notes)}</div>` : ''}
                                </div>
                                <div style="display:flex;gap:6px">
                                    <button class="btn btn-secondary btn-sm" id="edit-contact-btn">Edit</button>
                                    <button class="btn btn-danger btn-sm" id="delete-contact-btn">Delete</button>
                                </div>
                            </div>
                            <h3 style="font-size:0.875rem;font-weight:600;color:var(--text-tertiary);margin-bottom:8px">Interactions</h3>
                            <div style="display:flex;gap:6px;margin-bottom:12px">
                                <input type="text" class="search-input" id="interaction-notes" placeholder="Add interaction note..." style="flex:1">
                                <select class="filter-select" id="interaction-type" style="width:auto">
                                    <option value="note">Note</option>
                                    <option value="email">Email</option>
                                    <option value="call">Call</option>
                                    <option value="meeting">Meeting</option>
                                    <option value="linkedin">LinkedIn</option>
                                </select>
                                <button class="btn btn-primary btn-sm" id="add-interaction-btn">Add</button>
                            </div>
                            <div class="timeline">
                                ${interactions.length === 0 ? '<div style="font-size:0.875rem;color:var(--text-tertiary);padding:8px 0">No interactions yet.</div>' :
                                interactions.map(i => `
                                    <div class="timeline-event">
                                        <div>
                                            <div class="timeline-detail">${escapeHtml(i.notes || i.type)}</div>
                                            <div class="timeline-time">${escapeHtml(i.type)} &middot; ${formatDate(i.date || i.created_at)}</div>
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    `;

                    document.getElementById('edit-contact-btn').addEventListener('click', () => {
                        editingContactId = contactId;
                        document.getElementById('contact-form-title').textContent = 'Edit Contact';
                        document.getElementById('contact-name').value = contact.name || '';
                        document.getElementById('contact-email').value = contact.email || '';
                        document.getElementById('contact-company').value = contact.company || '';
                        document.getElementById('contact-role').value = contact.role || '';
                        document.getElementById('contact-phone').value = contact.phone || '';
                        document.getElementById('contact-linkedin').value = contact.linkedin_url || '';
                        document.getElementById('contact-notes').value = contact.notes || '';
                        document.getElementById('contact-form-panel').style.display = '';
                        detailPanel.style.display = 'none';
                    });

                    document.getElementById('delete-contact-btn').addEventListener('click', async () => {
                        if (!confirm(`Delete ${contact.name}?`)) return;
                        try {
                            await api.request('DELETE', `/api/contacts/${contactId}`);
                            showToast('Contact deleted', 'success');
                            await renderNetwork(container);
                        } catch (err) { showToast(err.message, 'error'); }
                    });

                    document.getElementById('add-interaction-btn').addEventListener('click', async () => {
                        const notes = document.getElementById('interaction-notes').value.trim();
                        if (!notes) return;
                        try {
                            await api.request('POST', `/api/contacts/${contactId}/interactions`, {
                                type: document.getElementById('interaction-type').value,
                                notes,
                            });
                            showToast('Interaction added', 'success');
                            card.click(); // refresh detail
                        } catch (err) { showToast(err.message, 'error'); }
                    });
                } catch (err) {
                    detailPanel.innerHTML = `<div style="color:var(--danger);padding:16px">${escapeHtml(err.message)}</div>`;
                }
            });
        });
    } catch (err) {
        showToast(err.message, 'error');
        container.innerHTML = `<div class="empty-state"><div class="empty-state-title">Could not load contacts</div></div>`;
    }
}

// === Queue View ===
let queueEventSource = null;

async function renderQueue(container) {
    container.innerHTML = `<div class="loading-container"><div class="spinner spinner-lg"></div><span>Loading queue...</span></div>`;

    // Clean up any existing SSE connection
    if (queueEventSource) { queueEventSource.close(); queueEventSource = null; }

    try {
        const [queueData, resumesData] = await Promise.all([
            api.request('GET', '/api/queue'),
            api.request('GET', '/api/resumes'),
        ]);
        const queue = queueData.queue || [];
        const resumes = resumesData.resumes || [];

        const statusLabels = {
            queued: 'Queued', preparing: 'Preparing', ready: 'Ready',
            review: 'In Review', approved: 'Approved', filling: 'Filling',
            submitted: 'Submitted', rejected: 'Rejected',
            done: 'Done', failed: 'Failed'
        };
        const statusColors = {
            queued: 'var(--accent)', preparing: '#f59e0b', ready: '#22c55e',
            review: '#8b5cf6', approved: '#22c55e', filling: '#3b82f6',
            submitted: 'var(--score-green)', rejected: 'var(--danger)',
            done: 'var(--text-tertiary)', failed: 'var(--danger)'
        };

        const reviewCount = queue.filter(q => q.status === 'review').length;
        const queuedCount = queue.filter(q => q.status === 'queued').length;
        const approvedCount = queue.filter(q => q.status === 'approved').length;
        const fillingCount = queue.filter(q => q.status === 'filling').length;

        container.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
                <h1 style="font-size:1.5rem;font-weight:700;letter-spacing:-0.02em">Application Queue</h1>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button class="btn btn-primary btn-sm" id="queue-prepare-all-btn"${queuedCount === 0 ? ' disabled' : ''}>Prepare All</button>
                    ${reviewCount > 0 ? `
                        <button class="btn btn-sm" id="queue-approve-all-btn" style="background:#22c55e;color:#fff">Approve All (${reviewCount})</button>
                        <button class="btn btn-danger btn-sm" id="queue-reject-all-btn">Reject All</button>
                    ` : ''}
                </div>
            </div>
            ${queue.length > 0 ? `
                <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">
                    ${Object.entries(statusLabels).map(([s, label]) => {
                        const count = queue.filter(q => q.status === s).length;
                        if (!count) return '';
                        return `<span style="font-size:0.8rem;color:${statusColors[s]};font-weight:600">${label}: ${count}</span>`;
                    }).join('')}
                </div>
            ` : ''}
            ${queue.length === 0 ? `
                <div class="empty-state">
                    <div class="empty-state-icon">&#128203;</div>
                    <div class="empty-state-title">Queue is empty</div>
                    <div class="empty-state-desc">Add jobs to the queue from the job detail page to batch-prepare applications.</div>
                </div>
            ` : `
                <div style="display:flex;flex-direction:column;gap:8px" id="queue-items">
                    ${queue.map(item => renderQueueItem(item, statusLabels, statusColors)).join('')}
                </div>
            `}
        `;

        // Prepare All
        document.getElementById('queue-prepare-all-btn')?.addEventListener('click', async () => {
            const btn = document.getElementById('queue-prepare-all-btn');
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span> Preparing...';
            try {
                const result = await api.request('POST', '/api/queue/prepare-all');
                showToast(`Prepared ${result.prepared}/${result.total}${result.failed ? `, ${result.failed} failed` : ''}`, result.failed ? 'error' : 'success');
                await renderQueue(container);
            } catch (err) {
                showToast(err.message, 'error');
                btn.disabled = false;
                btn.textContent = 'Prepare All';
            }
        });

        // Batch Approve All
        document.getElementById('queue-approve-all-btn')?.addEventListener('click', async () => {
            try {
                const result = await api.request('POST', '/api/queue/approve-all');
                showToast(`Approved ${result.approved} items`, 'success');
                await renderQueue(container);
            } catch (err) { showToast(err.message, 'error'); }
        });

        // Batch Reject All
        document.getElementById('queue-reject-all-btn')?.addEventListener('click', async () => {
            if (!confirm('Reject all items in review?')) return;
            try {
                const result = await api.request('POST', '/api/queue/reject-all');
                showToast(`Rejected ${result.rejected} items`, 'success');
                await renderQueue(container);
            } catch (err) { showToast(err.message, 'error'); }
        });

        // Per-item: Submit for Review
        container.querySelectorAll('.queue-submit-review-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                try {
                    await api.request('POST', `/api/queue/${btn.dataset.id}/submit-for-review`);
                    showToast('Submitted for review', 'success');
                    await renderQueue(container);
                } catch (err) { showToast(err.message, 'error'); }
            });
        });

        // Per-item: Approve
        container.querySelectorAll('.queue-approve-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                try {
                    await api.request('POST', `/api/queue/${btn.dataset.id}/approve`);
                    showToast('Application approved', 'success');
                    await renderQueue(container);
                } catch (err) { showToast(err.message, 'error'); }
            });
        });

        // Per-item: Reject
        container.querySelectorAll('.queue-reject-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                try {
                    await api.request('POST', `/api/queue/${btn.dataset.id}/reject`);
                    showToast('Application rejected', 'info');
                    await renderQueue(container);
                } catch (err) { showToast(err.message, 'error'); }
            });
        });

        // Per-item: Remove
        container.querySelectorAll('.queue-remove-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                try {
                    await api.request('DELETE', `/api/queue/${btn.dataset.id}`);
                    showToast('Removed from queue', 'success');
                    await renderQueue(container);
                } catch (err) { showToast(err.message, 'error'); }
            });
        });

        // SSE for fill progress (only if items are filling)
        if (fillingCount > 0 || approvedCount > 0) {
            connectQueueSSE(container);
        }
    } catch (err) {
        showToast(err.message, 'error');
        container.innerHTML = `<div class="empty-state"><div class="empty-state-title">Could not load queue</div></div>`;
    }
}

function renderQueueItem(item, statusLabels, statusColors) {
    const status = item.status || 'queued';
    const label = statusLabels[status] || status;
    const color = statusColors[status] || 'var(--text-tertiary)';

    const actionButtons = [];
    if (status === 'ready') {
        actionButtons.push(`<button class="btn btn-sm queue-submit-review-btn" data-id="${item.id}" style="background:#8b5cf6;color:#fff">Submit for Review</button>`);
    }
    if (status === 'review') {
        actionButtons.push(`<button class="btn btn-sm queue-approve-btn" data-id="${item.id}" style="background:#22c55e;color:#fff">Approve</button>`);
        actionButtons.push(`<button class="btn btn-danger btn-sm queue-reject-btn" data-id="${item.id}">Reject</button>`);
    }
    actionButtons.push(`<a href="#/job/${item.job_id}" class="btn btn-secondary btn-sm">Review</a>`);
    if (!['filling', 'submitted'].includes(status)) {
        actionButtons.push(`<button class="btn btn-danger btn-sm queue-remove-btn" data-id="${item.id}">Remove</button>`);
    }

    const progressBar = status === 'filling' && item.fill_progress != null
        ? `<div style="margin-top:8px">
            <div style="display:flex;justify-content:space-between;font-size:0.75rem;color:var(--text-secondary);margin-bottom:4px">
                <span>Filling application...</span>
                <span class="queue-progress-text" data-queue-id="${item.id}">${item.fill_progress || 0}%</span>
            </div>
            <div style="height:6px;background:var(--bg-secondary);border-radius:3px;overflow:hidden">
                <div class="queue-progress-bar" data-queue-id="${item.id}" style="height:100%;width:${item.fill_progress || 0}%;background:var(--accent);border-radius:3px;transition:width 0.3s"></div>
            </div>
          </div>`
        : '';

    return `
        <div class="card queue-item" style="padding:16px" data-queue-id="${item.id}" data-queue-status="${status}">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
                <div style="flex:1;min-width:0">
                    <a href="#/job/${item.job_id}" style="font-weight:600;font-size:0.9375rem">${escapeHtml(item.title || 'Job #' + item.job_id)}</a>
                    <div style="font-size:0.8125rem;color:var(--text-secondary)">${escapeHtml(item.company || '')}</div>
                    <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
                        <span class="queue-status-badge" style="font-size:0.75rem;font-weight:600;color:#fff;background:${color};padding:2px 8px;border-radius:10px">${label}</span>
                        ${item.match_score != null ? `<span class="score-badge ${getScoreClass(item.match_score)}" style="font-size:0.75rem">${item.match_score}</span>` : ''}
                    </div>
                    ${progressBar}
                </div>
                <div style="display:flex;gap:6px;flex-shrink:0">
                    ${actionButtons.join('')}
                </div>
            </div>
        </div>
    `;
}

function connectQueueSSE(container) {
    if (queueEventSource) queueEventSource.close();
    queueEventSource = new EventSource('/api/queue/events');

    queueEventSource.addEventListener('fill_progress', (e) => {
        try {
            const data = JSON.parse(e.data);
            const queueId = data.queue_id;
            const progressBar = container.querySelector(`.queue-progress-bar[data-queue-id="${queueId}"]`);
            const progressText = container.querySelector(`.queue-progress-text[data-queue-id="${queueId}"]`);
            if (progressBar) progressBar.style.width = `${data.progress || 0}%`;
            if (progressText) progressText.textContent = `${data.progress || 0}%`;

            if (data.status === 'submitted') {
                showToast('Application submitted!', 'success');
                renderQueue(container);
            } else if (data.status === 'failed') {
                showToast('Fill failed', 'error');
                renderQueue(container);
            }
        } catch {}
    });

    queueEventSource.addEventListener('status_change', (e) => {
        try {
            const data = JSON.parse(e.data);
            const card = container.querySelector(`.queue-item[data-queue-id="${data.queue_id}"]`);
            if (card) renderQueue(container);
        } catch {}
    });

    queueEventSource.onerror = () => {
        queueEventSource.close();
        queueEventSource = null;
    };
}

// === Settings View ===
let settingsActiveTab = 'profile';
let settingsData = {};

async function renderSettings(container) {
    container.innerHTML = `<div class="loading-container"><div class="spinner spinner-lg"></div><span>Loading settings...</span></div>`;

    try {
        const [config, aiSettings, profile, fullProfile, scraperKeys, customQA, emailSettings, resumesData, embeddingSettings] = await Promise.all([
            api.getSearchConfig(),
            api.getAISettings(),
            api.request('GET', '/api/profile'),
            api.request('GET', '/api/profile/full'),
            api.request('GET', '/api/scraper-keys'),
            api.request('GET', '/api/custom-qa'),
            api.request('GET', '/api/settings/email'),
            api.request('GET', '/api/resumes'),
            api.request('GET', '/api/settings/embeddings'),
        ]);
        settingsData = { config, aiSettings, profile, fullProfile, scraperKeys, customQA: customQA.items || [], emailSettings, resumes: resumesData.resumes || [], embeddingSettings };
        renderSettingsShell(container);
    } catch (err) {
        showToast(err.message, 'error');
        container.innerHTML = `<div class="empty-state"><div class="empty-state-title">Could not load settings</div></div>`;
    }
}

function renderSettingsShell(container) {
    const tabs = [
        { id: 'profile', label: 'Profile' },
        { id: 'resumes', label: 'Resumes' },
        { id: 'work-history', label: 'Work History' },
        { id: 'job-search', label: 'Job Search' },
        { id: 'alerts', label: 'Alerts' },
        { id: 'follow-ups', label: 'Follow-Ups' },
        { id: 'integrations', label: 'AI & Integrations' },
        { id: 'data', label: 'Data Management' },
    ];

    container.innerHTML = `
        <h1 style="font-size:1.5rem;font-weight:700;letter-spacing:-0.02em;margin-bottom:24px">Settings</h1>
        <div class="settings-tab-bar">
            ${tabs.map(t => `<button class="settings-tab${settingsActiveTab === t.id ? ' settings-tab-active' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}
        </div>
        <div id="settings-tab-content"></div>
    `;

    container.querySelectorAll('.settings-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            settingsActiveTab = btn.dataset.tab;
            container.querySelectorAll('.settings-tab').forEach(b => b.classList.toggle('settings-tab-active', b.dataset.tab === settingsActiveTab));
            renderActiveTab(container);
        });
    });

    renderActiveTab(container);
}

function renderActiveTab(shell) {
    const content = shell.querySelector('#settings-tab-content');
    if (!content) return;
    const d = settingsData;
    switch (settingsActiveTab) {
        case 'profile': renderTabProfile(content, d.fullProfile || d.profile || {}); break;
        case 'resumes': renderTabResumes(content, d.resumes || []); break;
        case 'work-history': renderTabWorkHistory(content, d.fullProfile || {}); break;
        case 'job-search': renderTabJobSearch(content, d.config || {}, d.fullProfile || d.profile || {}, d.customQA || []); break;
        case 'alerts': renderTabAlerts(content); break;
        case 'follow-ups': renderTabFollowUps(content); break;
        case 'integrations': renderTabAI(content, d.aiSettings || {}, d.scraperKeys || {}, d.emailSettings || {}, d.embeddingSettings || {}); break;
        case 'data': renderTabData(content); break;
    }
}

async function renderTabAlerts(content) {
    content.innerHTML = '<div class="loading-container"><span class="spinner"></span></div>';
    try {
        const data = await api.request('GET', '/api/alerts');
        const alerts = data.alerts || [];
        content.innerHTML = `
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:16px">Job Alerts</h2>
            <p style="font-size:0.875rem;color:var(--text-secondary);margin-bottom:16px">Alerts notify you when new jobs match your saved filters. Create alerts from the filter bar on the Jobs page.</p>
            ${alerts.length === 0 ? `
                <div class="empty-state" style="padding:32px">
                    <div class="empty-state-title">No alerts yet</div>
                    <div class="empty-state-desc">Use "Create Alert" on the Jobs page to save your current filters as an alert.</div>
                </div>
            ` : `
                <div style="display:flex;flex-direction:column;gap:8px">
                    ${alerts.map(a => `
                        <div class="card" style="padding:16px" data-alert-id="${a.id}">
                            <div style="display:flex;justify-content:space-between;align-items:center">
                                <div>
                                    <span style="font-weight:600;font-size:0.9375rem">${escapeHtml(a.name)}</span>
                                    ${a.enabled ? '<span class="status-badge status-applied" style="margin-left:8px">Active</span>' : '<span class="status-badge" style="margin-left:8px;background:var(--bg-surface-secondary);color:var(--text-tertiary)">Paused</span>'}
                                </div>
                                <div style="display:flex;gap:6px">
                                    <button class="btn btn-secondary btn-sm alert-toggle-btn" data-id="${a.id}" data-enabled="${a.enabled}">${a.enabled ? 'Pause' : 'Enable'}</button>
                                    <button class="btn btn-danger btn-sm alert-delete-btn" data-id="${a.id}">Delete</button>
                                </div>
                            </div>
                            ${a.min_score ? `<div style="font-size:0.75rem;color:var(--text-tertiary);margin-top:4px">Min score: ${a.min_score}</div>` : ''}
                        </div>
                    `).join('')}
                </div>
            `}
        `;

        content.querySelectorAll('.alert-toggle-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const enabled = btn.dataset.enabled === 'true';
                try {
                    await api.request('PUT', `/api/alerts/${btn.dataset.id}`, { enabled: !enabled });
                    showToast(enabled ? 'Alert paused' : 'Alert enabled', 'success');
                    renderTabAlerts(content);
                } catch (err) { showToast(err.message, 'error'); }
            });
        });

        content.querySelectorAll('.alert-delete-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Delete this alert?')) return;
                try {
                    await api.request('DELETE', `/api/alerts/${btn.dataset.id}`);
                    showToast('Alert deleted', 'success');
                    renderTabAlerts(content);
                } catch (err) { showToast(err.message, 'error'); }
            });
        });
    } catch (err) {
        content.innerHTML = `<div style="color:var(--danger);font-size:0.875rem">${escapeHtml(err.message)}</div>`;
    }
}

async function renderTabFollowUps(content) {
    content.innerHTML = '<div class="loading-container"><span class="spinner"></span></div>';
    try {
        const data = await api.request('GET', '/api/follow-up-templates');
        const templates = data.templates || [];
        content.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
                <h2 style="font-size:1.125rem;font-weight:600">Follow-Up Templates</h2>
                <button class="btn btn-primary btn-sm" id="add-followup-btn">Add Template</button>
            </div>
            <p style="font-size:0.875rem;color:var(--text-secondary);margin-bottom:16px">Templates are used to auto-generate follow-up emails after applying.</p>
            <div id="followup-list">
                ${templates.length === 0 ? `
                    <div class="empty-state" style="padding:32px">
                        <div class="empty-state-title">No templates yet</div>
                        <div class="empty-state-desc">Add a follow-up template to automate reminders.</div>
                    </div>
                ` : templates.map(t => `
                    <div class="card" style="padding:16px;margin-bottom:8px" data-template-id="${t.id}">
                        <div style="display:flex;justify-content:space-between;align-items:center">
                            <div>
                                <span style="font-weight:600;font-size:0.9375rem">${escapeHtml(t.name)}</span>
                                ${t.is_default ? '<span class="status-badge status-applied" style="margin-left:8px">Default</span>' : ''}
                                <span style="font-size:0.75rem;color:var(--text-tertiary);margin-left:8px">${t.days_after} days after apply</span>
                            </div>
                            <div style="display:flex;gap:6px">
                                <button class="btn btn-secondary btn-sm followup-edit-btn" data-id="${t.id}">Edit</button>
                                <button class="btn btn-danger btn-sm followup-delete-btn" data-id="${t.id}">Delete</button>
                            </div>
                        </div>
                        ${t.template_text ? `<div style="font-size:0.8125rem;color:var(--text-secondary);margin-top:6px;white-space:pre-wrap;max-height:60px;overflow:hidden">${escapeHtml(t.template_text.slice(0, 150))}${t.template_text.length > 150 ? '...' : ''}</div>` : ''}
                    </div>
                `).join('')}
            </div>
            <div id="followup-form-container" style="display:none">
                <div class="card" style="padding:20px;margin-top:16px">
                    <h3 style="font-size:1rem;font-weight:600;margin-bottom:12px" id="followup-form-title">Add Template</h3>
                    <div style="display:flex;flex-direction:column;gap:12px">
                        <div>
                            <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Name</label>
                            <input type="text" class="search-input" id="followup-name-input" placeholder="e.g. 1 Week Follow-Up" style="width:100%">
                        </div>
                        <div>
                            <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Days After Application</label>
                            <input type="number" class="search-input" id="followup-days-input" value="7" min="1" max="90" style="width:120px">
                        </div>
                        <div>
                            <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Template Text</label>
                            <textarea class="textarea-styled textarea-notes" id="followup-text-input" placeholder="Follow-up email template..."></textarea>
                        </div>
                        <div style="display:flex;gap:8px">
                            <button class="btn btn-primary btn-sm" id="followup-save-btn">Save</button>
                            <button class="btn btn-secondary btn-sm" id="followup-cancel-btn">Cancel</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        let editingId = null;

        document.getElementById('add-followup-btn').addEventListener('click', () => {
            editingId = null;
            document.getElementById('followup-form-title').textContent = 'Add Template';
            document.getElementById('followup-name-input').value = '';
            document.getElementById('followup-days-input').value = '7';
            document.getElementById('followup-text-input').value = '';
            document.getElementById('followup-form-container').style.display = '';
        });

        document.getElementById('followup-cancel-btn').addEventListener('click', () => {
            document.getElementById('followup-form-container').style.display = 'none';
        });

        document.getElementById('followup-save-btn').addEventListener('click', async () => {
            const name = document.getElementById('followup-name-input').value.trim();
            if (!name) { showToast('Name is required', 'error'); return; }
            const body = {
                name,
                days_after: parseInt(document.getElementById('followup-days-input').value) || 7,
                template_text: document.getElementById('followup-text-input').value,
            };
            try {
                if (editingId) {
                    await api.request('PUT', `/api/follow-up-templates/${editingId}`, body);
                    showToast('Template updated', 'success');
                } else {
                    await api.request('POST', '/api/follow-up-templates', body);
                    showToast('Template added', 'success');
                }
                renderTabFollowUps(content);
            } catch (err) { showToast(err.message, 'error'); }
        });

        content.querySelectorAll('.followup-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = parseInt(btn.dataset.id);
                const t = templates.find(x => x.id === id);
                if (!t) return;
                editingId = id;
                document.getElementById('followup-form-title').textContent = 'Edit Template';
                document.getElementById('followup-name-input').value = t.name || '';
                document.getElementById('followup-days-input').value = t.days_after || 7;
                document.getElementById('followup-text-input').value = t.template_text || '';
                document.getElementById('followup-form-container').style.display = '';
            });
        });

        content.querySelectorAll('.followup-delete-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Delete this template?')) return;
                try {
                    await api.request('DELETE', `/api/follow-up-templates/${btn.dataset.id}`);
                    showToast('Template deleted', 'success');
                    renderTabFollowUps(content);
                } catch (err) { showToast(err.message, 'error'); }
            });
        });
    } catch (err) {
        content.innerHTML = `<div style="color:var(--danger);font-size:0.875rem">${escapeHtml(err.message)}</div>`;
    }
}

function renderTabResumes(content, resumes) {
    content.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
            <h2 style="font-size:1.125rem;font-weight:600">Manage Resumes</h2>
            <button class="btn btn-primary btn-sm" id="add-resume-btn">Add Resume</button>
        </div>
        <div id="resumes-list">
            ${resumes.length === 0 ? `
                <div class="empty-state" style="padding:32px">
                    <div class="empty-state-title">No resumes yet</div>
                    <div class="empty-state-desc">Add a resume to use when preparing applications.</div>
                </div>
            ` : resumes.map(r => `
                <div class="card" style="padding:16px;margin-bottom:8px" data-resume-id="${r.id}">
                    <div style="display:flex;justify-content:space-between;align-items:center">
                        <div>
                            <span style="font-weight:600;font-size:0.9375rem">${escapeHtml(r.name)}</span>
                            ${r.is_default ? '<span class="status-badge status-applied" style="margin-left:8px">Default</span>' : ''}
                        </div>
                        <div style="display:flex;gap:6px">
                            ${!r.is_default ? `<button class="btn btn-secondary btn-sm resume-default-btn" data-id="${r.id}">Set Default</button>` : ''}
                            <button class="btn btn-secondary btn-sm resume-edit-btn" data-id="${r.id}">Edit</button>
                            <button class="btn btn-danger btn-sm resume-delete-btn" data-id="${r.id}">Delete</button>
                        </div>
                    </div>
                    ${r.summary ? `<div style="font-size:0.8125rem;color:var(--text-secondary);margin-top:6px">${escapeHtml(r.summary)}</div>` : ''}
                    <div style="font-size:0.75rem;color:var(--text-tertiary);margin-top:4px">${r.resume_text ? `${r.resume_text.length} chars` : 'No content'}</div>
                </div>
            `).join('')}
        </div>
        <div id="resume-form-container" style="display:none">
            <div class="card" style="padding:20px;margin-top:16px">
                <h3 style="font-size:1rem;font-weight:600;margin-bottom:12px" id="resume-form-title">Add Resume</h3>
                <div style="display:flex;flex-direction:column;gap:12px">
                    <div>
                        <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Name</label>
                        <input type="text" class="search-input" id="resume-name-input" placeholder="e.g. Full-Stack Developer Resume" style="width:100%">
                    </div>
                    <div>
                        <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Summary (optional)</label>
                        <input type="text" class="search-input" id="resume-summary-input" placeholder="Brief description" style="width:100%">
                    </div>
                    <div>
                        <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Resume Text</label>
                        <textarea class="textarea-styled" id="resume-text-input" style="min-height:200px" placeholder="Paste your resume text here..."></textarea>
                    </div>
                    <div style="display:flex;gap:8px">
                        <button class="btn btn-primary btn-sm" id="resume-save-btn">Save</button>
                        <button class="btn btn-secondary btn-sm" id="resume-cancel-btn">Cancel</button>
                    </div>
                </div>
            </div>
        </div>
    `;

    let editingId = null;

    document.getElementById('add-resume-btn').addEventListener('click', () => {
        editingId = null;
        document.getElementById('resume-form-title').textContent = 'Add Resume';
        document.getElementById('resume-name-input').value = '';
        document.getElementById('resume-summary-input').value = '';
        document.getElementById('resume-text-input').value = '';
        document.getElementById('resume-form-container').style.display = '';
    });

    document.getElementById('resume-cancel-btn').addEventListener('click', () => {
        document.getElementById('resume-form-container').style.display = 'none';
    });

    document.getElementById('resume-save-btn').addEventListener('click', async () => {
        const name = document.getElementById('resume-name-input').value.trim();
        if (!name) { showToast('Name is required', 'error'); return; }
        const body = {
            name,
            summary: document.getElementById('resume-summary-input').value.trim(),
            resume_text: document.getElementById('resume-text-input').value,
        };
        try {
            if (editingId) {
                await api.request('PUT', `/api/resumes/${editingId}`, body);
                showToast('Resume updated', 'success');
            } else {
                await api.request('POST', '/api/resumes', body);
                showToast('Resume added', 'success');
            }
            const data = await api.request('GET', '/api/resumes');
            settingsData.resumes = data.resumes || [];
            renderTabResumes(content, settingsData.resumes);
        } catch (err) {
            showToast(err.message, 'error');
        }
    });

    content.querySelectorAll('.resume-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = parseInt(btn.dataset.id);
            const r = resumes.find(x => x.id === id);
            if (!r) return;
            editingId = id;
            document.getElementById('resume-form-title').textContent = 'Edit Resume';
            document.getElementById('resume-name-input').value = r.name || '';
            document.getElementById('resume-summary-input').value = r.summary || '';
            document.getElementById('resume-text-input').value = r.resume_text || '';
            document.getElementById('resume-form-container').style.display = '';
        });
    });

    content.querySelectorAll('.resume-default-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            try {
                await api.request('POST', `/api/resumes/${btn.dataset.id}/set-default`);
                showToast('Default resume updated', 'success');
                const data = await api.request('GET', '/api/resumes');
                settingsData.resumes = data.resumes || [];
                renderTabResumes(content, settingsData.resumes);
            } catch (err) { showToast(err.message, 'error'); }
        });
    });

    content.querySelectorAll('.resume-delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm('Delete this resume?')) return;
            try {
                await api.request('DELETE', `/api/resumes/${btn.dataset.id}`);
                showToast('Resume deleted', 'success');
                const data = await api.request('GET', '/api/resumes');
                settingsData.resumes = data.resumes || [];
                renderTabResumes(content, settingsData.resumes);
            } catch (err) { showToast(err.message, 'error'); }
        });
    });
}

function settingsField(label, id, value, type = 'text', opts = {}) {
    const ph = opts.placeholder || '';
    const extra = opts.extra || '';
    return `<div>
        <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">${label}</label>
        <input type="${type}" class="search-input" id="${id}" value="${escapeHtml(value != null ? String(value) : '')}" placeholder="${escapeHtml(ph)}" style="width:100%" ${extra}>
    </div>`;
}

function settingsSelect(label, id, value, options) {
    return `<div>
        <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">${label}</label>
        <select class="filter-select" id="${id}" style="width:100%">
            ${options.map(o => {
                const val = typeof o === 'string' ? o : o.value;
                const lbl = typeof o === 'string' ? o : o.label;
                return `<option value="${escapeHtml(val)}" ${val === (value || '') ? 'selected' : ''}>${escapeHtml(lbl)}</option>`;
            }).join('')}
        </select>
    </div>`;
}

// === Tab 1: Profile ===
function renderTabProfile(container, p) {
    const mil = p.military || {};
    const eeo = p.eeo || {};
    const sameAddr = !p.perm_address_street1 && !p.perm_address_city;
    const nameParts = (p.full_name || '').split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.length > 2 ? nameParts.slice(2).join(' ') : (nameParts[1] || '');

    container.innerHTML = `
        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:16px">Personal Information</h2>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px">
                ${settingsField('First Name', 'pf-first', firstName)}
                ${settingsField('Middle Name', 'pf-middle', p.middle_name)}
                ${settingsField('Last Name', 'pf-last', lastName)}
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px">
                ${settingsField('Preferred Name', 'pf-preferred', p.preferred_name)}
                ${settingsField('Email', 'pf-email', p.email, 'email')}
                ${settingsSelect('Pronouns', 'pf-pronouns', p.pronouns, [
                    {value:'',label:'Select...'},{value:'he/him',label:'He/Him'},{value:'she/her',label:'She/Her'},
                    {value:'they/them',label:'They/Them'},{value:'other',label:'Other'},
                ])}
            </div>
            <div style="display:grid;grid-template-columns:auto 1fr auto 1fr;gap:12px;margin-bottom:12px">
                ${settingsSelect('Code', 'pf-phone-cc', p.phone_country_code || '+1', [
                    {value:'+1',label:'+1 (US/CA)'},{value:'+44',label:'+44 (UK)'},{value:'+61',label:'+61 (AU)'},
                    {value:'+49',label:'+49 (DE)'},{value:'+33',label:'+33 (FR)'},{value:'+91',label:'+91 (IN)'},
                    {value:'+81',label:'+81 (JP)'},{value:'+86',label:'+86 (CN)'},{value:'+55',label:'+55 (BR)'},
                    {value:'+52',label:'+52 (MX)'},{value:'+82',label:'+82 (KR)'},
                ])}
                ${settingsField('Phone', 'pf-phone', p.phone, 'tel')}
                ${settingsSelect('Phone Type', 'pf-phone-type', p.phone_type, [
                    {value:'',label:'Select...'},{value:'mobile',label:'Mobile'},{value:'home',label:'Home'},{value:'work',label:'Work'},
                ])}
                ${settingsField('Additional Phone', 'pf-addl-phone', p.additional_phone, 'tel')}
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                ${settingsField('Date of Birth', 'pf-dob', p.date_of_birth, 'date')}
                ${settingsField('Location (for quick copy)', 'pf-location', p.location)}
            </div>
        </div>

        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:16px">Address</h2>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
                ${settingsField('Street Address 1', 'pf-addr1', p.address_street1)}
                ${settingsField('Street Address 2', 'pf-addr2', p.address_street2)}
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:16px">
                ${settingsField('City', 'pf-addr-city', p.address_city)}
                ${settingsField('State', 'pf-addr-state', p.address_state)}
                ${settingsField('ZIP', 'pf-addr-zip', p.address_zip)}
                ${settingsField('Country', 'pf-addr-country', p.address_country_name || p.address_country_code)}
            </div>
            <label style="display:flex;align-items:center;gap:8px;font-size:0.875rem;cursor:pointer;margin-bottom:12px">
                <input type="checkbox" id="pf-same-addr" ${sameAddr ? 'checked' : ''}> Permanent address same as above
            </label>
            <div id="pf-perm-addr" style="${sameAddr ? 'display:none' : ''}">
                <h3 style="font-size:0.9375rem;font-weight:600;margin-bottom:12px;color:var(--text-secondary)">Permanent Address</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
                    ${settingsField('Street 1', 'pf-perm1', p.perm_address_street1)}
                    ${settingsField('Street 2', 'pf-perm2', p.perm_address_street2)}
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px">
                    ${settingsField('City', 'pf-perm-city', p.perm_address_city)}
                    ${settingsField('State', 'pf-perm-state', p.perm_address_state)}
                    ${settingsField('ZIP', 'pf-perm-zip', p.perm_address_zip)}
                    ${settingsField('Country', 'pf-perm-country', p.perm_address_country_name || p.perm_address_country_code)}
                </div>
            </div>
        </div>

        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:16px">Links</h2>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                ${settingsField('LinkedIn', 'pf-linkedin', p.linkedin_url, 'url')}
                ${settingsField('GitHub', 'pf-github', p.github_url, 'url')}
                ${settingsField('Portfolio', 'pf-portfolio', p.portfolio_url, 'url')}
                ${settingsField('Website', 'pf-website', p.website_url, 'url')}
            </div>
        </div>

        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:16px">Driver's License</h2>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
                ${settingsSelect('Have License?', 'pf-dl', p.drivers_license, [
                    {value:'',label:'Select...'},{value:'yes',label:'Yes'},{value:'no',label:'No'},
                ])}
                ${settingsField('Class', 'pf-dl-class', p.drivers_license_class)}
                ${settingsField('State', 'pf-dl-state', p.drivers_license_state)}
            </div>
        </div>

        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:16px">Work Authorization</h2>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px">
                ${settingsField('Country of Citizenship', 'pf-citizen', p.country_of_citizenship)}
                ${settingsSelect('Authorized to Work in US?', 'pf-auth-us', p.authorized_to_work_us, [
                    {value:'',label:'Select...'},{value:'yes',label:'Yes'},{value:'no',label:'No'},
                ])}
                ${settingsSelect('Requires Sponsorship?', 'pf-sponsor', p.requires_sponsorship, [
                    {value:'',label:'Select...'},{value:'yes',label:'Yes'},{value:'no',label:'No'},
                ])}
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
                ${settingsSelect('Authorization Type', 'pf-auth-type', p.authorization_type, [
                    {value:'',label:'Select...'},{value:'citizen',label:'US Citizen'},{value:'permanent_resident',label:'Permanent Resident'},
                    {value:'h1b',label:'H-1B'},{value:'opt',label:'OPT'},{value:'ead',label:'EAD'},
                    {value:'tn',label:'TN Visa'},{value:'other',label:'Other'},
                ])}
                ${settingsSelect('Security Clearance', 'pf-clearance', p.security_clearance, [
                    {value:'',label:'None'},{value:'confidential',label:'Confidential'},{value:'secret',label:'Secret'},
                    {value:'top_secret',label:'Top Secret'},{value:'ts_sci',label:'TS/SCI'},
                ])}
                ${settingsSelect('Clearance Status', 'pf-clear-status', p.clearance_status, [
                    {value:'',label:'N/A'},{value:'active',label:'Active'},{value:'inactive',label:'Inactive'},{value:'expired',label:'Expired'},
                ])}
            </div>
        </div>

        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:16px">Military Service</h2>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px">
                ${settingsField('Branch', 'pf-mil-branch', mil.branch)}
                ${settingsField('Rank', 'pf-mil-rank', mil.rank)}
                ${settingsField('Specialty / MOS', 'pf-mil-spec', mil.specialty)}
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                ${settingsField('Start Date', 'pf-mil-start', mil.start_date, 'date')}
                ${settingsField('End Date', 'pf-mil-end', mil.end_date, 'date')}
            </div>
        </div>

        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:8px">Voluntary Self-Identification (EEO)</h2>
            <p style="color:var(--text-secondary);font-size:0.8125rem;margin-bottom:16px">Optional. Used to pre-fill voluntary self-identification forms.</p>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                ${settingsSelect('Gender', 'pf-eeo-gender', eeo.gender, [
                    {value:'',label:'Decline to self-identify'},{value:'male',label:'Male'},{value:'female',label:'Female'},
                    {value:'non_binary',label:'Non-binary'},{value:'other',label:'Other'},
                ])}
                ${settingsSelect('Race / Ethnicity', 'pf-eeo-race', eeo.race_ethnicity, [
                    {value:'',label:'Decline to self-identify'},
                    {value:'american_indian',label:'American Indian or Alaska Native'},
                    {value:'asian',label:'Asian'},{value:'black',label:'Black or African American'},
                    {value:'hispanic',label:'Hispanic or Latino'},{value:'native_hawaiian',label:'Native Hawaiian or Pacific Islander'},
                    {value:'white',label:'White'},{value:'two_or_more',label:'Two or More Races'},
                ])}
                ${settingsSelect('Disability Status', 'pf-eeo-disability', eeo.disability_status, [
                    {value:'',label:'Decline to self-identify'},
                    {value:'yes',label:'Yes, I have a disability'},{value:'no',label:'No, I do not have a disability'},
                ])}
                ${settingsSelect('Veteran Status', 'pf-eeo-veteran', eeo.veteran_status, [
                    {value:'',label:'Decline to self-identify'},
                    {value:'not_veteran',label:'I am not a protected veteran'},
                    {value:'protected_veteran',label:'I identify as a protected veteran'},
                ])}
                ${settingsSelect('Sexual Orientation', 'pf-eeo-orient', eeo.sexual_orientation, [
                    {value:'',label:'Decline to self-identify'},
                    {value:'heterosexual',label:'Heterosexual'},{value:'gay_lesbian',label:'Gay or Lesbian'},
                    {value:'bisexual',label:'Bisexual'},{value:'other',label:'Other'},
                ])}
            </div>
        </div>

        <button class="btn btn-primary" id="save-profile-btn" style="margin-bottom:24px">Save Profile</button>
    `;

    document.getElementById('pf-same-addr')?.addEventListener('change', e => {
        document.getElementById('pf-perm-addr').style.display = e.target.checked ? 'none' : '';
    });

    document.getElementById('save-profile-btn').addEventListener('click', async () => {
        const first = document.getElementById('pf-first').value.trim();
        const middle = document.getElementById('pf-middle').value.trim();
        const last = document.getElementById('pf-last').value.trim();
        const sameAddress = document.getElementById('pf-same-addr').checked;

        const profileData = {
            full_name: [first, middle, last].filter(Boolean).join(' '),
            middle_name: middle,
            preferred_name: document.getElementById('pf-preferred').value,
            email: document.getElementById('pf-email').value,
            pronouns: document.getElementById('pf-pronouns').value,
            phone_country_code: document.getElementById('pf-phone-cc').value,
            phone: document.getElementById('pf-phone').value,
            phone_type: document.getElementById('pf-phone-type').value,
            additional_phone: document.getElementById('pf-addl-phone').value,
            date_of_birth: document.getElementById('pf-dob').value,
            location: document.getElementById('pf-location').value,
            address_street1: document.getElementById('pf-addr1').value,
            address_street2: document.getElementById('pf-addr2').value,
            address_city: document.getElementById('pf-addr-city').value,
            address_state: document.getElementById('pf-addr-state').value,
            address_zip: document.getElementById('pf-addr-zip').value,
            address_country_name: document.getElementById('pf-addr-country').value,
            perm_address_street1: sameAddress ? '' : document.getElementById('pf-perm1').value,
            perm_address_street2: sameAddress ? '' : document.getElementById('pf-perm2').value,
            perm_address_city: sameAddress ? '' : document.getElementById('pf-perm-city').value,
            perm_address_state: sameAddress ? '' : document.getElementById('pf-perm-state').value,
            perm_address_zip: sameAddress ? '' : document.getElementById('pf-perm-zip').value,
            perm_address_country_name: sameAddress ? '' : document.getElementById('pf-perm-country').value,
            linkedin_url: document.getElementById('pf-linkedin').value,
            github_url: document.getElementById('pf-github').value,
            portfolio_url: document.getElementById('pf-portfolio').value,
            website_url: document.getElementById('pf-website').value,
            drivers_license: document.getElementById('pf-dl').value,
            drivers_license_class: document.getElementById('pf-dl-class').value,
            drivers_license_state: document.getElementById('pf-dl-state').value,
            country_of_citizenship: document.getElementById('pf-citizen').value,
            authorized_to_work_us: document.getElementById('pf-auth-us').value,
            requires_sponsorship: document.getElementById('pf-sponsor').value,
            authorization_type: document.getElementById('pf-auth-type').value,
            security_clearance: document.getElementById('pf-clearance').value,
            clearance_status: document.getElementById('pf-clear-status').value,
        };
        const military = {
            branch: document.getElementById('pf-mil-branch').value,
            rank: document.getElementById('pf-mil-rank').value,
            specialty: document.getElementById('pf-mil-spec').value,
            start_date: document.getElementById('pf-mil-start').value,
            end_date: document.getElementById('pf-mil-end').value,
        };
        const eeoData = {
            gender: document.getElementById('pf-eeo-gender').value,
            race_ethnicity: document.getElementById('pf-eeo-race').value,
            disability_status: document.getElementById('pf-eeo-disability').value,
            veteran_status: document.getElementById('pf-eeo-veteran').value,
            sexual_orientation: document.getElementById('pf-eeo-orient').value,
        };
        try {
            await api.request('PUT', '/api/profile/full', { ...profileData, military, eeo: eeoData });
            settingsData.fullProfile = { ...settingsData.fullProfile, ...profileData, military, eeo: eeoData };
            settingsData.profile = { ...settingsData.profile, ...profileData };
            showToast('Profile saved', 'success');
        } catch (err) { showToast(err.message, 'error'); }
    });
}

// === Tab 2: Work History ===
function renderTabWorkHistory(container, fp) {
    const workHistory = fp.work_history || [];
    const education = fp.education || [];
    const certs = fp.certifications || [];
    const skills = fp.skills || [];
    const languages = fp.languages || [];
    const references = fp.references || [];

    function itemCard(item, type, line1, line2, extra) {
        return `<div style="padding:12px 16px;background:var(--bg-surface-secondary);border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:8px;display:flex;justify-content:space-between;align-items:start">
            <div style="min-width:0;flex:1">
                <div style="font-weight:600;font-size:0.875rem">${escapeHtml(line1 || '(empty)')}</div>
                ${line2 ? `<div style="color:var(--text-secondary);font-size:0.8125rem">${escapeHtml(line2)}</div>` : ''}
                ${extra ? `<div style="color:var(--text-tertiary);font-size:0.75rem;margin-top:2px">${extra}</div>` : ''}
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0;margin-left:8px">
                <button class="btn btn-ghost btn-sm wh-edit-btn" data-type="${type}" data-id="${item.id}">Edit</button>
                <button class="btn btn-danger btn-sm wh-delete-btn" data-type="${type}" data-id="${item.id}">Delete</button>
            </div>
        </div>`;
    }

    container.innerHTML = `
        <div class="card" style="padding:24px;margin-bottom:24px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
                <h2 style="font-size:1.125rem;font-weight:600;margin:0">Work Experience</h2>
                <button class="btn btn-primary btn-sm wh-add-btn" data-type="work-history">+ Add</button>
            </div>
            <div id="wh-work-history-list">${workHistory.length ? workHistory.map(w => {
                const dates = [w.start_month ? `${w.start_month}/` : '', w.start_year || '', w.is_current ? ' - Present' : (w.end_year ? ` - ${w.end_month ? w.end_month + '/' : ''}${w.end_year}` : '')].join('');
                return itemCard(w, 'work-history', w.job_title, w.company, [w.location_city, w.location_state].filter(Boolean).join(', ') + (dates ? ' | ' + dates : ''));
            }).join('') : '<p style="color:var(--text-tertiary);font-size:0.875rem">No entries yet.</p>'}</div>
            <div id="wh-work-history-form"></div>
        </div>

        <div class="card" style="padding:24px;margin-bottom:24px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
                <h2 style="font-size:1.125rem;font-weight:600;margin:0">Education</h2>
                <button class="btn btn-primary btn-sm wh-add-btn" data-type="education">+ Add</button>
            </div>
            <div id="wh-education-list">${education.length ? education.map(e => itemCard(e, 'education', e.school, [e.degree_type, e.field_of_study].filter(Boolean).join(' - '), e.grad_year ? `Graduated ${e.grad_year}` : '')).join('') : '<p style="color:var(--text-tertiary);font-size:0.875rem">No entries yet.</p>'}</div>
            <div id="wh-education-form"></div>
        </div>

        <div class="card" style="padding:24px;margin-bottom:24px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
                <h2 style="font-size:1.125rem;font-weight:600;margin:0">Certifications & Licenses</h2>
                <button class="btn btn-primary btn-sm wh-add-btn" data-type="certifications">+ Add</button>
            </div>
            <div id="wh-certifications-list">${certs.length ? certs.map(c => itemCard(c, 'certifications', c.name, c.issuing_org, [c.cert_type, c.date_obtained].filter(Boolean).join(' | '))).join('') : '<p style="color:var(--text-tertiary);font-size:0.875rem">No entries yet.</p>'}</div>
            <div id="wh-certifications-form"></div>
        </div>

        <div class="card" style="padding:24px;margin-bottom:24px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
                <h2 style="font-size:1.125rem;font-weight:600;margin:0">Skills</h2>
                <button class="btn btn-primary btn-sm wh-add-btn" data-type="skills">+ Add</button>
            </div>
            <div id="wh-skills-list">${skills.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px">${skills.map(s => `
                <span style="display:inline-flex;align-items:center;gap:6px;background:var(--bg-surface-secondary);border:1px solid var(--border);padding:4px 10px;border-radius:6px;font-size:0.875rem">
                    ${escapeHtml(s.name)}${s.years_experience ? ` (${s.years_experience}yr)` : ''}${s.proficiency ? ` - ${s.proficiency}` : ''}
                    <button class="btn btn-ghost btn-sm wh-delete-btn" data-type="skills" data-id="${s.id}" style="color:var(--danger);padding:0 2px;font-size:0.75rem;min-width:auto">x</button>
                </span>
            `).join('')}</div>` : '<p style="color:var(--text-tertiary);font-size:0.875rem">No skills added.</p>'}</div>
            <div id="wh-skills-form"></div>
        </div>

        <div class="card" style="padding:24px;margin-bottom:24px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
                <h2 style="font-size:1.125rem;font-weight:600;margin:0">Languages</h2>
                <button class="btn btn-primary btn-sm wh-add-btn" data-type="languages">+ Add</button>
            </div>
            <div id="wh-languages-list">${languages.length ? languages.map(l => itemCard(l, 'languages', l.language, l.proficiency)).join('') : '<p style="color:var(--text-tertiary);font-size:0.875rem">No entries yet.</p>'}</div>
            <div id="wh-languages-form"></div>
        </div>

        <div class="card" style="padding:24px;margin-bottom:24px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
                <h2 style="font-size:1.125rem;font-weight:600;margin:0">References</h2>
                <button class="btn btn-primary btn-sm wh-add-btn" data-type="references">+ Add</button>
            </div>
            <div id="wh-references-list">${references.length ? references.map(r => itemCard(r, 'references', r.name, [r.title, r.company].filter(Boolean).join(' at '), [r.phone, r.email].filter(Boolean).join(' | '))).join('') : '<p style="color:var(--text-tertiary);font-size:0.875rem">No entries yet.</p>'}</div>
            <div id="wh-references-form"></div>
        </div>
    `;

    const formConfigs = {
        'work-history': { endpoint: '/api/work-history', fields: [
            {key:'job_title',label:'Job Title',type:'text'},{key:'company',label:'Company',type:'text'},
            {key:'location_city',label:'City',type:'text'},{key:'location_state',label:'State',type:'text'},{key:'location_country',label:'Country',type:'text'},
            {key:'start_month',label:'Start Month',type:'number',extra:'min="1" max="12"'},{key:'start_year',label:'Start Year',type:'number',extra:'min="1950" max="2030"'},
            {key:'end_month',label:'End Month',type:'number',extra:'min="1" max="12"'},{key:'end_year',label:'End Year',type:'number',extra:'min="1950" max="2030"'},
            {key:'is_current',label:'Current?',type:'checkbox'},
            {key:'description',label:'Description',type:'textarea'},
            {key:'salary_at_position',label:'Salary',type:'text'},
        ], listKey: 'work_history'},
        'education': { endpoint: '/api/education', fields: [
            {key:'school',label:'School',type:'text'},{key:'degree_type',label:'Degree',type:'select',options:[
                {value:'',label:'Select...'},{value:'high_school',label:'High School'},{value:'associates',label:'Associates'},
                {value:'bachelors',label:'Bachelors'},{value:'masters',label:'Masters'},{value:'mba',label:'MBA'},
                {value:'phd',label:'PhD'},{value:'other',label:'Other'},
            ]},
            {key:'field_of_study',label:'Field of Study',type:'text'},{key:'minor',label:'Minor',type:'text'},
            {key:'start_year',label:'Start Year',type:'number'},{key:'grad_year',label:'Grad Year',type:'number'},
            {key:'gpa',label:'GPA',type:'text'},{key:'honors',label:'Honors',type:'text'},
        ], listKey: 'education'},
        'certifications': { endpoint: '/api/certifications', fields: [
            {key:'name',label:'Name',type:'text'},{key:'issuing_org',label:'Issuing Org',type:'text'},
            {key:'cert_type',label:'Type',type:'select',options:[{value:'certification',label:'Certification'},{value:'license',label:'License'}]},
            {key:'license_number',label:'License #',type:'text'},{key:'state',label:'State',type:'text'},
            {key:'date_obtained',label:'Date Obtained',type:'date'},{key:'expiration_date',label:'Expiration',type:'date'},
        ], listKey: 'certifications'},
        'skills': { endpoint: '/api/skills', fields: [
            {key:'name',label:'Skill',type:'text'},{key:'years_experience',label:'Years',type:'number'},
            {key:'proficiency',label:'Proficiency',type:'select',options:[
                {value:'',label:'Select...'},{value:'beginner',label:'Beginner'},{value:'intermediate',label:'Intermediate'},
                {value:'advanced',label:'Advanced'},{value:'expert',label:'Expert'},
            ]},
        ], listKey: 'skills'},
        'languages': { endpoint: '/api/languages', fields: [
            {key:'language',label:'Language',type:'text'},
            {key:'proficiency',label:'Proficiency',type:'select',options:[
                {value:'conversational',label:'Conversational'},{value:'professional',label:'Professional'},
                {value:'native',label:'Native / Bilingual'},{value:'basic',label:'Basic'},
            ]},
        ], listKey: 'languages'},
        'references': { endpoint: '/api/references', fields: [
            {key:'name',label:'Name',type:'text'},{key:'title',label:'Title',type:'text'},
            {key:'company',label:'Company',type:'text'},{key:'phone',label:'Phone',type:'tel'},
            {key:'email',label:'Email',type:'email'},{key:'relationship',label:'Relationship',type:'text'},
            {key:'years_known',label:'Years Known',type:'number'},
        ], listKey: 'references'},
    };

    function showForm(type, existingItem) {
        const cfg = formConfigs[type];
        const formEl = document.getElementById(`wh-${type}-form`);
        if (!formEl) return;
        const data = existingItem || {};
        const isEdit = !!data.id;
        const gridCols = cfg.fields.length <= 3 ? `repeat(${cfg.fields.length}, 1fr)` : 'repeat(auto-fill, minmax(180px, 1fr))';

        formEl.innerHTML = `
            <div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:16px;margin-top:12px;background:var(--bg-surface-secondary)">
                <div style="display:grid;grid-template-columns:${gridCols};gap:12px;margin-bottom:12px">
                    ${cfg.fields.map(f => {
                        const id = `wh-f-${type}-${f.key}`;
                        if (f.type === 'textarea') return `<div style="grid-column:1/-1"><label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">${f.label}</label><textarea class="textarea-styled textarea-notes" id="${id}" style="width:100%;min-height:80px">${escapeHtml(String(data[f.key] || ''))}</textarea></div>`;
                        if (f.type === 'checkbox') return `<div style="display:flex;align-items:center;gap:8px;align-self:end;padding-bottom:8px"><input type="checkbox" id="${id}" ${data[f.key] ? 'checked' : ''}><label style="font-size:0.8125rem;font-weight:600;color:var(--text-tertiary)">${f.label}</label></div>`;
                        if (f.type === 'select') return settingsSelect(f.label, id, String(data[f.key] || ''), f.options);
                        return settingsField(f.label, id, data[f.key], f.type, { extra: f.extra || '' });
                    }).join('')}
                </div>
                <div style="display:flex;gap:8px">
                    <button class="btn btn-primary btn-sm" id="wh-save-${type}">${isEdit ? 'Update' : 'Save'}</button>
                    <button class="btn btn-secondary btn-sm" id="wh-cancel-${type}">Cancel</button>
                </div>
            </div>`;

        document.getElementById(`wh-save-${type}`).addEventListener('click', async () => {
            const entry = {};
            if (data.id) entry.id = data.id;
            cfg.fields.forEach(f => {
                const input = document.getElementById(`wh-f-${type}-${f.key}`);
                if (!input) return;
                if (f.type === 'checkbox') entry[f.key] = input.checked ? 1 : 0;
                else if (f.type === 'number') entry[f.key] = input.value ? parseInt(input.value) : null;
                else entry[f.key] = input.value;
            });
            try {
                await api.request('POST', cfg.endpoint, entry);
                showToast(isEdit ? 'Updated' : 'Added', 'success');
                settingsData.fullProfile = await api.request('GET', '/api/profile/full');
                renderTabWorkHistory(container, settingsData.fullProfile);
            } catch (err) { showToast(err.message, 'error'); }
        });
        document.getElementById(`wh-cancel-${type}`).addEventListener('click', () => { formEl.innerHTML = ''; });
    }

    // Add buttons
    container.querySelectorAll('.wh-add-btn').forEach(btn => {
        btn.addEventListener('click', () => showForm(btn.dataset.type, null));
    });

    // Edit buttons
    container.querySelectorAll('.wh-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const type = btn.dataset.type;
            const id = parseInt(btn.dataset.id);
            const cfg = formConfigs[type];
            const items = fp[cfg.listKey] || [];
            const item = items.find(i => i.id === id);
            if (item) showForm(type, item);
        });
    });

    // Delete buttons
    container.querySelectorAll('.wh-delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const type = btn.dataset.type;
            const id = btn.dataset.id;
            if (!confirm('Delete this entry?')) return;
            try {
                await api.request('DELETE', `/api/${type}/${id}`);
                settingsData.fullProfile = await api.request('GET', '/api/profile/full');
                renderTabWorkHistory(container, settingsData.fullProfile);
                showToast('Deleted', 'info');
            } catch (err) { showToast(err.message, 'error'); }
        });
    });
}

// === Tab 3: Job Search ===
function renderTabJobSearch(container, config, profile, customQA) {
    const termsValue = (config.search_terms || []).join('\n');
    const excludeTermsValue = (config.exclude_terms || []).join('\n');
    const hasResume = config.resume_text && config.resume_text.length > 0;
    const jobTitles = config.job_titles || [];
    const keySkills = config.key_skills || [];
    const seniority = config.seniority || '';
    const summary = config.summary || '';
    const atsScore = config.ats_score || 0;
    const atsIssues = config.ats_issues || [];
    const atsTips = config.ats_tips || [];
    const hasAts = atsScore > 0;
    const hasAnalysis = jobTitles.length > 0 || summary;

    container.innerHTML = `
        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:16px">Resume</h2>
            <p style="color:var(--text-secondary);margin-bottom:16px;font-size:0.875rem">
                Upload your resume to automatically derive search terms. Supported: .pdf, .txt, .md files.
            </p>
            ${hasResume ? `<div class="status-badge status-prepared" style="margin-bottom:12px">Resume uploaded (${config.resume_text.length} chars)</div>` : ''}
            <div style="display:flex;gap:12px;align-items:center">
                <input type="file" id="resume-file" accept=".pdf,.txt,.md,.text" style="font-size:0.875rem">
                <button class="btn btn-primary" id="upload-resume-btn">Upload & Analyze</button>
            </div>
        </div>

        ${hasAts ? `
        <div class="card" style="padding:24px;margin-bottom:24px;${atsScore < 60 ? 'border-left:4px solid var(--danger)' : atsScore < 80 ? 'border-left:4px solid var(--warning, #f59e0b)' : 'border-left:4px solid var(--success, #22c55e)'}">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
                <h2 style="font-size:1.125rem;font-weight:600;margin:0">ATS Compatibility</h2>
                <span class="score-badge ${atsScore >= 80 ? 'score-badge-green' : atsScore >= 60 ? 'score-badge-amber' : 'score-badge-gray'}" style="font-size:1.25rem;padding:8px 16px">${atsScore}/100</span>
            </div>
            ${atsIssues.length ? `<div style="margin-bottom:12px"><span style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-tertiary)">Issues Found</span><ul style="margin-top:8px;padding-left:20px;display:flex;flex-direction:column;gap:4px">${atsIssues.map(i => `<li style="font-size:0.875rem;color:var(--text-secondary)">${escapeHtml(i)}</li>`).join('')}</ul></div>` : ''}
            ${atsTips.length ? `<div><span style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-tertiary)">Suggestions</span><ul style="margin-top:8px;padding-left:20px;display:flex;flex-direction:column;gap:4px">${atsTips.map(t => `<li style="font-size:0.875rem;color:var(--text-secondary)">${escapeHtml(t)}</li>`).join('')}</ul></div>` : ''}
        </div>` : ''}

        ${hasAnalysis ? `
        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:16px">Resume Analysis</h2>
            ${summary ? `<p style="color:var(--text-secondary);margin-bottom:16px;font-size:0.9375rem;line-height:1.6">${escapeHtml(summary)}</p>` : ''}
            ${seniority ? `<div style="margin-bottom:16px"><span style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-tertiary)">Seniority Level</span><div style="margin-top:4px;font-weight:600">${escapeHtml(seniority)}</div></div>` : ''}
            ${keySkills.length ? `<div style="margin-bottom:16px"><span style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-tertiary)">Key Skills</span><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">${keySkills.map(s => `<span style="background:var(--bg-tertiary);color:var(--text-primary);padding:4px 10px;border-radius:6px;font-size:0.8125rem">${escapeHtml(s)}</span>`).join('')}</div></div>` : ''}
            ${jobTitles.length ? `<div><span style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-tertiary)">Best-Fit Job Titles</span><div style="margin-top:8px;display:flex;flex-direction:column;gap:8px">${jobTitles.map(jt => {
                const title = typeof jt === 'string' ? jt : jt.title;
                const why = typeof jt === 'object' && jt.why ? jt.why : '';
                return `<div style="padding:10px 14px;border-radius:8px;background:var(--bg-tertiary)"><div style="font-weight:600;font-size:0.9375rem">${escapeHtml(title)}</div>${why ? `<div style="color:var(--text-secondary);font-size:0.8125rem;margin-top:2px">${escapeHtml(why)}</div>` : ''}</div>`;
            }).join('')}</div></div>` : ''}
        </div>` : ''}

        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:16px">Search Terms</h2>
            <p style="color:var(--text-secondary);margin-bottom:16px;font-size:0.875rem">
                These terms are used by scrapers to find relevant jobs. One per line.
            </p>
            <textarea class="textarea-styled" id="search-terms-textarea" rows="12" placeholder="e.g. senior devops engineer remote&#10;SRE remote&#10;platform engineer remote">${escapeHtml(termsValue)}</textarea>
            <div style="display:flex;gap:12px;margin-top:12px">
                <button class="btn btn-primary" id="save-terms-btn">Save Search Terms</button>
            </div>
        </div>

        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:16px">Exclude Terms</h2>
            <p style="color:var(--text-secondary);margin-bottom:16px;font-size:0.875rem">
                Jobs matching any of these terms will be hidden. One per line.
            </p>
            <textarea class="textarea-styled" id="exclude-terms-textarea" rows="6" placeholder="e.g. manager&#10;director&#10;VP">${escapeHtml(excludeTermsValue)}</textarea>
            <div style="display:flex;gap:12px;margin-top:12px">
                <button class="btn btn-primary" id="save-exclude-btn">Save Exclude Terms</button>
            </div>
        </div>

        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:16px">Salary Preferences</h2>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
                ${settingsField('Minimum Salary', 'js-sal-min', profile.desired_salary_min, 'number')}
                ${settingsField('Maximum Salary', 'js-sal-max', profile.desired_salary_max, 'number')}
                ${settingsSelect('Period', 'js-sal-period', profile.salary_period, [
                    {value:'',label:'Select...'},{value:'annual',label:'Annual'},{value:'hourly',label:'Hourly'},
                ])}
            </div>
        </div>

        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:16px">Availability</h2>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
                ${settingsField('Available From', 'js-avail-date', profile.availability_date, 'date')}
                ${settingsSelect('Notice Period', 'js-notice', profile.notice_period, [
                    {value:'',label:'Select...'},{value:'immediate',label:'Immediate'},
                    {value:'2_weeks',label:'2 Weeks'},{value:'1_month',label:'1 Month'},
                    {value:'2_months',label:'2 Months'},{value:'3_months',label:'3 Months'},
                ])}
                ${settingsSelect('Willing to Relocate', 'js-relocate', profile.willing_to_relocate, [
                    {value:'',label:'Select...'},{value:'yes',label:'Yes'},{value:'no',label:'No'},{value:'depends',label:'Depends'},
                ])}
            </div>
        </div>

        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:16px">Other Defaults</h2>
            ${settingsSelect('How did you hear about us? (default)', 'js-how-heard', profile.how_heard_default, [
                {value:'',label:'Select...'},{value:'job_board',label:'Job Board'},{value:'linkedin',label:'LinkedIn'},
                {value:'referral',label:'Referral'},{value:'company_website',label:'Company Website'},
                {value:'recruiter',label:'Recruiter'},{value:'other',label:'Other'},
            ])}
            <div style="margin-top:12px">
                <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Cover Letter Template</label>
                <textarea class="textarea-styled textarea-notes" id="js-cover-tpl" rows="6" placeholder="Dear Hiring Manager,&#10;&#10;I am writing to express my interest...">${escapeHtml(profile.cover_letter_template || '')}</textarea>
            </div>
            <button class="btn btn-primary" id="save-js-prefs-btn" style="margin-top:12px">Save Preferences</button>
        </div>

        <div class="card" style="padding:24px;margin-bottom:24px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
                <h2 style="font-size:1.125rem;font-weight:600;margin:0">Custom Q&A Bank</h2>
                <button class="btn btn-primary btn-sm" id="qa-add-btn">+ Add</button>
            </div>
            <div id="qa-items">${customQA.length ? customQA.map(q => `
                <div style="padding:12px 16px;background:var(--bg-surface-secondary);border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:8px">
                    <div style="display:flex;justify-content:space-between;align-items:start;gap:12px">
                        <div style="flex:1;min-width:0">
                            <div style="font-size:0.8125rem;font-weight:600;color:var(--text-tertiary)">Q: ${escapeHtml(q.question_pattern)}</div>
                            <div style="font-size:0.875rem;color:var(--text-secondary);margin-top:2px">${escapeHtml((q.answer || '').substring(0, 150))}${(q.answer || '').length > 150 ? '...' : ''}</div>
                        </div>
                        <div style="display:flex;gap:6px;flex-shrink:0">
                            <button class="btn btn-ghost btn-sm qa-edit-btn" data-id="${q.id}">Edit</button>
                            <button class="btn btn-danger btn-sm qa-del-btn" data-id="${q.id}">Delete</button>
                        </div>
                    </div>
                </div>
            `).join('') : '<p style="color:var(--text-tertiary);font-size:0.875rem">No saved Q&A pairs yet.</p>'}</div>
            <div id="qa-form-area"></div>
        </div>

        ${config.updated_at ? `<p style="color:var(--text-tertiary);font-size:0.8125rem;margin-bottom:24px">Last updated: ${formatDate(config.updated_at)}</p>` : ''}
    `;

    document.getElementById('upload-resume-btn').addEventListener('click', async () => {
        const fileInput = document.getElementById('resume-file');
        if (!fileInput.files.length) { showToast('Select a resume file first', 'error'); return; }
        const btn = document.getElementById('upload-resume-btn');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Analyzing...';
        try {
            const result = await api.uploadResume(fileInput.files[0]);
            showToast(`Resume analyzed! ${result.search_terms.length} search terms extracted.`, 'success');
            settingsData.config = await api.getSearchConfig();
            renderTabJobSearch(container, settingsData.config, profile, customQA);
        } catch (err) { showToast(err.message, 'error'); }
        finally { btn.disabled = false; btn.textContent = 'Upload & Analyze'; }
    });

    document.getElementById('save-terms-btn').addEventListener('click', async () => {
        const terms = document.getElementById('search-terms-textarea').value.split('\n').map(t => t.trim()).filter(Boolean);
        try {
            await api.updateSearchTerms(terms);
            showToast(`Saved ${terms.length} search terms`, 'success');
        } catch (err) { showToast(err.message, 'error'); }
    });

    document.getElementById('save-exclude-btn').addEventListener('click', async () => {
        const terms = document.getElementById('exclude-terms-textarea').value.split('\n').map(t => t.trim()).filter(Boolean);
        try {
            await api.request('POST', '/api/search-config/exclude-terms', { exclude_terms: terms });
            showToast(`Saved ${terms.length} exclude terms`, 'success');
        } catch (err) { showToast(err.message, 'error'); }
    });

    // Save job search preferences
    document.getElementById('save-js-prefs-btn').addEventListener('click', async () => {
        const prefs = {
            desired_salary_min: document.getElementById('js-sal-min').value ? parseInt(document.getElementById('js-sal-min').value) : null,
            desired_salary_max: document.getElementById('js-sal-max').value ? parseInt(document.getElementById('js-sal-max').value) : null,
            salary_period: document.getElementById('js-sal-period').value,
            availability_date: document.getElementById('js-avail-date').value,
            notice_period: document.getElementById('js-notice').value,
            willing_to_relocate: document.getElementById('js-relocate').value,
            how_heard_default: document.getElementById('js-how-heard').value,
            cover_letter_template: document.getElementById('js-cover-tpl').value,
        };
        try {
            await api.request('POST', '/api/profile', prefs);
            Object.assign(settingsData.fullProfile || {}, prefs);
            Object.assign(settingsData.profile || {}, prefs);
            showToast('Preferences saved', 'success');
        } catch (err) { showToast(err.message, 'error'); }
    });

    // Q&A handlers
    function showQAForm(existing) {
        const area = document.getElementById('qa-form-area');
        area.innerHTML = `
            <div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:16px;margin-top:12px;background:var(--bg-surface-secondary)">
                <div style="margin-bottom:12px">
                    <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Question Pattern</label>
                    <input type="text" class="search-input" id="qa-q" value="${escapeHtml(existing?.question_pattern || '')}" placeholder="e.g. Why do you want to work here?" style="width:100%">
                </div>
                <div style="margin-bottom:12px">
                    <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Category</label>
                    <input type="text" class="search-input" id="qa-cat" value="${escapeHtml(existing?.category || '')}" placeholder="e.g. motivation, experience" style="width:100%">
                </div>
                <div style="margin-bottom:12px">
                    <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Answer</label>
                    <textarea class="textarea-styled textarea-notes" id="qa-ans" rows="4">${escapeHtml(existing?.answer || '')}</textarea>
                </div>
                <div style="display:flex;gap:8px">
                    <button class="btn btn-primary btn-sm" id="qa-save-btn">Save</button>
                    <button class="btn btn-secondary btn-sm" id="qa-cancel-btn">Cancel</button>
                </div>
            </div>`;
        document.getElementById('qa-save-btn').addEventListener('click', async () => {
            const entry = { question_pattern: document.getElementById('qa-q').value, category: document.getElementById('qa-cat').value, answer: document.getElementById('qa-ans').value };
            if (existing?.id) entry.id = existing.id;
            try {
                await api.request('POST', '/api/custom-qa', entry);
                showToast('Q&A saved', 'success');
                const res = await api.request('GET', '/api/custom-qa');
                settingsData.customQA = res.items || [];
                renderTabJobSearch(container, settingsData.config, profile, settingsData.customQA);
            } catch (err) { showToast(err.message, 'error'); }
        });
        document.getElementById('qa-cancel-btn').addEventListener('click', () => { area.innerHTML = ''; });
    }

    document.getElementById('qa-add-btn').addEventListener('click', () => showQAForm(null));
    container.querySelectorAll('.qa-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const item = customQA.find(q => q.id === parseInt(btn.dataset.id));
            if (item) showQAForm(item);
        });
    });
    container.querySelectorAll('.qa-del-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm('Delete this Q&A?')) return;
            try {
                await api.request('DELETE', `/api/custom-qa/${btn.dataset.id}`);
                showToast('Deleted', 'info');
                const res = await api.request('GET', '/api/custom-qa');
                settingsData.customQA = res.items || [];
                renderTabJobSearch(container, settingsData.config, profile, settingsData.customQA);
            } catch (err) { showToast(err.message, 'error'); }
        });
    });
}

// === Tab 4: AI & Integrations ===
function renderTabAI(container, aiSettings, scraperKeys, emailSettings, embeddingSettings) {
    const aiProvider = aiSettings.provider || '';
    const aiKey = aiSettings.api_key || '';
    const aiModel = aiSettings.model || '';
    const aiBaseUrl = aiSettings.base_url || '';
    const hasKey = aiSettings.has_key || false;
    const keys = scraperKeys || {};

    container.innerHTML = `
        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:16px">AI Provider</h2>
            <p style="color:var(--text-secondary);margin-bottom:16px;font-size:0.875rem">
                Configure which AI backend to use for job scoring, resume analysis, and application autofill.
            </p>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
                <div>
                    <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Provider</label>
                    <select class="filter-select" id="ai-provider" style="width:100%">
                        <option value="anthropic" ${aiProvider === 'anthropic' ? 'selected' : ''}>Anthropic (Claude)</option>
                        <option value="openai" ${aiProvider === 'openai' ? 'selected' : ''}>OpenAI</option>
                        <option value="google" ${aiProvider === 'google' ? 'selected' : ''}>Google (Gemini)</option>
                        <option value="openrouter" ${aiProvider === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
                        <option value="ollama" ${aiProvider === 'ollama' ? 'selected' : ''}>Ollama (Local)</option>
                    </select>
                </div>
                <div>
                    <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Model</label>
                    <div id="ai-model-container">
                        <input type="text" class="search-input" id="ai-model" placeholder="${aiProvider === 'openai' ? 'e.g. gpt-4o' : aiProvider === 'google' ? 'e.g. gemini-2.0-flash' : 'e.g. claude-sonnet-4-20250514'}" value="${escapeHtml(aiModel)}" style="width:100%;${aiProvider === 'ollama' ? 'display:none' : ''}">
                        <div id="ai-model-ollama" style="${aiProvider === 'ollama' ? '' : 'display:none'}">
                            <div style="display:flex;gap:8px;align-items:center">
                                <select class="filter-select" id="ai-model-select" style="flex:1">
                                    ${aiModel ? `<option value="${escapeHtml(aiModel)}" selected>${escapeHtml(aiModel)}</option>` : '<option value="">Select a model...</option>'}
                                </select>
                                <button class="btn btn-secondary btn-sm" id="refresh-models-btn" style="white-space:nowrap">Refresh</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div id="ai-key-row" style="margin-bottom:12px;${aiProvider === 'ollama' ? 'display:none' : ''}">
                <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">API Key</label>
                <input type="password" class="search-input" id="ai-api-key" placeholder="${hasKey ? 'Key configured (leave blank to keep)' : 'Enter API key'}" value="${escapeHtml(aiKey)}" style="width:100%">
            </div>
            <div id="ai-url-row" style="margin-bottom:16px;${aiProvider === 'ollama' ? '' : 'display:none'}">
                <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Ollama URL</label>
                <input type="text" class="search-input" id="ai-base-url" placeholder="http://localhost:11434" value="${escapeHtml(aiBaseUrl)}" style="width:100%">
            </div>
            <div style="display:flex;gap:12px">
                <button class="btn btn-primary" id="save-ai-btn">Save AI Settings</button>
                <button class="btn btn-secondary" id="test-ai-btn">Test Connection</button>
            </div>
            <div id="ai-test-result" style="margin-top:12px"></div>
        </div>

        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:8px">Scraper API Keys</h2>
            <p style="color:var(--text-secondary);margin-bottom:16px;font-size:0.875rem">
                Optional API keys to enable additional job sources.
            </p>
            <div style="display:flex;flex-direction:column;gap:16px">
                <div>
                    <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">USAJobs API Key</label>
                    <input type="password" class="search-input" id="scraper-key-usajobs" placeholder="API key" value="${keys.usajobs?.has_key ? '****' : ''}" style="margin-bottom:4px">
                    <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px;margin-top:4px">USAJobs Email</label>
                    <input type="email" class="search-input" id="scraper-email-usajobs" placeholder="Email used when registering" value="${escapeHtml(keys.usajobs?.email || '')}">
                </div>
                <div>
                    <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Adzuna App ID</label>
                    <input type="password" class="search-input" id="scraper-key-adzuna-id" placeholder="App ID" value="${keys['adzuna-id']?.has_key ? '****' : ''}" style="margin-bottom:4px">
                    <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px;margin-top:4px">Adzuna App Key</label>
                    <input type="password" class="search-input" id="scraper-key-adzuna" placeholder="App key" value="${keys.adzuna?.has_key ? '****' : ''}">
                </div>
                <div>
                    <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">JSearch (RapidAPI) Key</label>
                    <input type="password" class="search-input" id="scraper-key-jsearch" placeholder="RapidAPI key" value="${keys.jsearch?.has_key ? '****' : ''}">
                </div>
            </div>
            <button class="btn btn-primary" id="save-scraper-keys-btn" style="margin-top:16px">Save Scraper Keys</button>
        </div>

        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:8px">Email & Digest Settings</h2>
            <p style="color:var(--text-secondary);margin-bottom:16px;font-size:0.875rem">
                Configure SMTP for sending application emails and automated job digest notifications.
            </p>
            <h3 style="font-size:0.9375rem;font-weight:600;margin-bottom:12px;color:var(--text-secondary)">SMTP Configuration</h3>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
                ${settingsField('SMTP Host', 'email-smtp-host', emailSettings.smtp_host || '', 'text', { placeholder: 'smtp.gmail.com' })}
                ${settingsField('SMTP Port', 'email-smtp-port', emailSettings.smtp_port || 587, 'number')}
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
                ${settingsField('Username', 'email-smtp-username', emailSettings.smtp_username || '', 'text', { placeholder: 'your@email.com' })}
                ${settingsField('Password', 'email-smtp-password', '', 'password', { placeholder: emailSettings.smtp_host ? 'Configured (leave blank to keep)' : 'SMTP password' })}
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
                ${settingsField('From Address', 'email-from-address', emailSettings.from_address || '', 'email', { placeholder: 'noreply@example.com' })}
                ${settingsField('To Address (for digests)', 'email-to-address', emailSettings.to_address || '', 'email', { placeholder: 'you@example.com' })}
            </div>
            <div style="margin-bottom:16px">
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                    <input type="checkbox" id="email-smtp-tls" ${emailSettings.smtp_use_tls !== false ? 'checked' : ''}>
                    <span style="font-size:0.875rem">Use TLS</span>
                </label>
            </div>

            <h3 style="font-size:0.9375rem;font-weight:600;margin-bottom:12px;margin-top:20px;color:var(--text-secondary)">Digest Settings</h3>
            <div style="margin-bottom:12px">
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                    <input type="checkbox" id="email-digest-enabled" ${emailSettings.digest_enabled ? 'checked' : ''}>
                    <span style="font-size:0.875rem;font-weight:600">Enable automated digest emails</span>
                </label>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px">
                ${settingsSelect('Schedule', 'email-digest-schedule', emailSettings.digest_schedule || 'daily', [
                    { value: 'daily', label: 'Daily' },
                    { value: 'weekly', label: 'Weekly' },
                ])}
                ${settingsField('Send Time', 'email-digest-time', emailSettings.digest_time || '08:00', 'time')}
                ${settingsField('Min Score', 'email-digest-min-score', emailSettings.digest_min_score || 60, 'number')}
            </div>
            <div style="display:flex;gap:12px">
                <button class="btn btn-primary" id="save-email-btn">Save Email Settings</button>
                <button class="btn btn-secondary" id="test-email-btn">Send Test Email</button>
                <button class="btn btn-secondary" id="test-digest-btn">Send Test Digest</button>
            </div>
            <div id="email-test-result" style="margin-top:12px"></div>
        </div>

        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:8px">Embedding Settings</h2>
            <p style="color:var(--text-secondary);margin-bottom:16px;font-size:0.875rem">
                Configure vector embeddings for semantic job search and similar job recommendations.
            </p>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
                ${settingsSelect('Provider', 'emb-provider', embeddingSettings.provider || '', [
                    { value: 'openai', label: 'OpenAI' },
                    { value: 'ollama', label: 'Ollama' },
                ])}
                <div>
                    <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Model</label>
                    <input type="text" class="search-input" id="emb-model" value="${escapeHtml(embeddingSettings.model || '')}" placeholder="${(!embeddingSettings.provider || embeddingSettings.provider === 'openai') ? 'text-embedding-3-small' : 'nomic-embed-text'}" style="width:100%">
                </div>
            </div>
            <div id="emb-key-row" style="margin-bottom:12px;${embeddingSettings.provider === 'ollama' ? 'display:none' : ''}">
                <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">API Key</label>
                <input type="password" class="search-input" id="emb-api-key" placeholder="${embeddingSettings.has_key ? 'Key configured (leave blank to keep)' : 'Enter API key'}" style="width:100%">
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
                <div id="emb-url-row" style="${embeddingSettings.provider === 'ollama' ? '' : 'display:none'}">
                    <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Base URL</label>
                    <input type="text" class="search-input" id="emb-base-url" value="${escapeHtml(embeddingSettings.base_url || '')}" placeholder="http://localhost:11434" style="width:100%">
                </div>
                ${settingsField('Dimensions', 'emb-dimensions', embeddingSettings.dimensions || (embeddingSettings.provider === 'ollama' ? 768 : 256), 'number')}
            </div>
            <div style="display:flex;gap:12px">
                <button class="btn btn-primary" id="save-emb-btn">Save Embedding Settings</button>
                <button class="btn btn-secondary" id="backfill-emb-btn">Backfill Embeddings</button>
            </div>
            <div id="emb-result" style="margin-top:12px"></div>
        </div>
    `;

    // AI provider toggle
    const modelPlaceholders = { anthropic: 'e.g. claude-sonnet-4-20250514', openai: 'e.g. gpt-4o', google: 'e.g. gemini-2.0-flash', openrouter: 'e.g. anthropic/claude-sonnet-4', ollama: '' };
    document.getElementById('ai-provider').addEventListener('change', (e) => {
        const provider = e.target.value;
        const isOllama = provider === 'ollama';
        document.getElementById('ai-key-row').style.display = isOllama ? 'none' : '';
        document.getElementById('ai-url-row').style.display = isOllama ? '' : 'none';
        document.getElementById('ai-model').style.display = isOllama ? 'none' : '';
        document.getElementById('ai-model').placeholder = modelPlaceholders[provider] || '';
        document.getElementById('ai-model-ollama').style.display = isOllama ? '' : 'none';
        if (isOllama) fetchOllamaModels();
    });

    async function fetchOllamaModels() {
        const select = document.getElementById('ai-model-select');
        const currentVal = select.value;
        const btn = document.getElementById('refresh-models-btn');
        btn.disabled = true; btn.textContent = '...';
        try {
            const baseUrl = document.getElementById('ai-base-url').value || 'http://localhost:11434';
            const result = await api.getOllamaModels(baseUrl);
            if (result.ok && result.models.length > 0) {
                select.innerHTML = result.models.map(m => `<option value="${escapeHtml(m)}" ${m === currentVal ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
                if (!currentVal) select.value = result.models[0];
            } else if (!result.ok) {
                select.innerHTML = `<option value="">Failed to connect</option>`;
            } else {
                select.innerHTML = `<option value="">No models found</option>`;
            }
        } catch { select.innerHTML = `<option value="">Error loading models</option>`; }
        finally { btn.disabled = false; btn.textContent = 'Refresh'; }
    }

    document.getElementById('refresh-models-btn').addEventListener('click', fetchOllamaModels);
    if (document.getElementById('ai-provider').value === 'ollama') fetchOllamaModels();

    function getAIFormValues() {
        const provider = document.getElementById('ai-provider').value;
        const model = provider === 'ollama' ? document.getElementById('ai-model-select').value : document.getElementById('ai-model').value;
        return { provider, api_key: document.getElementById('ai-api-key').value, model, base_url: document.getElementById('ai-base-url').value };
    }

    document.getElementById('save-ai-btn').addEventListener('click', async () => {
        const btn = document.getElementById('save-ai-btn');
        btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Saving...';
        try { await api.updateAISettings(getAIFormValues()); showToast('AI settings saved', 'success'); }
        catch (err) { showToast(err.message, 'error'); }
        finally { btn.disabled = false; btn.textContent = 'Save AI Settings'; }
    });

    document.getElementById('test-ai-btn').addEventListener('click', async () => {
        const btn = document.getElementById('test-ai-btn');
        const resultDiv = document.getElementById('ai-test-result');
        btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Testing...'; resultDiv.innerHTML = '';
        try {
            const result = await api.testAIConnection(getAIFormValues());
            resultDiv.innerHTML = result.ok
                ? `<div style="color:var(--success, #22c55e);font-size:0.875rem;font-weight:600">Connection successful! Response: "${escapeHtml(result.response)}"</div>`
                : `<div style="color:var(--danger, #ef4444);font-size:0.875rem;font-weight:600">Connection failed: ${escapeHtml(result.error)}</div>`;
        } catch (err) { resultDiv.innerHTML = `<div style="color:var(--danger, #ef4444);font-size:0.875rem">${escapeHtml(err.message)}</div>`; }
        finally { btn.disabled = false; btn.textContent = 'Test Connection'; }
    });

    document.getElementById('save-scraper-keys-btn').addEventListener('click', async () => {
        const payload = {
            usajobs: { api_key: document.getElementById('scraper-key-usajobs').value, email: document.getElementById('scraper-email-usajobs').value },
            'adzuna-id': { api_key: document.getElementById('scraper-key-adzuna-id').value, email: '' },
            adzuna: { api_key: document.getElementById('scraper-key-adzuna').value, email: '' },
            jsearch: { api_key: document.getElementById('scraper-key-jsearch').value, email: '' },
        };
        try { await api.request('POST', '/api/scraper-keys', payload); showToast('Scraper keys saved', 'success'); }
        catch (err) { showToast(err.message, 'error'); }
    });

    function getEmailFormValues() {
        return {
            smtp_host: document.getElementById('email-smtp-host').value,
            smtp_port: parseInt(document.getElementById('email-smtp-port').value) || 587,
            smtp_username: document.getElementById('email-smtp-username').value,
            smtp_password: document.getElementById('email-smtp-password').value,
            smtp_use_tls: document.getElementById('email-smtp-tls').checked,
            from_address: document.getElementById('email-from-address').value,
            to_address: document.getElementById('email-to-address').value,
            digest_enabled: document.getElementById('email-digest-enabled').checked,
            digest_schedule: document.getElementById('email-digest-schedule').value,
            digest_time: document.getElementById('email-digest-time').value || '08:00',
            digest_min_score: parseInt(document.getElementById('email-digest-min-score').value) || 60,
        };
    }

    document.getElementById('save-email-btn').addEventListener('click', async () => {
        const btn = document.getElementById('save-email-btn');
        btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Saving...';
        try {
            await api.request('POST', '/api/settings/email', getEmailFormValues());
            showToast('Email settings saved', 'success');
        } catch (err) { showToast(err.message, 'error'); }
        finally { btn.disabled = false; btn.textContent = 'Save Email Settings'; }
    });

    document.getElementById('test-email-btn').addEventListener('click', async () => {
        const btn = document.getElementById('test-email-btn');
        const resultDiv = document.getElementById('email-test-result');
        btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Sending...'; resultDiv.innerHTML = '';
        try {
            const result = await api.request('POST', '/api/settings/email/test', getEmailFormValues());
            resultDiv.innerHTML = `<div style="color:var(--success, #22c55e);font-size:0.875rem;font-weight:600">${escapeHtml(result.message)}</div>`;
        } catch (err) {
            resultDiv.innerHTML = `<div style="color:var(--danger, #ef4444);font-size:0.875rem">${escapeHtml(err.message)}</div>`;
        }
        finally { btn.disabled = false; btn.textContent = 'Send Test Email'; }
    });

    document.getElementById('test-digest-btn').addEventListener('click', async () => {
        const btn = document.getElementById('test-digest-btn');
        const resultDiv = document.getElementById('email-test-result');
        btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Sending...'; resultDiv.innerHTML = '';
        try {
            const result = await api.request('POST', '/api/digest/send-test');
            resultDiv.innerHTML = `<div style="color:var(--success, #22c55e);font-size:0.875rem;font-weight:600">${escapeHtml(result.message)}</div>`;
        } catch (err) {
            resultDiv.innerHTML = `<div style="color:var(--danger, #ef4444);font-size:0.875rem">${escapeHtml(err.message)}</div>`;
        }
        finally { btn.disabled = false; btn.textContent = 'Send Test Digest'; }
    });

    // Embedding provider toggle
    const embDefaults = { openai: { model: 'text-embedding-3-small', dims: 256 }, ollama: { model: 'nomic-embed-text', dims: 768 } };
    document.getElementById('emb-provider').addEventListener('change', (e) => {
        const provider = e.target.value;
        const isOllama = provider === 'ollama';
        document.getElementById('emb-key-row').style.display = isOllama ? 'none' : '';
        document.getElementById('emb-url-row').style.display = isOllama ? '' : 'none';
        document.getElementById('emb-model').placeholder = embDefaults[provider]?.model || '';
        document.getElementById('emb-dimensions').value = embDefaults[provider]?.dims || 256;
    });

    document.getElementById('save-emb-btn').addEventListener('click', async () => {
        const btn = document.getElementById('save-emb-btn');
        const resultDiv = document.getElementById('emb-result');
        btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Saving...';
        try {
            const payload = {
                provider: document.getElementById('emb-provider').value,
                api_key: document.getElementById('emb-api-key').value,
                model: document.getElementById('emb-model').value,
                base_url: document.getElementById('emb-base-url').value,
                dimensions: parseInt(document.getElementById('emb-dimensions').value) || 256,
            };
            await api.request('POST', '/api/settings/embeddings', payload);
            showToast('Embedding settings saved', 'success');
            resultDiv.innerHTML = '';
        } catch (err) {
            showToast(err.message, 'error');
            resultDiv.innerHTML = `<div style="color:var(--danger, #ef4444);font-size:0.875rem">${escapeHtml(err.message)}</div>`;
        }
        finally { btn.disabled = false; btn.textContent = 'Save Embedding Settings'; }
    });

    document.getElementById('backfill-emb-btn').addEventListener('click', async () => {
        const btn = document.getElementById('backfill-emb-btn');
        const resultDiv = document.getElementById('emb-result');
        btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Backfilling...';
        resultDiv.innerHTML = '<div style="font-size:0.875rem;color:var(--text-secondary)">Processing embeddings, this may take a while...</div>';
        try {
            const result = await api.request('POST', '/api/embeddings/backfill');
            resultDiv.innerHTML = `<div style="color:var(--success, #22c55e);font-size:0.875rem;font-weight:600">Backfill complete: ${result.embedded || 0}/${result.total || 0} jobs embedded${result.errors ? `, ${result.errors} errors` : ''}</div>`;
        } catch (err) {
            resultDiv.innerHTML = `<div style="color:var(--danger, #ef4444);font-size:0.875rem">${escapeHtml(err.message)}</div>`;
        }
        finally { btn.disabled = false; btn.textContent = 'Backfill Embeddings'; }
    });
}

// === Tab 5: Data Management ===
function renderTabData(container) {
    container.innerHTML = `
        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:16px">Export</h2>
            <p style="color:var(--text-secondary);margin-bottom:16px;font-size:0.875rem">Export your job data as CSV.</p>
            <a href="/api/export/csv" class="btn btn-secondary" download>Download CSV Export</a>
        </div>

        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:16px">Export / Import Profile</h2>
            <p style="color:var(--text-secondary);margin-bottom:16px;font-size:0.875rem">
                Export your full profile data as JSON, or import from a previously exported file.
            </p>
            <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
                <button class="btn btn-secondary" id="export-profile-btn">Export Profile JSON</button>
                <input type="file" id="import-profile-file" accept=".json" style="font-size:0.875rem">
                <button class="btn btn-secondary" id="import-profile-btn">Import Profile</button>
            </div>
        </div>

        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:16px">Autofill History</h2>
            <p style="color:var(--text-secondary);margin-bottom:16px;font-size:0.875rem">Recent autofill sessions from the browser extension.</p>
            <div id="autofill-history-list"><span class="spinner"></span></div>
        </div>

        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:16px">Scraper Schedule</h2>
            <p style="color:var(--text-secondary);margin-bottom:16px;font-size:0.875rem">Configure how often each scraper runs. Set interval in hours (e.g. 168 = weekly).</p>
            <div id="scraper-schedule-list"><span class="spinner"></span></div>
        </div>

        <div class="card" style="padding:24px;margin-bottom:24px;border-left:4px solid var(--danger, #ef4444)">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:16px;color:var(--danger, #ef4444)">Danger Zone</h2>
            <div style="display:flex;flex-direction:column;gap:16px">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:16px">
                    <div>
                        <div style="font-weight:600;font-size:0.9375rem">Clear Jobs & Scores</div>
                        <div style="color:var(--text-secondary);font-size:0.8125rem">Remove all scraped jobs, scores, and application data. Keeps your resume, search terms, and AI settings.</div>
                    </div>
                    <button class="btn btn-danger" id="clear-jobs-btn" style="white-space:nowrap">Clear Jobs</button>
                </div>
                <div style="border-top:1px solid var(--border);padding-top:16px;display:flex;align-items:center;justify-content:space-between;gap:16px">
                    <div>
                        <div style="font-weight:600;font-size:0.9375rem">Reset Everything</div>
                        <div style="color:var(--text-secondary);font-size:0.8125rem">Remove all data including resume, search terms, AI settings, jobs, and scores. Returns to a fresh state.</div>
                    </div>
                    <button class="btn btn-danger" id="clear-all-btn" style="white-space:nowrap">Reset All</button>
                </div>
            </div>
        </div>
    `;

    // Load autofill history
    api.request('GET', '/api/autofill/history').then(data => {
        const list = container.querySelector('#autofill-history-list');
        const items = data.items || [];
        if (!items.length) { list.innerHTML = '<p style="color:var(--text-tertiary);font-size:0.875rem">No autofill sessions yet.</p>'; return; }
        list.innerHTML = items.map(h => `
            <div style="padding:8px 12px;background:var(--bg-surface-secondary);border-radius:var(--radius-sm);margin-bottom:6px">
                <div style="font-weight:600;font-size:0.875rem">${escapeHtml(h.job_title || 'Unknown')} at ${escapeHtml(h.company || 'Unknown')}</div>
                <div style="color:var(--text-tertiary);font-size:0.8125rem">${formatDate(h.created_at)}</div>
            </div>
        `).join('');
    }).catch(() => {
        container.querySelector('#autofill-history-list').innerHTML = '<p style="color:var(--text-tertiary)">Could not load history.</p>';
    });

    // Load scraper schedules
    api.request('GET', '/api/scraper-schedule').then(data => {
        const list = container.querySelector('#scraper-schedule-list');
        const schedules = data.schedules || [];
        if (!schedules.length) {
            list.innerHTML = '<p style="color:var(--text-tertiary);font-size:0.875rem">No scraper schedules configured yet. Scrapers will use the global interval. Run a scrape cycle first to populate sources.</p>';
            return;
        }
        list.innerHTML = `
            <table style="width:100%;border-collapse:collapse;font-size:0.875rem">
                <thead>
                    <tr style="border-bottom:2px solid var(--border);text-align:left">
                        <th style="padding:8px 12px">Source</th>
                        <th style="padding:8px 12px">Interval (hours)</th>
                        <th style="padding:8px 12px">Last Ran</th>
                        <th style="padding:8px 12px"></th>
                    </tr>
                </thead>
                <tbody>
                    ${schedules.map(s => `
                        <tr style="border-bottom:1px solid var(--border)" data-source="${escapeHtml(s.source_name)}">
                            <td style="padding:8px 12px;font-weight:600">${escapeHtml(s.source_name)}</td>
                            <td style="padding:8px 12px"><input type="number" min="1" value="${s.interval_hours}" style="width:80px;padding:4px 8px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-surface);color:var(--text-primary)" class="schedule-interval"></td>
                            <td style="padding:8px 12px;color:var(--text-secondary)">${s.last_scraped_at ? formatDate(s.last_scraped_at) : 'Never'}</td>
                            <td style="padding:8px 12px"><button class="btn btn-secondary schedule-save-btn" style="padding:4px 12px;font-size:0.8125rem">Save</button></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
        list.querySelectorAll('.schedule-save-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const row = btn.closest('tr');
                const source_name = row.dataset.source;
                const interval_hours = parseInt(row.querySelector('.schedule-interval').value, 10);
                if (!interval_hours || interval_hours < 1) { showToast('Interval must be at least 1 hour', 'error'); return; }
                try {
                    await api.request('POST', '/api/scraper-schedule', { source_name, interval_hours });
                    showToast(`Schedule updated for ${source_name}`, 'success');
                } catch (err) { showToast(err.message, 'error'); }
            });
        });
    }).catch(() => {
        container.querySelector('#scraper-schedule-list').innerHTML = '<p style="color:var(--text-tertiary)">Could not load scraper schedules.</p>';
    });

    document.getElementById('clear-jobs-btn').addEventListener('click', async () => {
        if (!confirm('This will permanently delete all jobs, scores, and applications. Continue?')) return;
        try { await api.request('POST', '/api/clear-jobs'); showToast('All jobs cleared', 'info'); }
        catch (err) { showToast(err.message, 'error'); }
    });

    document.getElementById('clear-all-btn').addEventListener('click', async () => {
        if (!confirm('This will permanently delete ALL data. Continue?')) return;
        if (!confirm('Are you sure? This cannot be undone.')) return;
        try {
            await api.request('POST', '/api/clear-all');
            showToast('All data reset', 'info');
            settingsData = {};
            await renderSettings(document.getElementById('app'));
        } catch (err) { showToast(err.message, 'error'); }
    });

    // Export profile
    document.getElementById('export-profile-btn').addEventListener('click', async () => {
        try {
            const data = await api.request('GET', '/api/profile/full');
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'jobfinder-profile.json'; a.click();
            URL.revokeObjectURL(url);
            showToast('Profile exported', 'success');
        } catch (err) { showToast(err.message, 'error'); }
    });

    // Import profile
    document.getElementById('import-profile-btn').addEventListener('click', async () => {
        const fileInput = document.getElementById('import-profile-file');
        if (!fileInput.files.length) { showToast('Select a JSON file first', 'error'); return; }
        try {
            const text = await fileInput.files[0].text();
            const data = JSON.parse(text);
            await api.request('PUT', '/api/profile/full', data);
            showToast('Profile imported successfully', 'success');
            settingsData.fullProfile = await api.request('GET', '/api/profile/full');
            settingsData.profile = await api.request('GET', '/api/profile');
        } catch (err) { showToast(err.message, 'error'); }
    });
}

// === Theme Toggle ===
function initTheme() {
    const saved = localStorage.getItem('jf_theme');
    if (saved) {
        document.documentElement.setAttribute('data-theme', saved);
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        document.documentElement.setAttribute('data-theme', 'dark');
    }
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('jf_theme', next);
}

// === Keyboard Shortcuts ===
let focusedJobIndex = -1;

const SHORTCUTS = {
    'j': { desc: 'Next job', action: () => navigateJob(1) },
    'k': { desc: 'Previous job', action: () => navigateJob(-1) },
    'o': { desc: 'Open job listing', action: openCurrentJob },
    'd': { desc: 'Dismiss job', action: dismissCurrentJob },
    'p': { desc: 'Prepare application', action: prepareCurrentJob },
    's': { desc: 'Scrape now', action: handleScrape },
    '/': { desc: 'Focus search', action: focusSearch },
    't': { desc: 'Triage mode', action: enterTriageMode },
    '?': { desc: 'Show shortcuts', action: toggleShortcutsHelp },
    'Escape': { desc: 'Close / Go back', action: goBack },
};

document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

    // Triage mode key bindings
    if (triageActive) {
        if (e.key === 'ArrowRight') { e.preventDefault(); triageKeep(); return; }
        if (e.key === 'ArrowLeft') { e.preventDefault(); triageDismiss(); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); triageSkip(); return; }
        if (e.key === 'z') { e.preventDefault(); triageUndo(); return; }
        if (e.key === 'Enter') {
            e.preventDefault();
            const job = triageJobs[triageIndex];
            if (job) navigate(`#/job/${job.id}`);
            return;
        }
        if (e.key === 'Escape') { e.preventDefault(); exitTriageMode(); return; }
        return;
    }

    if (e.key === 'Enter' && focusedJobIndex >= 0) {
        const cards = document.querySelectorAll('.job-card');
        if (cards[focusedJobIndex]) cards[focusedJobIndex].click();
        return;
    }

    const key = e.key;
    const shortcut = SHORTCUTS[key];
    if (shortcut) {
        e.preventDefault();
        shortcut.action();
    }
});

function navigateJob(delta) {
    const cards = document.querySelectorAll('.job-card');
    if (!cards.length) return;
    cards.forEach(c => c.classList.remove('job-card-focused'));
    focusedJobIndex = Math.max(0, Math.min(cards.length - 1, focusedJobIndex + delta));
    const card = cards[focusedJobIndex];
    card.classList.add('job-card-focused');
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function openCurrentJob() {
    const openLink = document.querySelector('a[target="_blank"][href^="http"]');
    if (openLink) window.open(openLink.href, '_blank');
}

function dismissCurrentJob() {
    const cards = document.querySelectorAll('.job-card');
    if (focusedJobIndex >= 0 && focusedJobIndex < cards.length) {
        const dismissBtn = cards[focusedJobIndex].querySelector('.dismiss-btn');
        if (dismissBtn) dismissBtn.click();
    }
}

function prepareCurrentJob() {
    const prepareBtn = document.getElementById('prepare-btn');
    if (prepareBtn && !prepareBtn.disabled) prepareBtn.click();
}

function focusSearch() {
    const searchInput = document.querySelector('.search-input');
    if (searchInput) searchInput.focus();
}

function goBack() {
    const modal = document.getElementById('shortcuts-modal');
    if (modal) { modal.remove(); return; }
    if (window.location.hash.startsWith('#/job/')) {
        window.location.hash = '#/';
    }
}

function toggleShortcutsHelp() {
    let modal = document.getElementById('shortcuts-modal');
    if (modal) { modal.remove(); return; }
    modal = document.createElement('div');
    modal.id = 'shortcuts-modal';
    modal.innerHTML = `
        <div class="modal-overlay" onclick="document.getElementById('shortcuts-modal').remove()">
            <div class="modal-content" onclick="event.stopPropagation()">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
                    <h2 style="font-size:1.125rem;font-weight:700;margin:0">Keyboard Shortcuts</h2>
                    <button class="btn btn-ghost btn-sm" onclick="document.getElementById('shortcuts-modal').remove()">Close</button>
                </div>
                <div class="shortcuts-grid">
                    ${Object.entries(SHORTCUTS).map(([key, {desc}]) =>
                        `<div class="shortcut-key"><kbd>${key === ' ' ? 'Space' : key}</kbd></div><div class="shortcut-desc">${desc}</div>`
                    ).join('')}
                    <div class="shortcut-key"><kbd>Enter</kbd></div><div class="shortcut-desc">Open focused job</div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

// === Init ===
// === Reminder Actions (global for onclick handlers) ===
window.completeReminder = async function(id) {
    try {
        await api.request('POST', `/api/reminders/${id}/complete`);
        showToast('Reminder completed', 'success');
        handleRoute();
    } catch (err) { showToast(err.message, 'error'); }
};
window.dismissReminder = async function(id) {
    try {
        await api.request('POST', `/api/reminders/${id}/dismiss`);
        showToast('Reminder dismissed', 'success');
        handleRoute();
    } catch (err) { showToast(err.message, 'error'); }
};

// === Notifications ===
let notifDropdownOpen = false;

async function updateNotifBadge() {
    try {
        const data = await api.getNotifications();
        const badge = document.getElementById('notif-badge');
        if (badge) {
            badge.textContent = data.unread_count;
            badge.style.display = data.unread_count > 0 ? '' : 'none';
        }
    } catch {}
}

function renderNotifDropdown(notifications) {
    const dropdown = document.getElementById('notif-dropdown');
    if (!dropdown) return;

    if (notifications.length === 0) {
        dropdown.innerHTML = `<div class="notif-empty">No notifications</div>`;
        return;
    }

    dropdown.innerHTML = `
        <div class="notif-header">
            <span style="font-weight:600;font-size:0.875rem">Notifications</span>
            <button class="btn btn-ghost btn-sm" id="notif-read-all">Mark all read</button>
        </div>
        <div class="notif-list">
            ${notifications.slice(0, 20).map(n => `
                <div class="notif-item ${n.read ? '' : 'notif-unread'}" data-notif-id="${n.id}" data-job-id="${n.job_id}">
                    <div class="notif-item-title">${escapeHtml(n.title)}</div>
                    <div class="notif-item-message">${escapeHtml(n.message)}</div>
                </div>
            `).join('')}
        </div>
    `;

    document.getElementById('notif-read-all')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        await api.markAllNotificationsRead();
        updateNotifBadge();
        dropdown.querySelectorAll('.notif-unread').forEach(el => el.classList.remove('notif-unread'));
    });

    dropdown.querySelectorAll('.notif-item').forEach(item => {
        item.addEventListener('click', async () => {
            const notifId = item.dataset.notifId;
            const jobId = item.dataset.jobId;
            await api.markNotificationRead(notifId);
            item.classList.remove('notif-unread');
            updateNotifBadge();
            dropdown.style.display = 'none';
            notifDropdownOpen = false;
            navigate(`#/job/${jobId}`);
        });
    });
}

async function toggleNotifDropdown() {
    const dropdown = document.getElementById('notif-dropdown');
    if (!dropdown) return;
    notifDropdownOpen = !notifDropdownOpen;
    if (notifDropdownOpen) {
        dropdown.style.display = 'block';
        try {
            const data = await api.getNotifications();
            renderNotifDropdown(data.notifications);
        } catch {}
    } else {
        dropdown.style.display = 'none';
    }
}

function initNotificationSSE() {
    const evtSource = new EventSource('/api/notifications/stream');
    evtSource.onmessage = (event) => {
        try {
            const notif = JSON.parse(event.data);
            showToast(`${notif.title}: ${notif.message}`, 'info');
            updateNotifBadge();
        } catch {}
    };
    evtSource.onerror = () => {
        evtSource.close();
        setTimeout(initNotificationSSE, 30000);
    };
}

document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    handleRoute();

    window.addEventListener('hashchange', handleRoute);
    document.getElementById('scrape-btn').addEventListener('click', handleScrape);
    document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
    document.getElementById('notif-btn').addEventListener('click', toggleNotifDropdown);

    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
        if (notifDropdownOpen && !e.target.closest('.notif-btn') && !e.target.closest('.notif-dropdown')) {
            document.getElementById('notif-dropdown').style.display = 'none';
            notifDropdownOpen = false;
        }
    });

    updateNotifBadge();
    initNotificationSSE();
});
