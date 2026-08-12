// scraper.js  v3 — Hybrid: anonymous-first, cookie fallback for blocked pages
// Why: anonymous mode gets Facebook's static preview (has contact info).
// Authenticated mode triggers the React SPA (dynamic, harder to extract).
// Strategy: scrape anonymously first. If redirected to login, retry with cookies.

import { chromium } from 'playwright';
import { ensureHeaderRow, appendLeads } from './sheets.js';

const SHEET_WEBHOOK_URL     = process.env.SHEET_WEBHOOK_URL;
const SHEET_TAB             = process.env.SHEET_TAB || 'FB Leads';
const BETWEEN_PAGE_DELAY_MS = [4000, 9000];
const ANON_WAIT_MS          = [2500, 4500];   // anon: static HTML, renders fast
const AUTH_WAIT_MS          = [7000, 11000];  // auth: React SPA, needs longer
const DEBUG = (process.env.DEBUG || '').toLowerCase() === 'true';

// Load Facebook session cookies (used as fallback for blocked pages only)
let FB_COOKIES = [];
try {
  const raw = (process.env.FACEBOOK_COOKIES || '').trim();
  if (!raw || raw === '[]') {
    console.log('[auth] No FACEBOOK_COOKIES — blocked pages will be skipped.');
  } else if (raw.startsWith('[')) {
    const parsed = JSON.parse(raw);
    FB_COOKIES = parsed.map(c => ({
      name:     c.name,
      value:    c.value,
      domain:   c.domain ? (c.domain.startsWith('.') ? c.domain : '.' + c.domain) : '.facebook.com',
      path:     c.path || '/',
      httpOnly: !!c.httpOnly,
      secure:   !!c.secure,
      sameSite: c.sameSite || 'None',
      expires:  c.expires ?? c.expirationDate ?? -1
    }));
    console.log(`[auth] Loaded ${FB_COOKIES.length} cookies (JSON) — cookie fallback ready.`);
  } else {
    FB_COOKIES = raw.split(';').map(pair => {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) return null;
      const name  = pair.slice(0, eqIdx).trim();
      const value = pair.slice(eqIdx + 1).trim();
      if (!name) return null;
      return { name, value, domain: '.facebook.com', path: '/', secure: true, sameSite: 'None' };
    }).filter(Boolean);
    console.log(`[auth] Loaded ${FB_COOKIES.length} cookies (raw) — cookie fallback ready.`);
  }
} catch (e) {
  console.warn('[auth] Could not parse FACEBOOK_COOKIES:', e.message);
}

function randomDelay([min, max]) { return min + Math.floor(Math.random() * (max - min)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function normalizePageUrl(rawUrl) {
  let url = rawUrl.trim();
  if (!url.startsWith('http')) url = `https://${url}`;
  if (!url.includes('profile.php')) url = url.split('?')[0].replace(/\/+$/, '');
  return url;
}
function decodeFacebookRedirect(href) {
  try {
    const parsed = new URL(href);
    if (parsed.hostname.includes('l.facebook.com') && parsed.searchParams.has('u'))
      return decodeURIComponent(parsed.searchParams.get('u'));
    return href;
  } catch (_) { return href; }
}
function isBlocked(url) {
  return url.includes('meta.com') || url.includes('/login') ||
         url.includes('checkpoint') || url.includes('two_step_verification');
}

async function dismissOverlays(page) {
  for (const sel of [
    'button:has-text("Decline optional cookies")',
    'button:has-text("Allow all cookies")',
    '[aria-label="Close"]',
    'button:has-text("Not Now")'
  ]) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 })) { await btn.click(); await sleep(600); }
    } catch (_) {}
  }
}

// Core scrape: one attempt with a given context (anon or authenticated)
async function scrapeWithContext(browser, pageUrl, useCookies) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport:  { width: 1440, height: 900 },
    locale:    'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
  });

  if (useCookies && FB_COOKIES.length > 0) {
    await context.addCookies(FB_COOKIES);
  }

  const page = await context.newPage();
  const result = { blocked: false, name: '', phone: '', email: '', website: '', address: '', about: '', category: '' };

  try {
    const aboutUrl = pageUrl.includes('profile.php') ? pageUrl : `${pageUrl}/about`;
    await page.goto(aboutUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await dismissOverlays(page);

    // Anon: static HTML ready fast. Auth: React SPA needs more time.
    await sleep(randomDelay(useCookies ? AUTH_WAIT_MS : ANON_WAIT_MS));

    const currentUrl = page.url();
    if (isBlocked(currentUrl)) {
      result.blocked = true;
      await context.close();
      return result;
    }

    const data = await page.evaluate(() => ({
      title:    document.title.replace(/\s*\|\s*Facebook\s*$/i, '').trim(),
      ogDesc:   document.querySelector('meta[property="og:description"]')?.content || '',
      bodyText: document.body?.innerText || '',
      bodyLen:  (document.body?.innerText || '').length,
      links:    [...document.querySelectorAll('a[href]')].map(a => ({ href: a.href, text: (a.innerText||'').trim() }))
    }));

    console.log(`  [body] ${data.bodyLen} chars` + (useCookies ? ' (auth)' : ' (anon)'));

    result.name  = data.title  || '';
    result.about = data.ogDesc || '';

    const emailRegex = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
    result.email = (data.bodyText.match(emailRegex) || [])
      .find(e => !e.toLowerCase().endsWith('.png') && !e.includes('sentry') && !e.includes('facebook')) || '';

    const phoneSectionMatch = data.bodyText.match(/Phone number\s*\n?\s*([+()\d][\d\s().-]{6,}\d)/i);
    if (phoneSectionMatch) {
      result.phone = phoneSectionMatch[1].trim();
    } else {
      result.phone = (data.bodyText.match(/(\+?\d[\d ()\-.\u00A0]{7,}\d)/g) || [])[0] || '';
    }

    const addrMatch = data.bodyText.match(/Address\s*\n?\s*([^\n]{5,120})/i);
    if (addrMatch) result.address = addrMatch[1].trim();

    const catMatch = data.bodyText.match(/\n(Restaurant|Local Business|Shopping & Retail|Product\/Service|Professional Service|Health\/Beauty|Home Improvement|Real Estate|Automotive|Medical & Health|Education|Contractor|Plumbing Service|Roofing Contractor)\n/i);
    if (catMatch) result.category = catMatch[1];

    const excluded = ['facebook.com','fb.com','fb.me','instagram.com','messenger.com'];
    for (const link of data.links) {
      const resolved = decodeFacebookRedirect(link.href);
      try {
        const host = new URL(resolved).hostname.replace('www.','');
        if (!excluded.some(h => host.includes(h))) { result.website = resolved; break; }
      } catch (_) {}
    }

  } catch (err) {
    console.log(`  Error: ${err.message.slice(0,120)}`);
  }

  await context.close();
  return result;
}

