import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { loadScript } from './setup.js';

beforeAll(() => {
    document.body.innerHTML = '<div id="toast-container"></div>';
    loadScript('utils.js');
});

describe('formatCurrency', () => {
    it('formats whole numbers with commas', () => {
        expect(formatCurrency(120000)).toBe('$120,000');
    });

    it('formats zero', () => {
        expect(formatCurrency(0)).toBe('$0');
    });

    it('returns dash for null/undefined', () => {
        expect(formatCurrency(null)).toBe('-');
        expect(formatCurrency(undefined)).toBe('-');
    });

    it('returns dash for empty string', () => {
        expect(formatCurrency('')).toBe('-');
    });

    it('formats small numbers', () => {
        expect(formatCurrency(50)).toBe('$50');
    });

    it('formats string numbers', () => {
        expect(formatCurrency('75000')).toBe('$75,000');
    });
});

describe('formatSalary', () => {
    it('formats min and max', () => {
        expect(formatSalary(100000, 150000)).toBe('$100k - $150k');
    });

    it('formats min only', () => {
        expect(formatSalary(80000, null)).toBe('$80k+');
    });

    it('formats max only', () => {
        expect(formatSalary(null, 120000)).toBe('Up to $120k');
    });

    it('returns null when both missing', () => {
        expect(formatSalary(null, null)).toBeNull();
    });

    it('returns null when both zero', () => {
        expect(formatSalary(0, 0)).toBeNull();
    });

    it('handles small numbers under 1000', () => {
        expect(formatSalary(50, 100)).toBe('$50 - $100');
    });

    it('falls back to estimates when primary values missing', () => {
        expect(formatSalary(null, null, 90000, 130000)).toBe('$90k - $130k');
    });

    it('prefers primary values over estimates', () => {
        expect(formatSalary(100000, 150000, 80000, 120000)).toBe('$100k - $150k');
    });

    it('mixes primary min with estimate max', () => {
        expect(formatSalary(100000, null, null, 150000)).toBe('$100k - $150k');
    });
});

describe('formatDate', () => {
    it('returns empty string for falsy input', () => {
        expect(formatDate(null)).toBe('');
        expect(formatDate('')).toBe('');
        expect(formatDate(undefined)).toBe('');
    });

    it('returns "Today" for today', () => {
        expect(formatDate(new Date().toISOString())).toBe('Today');
    });

    it('returns "Yesterday" for yesterday', () => {
        const yesterday = new Date(Date.now() - 86400000).toISOString();
        expect(formatDate(yesterday)).toBe('Yesterday');
    });

    it('returns days ago for recent dates', () => {
        const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
        expect(formatDate(threeDaysAgo)).toBe('3d ago');
    });

    it('returns weeks ago for dates within a month', () => {
        const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString();
        expect(formatDate(twoWeeksAgo)).toBe('2w ago');
    });

    it('returns date string for invalid dates', () => {
        expect(formatDate('not-a-date')).toBe('not-a-date');
    });
});

describe('getScoreClass', () => {
    it('returns green for scores >= 80', () => {
        expect(getScoreClass(80)).toBe('score-badge-green');
        expect(getScoreClass(100)).toBe('score-badge-green');
    });

    it('returns amber for scores 60-79', () => {
        expect(getScoreClass(60)).toBe('score-badge-amber');
        expect(getScoreClass(79)).toBe('score-badge-amber');
    });

    it('returns gray for scores < 60', () => {
        expect(getScoreClass(59)).toBe('score-badge-gray');
        expect(getScoreClass(0)).toBe('score-badge-gray');
    });

    it('returns none for null/undefined', () => {
        expect(getScoreClass(null)).toBe('score-badge-none');
        expect(getScoreClass(undefined)).toBe('score-badge-none');
    });
});

describe('escapeHtml', () => {
    it('escapes HTML special characters', () => {
        expect(escapeHtml('<script>alert("xss")</script>')).toBe(
            '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
        );
    });

    it('escapes single quotes', () => {
        expect(escapeHtml("it's")).toBe("it&#39;s");
    });

    it('escapes ampersands', () => {
        expect(escapeHtml('A & B')).toBe('A &amp; B');
    });

    it('returns empty string for falsy input', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml('')).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });

    it('passes through safe strings unchanged', () => {
        expect(escapeHtml('Hello World')).toBe('Hello World');
    });
});

describe('isNew', () => {
    let mockStorage;

    beforeEach(() => {
        mockStorage = {};
        vi.stubGlobal('localStorage', {
            getItem: (key) => mockStorage[key] ?? null,
            setItem: (key, val) => { mockStorage[key] = String(val); },
            removeItem: (key) => { delete mockStorage[key]; },
        });
    });

    it('returns false when no last visit stored', () => {
        expect(isNew(new Date().toISOString())).toBe(false);
    });

    it('returns true when job is newer than last visit', () => {
        mockStorage['jf_last_visit'] = new Date(Date.now() - 3600000).toISOString();
        expect(isNew(new Date().toISOString())).toBe(true);
    });

    it('returns false when job is older than last visit', () => {
        mockStorage['jf_last_visit'] = new Date().toISOString();
        const older = new Date(Date.now() - 3600000).toISOString();
        expect(isNew(older)).toBe(false);
    });
});

describe('getFreshness', () => {
    it('returns Fresh for jobs posted today', () => {
        const job = { posted_date: new Date().toISOString() };
        const result = getFreshness(job);
        expect(result.label).toBe('Fresh');
        expect(result.class).toBe('freshness-hot');
    });

    it('returns New for jobs 2-3 days old', () => {
        const job = { posted_date: new Date(Date.now() - 2 * 86400000).toISOString() };
        const result = getFreshness(job);
        expect(result.label).toBe('New');
        expect(result.class).toBe('freshness-new');
    });

    it('returns Stale for very old jobs', () => {
        const job = { posted_date: new Date(Date.now() - 60 * 86400000).toISOString() };
        const result = getFreshness(job);
        expect(result.label).toBe('Stale');
        expect(result.class).toBe('freshness-stale');
    });

    it('returns null when no date available', () => {
        expect(getFreshness({})).toBeNull();
    });

    it('falls back to created_at when no posted_date', () => {
        const job = { created_at: new Date().toISOString() };
        const result = getFreshness(job);
        expect(result).not.toBeNull();
        expect(result.label).toBe('Fresh');
    });
});

describe('showToast', () => {
    it('adds a toast element to the container', () => {
        const container = document.getElementById('toast-container');
        container.innerHTML = '';
        showToast('Test message', 'success');
        const toasts = container.querySelectorAll('.toast');
        expect(toasts.length).toBe(1);
        expect(toasts[0].textContent).toBe('Test message');
        expect(toasts[0].classList.contains('toast-success')).toBe(true);
    });

    it('creates error toasts', () => {
        const container = document.getElementById('toast-container');
        container.innerHTML = '';
        showToast('Error!', 'error');
        const toast = container.querySelector('.toast');
        expect(toast.classList.contains('toast-error')).toBe(true);
    });
});
