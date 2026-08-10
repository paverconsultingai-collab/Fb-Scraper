// scraper.js
// Personal, account-free, cloud-hosted Facebook Business Page scraper.
//
// Deliberately logged-out — no cookies, no session, no account risk.
// Business Pages generally expose contact info (phone/email/website/address)
// publicly since that's the point of having a Page, unlike personal profiles.
//
// This is a text/regex-based extraction (same technique your original
// extension's pageScraper() used) rather than structured DOM parsing,
// since Facebook's class names are obfuscated and change often — reading
// the rendered page text is more resilient to that churn.

import { chromium } from 'playwright';
import { ensureHeaderRow, appendLeads } from './sheets.js';

const SHEET_WEBHOOK_URL = process.env.SHEET_WEBHOOK_URL;
const SHEET_TAB = process.env.SHEET_TAB || 'FB Leads';
const BETWEEN_PAGE_DELAY_MS = [4000, 9000]; // randomized, mimics human pacing
const DEBUG = (process.env.DEBUG || '').toLowerCase() === 'true';

function randomDelay([min, max]) {
    return min + Math.floor(Math.random() * (max - min));
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizePageUrl(rawUrl) {
    let url = rawUrl.trim();
    if (!url.startsWith('http')) url = `https://${url}`;
    url = url.split('?')[0].replace(/\/+$/, '');
    return url;
}

function decodeFacebookRedirect(href) {
    // Facebook wraps outbound links as https://l.facebook.com/l.php?u=<encoded>&h=...
    try {
        const parsed = new URL(href);
        if (parsed.hostname.includes('l.facebook.com') && parsed.searchParams.has('u')) {
            return decodeURIComponent(parsed.searchParams.get('u'));
        }
        return href;
    } catch (_) {
        return href;
    }
}

async function dismissOverlaysIfPresent(page) {
    const selectors = [
        'button:has-text("Decline optional cookies")',
        'button:has-text("Allow all cookies")',
        '[aria-label="Close"]',
        'button:has-text("Not Now")'
    ];
    for (const selector of selectors) {
        try {
            const btn = page.locator(selector).first();
            if (await btn.isVisible({ timeout: 2000 })) {
                await btn.click();
                await page.waitForTimeout(800);
            }
        } catch (_) { /* not present, keep trying */ }
    }
}

async function scrapePage(browser, rawUrl) {
    const pageUrl = normalizePageUrl(rawUrl);
    console.log(`\n=== Scraping: ${pageUrl} ===`);

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 900 },
        locale: 'en-US'
    });
    const page = await context.newPage();

    const lead = {
        pageUrl, name: '', category: '', phone: '', email: '',
        website: '', address: '', about: ''
    };

    try {
        // The /about route surfaces contact info + description in one place,
        // which is more consistent than trying to find it on the main timeline.
        await page.goto(`${pageUrl}/about`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await dismissOverlaysIfPresent(page);
        await sleep(randomDelay([2500, 4500])); // let content settle, human-like dwell time

        const data = await page.evaluate(() => {
            const title = document.title.replace(/\s*\|\s*Facebook\s*$/i, '').trim();
            const ogDescription = document.querySelector('meta[property="og:description"]')?.content || '';
            const bodyText = document.body ? document.body.innerText || '' : '';

            const links = [...document.querySelectorAll('a[href]')].map(a => ({
                href: a.href,
                text: (a.innerText || '').trim()
            }));

            return { title, ogDescription, bodyText, links };
        });

        lead.name = data.title || '';
        lead.about = data.ogDescription || '';

        // Email: same regex approach as your original extension's pageScraper.
        const emailRegex = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
        const emailMatch = (data.bodyText.match(emailRegex) || [])
            .find(e => !e.toLowerCase().endsWith('.png') && !e.toLowerCase().includes('sentry'));
        lead.email = emailMatch || '';

        // Phone: look for a labeled "Phone number" section first (more reliable
        // than a bare regex over the whole page, which picks up unrelated numbers).
        const phoneSectionMatch = data.bodyText.match(/Phone number\s*\n?\s*([+()\d][\d\s().-]{6,}\d)/i);
        if (phoneSectionMatch) {
            lead.phone = phoneSectionMatch[1].trim();
        } else {
            const phoneRegex = /(\+?\d[\d ()\-.\u00A0]{7,}\d)/g;
            const phones = data.bodyText.match(phoneRegex) || [];
            lead.phone = phones[0] || '';
        }

        // Address: look for a labeled section similarly.
        const addressMatch = data.bodyText.match(/Address\s*\n?\s*([^\n]{5,120})/i);
        if (addressMatch) lead.address = addressMatch[1].trim();

        // Category: Facebook often puts this right after the page name in the
        // About text, e.g. "Local Business" / "Restaurant" — best-effort only.
        const categoryMatch = data.bodyText.match(/\n(Restaurant|Local Business|Shopping & Retail|Product\/Service|Professional Service|Health\/Beauty|Home Improvement|Real Estate|Automotive|Medical & Health|Education|Contractor|Plumbing Service|Roofing Contractor)\n/i);
        if (categoryMatch) lead.category = categoryMatch[1];

        // Website: first external link that isn't Facebook's own domains.
        const excludedHosts = ['facebook.com', 'fb.com', 'fb.me', 'instagram.com', 'messenger.com'];
        for (const link of data.links) {
            const resolved = decodeFacebookRedirect(link.href);
            try {
                const host = new URL(resolved).hostname.replace('www.', '');
                if (!excludedHosts.some(h => host.includes(h))) {
                    lead.website = resolved;
                    break;
                }
            } catch (_) { /* skip malformed href */ }
        }

        const gotAnything = lead.email || lead.phone || lead.website || lead.address;
        if (!gotAnything) {
            console.log('  No contact fields found — this Page may require login for its About info, or the page structure has changed.');
            if (DEBUG) console.log(`  (debug) title="${lead.name}" bodyText length=${data.bodyText.length}`);
        } else {
            console.log(`  Found: ${[lead.phone && 'phone', lead.email && 'email', lead.website && 'website', lead.address && 'address'].filter(Boolean).join(', ')}`);
        }
    } catch (error) {
        console.log(`  Error scraping this page: ${error.message}`);
    }

    await context.close();
    return lead;
}

async function main() {
    const rawUrls = process.env.PAGE_URLS || '';
    const pageUrls = rawUrls
        .split(/\r?\n|\|/)
        .map(u => u.trim())
        .filter(Boolean);

    if (!pageUrls.length) {
        console.error('No Page URLs provided. Set the PAGE_URLS environment variable (one per line, or "|"-separated).');
        process.exit(1);
    }
    if (!SHEET_WEBHOOK_URL) {
        console.error('SHEET_WEBHOOK_URL environment variable is not set.');
        process.exit(1);
    }

    console.log(`Running ${pageUrls.length} page(s)...`);
    await ensureHeaderRow();

    const browser = await chromium.launch({ headless: true });
    const leads = [];

    try {
        for (let i = 0; i < pageUrls.length; i++) {
            const lead = await scrapePage(browser, pageUrls[i]);
            leads.push(lead);

            if (i < pageUrls.length - 1) {
                const delay = randomDelay(BETWEEN_PAGE_DELAY_MS);
                console.log(`  Waiting ${Math.round(delay / 1000)}s before next page...`);
                await sleep(delay);
            }
        }
    } finally {
        await browser.close();
    }

    await appendLeads(SHEET_WEBHOOK_URL, SHEET_TAB, leads);
    console.log(`\nDone. ${leads.length} page(s) processed and written to the sheet.`);
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