async function scrapePage(browser, rawUrl) {
  const pageUrl = normalizePageUrl(rawUrl);
  console.log(`\n--- Scraping: ${pageUrl} ---`);

  // Pass 1: anonymous — gets static HTML with contact info
  let result = await scrapeWithContext(browser, pageUrl, false);

  // Pass 2: if blocked AND we have cookies, retry authenticated
  if (result.blocked) {
    if (FB_COOKIES.length > 0) {
      console.log('  [blocked anon] Retrying with session cookies...');
      result = await scrapeWithContext(browser, pageUrl, true);
      if (result.blocked) {
        console.log('  [blocked auth] Still blocked — skipping.');
      }
    } else {
      console.log('  [blocked] No cookies available — skipping.');
    }
  }

  const lead = {
    pageUrl,
    name:     result.name,
    category: result.category,
    phone:    result.phone,
    email:    result.email,
    website:  result.website,
    address:  result.address,
    about:    result.about
  };

  console.log(`  Name:    ${lead.name    || '—'}`);
  console.log(`  Phone:   ${lead.phone   || '—'}`);
  console.log(`  Email:   ${lead.email   || '—'}`);
  console.log(`  Website: ${lead.website || '—'}`);
  console.log(`  Address: ${lead.address || '—'}`);
  if (!lead.email && !lead.phone && !lead.website && !lead.address)
    console.log('  No contact fields found.');

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

  const allPageUrls = await fetchPageUrlsFromSheet(SHEET_READ_URL);
  if (!allPageUrls.length) { console.log('No URLs found. Exiting.'); process.exit(0); }
    const BATCH_SIZE = 10;
    const startIndex = parseInt(process.env.START_INDEX || '0', 10);
    const batchUrls = allPageUrls.slice(startIndex, startIndex + BATCH_SIZE);
    const nextIndex = startIndex + BATCH_SIZE;
    const hasMore = nextIndex < allPageUrls.length;

  const hasCookies = FB_COOKIES.length > 0;
  console.log(`Running ${batchUrls.length} page(s). Strategy: anon-first${ hasCookies ? ', cookie fallback for blocked' : ' (no cookie fallback)' }...\n`);
  await ensureHeaderRow();

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox']
  });
  let sent = 0;

  try {
    for (let i = 0; i < batchUrls.length; i++) {
      const lead = await scrapePage(browser, batchUrls[i]);
      try {
        console.log('  Sending to sheet...');
        await appendLeads(SHEET_WEBHOOK_URL, SHEET_TAB, [lead]);
        sent++;
        console.log(`  Sent to sheet OK (${sent}/${batchUrls.length})`);
      } catch (webhookErr) {
        console.warn(`  Webhook error (continuing): ${webhookErr.message.slice(0, 120)}`);
      }
      if (i < batchUrls.length - 1) {
        const delay = randomDelay(BETWEEN_PAGE_DELAY_MS);
        console.log(' Waiting ' + Math.round(delay / 1000) + 's before next page...');
        await sleep(delay);
      }
    }
  } finally {
    await browser.close();
  }

  console.log('\nDone. ' + sent + '/' + batchUrls.length + ' page(s) sent.');
    // Auto-trigger next batch if more pages remain
    if (hasMore) {
          const ghToken = process.env.GITHUB_TOKEN;
          const ghRepo  = process.env.GITHUB_REPOSITORY;
          if (ghToken && ghRepo) {
                  console.log(`Triggering next batch (start_index=${nextIndex})...`);
                  const res = await fetch(
                            `https://api.github.com/repos/${ghRepo}/actions/workflows/scrape.yml/dispatches`,
                            { method: 'POST',
                                       headers: { 'Authorization': `Bearer ${ghToken}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
                                       body: JSON.stringify({ ref: 'main', inputs: { start_index: String(nextIndex), debug: process.env.DEBUG || 'false' } })
                            }
                          );
                  if (res.ok || res.status === 204) {
                            console.log(`Next batch triggered. Status: ${res.status}`);
                          } else { const body = await res.text(); console.warn(`Trigger failed: ${res.status}`); }
                } else { console.warn('GITHUB_TOKEN or GITHUB_REPOSITORY not set.'); }
        } else { console.log('All pages processed — no more batches.'); }
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
