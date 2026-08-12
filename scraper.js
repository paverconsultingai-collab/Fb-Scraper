// scraper.js
// Cloud-hosted Facebook Business Page scraper.
// Uses mbasic.facebook.com as PRIMARY — bypasses desktop bot detection.
// Falls back to desktop if mbasic is also blocked.

import { chromium } from 'playwright';
import { ensureHeaderRow, appendLeads } from './sheets.js';

const SHEET_WEBHOOK_URL  = process.env.SHEET_WEBHOOK_URL;
const SHEET_TAB          = process.env.SHEET_TAB || 'FB Leads';
const FACEBOOK_EMAIL     = process.env.FACEBOOK_EMAIL;
const FACEBOOK_PASSWORD  = process.env.FACEBOOK_PASSWORD;
const BETWEEN_PAGE_DELAY_MS = [4000, 9000];
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
  if (!url.includes('profile.php')) url = url.split('?')[0].replace(/\/+$/, '');
  return url;
}
function toMbasicUrl(pageUrl) {
  return pageUrl
    .replace('www.facebook.com', 'mbasic.facebook.com')
    .replace('m.facebook.com',   'mbasic.facebook.com');
}
function decodeFacebookRedirect(href) {
  try {
    const parsed = new URL(href);
    if (parsed.hostname.includes('l.facebook.com') && parsed.searchParams.has('u')) {
      return decodeURIComponent(parsed.searchParams.get('u'));
    }
    return href;
  } catch (_) { return href; }
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
    } catch (_) {}
  }
}

function isBlocked(url) {
  return url.includes('meta.com') || url.includes('/login') || url.includes('checkpoint');
}

function extractLeadData(bodyText, links, pageUrl) {
  const lead = { pageUrl, name: '', category: '', phone: '', email: '', website: '', address: '', about: '' };

  const emailRegex = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
  lead.email = (bodyText.match(emailRegex) || [])
    .find(e => !e.toLowerCase().endsWith('.png') && !e.includes('sentry') && !e.includes('facebook')) || '';

  const phoneSectionMatch = bodyText.match(/Phone number\s*\n?\s*([+()\d][\d\s().-]{6,}\d)/i);
  if (phoneSectionMatch) {
    lead.phone = phoneSectionMatch[1].trim();
  } else {
    const phoneRegex = /(\+?\d[\d ()\-.\u00A0]{7,}\d)/g;
    lead.phone = (bodyText.match(phoneRegex) || [])[0] || '';
  }

  const addressMatch = bodyText.match(/Address\s*\n?\s*([^\n]{5,120})/i);
  if (addressMatch) lead.address = addressMatch[1].trim();

  const categoryMatch = bodyText.match(/\n(Restaurant|Local Business|Shopping & Retail|Product\/Service|Professional Service|Health\/Beauty|Home Improvement|Real Estate|Automotive|Medical & Health|Education|Contractor|Plumbing Service|Roofing Contractor)\n/i);
  if (categoryMatch) lead.category = categoryMatch[1];

  const excludedHosts = ['facebook.com', 'fb.com', 'fb.me', 'instagram.com', 'messenger.com', 'mbasic.'];
  for (const link of links) {
    const resolved = decodeFacebookRedirect(link.href);
    try {
      const host = new URL(resolved).hostname.replace('www.', '');
      if (!excludedHosts.some(h => host.includes(h))) { lead.website = resolved; break; }
    } catch (_) {}
  }

  return lead;
}

// =============================================
// FACEBOOK LOGIN
// =============================================
async function loginToFacebook(browser) {
  if (!FACEBOOK_EMAIL || !FACEBOOK_PASSWORD) {
    console.log('No Facebook credentials set.');
    return [];
  }
  console.log('\n=== Logging in to Facebook ===');
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 }, locale: 'en-US'
  });
  const page = await context.newPage();
  try {
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissOverlaysIfPresent(page);
    await sleep(2000);
    console.log('  Filling credentials...');
    await page.waitForSelector('input[name="email"]', { timeout: 15000 });
    await page.fill('input[name="email"]', FACEBOOK_EMAIL);
    await sleep(500);
    await page.fill('input[type="password"]', FACEBOOK_PASSWORD);
    await sleep(500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(6000);
    const url = page.url();
    console.log('  Post-login URL: ' + url.split('?')[0]);
    if (isBlocked(url)) {
      console.log('  WARNING: Blocked by Facebook checkpoint (datacenter IP). Scraping continues without login.');
    } else {
      console.log('  Login successful!');
    }
    const cookies = await context.cookies(['https://www.facebook.com', 'https://mbasic.facebook.com']);
    console.log('  Saved ' + cookies.length + ' cookies.');
    await context.close();
    return cookies;
  } catch (err) {
    console.log('  Login error: ' + err.message.slice(0, 100));
    await context.close();
    return [];
  }
}

