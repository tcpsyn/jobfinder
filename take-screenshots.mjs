import puppeteer from 'puppeteer';
import { mkdir } from 'fs/promises';

const BASE = 'http://localhost:8085';
const LANDING_OUT = '/Users/lukemacneil/code/careerpulse-landing/screenshots';

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    const browser = await puppeteer.launch({
        headless: true,
        defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
        args: ['--no-sandbox']
    });

    const page = await browser.newPage();

    // Force dark mode
    await page.goto(BASE, { waitUntil: 'networkidle2' });
    await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'dark');
        localStorage.setItem('jf_theme', 'dark');
    });
    await delay(500);

    // --- Calculator screenshots ---

    await page.goto(`${BASE}/#/calculator`, { waitUntil: 'networkidle2' });
    await delay(1000);

    // Type a salary
    const salaryInput = await page.$('#calc-salary');
    await salaryInput.click({ clickCount: 3 });
    await salaryInput.type('150000');
    await delay(300);

    // Set state to California
    await page.select('#calc-state', 'CA');
    await delay(1000);

    // Screenshot: W2 results with charts
    await page.screenshot({ path: `${LANDING_OUT}/calculator.png`, fullPage: true });
    console.log('✓ calculator.png — $150K W2 CA');

    // Screenshot: 1099
    await page.click('.calc-toggle-btn[data-value="1099"]');
    await delay(1000);
    await page.screenshot({ path: `${LANDING_OUT}/calculator-1099.png`, fullPage: true });
    console.log('✓ calculator-1099.png — 1099 view');

    // Screenshot: C2C
    await page.click('.calc-toggle-btn[data-value="c2c"]');
    await delay(1000);
    await page.screenshot({ path: `${LANDING_OUT}/calculator-c2c.png`, fullPage: true });
    console.log('✓ calculator-c2c.png — C2C view');

    // --- Animation frames for GIF ---
    const animDir = `${LANDING_OUT}/calc-animation`;
    await mkdir(animDir, { recursive: true });

    // Reset to clean state
    await page.click('.calc-toggle-btn[data-value="w2"]');
    await delay(300);
    await page.click('.calc-toggle-btn[data-value="salary"]');
    await delay(300);
    await page.select('#calc-state', 'CA');
    await delay(300);

    // Clear salary
    const salary2 = await page.$('#calc-salary');
    await salary2.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await delay(500);

    // Frame 1: Empty state
    await page.screenshot({ path: `${animDir}/frame-01.png` });
    console.log('✓ frame-01 — empty state');

    // Frame 2: After typing salary, charts appear
    await salary2.type('150000');
    await delay(1200);
    await page.screenshot({ path: `${animDir}/frame-02.png` });
    console.log('✓ frame-02 — W2 $150K CA, charts visible');

    // Frame 3: Hold on W2 results
    await delay(500);
    await page.screenshot({ path: `${animDir}/frame-03.png` });
    console.log('✓ frame-03 — W2 results hold');

    // Frame 4: Switch to 1099
    await page.click('.calc-toggle-btn[data-value="1099"]');
    await delay(1200);
    await page.screenshot({ path: `${animDir}/frame-04.png` });
    console.log('✓ frame-04 — 1099 view');

    // Frame 5: Switch to C2C
    await page.click('.calc-toggle-btn[data-value="c2c"]');
    await delay(1200);
    await page.screenshot({ path: `${animDir}/frame-05.png` });
    console.log('✓ frame-05 — C2C view');

    // Frame 6: Change state to Texas (no state tax)
    await page.select('#calc-state', 'TX');
    await delay(1200);
    await page.screenshot({ path: `${animDir}/frame-06.png` });
    console.log('✓ frame-06 — C2C TX (no state tax)');

    // Frame 7: Back to W2 with Texas
    await page.click('.calc-toggle-btn[data-value="w2"]');
    await delay(1200);
    await page.screenshot({ path: `${animDir}/frame-07.png` });
    console.log('✓ frame-07 — W2 TX');

    // Frame 8: Hourly mode
    await page.click('.calc-toggle-btn[data-value="hourly"]');
    await delay(300);
    const rateInput = await page.$('#calc-rate');
    if (rateInput) {
        await rateInput.click({ clickCount: 3 });
        await rateInput.type('75');
        await delay(1200);
    }
    await page.screenshot({ path: `${animDir}/frame-08.png` });
    console.log('✓ frame-08 — Hourly $75/hr');

    // Frame 9: Married filing
    await page.click('.calc-toggle-btn[data-value="married"]');
    await delay(1200);
    await page.screenshot({ path: `${animDir}/frame-09.png` });
    console.log('✓ frame-09 — Married filing');

    console.log(`\nScreenshots saved. Creating GIF...`);

    await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
