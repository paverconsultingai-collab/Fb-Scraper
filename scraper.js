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
    } catch (_) { /* not present */ }
  }
}

async function scrapePage(browser, rawUrl) {
  const pageUrl = normalizePageUrl(rawUrl);
  console.log(`\n--- Scraping: ${pageUrl} ---`);

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
    locale: 'en-US'
  });
  const page = await context.newPage();

  const lead = { pageUrl, name: '', category: '', phone: '', email: '', website: '', address: '', about: '' };

  try {
    await page.goto(`${pageUrl}/about`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await dismissOverlaysIfPresent(page);
    await sleep(randomDelay([2500, 4500]));

    const data = await page.evaluate(() => {
      const title = document.title.replace(/\s*\|\s*Facebook\s*$/i, '').trim();
      const ogDescription = document.querySelector('meta[property="og:description"]')?.content || '';
      const bodyText = document.body ? document.body.innerText || '' : '';
      const links = [...document.querySelectorAll('a[href]')].map(a => ({ href: a.href, text: (a.innerText || '').trim() }));
      return { title, ogDescription, bodyText, links };
    });

    lead.name  = data.title || '';
    lead.about = data.ogDescription || '';

    const emailRegex = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
    const emailMatch = (data.bodyText.match(emailRegex) || [])
      .find(e => !e.toLowerCase().endsWith('.png') && !e.toLowerCase().includes('sentry'));
    lead.email = emailMatch || '';

    const phoneSectionMatch = data.bodyText.match(/Phone number\s*\n?\s*([+()\d][\d\s().-]{6,}\d)/i);
    if (phoneSectionMatch) {
      lead.phone = phoneSectionMatch[1].trim();
    } else {
      const phoneRegex = /(\+?\d[\d ()\-.\u00A0]{7,}\d)/g;
      const phones = data.bodyText.match(phoneRegex) || [];
      lead.phone = phones[0] || '';
    }

    const addressMatch = data.bodyText.match(/Address\s*\n?\s*([^\n]{5,120})/i);
    if (addressMatch) lead.address = addressMatch[1].trim();

    const categoryMatch = data.bodyText.match(/\n(Restaurant|Local Business|Shopping & Retail|Product\/Service|Professional Service|Health\/Beauty|Home Improvement|Real Estate|Automotive|Medical & Health|Education|Contractor|Plumbing Service|Roofing Contractor)\n/i);
    if (categoryMatch) lead.category = categoryMatch[1];

    const excludedHosts = ['facebook.com', 'fb.com', 'fb.me', 'instagram.com', 'messenger.com'];
    for (const link of data.links) {
      const resolved = decodeFacebookRedirect(link.href);
      try {
        const host = new URL(resolved).hostname.replace('www.', '');
        if (!excludedHosts.some(h => host.includes(h))) { lead.website = resolved; break; }
      } catch (_) { /* skip malformed href */ }
    }

    // --- Log all extracted values ---
    console.log(`  Name:    ${lead.name    || '—'}`);
    console.log(`  Phone:   ${lead.phone   || '—'}`);
    console.log(`  Email:   ${lead.email   || '—'}`);
    console.log(`  Website: ${lead.website || '—'}`);
    console.log(`  Address: ${lead.address || '—'}`);

    const gotAnything = lead.email || lead.phone || lead.website || lead.address;
    if (!gotAnything) {
      console.log('  No contact fields found — Page may require login or structure changed.');
      if (DEBUG) console.log(`  (debug) title="${lead.name}" bodyText length=${data.bodyText.length}`);
    }

  } catch (error) {
    console.log(`  Error scraping this page: ${error.message}`);
  }

  await context.close();
  return lead;
}

async function fetchPageUrlsFromSheet(sheetUrl) {
  let csvUrl = sheetUrl;
  if (sheetUrl.includes('/pubhtml')) {
    csvUrl = sheetUrl.replace('/pubhtml', '/pub');
    if (!csvUrl.includes('output=csv')) csvUrl += '&output=csv';
  } else if (sheetUrl.includes('/edit')) {
    csvUrl = sheetUrl.replace(/\/edit.*$/, '/export?format=csv');
  } else if (!sheetUrl.includes('output=csv') && !sheetUrl.includes('format=csv')) {
    csvUrl = sheetUrl + (sheetUrl.includes('?') ? '&' : '?') + 'output=csv';
  }
  console.log('Fetching Facebook URLs from sheet...');
  const response = await fetch(csvUrl);
  if (!response.ok) throw new Error('Sheet fetch failed: ' + response.status);
  const csvText = await response.text();
  const rows = csvText.split('\n').map(r => r.split(','));
  const urls = rows.slice(1)
    .map(r => (r[0] || '').trim().replace(/^"|"$/g, ''))
    .filter(u => u && u.startsWith('http'));
  console.log('Found ' + urls.length + ' Facebook URLs in sheet.');
  return urls;
}

async function main() {
  const SHEET_READ_URL = process.env.SHEET_READ_URL;
  if (!SHEET_READ_URL)    { console.error('SHEET_READ_URL not set.');    process.exit(1); }
  if (!SHEET_WEBHOOK_URL) { console.error('SHEET_WEBHOOK_URL not set.'); process.exit(1); }

  const pageUrls = await fetchPageUrlsFromSheet(SHEET_READ_URL);
  if (!pageUrls.length) {
    console.log('No Facebook URLs found in sheet. Exiting.');
    process.exit(0);
  }

  console.log('Running ' + pageUrls.length + ' page(s)...\n');
  await ensureHeaderRow();

  const browser = await chromium.launch({ headless: true });
  let sent = 0;

  try {
    for (let i = 0; i < pageUrls.length; i++) {
      // 1. Scrape the page
      const lead = await scrapePage(browser, pageUrls[i]);

      // 2. Send immediately — don't wait for all pages
      console.log('  Sending to sheet...');
      await appendLeads(SHEET_WEBHOOK_URL, SHEET_TAB, [lead]);
      sent++;
      console.log(`  Sent to sheet OK (${sent}/${pageUrls.length})`);

      // 3. Next URL
      if (i < pageUrls.length - 1) {
        const delay = randomDelay(BETWEEN_PAGE_DELAY_MS);
        console.log(' Waiting ' + Math.round(delay / 1000) + 's before next page...');
        await sleep(delay);
      }
    }
  } finally {
    await browser.close();
  }

  console.log('\nDone. ' + sent + '/' + pageUrls.length + ' page(s) sent to the sheet.');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
