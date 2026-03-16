// === Salary Calculator ===
// Calculation engine, UI rendering, Chart.js integration

const CALC_STORAGE_KEY = 'careerpulse_calc_settings';

// --- Calculation Engine ---

function calcFederalTax(taxableIncome, filingStatus) {
    if (taxableIncome <= 0) return { total: 0, breakdown: [] };
    const brackets = TAX_DATA.federal.brackets[filingStatus] || TAX_DATA.federal.brackets.single;
    let remaining = taxableIncome;
    let total = 0;
    const breakdown = [];
    for (const b of brackets) {
        if (remaining <= 0) break;
        const width = b.max === Infinity ? remaining : b.max - b.min;
        const taxable = Math.min(remaining, width);
        const tax = taxable * b.rate;
        total += tax;
        if (tax > 0) breakdown.push({ bracket: `${(b.rate * 100).toFixed(0)}%`, amount: tax, taxable });
        remaining -= taxable;
    }
    return { total, breakdown };
}

function calcStateTax(taxableIncome, stateCode) {
    if (taxableIncome <= 0 || !stateCode) return 0;
    const state = TAX_DATA.states[stateCode];
    if (!state || state.type === 'none') return 0;
    if (state.type === 'flat') return taxableIncome * state.rate;
    let remaining = taxableIncome;
    let total = 0;
    for (const b of state.brackets) {
        if (remaining <= 0) break;
        const width = b.max === Infinity ? remaining : b.max - b.min;
        const taxable = Math.min(remaining, width);
        total += taxable * b.rate;
        remaining -= taxable;
    }
    return total;
}

function calcFICA(grossIncome, employmentType) {
    const fica = TAX_DATA.fica;
    if (employmentType === '1099') {
        const netEarnings = grossIncome * fica.selfEmployment.netEarningsMultiplier;
        const ssTaxable = Math.min(netEarnings, fica.socialSecurity.cap);
        const ss = ssTaxable * fica.socialSecurity.rate * 2;
        const medicare = netEarnings * fica.medicare.rate * 2;
        const additionalMedicare = grossIncome > fica.medicare.additionalThreshold
            ? (grossIncome - fica.medicare.additionalThreshold) * fica.medicare.additionalRate
            : 0;
        const seTax = ss + medicare + additionalMedicare;
        return { ss, medicare: medicare + additionalMedicare, seTax, deductibleHalf: seTax * fica.selfEmployment.deductibleHalf, total: seTax };
    }
    // W2 or C2C (on salary portion)
    const ssTaxable = Math.min(grossIncome, fica.socialSecurity.cap);
    const ss = ssTaxable * fica.socialSecurity.rate;
    const medicare = grossIncome * fica.medicare.rate;
    const additionalMedicare = grossIncome > fica.medicare.additionalThreshold
        ? (grossIncome - fica.medicare.additionalThreshold) * fica.medicare.additionalRate
        : 0;
    return { ss, medicare: medicare + additionalMedicare, seTax: 0, deductibleHalf: 0, total: ss + medicare + additionalMedicare };
}

