// === Shared Utilities ===

function formatCurrency(val) {
    if (!val && val !== 0) return '-';
    return '$' + Number(val).toLocaleString();
}

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

function formatSalary(min, max, estMin, estMax) {
    const lo = min || estMin;
    const hi = max || estMax;
    if (!lo && !hi) return null;
    const fmt = (n) => {
        if (n >= 1000) return `$${Math.round(n / 1000)}k`;
        return `$${n}`;
    };
    if (lo && hi) return `${fmt(lo)} - ${fmt(hi)}`;
    if (lo) return `${fmt(lo)}+`;
    return `Up to ${fmt(hi)}`;
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
    return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sanitizeHtml(html) {
    const ALLOWED_TAGS = new Set([
        'p', 'br', 'b', 'i', 'em', 'strong', 'u', 'ul', 'ol', 'li', 'a',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'div', 'table', 'thead',
        'tbody', 'tr', 'th', 'td', 'pre', 'code', 'blockquote', 'hr', 'dl',
        'dt', 'dd', 'sub', 'sup',
    ]);
    const ALLOWED_ATTRS = new Set(['href', 'target', 'rel']);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    function clean(node) {
        for (const child of Array.from(node.childNodes)) {
            if (child.nodeType === Node.ELEMENT_NODE) {
                const tag = child.tagName.toLowerCase();
                if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'object' || tag === 'embed') {
                    node.removeChild(child);
                    continue;
                }
                if (!ALLOWED_TAGS.has(tag)) {
                    while (child.firstChild) node.insertBefore(child.firstChild, child);
                    node.removeChild(child);
                    continue;
                }
                for (const attr of Array.from(child.attributes)) {
                    if (!ALLOWED_ATTRS.has(attr.name)) {
                        child.removeAttribute(attr.name);
                    }
                }
                if (child.hasAttribute('href')) {
                    const href = child.getAttribute('href').trim().toLowerCase();
                    if (href.startsWith('javascript:') || href.startsWith('data:') || href.startsWith('vbscript:')) {
                        child.removeAttribute('href');
                    }
                }
                if (tag === 'a') {
                    child.setAttribute('target', '_blank');
                    child.setAttribute('rel', 'noopener noreferrer');
                }
                clean(child);
            }
        }
    }
    clean(doc.body);
    return doc.body.innerHTML;
}

function sanitizeUrl(url) {
    if (!url) return '';
    const trimmed = url.trim();
    if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('#') || trimmed.startsWith('mailto:')) {
        return trimmed;
    }
    return '';
}

function parseJsonField(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    try { return JSON.parse(val); } catch { return []; }
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

// === In-App Modal (replaces native prompt/confirm) ===
function showModal({ title, message, input, confirmText, cancelText, danger }) {
    return new Promise((resolve) => {
        const existing = document.getElementById('app-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'app-modal';
        modal.innerHTML = `
            <div class="modal-overlay">
                <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="app-modal-title">
                    <h3 id="app-modal-title" class="modal-title">${escapeHtml(title)}</h3>
                    ${message ? `<p class="modal-message">${escapeHtml(message)}</p>` : ''}
                    ${input ? `<input type="text" class="search-input modal-input" id="modal-input" placeholder="${escapeHtml(input.placeholder || '')}" value="${escapeHtml(input.value || '')}">` : ''}
                    <div class="modal-actions">
                        <button class="btn btn-secondary btn-sm" id="modal-cancel">${escapeHtml(cancelText || 'Cancel')}</button>
                        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-sm" id="modal-confirm">${escapeHtml(confirmText || 'OK')}</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const inputEl = modal.querySelector('#modal-input');
        const confirmBtn = modal.querySelector('#modal-confirm');
        const cancelBtn = modal.querySelector('#modal-cancel');

        if (inputEl) { inputEl.focus(); inputEl.select(); }
        else confirmBtn.focus();

        function close(result) {
            modal.remove();
            resolve(result);
        }

        confirmBtn.addEventListener('click', () => close(input ? (inputEl.value || null) : true));
        cancelBtn.addEventListener('click', () => close(input ? null : false));
        modal.querySelector('.modal-overlay').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) close(input ? null : false);
        });
        modal.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); close(input ? null : false); }
            if (e.key === 'Enter' && input && document.activeElement === inputEl) { e.preventDefault(); close(inputEl.value || null); }
            if (e.key === 'Enter' && !input) { e.preventDefault(); close(true); }
            // Focus trap
            if (e.key === 'Tab') {
                const focusable = modal.querySelectorAll('input, button');
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
        });
    });
}
