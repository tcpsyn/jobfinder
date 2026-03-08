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

    prepareApplication(id) {
        return this.request('POST', `/api/jobs/${id}/prepare`);
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

// === State ===
let currentJobs = [];
let currentOffset = 0;
const PAGE_SIZE = 50;

// === Router ===
function getRoute() {
    const hash = window.location.hash || '#/';
    if (hash.startsWith('#/job/')) {
        const id = hash.slice(6);
        return { view: 'detail', id: parseInt(id, 10) };
    }
    if (hash === '#/stats') return { view: 'stats' };
    if (hash === '#/settings') return { view: 'settings' };
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
    } else if (route.view === 'settings') {
        await renderSettings(app);
    } else {
        await renderFeed(app);
    }
}

// === Feed View ===
async function renderFeed(container) {
    currentOffset = 0;
    container.innerHTML = `
        <div class="filter-bar">
            <input type="text" class="search-input" id="filter-search" placeholder="Search jobs...">
            <select class="filter-select" id="filter-score">
                <option value="">All scores</option>
                <option value="40">40+</option>
                <option value="60" selected>60+</option>
                <option value="80">80+</option>
            </select>
            <select class="filter-select" id="filter-sort">
                <option value="score">Sort by score</option>
                <option value="date">Sort by date</option>
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
    const loadMoreBtn = document.getElementById('load-more-btn');

    let debounceTimer;
    const reload = () => {
        currentOffset = 0;
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
    loadMoreBtn.addEventListener('click', () => loadJobs(true));

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

function createJobCard(job) {
    const card = document.createElement('div');
    card.className = 'card card-interactive job-card';
    card.dataset.jobId = job.id;

    const score = job.match_score;
    const salary = formatSalary(job.salary_min, job.salary_max);
    const scoreClass = getScoreClass(score);
    const newTag = isNew(job.created_at) ? `<span class="new-indicator">New</span>` : '';
    const statusTag = job.app_status ? `<span class="status-badge status-${job.app_status}">${job.app_status}</span>` : '';

    card.innerHTML = `
        <div class="job-card-content">
            <div class="job-card-header">
                <span class="job-card-title text-truncate">${escapeHtml(job.title)}</span>
                ${newTag}
                ${statusTag}
            </div>
            <span class="job-card-company">${escapeHtml(job.company)}</span>
            <div class="job-card-meta">
                ${job.location ? `<span>${escapeHtml(job.location)}</span>` : ''}
                ${salary ? `<span>${salary}</span>` : ''}
                <span>${formatDate(job.created_at)}</span>
            </div>
        </div>
        <div class="job-card-actions">
            <span class="score-badge ${scoreClass}">${score !== null && score !== undefined ? score : '--'}</span>
            <div class="job-card-quick-actions">
                <button class="btn btn-danger btn-sm dismiss-btn" title="Dismiss">Dismiss</button>
            </div>
        </div>
    `;

    card.addEventListener('click', (e) => {
        if (e.target.closest('.dismiss-btn')) return;
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
        const job = await api.getJob(jobId);
        renderJobDetailContent(container, job);
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

function renderJobDetailContent(container, job) {
    const score = job.score;
    const matchScore = score?.match_score;
    const scoreClass = getScoreClass(matchScore);
    const salary = formatSalary(job.salary_min, job.salary_max);
    const sources = job.sources || [];
    const application = job.application;

    const reasonsHtml = (score?.match_reasons || []).map(r => `<li>${escapeHtml(r)}</li>`).join('');
    const concernsHtml = (score?.concerns || []).map(c => `<li>${escapeHtml(c)}</li>`).join('');

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
                ${salary ? `<span>${salary}</span>` : ''}
                <span>${formatDate(job.posted_date || job.created_at)}</span>
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
                    </div>
                    ${reasonsHtml ? `<ul class="score-reasons">${reasonsHtml}</ul>` : ''}
                    ${concernsHtml ? `<div class="concerns-label">Concerns</div><ul class="score-concerns">${concernsHtml}</ul>` : ''}
                </div>
                ` : ''}
                <div class="card sidebar-section">
                    <h3>Actions</h3>
                    <div class="action-buttons">
                        <button class="btn btn-primary" id="prepare-btn">
                            Prepare Application
                        </button>
                        <a href="${escapeHtml(job.url)}" target="_blank" class="btn btn-secondary">
                            Open Job Listing
                        </a>
                        ${job.contact_email ? `<button class="btn btn-secondary" id="email-btn">Draft Email</button>` : ''}
                    </div>
                    <div class="mt-16">
                        <label class="mb-8" style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary)">Status</label>
                        <select class="status-select" id="status-select">
                            ${['interested', 'prepared', 'applied', 'interviewing', 'rejected'].map(s =>
                                `<option value="${s}" ${s === appStatus ? 'selected' : ''}>${s}</option>`
                            ).join('')}
                        </select>
                    </div>
                    <div class="mt-16">
                        <label class="mb-8" style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary)">Notes</label>
                        <textarea class="textarea-styled textarea-notes" id="notes-textarea" placeholder="Add notes...">${escapeHtml(application?.notes || '')}</textarea>
                    </div>
                    <div class="mt-16">
                        <button class="btn btn-secondary btn-sm" id="save-status-btn">Save Status & Notes</button>
                    </div>
                </div>
                <div id="prepared-container">
                    ${application?.tailored_resume ? renderPreparedSection(application, job.id) : ''}
                </div>
                <div id="email-container">
                    ${application?.email_draft ? renderEmailPreview(JSON.parse(application.email_draft)) : ''}
                </div>
            </div>
        </div>
    `;

    // Wire up events
    document.getElementById('back-btn').addEventListener('click', (e) => {
        e.preventDefault();
        navigate('#/');
    });

    document.getElementById('prepare-btn').addEventListener('click', async () => {
        const btn = document.getElementById('prepare-btn');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Preparing...';
        try {
            const result = await api.prepareApplication(job.id);
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

    document.getElementById('save-status-btn').addEventListener('click', async () => {
        const status = document.getElementById('status-select').value;
        const notes = document.getElementById('notes-textarea').value;
        try {
            await api.updateApplication(job.id, status, notes);
            showToast('Status updated', 'success');
        } catch (err) {
            showToast(err.message, 'error');
        }
    });

    const emailBtn = document.getElementById('email-btn');
    if (emailBtn) {
        emailBtn.addEventListener('click', async () => {
            emailBtn.disabled = true;
            emailBtn.innerHTML = '<span class="spinner"></span> Drafting...';
            try {
                const result = await api.draftEmail(job.id);
                document.getElementById('email-container').innerHTML = renderEmailPreview(result.email);
                showToast('Email drafted', 'success');
            } catch (err) {
                showToast(err.message, 'error');
            } finally {
                emailBtn.disabled = false;
                emailBtn.textContent = 'Draft Email';
            }
        });
    }

    attachPreparedListeners();
}

function renderPreparedSection(data, jobId) {
    return `
        <div class="card sidebar-section">
            <h3>Tailored Resume</h3>
            <div class="pdf-download-card">
                <a href="/api/jobs/${jobId}/resume.pdf" download class="pdf-file-link" draggable="true">
                    <span class="pdf-icon">PDF</span>
                    <span class="pdf-label">Resume</span>
                </a>
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
            <div class="pdf-download-card">
                <a href="/api/jobs/${jobId}/cover-letter.pdf" download class="pdf-file-link" draggable="true">
                    <span class="pdf-icon">PDF</span>
                    <span class="pdf-label">Cover Letter</span>
                </a>
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
                <button class="btn btn-secondary btn-sm" onclick="copyToClipboard(document.querySelector('.email-body')?.textContent || '')">Copy Email</button>
            </div>
        </div>
    `;
}

// === Stats Dashboard View ===
async function renderStats(container) {
    container.innerHTML = `<div class="loading-container"><div class="spinner spinner-lg"></div><span>Loading stats...</span></div>`;

    try {
        const stats = await api.getStats();
        container.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
                <h1 style="font-size:1.5rem;font-weight:700;letter-spacing:-0.02em">Dashboard</h1>
                <button class="btn btn-primary" id="stats-scrape-btn">Scrape Now</button>
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
                        <div class="stage-count">${(stats.total_scored || 0) - (stats.total_applied || 0) - (stats.total_interviewing || 0)}</div>
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
        `;

        document.getElementById('stats-scrape-btn').addEventListener('click', handleScrape);
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
async function handleScrape() {
    const btn = document.getElementById('scrape-btn') || document.getElementById('stats-scrape-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Scraping...';
    }
    try {
        await api.triggerScrape();
        showToast('Scrape started! New jobs will appear shortly.', 'info');
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Scrape Now';
        }
    }
}

