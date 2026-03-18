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
        ? (job.description.includes('<') && job.description.includes('>') ? sanitizeHtml(job.description) : `<p>${escapeHtml(job.description).replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`)
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
                ${sources.map(s => `<a href="${sanitizeUrl(s.source_url || job.url)}" target="_blank" rel="noopener noreferrer" class="source-tag">${escapeHtml(s.source_name)}</a>`).join('')}
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
                        <a href="${sanitizeUrl(job.url)}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary">
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
                    ${companyInfo.website ? `<a href="${sanitizeUrl(companyInfo.website)}" target="_blank" rel="noopener noreferrer" style="font-size:0.8125rem;color:var(--accent)">Company Website →</a>` : ''}
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
            const ok = await showModal({
                title: 'Dismiss Similar Listings',
                message: 'Dismiss all similar listings? This keeps only the current job.',
                confirmText: 'Dismiss',
                danger: true,
            });
            if (!ok) return;
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
        return '<div class="empty-state empty-state-compact"><div class="empty-state-title">No events yet</div><div class="empty-state-desc">Add a note or take an action to start the timeline.</div></div>';
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