function calculateSalary(input) {
    const { gross, state, filingStatus, employmentType, deductions = {}, c2cMargin = 0, c2cSalarySplit = 0.6 } = input;
    if (!gross || gross <= 0) return null;

    const stdDeduction = TAX_DATA.federal.standardDeduction[filingStatus] || TAX_DATA.federal.standardDeduction.single;

    if (employmentType === 'w2') {
        const ficaResult = calcFICA(gross, 'w2');
        const taxableIncome = Math.max(0, gross - stdDeduction);
        const federal = calcFederalTax(taxableIncome, filingStatus);
        const stateTax = calcStateTax(taxableIncome, state);
        const totalTax = federal.total + stateTax + ficaResult.total;
        const takeHome = gross - totalTax;
        return {
            type: 'w2', gross, federal: federal.total, federalBreakdown: federal.breakdown,
            state: stateTax, ss: ficaResult.ss, medicare: ficaResult.medicare, seTax: 0,
            totalTax, takeHome, effectiveRate: totalTax / gross,
            hourly: null // filled by caller
        };
    }

    if (employmentType === '1099') {
        const bizDeductions = (deductions.health || 0) + (deductions.retirement || 0) + (deductions.equipment || 0) + (deductions.other || 0);
        const ficaResult = calcFICA(gross, '1099');
        const agi = gross - bizDeductions - ficaResult.deductibleHalf;
        const taxableIncome = Math.max(0, agi - stdDeduction);
        const federal = calcFederalTax(taxableIncome, filingStatus);
        const stateTax = calcStateTax(taxableIncome, state);
        const totalTax = federal.total + stateTax + ficaResult.total;
        const takeHome = gross - totalTax - bizDeductions;
        return {
            type: '1099', gross, federal: federal.total, federalBreakdown: federal.breakdown,
            state: stateTax, ss: 0, medicare: 0, seTax: ficaResult.seTax,
            bizDeductions, deductibleHalf: ficaResult.deductibleHalf,
            totalTax, takeHome, effectiveRate: totalTax / gross,
            hourly: null
        };
    }

    // C2C — S-Corp model
    const netAfterMargin = gross * (1 - (c2cMargin / 100));
    const bizDeductions = (deductions.health || 0) + (deductions.retirement || 0) + (deductions.equipment || 0) + (deductions.other || 0);
    const distributable = netAfterMargin - bizDeductions;
    const salaryPortion = distributable * c2cSalarySplit;
    const distribution = distributable - salaryPortion;
    const ficaResult = calcFICA(salaryPortion, 'w2');
    const totalIncome = salaryPortion + distribution;
    const taxableIncome = Math.max(0, totalIncome - stdDeduction);
    const federal = calcFederalTax(taxableIncome, filingStatus);
    const stateTax = calcStateTax(taxableIncome, state);
    const totalTax = federal.total + stateTax + ficaResult.total;
    const takeHome = distributable - totalTax;
    return {
        type: 'c2c', gross, netAfterMargin, salaryPortion, distribution,
        federal: federal.total, federalBreakdown: federal.breakdown,
        state: stateTax, ss: ficaResult.ss, medicare: ficaResult.medicare, seTax: 0,
        bizDeductions, totalTax, takeHome, effectiveRate: totalTax / gross,
        hourly: null
    };
}

function compareEmploymentTypes(gross, state, filingStatus, deductions, c2cMargin) {
    const base = { gross, state, filingStatus, deductions };
    return {
        w2: calculateSalary({ ...base, employmentType: 'w2' }),
        '1099': calculateSalary({ ...base, employmentType: '1099' }),
        c2c: calculateSalary({ ...base, employmentType: 'c2c', c2cMargin: c2cMargin || 0 })
    };
}

// --- Chart Management ---

let donutChart = null;
let barChart = null;

function getChartColors() {
    const style = getComputedStyle(document.documentElement);
    const isDark = document.documentElement.dataset.theme === 'dark';
    return {
        federal: '#6366f1',
        state: '#f59e0b',
        ss: '#10b981',
        medicare: '#3b82f6',
        seTax: '#ef4444',
        takeHome: isDark ? '#22c55e' : '#16a34a',
        text: style.getPropertyValue('--text-primary').trim() || (isDark ? '#e2e8f0' : '#1e293b'),
        textSecondary: style.getPropertyValue('--text-secondary').trim() || (isDark ? '#94a3b8' : '#64748b'),
        grid: style.getPropertyValue('--border').trim() || (isDark ? '#334155' : '#e2e8f0'),
        surface: style.getPropertyValue('--bg-surface').trim() || (isDark ? '#1e293b' : '#fff')
    };
}