// === Settings View ===
async function renderSettings(container) {
    container.innerHTML = `<div class="loading-container"><div class="spinner spinner-lg"></div><span>Loading settings...</span></div>`;

    try {
        const [config, aiSettings] = await Promise.all([
            api.getSearchConfig(),
            api.getAISettings(),
        ]);
        renderSettingsContent(container, config, aiSettings);
    } catch (err) {
        showToast(err.message, 'error');
        container.innerHTML = `<div class="empty-state"><div class="empty-state-title">Could not load settings</div></div>`;
    }
}

function renderSettingsContent(container, config, aiSettings = {}) {
    const termsValue = (config.search_terms || []).join('\n');
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

    const aiProvider = aiSettings.provider || '';
    const aiKey = aiSettings.api_key || '';
    const aiModel = aiSettings.model || '';
    const aiBaseUrl = aiSettings.base_url || '';
    const hasKey = aiSettings.has_key || false;

    container.innerHTML = `
        <h1 style="font-size:1.5rem;font-weight:700;letter-spacing:-0.02em;margin-bottom:24px">Settings</h1>

        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:16px">AI Provider</h2>
            <p style="color:var(--text-secondary);margin-bottom:16px;font-size:0.875rem">
                Configure which AI backend to use for job scoring, resume analysis, and application tailoring.
            </p>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
                <div>
                    <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Provider</label>
                    <select class="filter-select" id="ai-provider" style="width:100%">
                        <option value="anthropic" ${aiProvider === 'anthropic' ? 'selected' : ''}>Anthropic (Claude)</option>
                        <option value="ollama" ${aiProvider === 'ollama' ? 'selected' : ''}>Ollama (Local)</option>
                    </select>
                </div>
                <div>
                    <label style="display:block;font-size:0.8125rem;font-weight:600;color:var(--text-tertiary);margin-bottom:4px">Model</label>
                    <div id="ai-model-container">
                        <input type="text" class="search-input" id="ai-model" placeholder="e.g. claude-sonnet-4-20250514" value="${escapeHtml(aiModel)}" style="width:100%;${aiProvider === 'ollama' ? 'display:none' : ''}">
                        <div id="ai-model-ollama" style="${aiProvider === 'ollama' ? '' : 'display:none'}">
                            <div style="display:flex;gap:8px;align-items:center">
                                <select class="filter-select" id="ai-model-select" style="flex:1">
                                    ${aiModel ? `<option value="${escapeHtml(aiModel)}" selected>${escapeHtml(aiModel)}</option>` : '<option value="">Select a model...</option>'}
                                </select>
                                <button class="btn btn-secondary btn-sm" id="refresh-models-btn" title="Refresh models" style="white-space:nowrap">Refresh</button>
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
            ${atsScore < 60 ? `<div style="background:var(--danger-bg, rgba(239,68,68,0.1));color:var(--danger, #ef4444);padding:12px 16px;border-radius:8px;margin-bottom:16px;font-weight:600;font-size:0.875rem">Your resume has significant ATS compatibility issues. Many applicant tracking systems may not parse it correctly.</div>` : ''}
            ${atsScore >= 60 && atsScore < 80 ? `<div style="background:rgba(245,158,11,0.1);color:#d97706;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-weight:600;font-size:0.875rem">Your resume is moderately ATS-friendly but has room for improvement.</div>` : ''}
            ${atsIssues.length ? `
            <div style="margin-bottom:12px">
                <span style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-tertiary)">Issues Found</span>
                <ul style="margin-top:8px;padding-left:20px;display:flex;flex-direction:column;gap:4px">
                    ${atsIssues.map(i => `<li style="font-size:0.875rem;color:var(--text-secondary)">${escapeHtml(i)}</li>`).join('')}
                </ul>
            </div>
            ` : ''}
            ${atsTips.length ? `
            <div>
                <span style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-tertiary)">Suggestions</span>
                <ul style="margin-top:8px;padding-left:20px;display:flex;flex-direction:column;gap:4px">
                    ${atsTips.map(t => `<li style="font-size:0.875rem;color:var(--text-secondary)">${escapeHtml(t)}</li>`).join('')}
                </ul>
            </div>
            ` : ''}
        </div>
        ` : ''}

        ${hasAnalysis ? `
        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:16px">Resume Analysis</h2>
            ${summary ? `<p style="color:var(--text-secondary);margin-bottom:16px;font-size:0.9375rem;line-height:1.6">${escapeHtml(summary)}</p>` : ''}
            ${seniority ? `<div style="margin-bottom:16px"><span style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-tertiary)">Seniority Level</span><div style="margin-top:4px;font-weight:600">${escapeHtml(seniority)}</div></div>` : ''}
            ${keySkills.length ? `
            <div style="margin-bottom:16px">
                <span style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-tertiary)">Key Skills</span>
                <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">
                    ${keySkills.map(s => `<span style="background:var(--bg-tertiary);color:var(--text-primary);padding:4px 10px;border-radius:6px;font-size:0.8125rem">${escapeHtml(s)}</span>`).join('')}
                </div>
            </div>
            ` : ''}
            ${jobTitles.length ? `
            <div>
                <span style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-tertiary)">Best-Fit Job Titles</span>
                <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px">
                    ${jobTitles.map(jt => {
                        const title = typeof jt === 'string' ? jt : jt.title;
                        const why = typeof jt === 'object' && jt.why ? jt.why : '';
                        return `<div style="padding:10px 14px;border-radius:8px;background:var(--bg-tertiary)">
                            <div style="font-weight:600;font-size:0.9375rem">${escapeHtml(title)}</div>
                            ${why ? `<div style="color:var(--text-secondary);font-size:0.8125rem;margin-top:2px">${escapeHtml(why)}</div>` : ''}
                        </div>`;
                    }).join('')}
                </div>
            </div>
            ` : ''}
        </div>
        ` : ''}

        <div class="card" style="padding:24px;margin-bottom:24px">
            <h2 style="font-size:1.125rem;font-weight:600;margin-bottom:16px">Search Terms</h2>
            <p style="color:var(--text-secondary);margin-bottom:16px;font-size:0.875rem">
                These terms are used by scrapers to find relevant jobs. One per line. Edit freely — they are saved independently of the resume.
            </p>
            <textarea class="textarea-styled" id="search-terms-textarea" rows="12" placeholder="e.g. senior devops engineer remote&#10;SRE remote&#10;platform engineer remote">${escapeHtml(termsValue)}</textarea>
            <div style="display:flex;gap:12px;margin-top:12px">
                <button class="btn btn-primary" id="save-terms-btn">Save Search Terms</button>
            </div>
        </div>

        ${config.updated_at ? `<p style="color:var(--text-tertiary);font-size:0.8125rem;margin-bottom:24px">Last updated: ${formatDate(config.updated_at)}</p>` : ''}

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

    document.getElementById('upload-resume-btn').addEventListener('click', async () => {
        const fileInput = document.getElementById('resume-file');
        if (!fileInput.files.length) {
            showToast('Select a resume file first', 'error');
            return;
        }
        const btn = document.getElementById('upload-resume-btn');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Analyzing...';
        try {
            const result = await api.uploadResume(fileInput.files[0]);
            showToast(`Resume analyzed! ${result.search_terms.length} search terms extracted.`, 'success');
            const [updatedConfig, updatedAI] = await Promise.all([
                api.getSearchConfig(),
                api.getAISettings(),
            ]);
            renderSettingsContent(container, updatedConfig, updatedAI);
        } catch (err) {
            showToast(err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Upload & Analyze';
        }
    });

    document.getElementById('save-terms-btn').addEventListener('click', async () => {
        const text = document.getElementById('search-terms-textarea').value;
        const terms = text.split('\n').map(t => t.trim()).filter(t => t.length > 0);
        try {
            await api.updateSearchTerms(terms);
            showToast(`Saved ${terms.length} search terms`, 'success');
        } catch (err) {
            showToast(err.message, 'error');
        }
    });

    // AI provider toggle
    document.getElementById('ai-provider').addEventListener('change', (e) => {
        const isOllama = e.target.value === 'ollama';
        document.getElementById('ai-key-row').style.display = isOllama ? 'none' : '';
        document.getElementById('ai-url-row').style.display = isOllama ? '' : 'none';
        document.getElementById('ai-model').style.display = isOllama ? 'none' : '';
        document.getElementById('ai-model-ollama').style.display = isOllama ? '' : 'none';
        if (isOllama) fetchOllamaModels();
    });

    // Fetch and populate Ollama models dropdown
    async function fetchOllamaModels() {
        const select = document.getElementById('ai-model-select');
        const currentVal = select.value;
        const btn = document.getElementById('refresh-models-btn');
        btn.disabled = true;
        btn.textContent = '...';
        try {
            const baseUrl = document.getElementById('ai-base-url').value || 'http://localhost:11434';
            const result = await api.getOllamaModels(baseUrl);
            if (result.ok && result.models.length > 0) {
                select.innerHTML = result.models.map(m =>
                    `<option value="${escapeHtml(m)}" ${m === currentVal ? 'selected' : ''}>${escapeHtml(m)}</option>`
                ).join('');
                if (!currentVal && result.models.length > 0) {
                    select.value = result.models[0];
                }
            } else if (!result.ok) {
                select.innerHTML = `<option value="">Failed to connect</option>`;
                showToast(`Could not reach Ollama: ${result.error}`, 'error');
            } else {
                select.innerHTML = `<option value="">No models found</option>`;
            }
        } catch (err) {
            select.innerHTML = `<option value="">Error loading models</option>`;
        } finally {
            btn.disabled = false;
            btn.textContent = 'Refresh';
        }
    }

    document.getElementById('refresh-models-btn').addEventListener('click', fetchOllamaModels);

    // Auto-fetch models if Ollama is already selected
    if (document.getElementById('ai-provider').value === 'ollama') {
        fetchOllamaModels();
    }

    function getAIFormValues() {
        const provider = document.getElementById('ai-provider').value;
        const model = provider === 'ollama'
            ? document.getElementById('ai-model-select').value
            : document.getElementById('ai-model').value;
        return {
            provider,
            api_key: document.getElementById('ai-api-key').value,
            model,
            base_url: document.getElementById('ai-base-url').value,
        };
    }

    // Save AI settings
    document.getElementById('save-ai-btn').addEventListener('click', async () => {
        const btn = document.getElementById('save-ai-btn');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Saving...';
        try {
            await api.updateAISettings(getAIFormValues());
            showToast('AI settings saved', 'success');
        } catch (err) {
            showToast(err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Save AI Settings';
        }
    });

    // Test AI connection
    document.getElementById('test-ai-btn').addEventListener('click', async () => {
        const btn = document.getElementById('test-ai-btn');
        const resultDiv = document.getElementById('ai-test-result');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Testing...';
        resultDiv.innerHTML = '';
        try {
            const result = await api.testAIConnection(getAIFormValues());
            if (result.ok) {
                resultDiv.innerHTML = `<div style="color:var(--success, #22c55e);font-size:0.875rem;font-weight:600">Connection successful! Response: "${escapeHtml(result.response)}"</div>`;
            } else {
                resultDiv.innerHTML = `<div style="color:var(--danger, #ef4444);font-size:0.875rem;font-weight:600">Connection failed: ${escapeHtml(result.error)}</div>`;
            }
        } catch (err) {
            resultDiv.innerHTML = `<div style="color:var(--danger, #ef4444);font-size:0.875rem">${escapeHtml(err.message)}</div>`;
        } finally {
            btn.disabled = false;
            btn.textContent = 'Test Connection';
        }
    });

    // Clear jobs
    document.getElementById('clear-jobs-btn').addEventListener('click', async () => {
        if (!confirm('This will permanently delete all jobs, scores, and applications. Continue?')) return;
        try {
            await api.request('POST', '/api/clear-jobs');
            showToast('All jobs cleared', 'info');
            const [updatedConfig, updatedAI] = await Promise.all([api.getSearchConfig(), api.getAISettings()]);
            renderSettingsContent(container, updatedConfig, updatedAI);
        } catch (err) {
            showToast(err.message, 'error');
        }
    });

    // Reset everything
    document.getElementById('clear-all-btn').addEventListener('click', async () => {
        if (!confirm('This will permanently delete ALL data including your resume, search terms, and AI settings. Continue?')) return;
        if (!confirm('Are you sure? This cannot be undone.')) return;
        try {
            await api.request('POST', '/api/clear-all');
            showToast('All data reset', 'info');
            const [updatedConfig, updatedAI] = await Promise.all([api.getSearchConfig(), api.getAISettings()]);
            renderSettingsContent(container, updatedConfig, updatedAI);
        } catch (err) {
            showToast(err.message, 'error');
        }
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

// === Init ===
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    handleRoute();

    window.addEventListener('hashchange', handleRoute);
    document.getElementById('scrape-btn').addEventListener('click', handleScrape);
    document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
});
