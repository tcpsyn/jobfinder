import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(__dirname, 'extension');

const context = await chromium.launchPersistentContext('', {
  headless: false,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--start-maximized',
  ],
  viewport: null,
});

const page = context.pages()[0] || await context.newPage();
await page.goto('https://davita.wd1.myworkdayjobs.com/DaVita_Teammate_Openings');

console.log('READY: Browser open with extension loaded. Log in and navigate to a job application form.');
console.log('PID:' + process.pid);

// Keep alive until killed
await new Promise(() => {});