function renderDonutChart(canvas, result) {
    if (donutChart) donutChart.destroy();
    if (!result) return;
    const colors = getChartColors();
    const segments = [
        { label: 'Federal Tax', value: result.federal, color: colors.federal },
        { label: 'State Tax', value: result.state, color: colors.state },
        { label: 'Social Security', value: result.ss, color: colors.ss },
        { label: 'Medicare', value: result.medicare, color: colors.medicare }
    ];
    if (result.seTax > 0) segments.push({ label: 'SE Tax', value: result.seTax, color: colors.seTax });
    segments.push({ label: 'Take-Home', value: Math.max(0, result.takeHome), color: colors.takeHome });
    const filtered = segments.filter(s => s.value > 0);

    donutChart = new Chart(canvas, {
        type: 'doughnut',
        data: {
            labels: filtered.map(s => s.label),
            datasets: [{
                data: filtered.map(s => s.value),
                backgroundColor: filtered.map(s => s.color),
                borderWidth: 2,
                borderColor: colors.surface
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '60%',
            animation: { animateRotate: true, duration: 800, easing: 'easeOutQuart' },
            plugins: {
                legend: { position: 'bottom', labels: { color: colors.text, padding: 12, usePointStyle: true, pointStyleWidth: 10, font: { size: 12 } } },
                tooltip: {
                    callbacks: {
                        label: ctx => `${ctx.label}: ${formatCurrency(ctx.raw)} (${((ctx.raw / result.gross) * 100).toFixed(1)}%)`
                    }
                }
            }
        }
    });
}

function renderBarChart(canvas, comparison) {
    if (barChart) barChart.destroy();
    if (!comparison || !comparison.w2) return;
    const colors = getChartColors();
    const types = ['w2', '1099', 'c2c'];
    const labels = ['W-2', '1099', 'C2C'];

    const datasets = [
        { label: 'Federal Tax', backgroundColor: colors.federal, data: types.map(t => comparison[t]?.federal || 0) },
        { label: 'State Tax', backgroundColor: colors.state, data: types.map(t => comparison[t]?.state || 0) },
        { label: 'SS + Medicare / SE Tax', backgroundColor: colors.ss, data: types.map(t => (comparison[t]?.ss || 0) + (comparison[t]?.medicare || 0) + (comparison[t]?.seTax || 0)) },
        { label: 'Take-Home', backgroundColor: colors.takeHome, data: types.map(t => Math.max(0, comparison[t]?.takeHome || 0)) }
    ];

    barChart = new Chart(canvas, {
        type: 'bar',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 600, easing: 'easeOutQuart' },
            scales: {
                x: { stacked: true, ticks: { color: colors.text }, grid: { display: false } },
                y: {
                    stacked: true,
                    ticks: { color: colors.textSecondary, callback: v => formatCurrency(v) },
                    grid: { color: colors.grid }
                }
            },
            plugins: {
                legend: { position: 'bottom', labels: { color: colors.text, padding: 12, usePointStyle: true, pointStyleWidth: 10, font: { size: 12 } } },
                tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${formatCurrency(ctx.raw)}` } }
            }
        }
    });
}

// --- localStorage ---

function loadCalcSettings() {
    try {
        return JSON.parse(localStorage.getItem(CALC_STORAGE_KEY)) || {};
    } catch { return {}; }
}

function saveCalcSettings(settings) {
    localStorage.setItem(CALC_STORAGE_KEY, JSON.stringify(settings));
}

// --- UI ---

function gatherInputs(container) {
    const val = (id, fallback) => {
        const el = container.querySelector(`#${id}`);
        return el ? (el.value || fallback) : fallback;
    };
    const num = (id) => {
        const el = container.querySelector(`#${id}`);
        return el ? parseFloat(el.value) || 0 : 0;
    };
    const activeToggle = (name) => {
        const btn = container.querySelector(`.calc-toggle-btn[data-group="${name}"].active`);
        return btn ? btn.dataset.value : null;
    };

    const payType = activeToggle('payType') || 'salary';
    const employmentType = activeToggle('empType') || 'w2';
    const filingStatus = activeToggle('filing') || 'single';
    const state = val('calc-state', 'TX');

    const hpw = num('calc-hpw') || 40;
    const wpy = num('calc-wpy') || 52;
    let gross;
    if (payType === 'hourly') {
        const rate = num('calc-rate');
        gross = rate * hpw * wpy;
    } else {
        gross = num('calc-salary');
    }

    const deductions = {
        health: num('calc-ded-health'),
        retirement: num('calc-ded-retirement'),
        equipment: num('calc-ded-equipment'),
        other: num('calc-ded-other')
    };
    const c2cMargin = num('calc-c2c-margin');

    return { payType, employmentType, filingStatus, state, gross, deductions, c2cMargin, hoursPerYear: hpw * wpy };
}

function buildToggleGroup(name, options, defaultValue) {
    return `<div class="calc-toggle-group">${options.map(o =>
        `<button class="calc-toggle-btn${o.value === defaultValue ? ' active' : ''}" data-group="${name}" data-value="${o.value}">${o.label}</button>`
    ).join('')}</div>`;
}

function buildStateDropdown(selected) {
    const states = Object.entries(TAX_DATA.states).sort((a, b) => a[1].name.localeCompare(b[1].name));
    return `<select id="calc-state">${states.map(([code, s]) =>
        `<option value="${code}"${code === selected ? ' selected' : ''}>${s.name}${s.type === 'none' ? ' (no tax)' : ''}</option>`
    ).join('')}</select>`;
}

async function renderSalaryCalculator(container) {
    const saved = loadCalcSettings();
    const defaults = {
        payType: saved.payType || 'salary',
        empType: saved.empType || 'w2',
        filing: saved.filing || 'single',
        state: saved.state || 'TX',
        salary: saved.salary || '',
        rate: saved.rate || '',
        hpw: saved.hpw || 40,
        wpy: saved.wpy || 52,
        dedHealth: saved.dedHealth || '',
        dedRetirement: saved.dedRetirement || '',
        dedEquipment: saved.dedEquipment || '',
        dedOther: saved.dedOther || '',
        c2cMargin: saved.c2cMargin || 10
    };
    const showHourly = defaults.payType === 'hourly';
    const showDeductions = defaults.empType !== 'w2';

    // Load offers for import dropdown
    let offers = [];
    try {
        const res = await api.request('GET', '/api/offers');
        offers = res.offers || [];
    } catch { /* no offers available */ }

    container.innerHTML = `
        <div style="margin-bottom:24px">
            <h2 style="font-size:1.5rem;font-weight:700;margin-bottom:4px">Salary Calculator</h2>
            <p style="color:var(--text-secondary);font-size:0.875rem">Estimate take-home pay across employment types with federal &amp; state taxes.</p>
        </div>

        <div class="calc-chart-card" style="margin-bottom:24px">
            <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:end;margin-bottom:20px">
                <div class="calc-input-group">
                    <label>Pay Type</label>
                    ${buildToggleGroup('payType', [{ label: 'Salary', value: 'salary' }, { label: 'Hourly', value: 'hourly' }], defaults.payType)}
                </div>
                <div class="calc-input-group">
                    <label>Employment</label>
                    ${buildToggleGroup('empType', [{ label: 'W-2', value: 'w2' }, { label: '1099', value: '1099' }, { label: 'C2C', value: 'c2c' }], defaults.empType)}
                </div>
                <div class="calc-input-group">
                    <label>Filing Status</label>
                    ${buildToggleGroup('filing', [{ label: 'Single', value: 'single' }, { label: 'Married', value: 'married' }], defaults.filing)}
                </div>
                <div class="calc-input-group">
                    <label>State</label>
                    ${buildStateDropdown(defaults.state)}
                </div>
            </div>

            <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:end">
                <div class="calc-input-group" id="calc-salary-group" style="${showHourly ? 'display:none' : ''}">
                    <label>Annual Salary ($)</label>
                    <input type="number" id="calc-salary" placeholder="100,000" min="0" step="1000" value="${defaults.salary}">
                </div>
                <div class="calc-input-group" id="calc-hourly-group" style="${showHourly ? '' : 'display:none'}">
                    <label>Hourly Rate ($)</label>
                    <input type="number" id="calc-rate" placeholder="75" min="0" step="1" value="${defaults.rate}">
                </div>
                <div class="calc-input-group" id="calc-hpw-group" style="${showHourly ? '' : 'display:none'}">
                    <label>Hours/Week</label>
                    <input type="number" id="calc-hpw" min="1" max="80" value="${defaults.hpw}">
                </div>
                <div class="calc-input-group" id="calc-wpy-group" style="${showHourly ? '' : 'display:none'}">
                    <label>Weeks/Year</label>
                    <input type="number" id="calc-wpy" min="1" max="52" value="${defaults.wpy}">
                </div>
                ${offers.length > 0 ? `
                <div class="calc-input-group">
                    <label>Import from Offer</label>
                    <select id="calc-import-offer">
                        <option value="">-- select --</option>
                        ${offers.map(o => `<option value="${o.base || 0}" data-title="${(o.title || 'Offer').replace(/"/g, '&quot;')}">${o.title || 'Offer'} — ${formatCurrency(o.base)}</option>`).join('')}
                    </select>
                </div>` : ''}
            </div>
        </div>

        <div class="calc-deductions-panel${showDeductions ? ' open' : ''}" id="calc-deductions-panel">
            <div class="calc-chart-card" style="margin-bottom:24px">
                <h3 style="font-size:0.9375rem;font-weight:600;margin-bottom:16px">Business Deductions (Annual)</h3>
                <div style="display:flex;flex-wrap:wrap;gap:16px">
                    <div class="calc-input-group">
                        <label>Health Insurance ($)</label>
                        <input type="number" id="calc-ded-health" min="0" step="100" placeholder="0" value="${defaults.dedHealth}">
                    </div>
                    <div class="calc-input-group">
                        <label>Retirement ($)</label>
                        <input type="number" id="calc-ded-retirement" min="0" step="100" placeholder="0" value="${defaults.dedRetirement}">
                    </div>
                    <div class="calc-input-group">
                        <label>Equipment ($)</label>
                        <input type="number" id="calc-ded-equipment" min="0" step="100" placeholder="0" value="${defaults.dedEquipment}">
                    </div>
                    <div class="calc-input-group">
                        <label>Other Expenses ($)</label>
                        <input type="number" id="calc-ded-other" min="0" step="100" placeholder="0" value="${defaults.dedOther}">
                    </div>
                    <div class="calc-input-group" id="calc-c2c-margin-group" style="${defaults.empType === 'c2c' ? '' : 'display:none'}">
                        <label>C2C Agency Margin (%)</label>
                        <input type="number" id="calc-c2c-margin" min="0" max="50" step="1" value="${defaults.c2cMargin}">
                    </div>
                </div>
            </div>
        </div>

        <div class="calc-stat-grid" id="calc-stats">
            <div class="calc-stat-card"><div class="stat-number" id="stat-gross">-</div><div class="stat-label">Gross Annual</div></div>
            <div class="calc-stat-card"><div class="stat-number" id="stat-tax">-</div><div class="stat-label">Total Taxes</div></div>
            <div class="calc-stat-card"><div class="stat-number" id="stat-takehome">-</div><div class="stat-label">Take-Home</div></div>
            <div class="calc-stat-card"><div class="stat-number" id="stat-rate">-</div><div class="stat-label">Effective Rate</div></div>
        </div>

        <div class="calc-chart-row" style="margin-bottom:24px">
            <div class="calc-chart-card">
                <h3>Tax Breakdown</h3>
                <div style="height:280px"><canvas id="calc-donut"></canvas></div>
            </div>
            <div class="calc-chart-card">
                <h3>W-2 vs 1099 vs C2C</h3>
                <div style="height:280px"><canvas id="calc-bar"></canvas></div>
            </div>
        </div>

        <div class="calc-chart-card" style="margin-bottom:24px">
            <h3 style="font-size:0.9375rem;font-weight:600;margin-bottom:16px">Detailed Breakdown</h3>
            <div class="calc-breakdown-table-wrap">
                <table class="calc-breakdown-table" id="calc-breakdown-table">
                    <thead><tr><th>Item</th><th style="text-align:right">W-2</th><th style="text-align:right">1099</th><th style="text-align:right">C2C</th></tr></thead>
                    <tbody id="calc-breakdown-body"></tbody>
                </table>
            </div>
        </div>

        <p style="color:var(--text-tertiary);font-size:0.75rem;text-align:center;padding:8px 0">
            Estimates only for ${TAX_DATA.year} tax year. Does not account for local taxes, credits, AMT, or NIIT. Consult a tax professional for personalized advice.
        </p>
    `;

    // Wire events
    const debounceTimer = { id: null };
    const recalc = () => {
        clearTimeout(debounceTimer.id);
        debounceTimer.id = setTimeout(() => updateCalculation(container), 150);
    };

    // Toggle buttons
    container.querySelectorAll('.calc-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const group = btn.dataset.group;
            container.querySelectorAll(`.calc-toggle-btn[data-group="${group}"]`).forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            if (group === 'payType') {
                const hourly = btn.dataset.value === 'hourly';
                container.querySelector('#calc-salary-group').style.display = hourly ? 'none' : '';
                container.querySelector('#calc-hourly-group').style.display = hourly ? '' : 'none';
                container.querySelector('#calc-hpw-group').style.display = hourly ? '' : 'none';
                container.querySelector('#calc-wpy-group').style.display = hourly ? '' : 'none';
            }

            if (group === 'empType') {
                const panel = container.querySelector('#calc-deductions-panel');
                const marginGroup = container.querySelector('#calc-c2c-margin-group');
                if (btn.dataset.value === 'w2') {
                    panel.classList.remove('open');
                } else {
                    panel.classList.add('open');
                }
                if (marginGroup) marginGroup.style.display = btn.dataset.value === 'c2c' ? '' : 'none';
            }

            recalc();
        });
    });

    // All inputs
    container.querySelectorAll('input, select').forEach(el => {
        el.addEventListener('input', recalc);
        el.addEventListener('change', recalc);
    });

    // Import from offer
    const importSelect = container.querySelector('#calc-import-offer');
    if (importSelect) {
        importSelect.addEventListener('change', () => {
            const val = parseFloat(importSelect.value);
            if (val > 0) {
                const salaryInput = container.querySelector('#calc-salary');
                if (salaryInput) {
                    salaryInput.value = val;
                    // Switch to salary mode
                    const salaryBtn = container.querySelector('.calc-toggle-btn[data-group="payType"][data-value="salary"]');
                    if (salaryBtn && !salaryBtn.classList.contains('active')) salaryBtn.click();
                    recalc();
                }
            }
        });
    }

    // Initial calc
    updateCalculation(container);
}