// =============================================
// SCRAPE ONE PAGE
// mbasic.facebook.com PRIMARY, desktop FALLBACK
// =============================================
async function scrapePage(browser, rawUrl, fbCookies = []) {
  const pageUrl   = normalizePageUrl(rawUrl);
  const mbasicUrl = toMbasicUrl(pageUrl);
  console.log(`\n--- Scraping: ${pageUrl} ---`);

  // Mobile user-agent for mbasic
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    viewport: { width: 390, height: 844 },
    locale: 'en-US'
  });
  if (fbCookies.length > 0) await context.addCookies(fbCookies);

  const page = await context.newPage();
  const lead = { pageUrl, name: '', category: '', phone: '', email: '', website: '', address: '', about: '' };

  try {
    // 1. Try mbasic
    const aboutUrl = mbasicUrl.includes('profile.php') ? mbasicUrl : `${mbasicUrl}/about`;
    console.log('  Trying mbasic: ' + aboutUrl);
    await page.goto(aboutUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await dismissOverlaysIfPresent(page);
    await sleep(randomDelay([1500, 3000]));

    let currentUrl = page.url();

    // 2. If mbasic blocked, try desktop fallback
    if (isBlocked(currentUrl)) {
      console.log('  mbasic blocked — trying desktop fallback...');
      const desktopAbout = pageUrl.includes('profile.php') ? pageUrl : `${pageUrl}/about`;
      await page.goto(desktopAbout, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(randomDelay([2000, 4000]));
      currentUrl = page.url();
    }

    // 3. Both blocked — skip
    if (isBlocked(currentUrl)) {
      console.log('  Both mbasic + desktop blocked — skipping.');
      await context.close();
      return lead;
    }

    const data = await page.evaluate(() => {
      const title = document.title.replace(/\s*\|\s*Facebook\s*$/i, '').trim();
      const ogDesc = document.querySelector('meta[property="og:description"]')?.content || '';
      const bodyText = document.body ? document.body.innerText || '' : '';
      const links = [...document.querySelectorAll('a[href]')].map(a => ({ href: a.href, text: (a.innerText || '').trim() }));
      return { title, ogDesc, bodyText, links };
    });

    lead.name  = data.title || '';
    lead.about = data.ogDesc || '';
    const ex = extractLeadData(data.bodyText, data.links, pageUrl);
    lead.email    = ex.email;
    lead.phone    = ex.phone;
    lead.address  = ex.address;
    lead.website  = ex.website;
    lead.category = ex.category;

    console.log(`  Name:    ${lead.name    || '—'}`);
    console.log(`  Phone:   ${lead.phone   || '—'}`);
    console.log(`  Email:   ${lead.email   || '—'}`);
    console.log(`  Website: ${lead.website || '—'}`);
    console.log(`  Address: ${lead.address || '—'}`);

    const gotAnything = lead.email || lead.phone || lead.website || lead.address;
    if (!gotAnything) {
      console.log('  No contact fields found.');
      if (DEBUG) console.log(`  (debug) URL=${currentUrl} len=${data.bodyText.length}`);
    }

  } catch (err) {
    console.log(`  Error: ${err.message}`);
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
  const res = await fetch(csvUrl);
  if (!res.ok) throw new Error('Sheet fetch failed: ' + res.status);
  const csv = await res.text();
  const rows = csv.split('\n').map(r => r.split(','));
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
  if (!pageUrls.length) { console.log('No URLs found. Exiting.'); process.exit(0); }

  console.log('Running ' + pageUrls.length + ' page(s)...\n');
  await ensureHeaderRow();

  const browser    = await chromium.launch({ headless: true });
  const fbCookies  = await loginToFacebook(browser);
  let sent = 0;

  try {
    for (let i = 0; i < pageUrls.length; i++) {
      const lead = await scrapePage(browser, pageUrls[i], fbCookies);

      console.log('  Sending to sheet...');
      await appendLeads(SHEET_WEBHOOK_URL, SHEET_TAB, [lead]);
      sent++;
      console.log(`  Sent to sheet OK (${sent}/${pageUrls.length})`);

      if (i < pageUrls.length - 1) {
        const delay = randomDelay(BETWEEN_PAGE_DELAY_MS);
        console.log(' Waiting ' + Math.round(delay / 1000) + 's before next page...');
        await sleep(delay);
      }
    }
  } finally {
    await browser.close();
  }

  console.log('\nDone. ' + sent + '/' + pageUrls.length + ' page(s) sent.');
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
