// === Feed View ===
// Map of normalized company name → app_status for companies with active applications
let _companyAppMap = {};

async function renderFeed(container) {
    focusedJobIndex = -1;
    currentOffset = 0;
    container.innerHTML = `
        <div id="smart-views" class="smart-views-bar"></div>
        <div class="filter-bar">
            <input type="text" class="search-input" id="filter-search" placeholder="Search jobs...">
            <input type="text" class="search-input" id="filter-exclude" placeholder="Exclude terms..." style="max-width:160px">
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
            <label style="display:flex;align-items:center;gap:4px;font-size:0.8125rem;color:var(--text-secondary);white-space:nowrap;cursor:pointer"><input type="checkbox" id="filter-show-stale"> Show stale</label>
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
    const excludeInput = document.getElementById('filter-exclude');
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
    registerViewCleanup(() => clearTimeout(debounceTimer));
    const reload = () => {
        currentOffset = 0;
        saveFilterState();
        loadJobs(false);
    };

    searchInput.addEventListener('input', () => {
        filterJobsClientSide();
        saveFilterState();
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(reload, 500);
    });
    excludeInput.addEventListener('input', () => {
        saveFilterState();
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(filterJobsClientSide, 150);
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
    document.getElementById('filter-show-stale').addEventListener('change', () => {
        saveFilterState();
        filterJobsClientSide();
    });

    // Smart views
    await renderSmartViewChips(reload);

    // Save View button
    document.getElementById('save-view-btn').addEventListener('click', async () => {
        const name = await showModal({
            title: 'Save View',
            input: { placeholder: 'View name...' },
            confirmText: 'Save',
        });
        if (!name?.trim()) return;
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
        const name = await showModal({
            title: 'Create Alert',
            input: { placeholder: 'Alert name...' },
            confirmText: 'Create',
        });
        if (!name?.trim()) return;
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

        if (!append) {
            list.innerHTML = '';
            _companyAppMap = {};
        }

        // Build company → status map for cross-referencing
        for (const job of jobs) {
            if (job.app_status && job.company) {
                const key = job.company.trim().toLowerCase();
                if (!_companyAppMap[key]) _companyAppMap[key] = job.app_status;
            }
        }

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
        filterJobsClientSide();
    } catch (err) {
        showToast(err.message, 'error');
        if (!append) list.innerHTML = '';
    }
}

function filterJobsClientSide() {
    const searchVal = (document.getElementById('filter-search')?.value || '').toLowerCase().trim();
    const excludeVal = (document.getElementById('filter-exclude')?.value || '').toLowerCase().trim();
    const showStale = document.getElementById('filter-show-stale')?.checked || false;
    const searchWords = searchVal ? searchVal.split(/\s+/) : [];
    const excludeWords = excludeVal ? excludeVal.split(/\s+/) : [];

    document.querySelectorAll('.job-card').forEach(card => {
        let visible = true;

        if (!showStale && card.dataset.freshness === 'freshness-stale') {
            visible = false;
        }
        if (visible && searchWords.length) {
            const text = card.dataset.searchText || '';
            visible = searchWords.every(w => text.includes(w));
        }
        if (visible && excludeWords.length) {
            const text = card.dataset.searchText || '';
            visible = !excludeWords.some(w => text.includes(w));
        }

        card.style.display = visible ? '' : 'none';
    });
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
    if (!await requireAIAndResume()) return;
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
    const ok = await showModal({
        title: 'Dismiss Jobs',
        message: `Dismiss ${ids.length} jobs?`,
        confirmText: 'Dismiss',
        danger: true,
    });
    if (!ok) return;
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
                    const safeS = s ? s.replace(/[^a-z0-9-]/gi, '') : '';
                    return safeS ? `<span class="status-badge status-${safeS}">${escapeHtml(s)}</span>` : '<span style="color:var(--text-tertiary)">None</span>';
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
                                        <a href="${sanitizeUrl(job.url)}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm">Open Listing</a>
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
    card.dataset.searchText = [job.title, job.company, job.location, job.description || ''].join(' ').toLowerCase();
    const freshness = getFreshness(job);
    card.dataset.freshness = freshness ? freshness.class : '';

    const score = job.match_score;
    const salary = formatSalary(job.salary_min, job.salary_max);
    const scoreClass = getScoreClass(score);
    const newTag = isNew(job.created_at) ? `<span class="new-indicator">New</span>` : '';
    const safeStatus = job.app_status ? job.app_status.replace(/[^a-z0-9-]/gi, '') : '';
    const statusTag = safeStatus ? `<span class="status-badge status-${safeStatus}">${escapeHtml(job.app_status)}</span>` : '';
    const freshnessHtml = freshness ? `<span class="freshness-badge ${freshness.class}">${freshness.label}</span>` : '';

    // Company-level indicator: show if another job at this company has an active application
    let companyIndicator = '';
    if (!job.app_status && job.company) {
        const companyKey = job.company.trim().toLowerCase();
        const companyStatus = _companyAppMap[companyKey];
        if (companyStatus) {
            companyIndicator = `<span class="company-app-indicator" title="You have an active application at ${escapeHtml(job.company)}">Active at company</span>`;
        }
    }

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
            <span class="job-card-company">${escapeHtml(job.company)}${companyIndicator ? ` ${companyIndicator}` : ''}</span>
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