function updateCalculation(container) {
    const inputs = gatherInputs(container);

    // Persist
    saveCalcSettings({
        payType: inputs.payType, empType: inputs.employmentType, filing: inputs.filingStatus,
        state: inputs.state, salary: container.querySelector('#calc-salary')?.value || '',
        rate: container.querySelector('#calc-rate')?.value || '',
        hpw: container.querySelector('#calc-hpw')?.value || 40,
        wpy: container.querySelector('#calc-wpy')?.value || 52,
        dedHealth: container.querySelector('#calc-ded-health')?.value || '',
        dedRetirement: container.querySelector('#calc-ded-retirement')?.value || '',
        dedEquipment: container.querySelector('#calc-ded-equipment')?.value || '',
        dedOther: container.querySelector('#calc-ded-other')?.value || '',
        c2cMargin: container.querySelector('#calc-c2c-margin')?.value || 10
    });

    if (!inputs.gross || inputs.gross <= 0) {
        container.querySelector('#stat-gross').textContent = '-';
        container.querySelector('#stat-tax').textContent = '-';
        container.querySelector('#stat-takehome').textContent = '-';
        container.querySelector('#stat-rate').textContent = '-';
        container.querySelector('#calc-breakdown-body').innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-tertiary);padding:24px">Enter a salary or rate to see results</td></tr>';
        if (donutChart) { donutChart.destroy(); donutChart = null; }
        if (barChart) { barChart.destroy(); barChart = null; }
        return;
    }

    const result = calculateSalary({
        gross: inputs.gross,
        state: inputs.state,
        filingStatus: inputs.filingStatus,
        employmentType: inputs.employmentType,
        deductions: inputs.deductions,
        c2cMargin: inputs.c2cMargin
    });

    if (!result) return;

    // Stat cards
    container.querySelector('#stat-gross').textContent = formatCurrency(result.gross);
    container.querySelector('#stat-tax').textContent = formatCurrency(result.totalTax);
    container.querySelector('#stat-takehome').textContent = formatCurrency(result.takeHome);
    container.querySelector('#stat-rate').textContent = (result.effectiveRate * 100).toFixed(1) + '%';

    // Charts
    const donutCanvas = container.querySelector('#calc-donut');
    const barCanvas = container.querySelector('#calc-bar');
    if (donutCanvas) renderDonutChart(donutCanvas, result);

    const comparison = compareEmploymentTypes(inputs.gross, inputs.state, inputs.filingStatus, inputs.deductions, inputs.c2cMargin);
    if (barCanvas) renderBarChart(barCanvas, comparison);

    // Breakdown table
    renderBreakdownTable(container.querySelector('#calc-breakdown-body'), comparison, inputs.gross, inputs.hoursPerYear);
}

