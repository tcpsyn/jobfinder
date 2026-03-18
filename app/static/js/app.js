// === State ===
let currentJobs = [];
let currentOffset = 0;
const PAGE_SIZE = 50;
let selectedJobIds = new Set();
let selectMode = false;

// === View Cleanup Registry ===
const _viewCleanups = [];

function registerViewCleanup(fn) {
    _viewCleanups.push(fn);
}

function cleanupCurrentView() {
    while (_viewCleanups.length) _viewCleanups.pop()();
    stopScrapePoll();
    if (typeof queueEventSource !== 'undefined' && queueEventSource) {
        queueEventSource.close();
        queueEventSource = null;
    }
}

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
    cleanupCurrentView();
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

    app.setAttribute('tabindex', '-1');
    app.focus({ preventScroll: true });
}

// === Filter Persistence & Smart Views ===
const FILTER_IDS = ['filter-search', 'filter-exclude', 'filter-score', 'filter-sort', 'filter-work-type', 'filter-employment', 'filter-location', 'filter-region', 'filter-posted-within', 'filter-clearance'];
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
let _viewsMigrating = false;

async function getSmartViews() {
    if (_cachedViews) return _cachedViews;
    try {
        const data = await api.request('GET', '/api/saved-views');
        _cachedViews = data.views || [];
        if (!_viewsMigrating) {
            try {
                const raw = localStorage.getItem(SMART_VIEWS_KEY);
                if (raw) {
                    _viewsMigrating = true;
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
                        _viewsMigrating = false;
                        return getSmartViews();
                    }
                    _viewsMigrating = false;
                }
            } catch { _viewsMigrating = false; }
        }
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
                    handleRoute();
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

    const appModal = document.getElementById('app-modal');
    if (appModal) { appModal.remove(); return; }

    if (notifDropdownOpen) {
        closeNotifDropdown();
        return;
    }

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
    const btn = document.getElementById('notif-btn');
    if (!dropdown) return;
    notifDropdownOpen = !notifDropdownOpen;
    btn?.setAttribute('aria-expanded', String(notifDropdownOpen));
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

function closeNotifDropdown() {
    if (!notifDropdownOpen) return;
    document.getElementById('notif-dropdown').style.display = 'none';
    notifDropdownOpen = false;
    const btn = document.getElementById('notif-btn');
    btn?.setAttribute('aria-expanded', 'false');
    btn?.focus();
}

let _notifEventSource = null;
let _notifSSERetries = 0;
const _NOTIF_SSE_MAX_RETRIES = 5;

function initNotificationSSE() {
    if (_notifEventSource) { _notifEventSource.close(); _notifEventSource = null; }
    _notifEventSource = new EventSource('/api/notifications/stream');
    _notifEventSource.onmessage = (event) => {
        try {
            _notifSSERetries = 0;
            const notif = JSON.parse(event.data);
            showToast(`${notif.title}: ${notif.message}`, 'info');
            updateNotifBadge();
        } catch {}
    };
    _notifEventSource.onerror = () => {
        _notifEventSource.close();
        _notifEventSource = null;
        _notifSSERetries++;
        if (_notifSSERetries <= _NOTIF_SSE_MAX_RETRIES) {
            const delay = Math.min(30000 * Math.pow(2, _notifSSERetries - 1), 300000);
            setTimeout(initNotificationSSE, delay);
        }
    };
}

document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    if (!isOnboardingDone()) {
        showOnboardingWizard();
    }
    updateSetupIndicator();
    handleRoute();

    window.addEventListener('hashchange', handleRoute);
    document.getElementById('scrape-btn').addEventListener('click', handleScrape);
    document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
    document.getElementById('notif-btn').addEventListener('click', toggleNotifDropdown);

    // === Hamburger Menu ===
    const hamburger = document.getElementById('nav-hamburger');
    const navLinks = document.querySelector('.nav-links');
    const drawerOverlay = document.getElementById('nav-drawer-overlay');

    function openDrawer() {
        navLinks.classList.add('nav-drawer-open');
        drawerOverlay.classList.add('active');
        hamburger.setAttribute('aria-expanded', 'true');
    }

    function closeDrawer() {
        navLinks.classList.remove('nav-drawer-open');
        drawerOverlay.classList.remove('active');
        hamburger.setAttribute('aria-expanded', 'false');
    }

    function toggleDrawer() {
        if (navLinks.classList.contains('nav-drawer-open')) {
            closeDrawer();
        } else {
            openDrawer();
        }
    }

    hamburger.addEventListener('click', toggleDrawer);
    drawerOverlay.addEventListener('click', closeDrawer);

    navLinks.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', closeDrawer);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && navLinks.classList.contains('nav-drawer-open')) {
            closeDrawer();
            hamburger.focus();
        }
    });

    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
        if (notifDropdownOpen && !e.target.closest('.notif-btn') && !e.target.closest('.notif-dropdown')) {
            closeNotifDropdown();
        }
    });

    updateNotifBadge();
    initNotificationSSE();
});
