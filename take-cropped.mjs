import puppeteer from 'puppeteer';

const BASE = 'http://localhost:8085';
const OUT = '/Users/lukemacneil/code/careerpulse-landing/screenshots';

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

    // Navigate to network page
    await page.goto(`${BASE}/#/network`, { waitUntil: 'networkidle2' });
    await delay(1500);

    // Inject mock contacts
    await page.evaluate(() => {
        const escapeHtml = s => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

        const contacts = [
            { name: 'Sarah Chen', role: 'Engineering Manager', company: 'Stripe', email: 's.chen@stripe.com', linkedin: true },
            { name: 'Marcus Johnson', role: 'VP of Engineering', company: 'Datadog', email: 'm.johnson@datadog.com', linkedin: true },
            { name: 'Emily Rodriguez', role: 'Senior Recruiter', company: 'Cloudflare', email: 'e.rodriguez@cloudflare.com', linkedin: true },
            { name: 'David Kim', role: 'Staff Engineer', company: 'Figma', email: 'd.kim@figma.com', linkedin: true },
            { name: 'Alex Thompson', role: 'Hiring Manager', company: 'Anthropic', email: 'a.thompson@anthropic.com', linkedin: true },
            { name: 'Rachel Park', role: 'Technical Recruiter', company: 'HashiCorp', email: 'r.park@hashicorp.com', linkedin: true },
            { name: 'James Wilson', role: 'Director of Engineering', company: 'Vercel', email: 'j.wilson@vercel.com', linkedin: true },
            { name: 'Priya Sharma', role: 'Senior SRE', company: 'Grafana Labs', email: 'p.sharma@grafana.com', linkedin: true },
            { name: 'Michael Lee', role: 'Principal Engineer', company: 'Netflix', email: 'm.lee@netflix.com', linkedin: true },
            { name: 'Sofia Martinez', role: 'Recruiter', company: 'Notion', email: 's.martinez@notion.so', linkedin: true },
            { name: 'Ryan O\'Brien', role: 'Engineering Lead', company: 'Linear', email: 'r.obrien@linear.app', linkedin: true },
            { name: 'Nina Patel', role: 'Head of Talent', company: 'Supabase', email: 'n.patel@supabase.com', linkedin: true },
        ];

        const contactsList = document.getElementById('contacts-list');
        if (contactsList) {
            contactsList.innerHTML = `
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px">
                    ${contacts.map(c => `
                        <div class="card card-interactive contact-card" style="padding:16px;cursor:pointer">
                            <div style="font-weight:600;font-size:0.9375rem">${escapeHtml(c.name)}</div>
                            <div style="font-size:0.8125rem;color:var(--text-secondary)">${escapeHtml(c.role)}</div>
                            <div style="font-size:0.8125rem;color:var(--text-tertiary)">${escapeHtml(c.company)}</div>
                            <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
                                <span style="font-size:0.75rem;color:var(--accent)">${escapeHtml(c.email)}</span>
                                ${c.linkedin ? '<a href="#" style="font-size:0.75rem">LinkedIn</a>' : ''}
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        }
    });

    await delay(500);
    await page.screenshot({
        path: `${OUT}/network.png`,
        clip: { x: 0, y: 0, width: 1440, height: 900 }
    });
    console.log('network.png — mock contacts');

    await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