function renderBreakdownTable(tbody, comparison, gross, hoursPerYear = 2080) {
    if (!tbody || !comparison.w2) return;
    const fmt = v => v != null ? formatCurrency(Math.round(v)) : '-';
    const fmtHr = v => v != null ? formatCurrency(Math.round(v / hoursPerYear * 100) / 100) + '/hr' : '';

    const rows = [
        { label: 'Gross Income', key: 'gross' },
        { label: 'Federal Tax', key: 'federal' },
        { label: 'State Tax', key: 'state' },
        { label: 'Social Security', key: 'ss' },
        { label: 'Medicare', key: 'medicare' },
        { label: 'SE Tax', key: 'seTax', show1099: true },
        { label: 'Business Deductions', key: 'bizDeductions', hideW2: true },
        { label: 'Total Taxes', key: 'totalTax', bold: true },
        { label: 'Take-Home Pay', key: 'takeHome', bold: true, highlight: true }
    ];

    const html = rows.map(row => {
        const w2Val = comparison.w2?.[row.key];
        const val1099 = comparison['1099']?.[row.key];
        const c2cVal = comparison.c2c?.[row.key];
        const style = row.bold ? 'font-weight:600;color:var(--text-primary)' : '';
        const highlightStyle = row.highlight ? ';color:var(--score-green)' : '';
        const w2Display = (row.hideW2 && !w2Val) ? '-' : fmt(w2Val);
        const display1099 = fmt(val1099);
        const c2cDisplay = fmt(c2cVal);
        return `<tr>
            <td style="${style}">${row.label}</td>
            <td style="text-align:right;${style}${highlightStyle}">${w2Display}<br><small style="color:var(--text-tertiary)">${w2Val ? fmtHr(w2Val) : ''}</small></td>
            <td style="text-align:right;${style}${highlightStyle}">${display1099}<br><small style="color:var(--text-tertiary)">${val1099 ? fmtHr(val1099) : ''}</small></td>
            <td style="text-align:right;${style}${highlightStyle}">${c2cDisplay}<br><small style="color:var(--text-tertiary)">${c2cVal ? fmtHr(c2cVal) : ''}</small></td>
        </tr>`;
    }).join('');

    tbody.innerHTML = html;
}
