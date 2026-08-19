// scraper.js  v5 â fetch-first + single-run (all batches in one job) + PARALLEL=10
// PRIMARY:  raw HTTP fetch (no browser, no Playwright install needed)
// FALLBACK: Playwright + cookies (only if FACEBOOK_COOKIES secret is set)
// KEY WIN:  all batches loop internally â no GitHub Actions chaining overhead
// UNCHANGED: webhook, monitor logs, cleanup, Master Lead Cleaner subsystems

import { chromium } from 'playwright';
import { ensureHeaderRow, appendLeads } from './sheets.js';

const SHEET_WEBHOOK_URL = process.env.SHEET_WEBHOOK_URL;
const SHEET_TAB         = process.env.SHEET_TAB || 'FB Leads';
const FETCH_TIMEOUT_MS  = 12000;        // per-page HTTP timeout
const AUTH_WAIT_MS      = [3000, 5000]; // Playwright fallback: React SPA wait
const PARALLEL          = 1;            // one page at a time (sequential)
const DEBUG = (process.env.DEBUG || '').toLowerCase() === 'true';

// Load Facebook session cookies (fallback for blocked pages only)
let FB_COOKIES = [];
try {
  const raw = (process.env.FACEBOOK_COOKIES || '').trim();
  if (!raw || raw === '[]') {
    console.log('[auth] No FACEBOOK_COOKIES â blocked pages will be skipped.');
  } else if (raw.startsWith('[')) {
    const parsed = JSON.parse(raw);
    FB_COOKIES = parsed.map(c => ({
      name:     c.name, value: c.value,
      domain:   c.domain ? (c.domain.startsWith('.') ? c.domain : '.' + c.domain) : '.facebook.com',
      path:     c.path || '/', httpOnly: !!c.httpOnly, secure: !!c.secure,
      sameSite: c.sameSite || 'None', expires: c.expires ?? c.expirationDate ?? -1
    }));
    console.log(`[auth] Loaded ${FB_COOKIES.length} cookies (JSON).`);
  } else {
    FB_COOKIES = raw.split(';').map(pair => {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) return null;
      const name = pair.slice(0, eqIdx).trim(), value = pair.slice(eqIdx + 1).trim();
      if (!name) return null;
      return { name, value, domain: '.facebook.com', path: '/', secure: true, sameSite: 'None' };
    }).filter(Boolean);
    console.log(`[auth] Loaded ${FB_COOKIES.length} cookies (raw).`);
  }
} catch (e) { console.warn('[auth] Could not parse FACEBOOK_COOKIES:', e.message); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay([min, max]) { return min + Math.floor(Math.random() * (max - min)); }
function normalizePageUrl(rawUrl) {
  let url = rawUrl.trim();
  if (!url.startsWith('http')) url = `https://${url}`;
  if (!url.includes('profile.php')) url = url.split('?')[0].replace(/\/+$/, '');
  return url;
}
function decodeFacebookRedirect(href) {
  try {
    const p = new URL(href);
    if (p.hostname.includes('l.facebook.com') && p.searchParams.has('u'))
      return decodeURIComponent(p.searchParams.get('u'));
    return href;
  } catch (_) { return href; }
}
function isBlocked(url) {
  return url.includes('meta.com') || url.includes('/login') ||
         url.includes('checkpoint') || url.includes('two_step_verification');
}

// Parallel map with concurrency limit
async function pmap(items, fn, concurrency) {
  const results = new Array(items.length); let index = 0;
  async function worker() { while (index < items.length) { const i = index++; results[i] = await fn(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ââ HTML parsing (replaces page.evaluate â no DOM needed) ââââââââââââââââââââââââââââââââ
function extractFromHtml(html) {
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const name = titleMatch ? titleMatch[1].replace(/\s*\|\s*Facebook\s*$/i, '').trim() : '';
  const ogMatch = html.match(/<meta\s[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i)
               || html.match(/<meta\s[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["']/i);
  const about = ogMatch ? ogMatch[1].replace(/&#039;/g, "'").replace(/&amp;/g, '&') : '';
  const bodyText = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#039;/g, "'")
    .replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
  const emailRegex = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
  const email = (bodyText.match(emailRegex) || [])
    .find(e => !e.toLowerCase().endsWith('.png') && !e.includes('sentry') && !e.includes('facebook')) || '';
  const phoneSectionMatch = bodyText.match(/Phone number\s*\n?\s*([+()\d][\d\s().-]{6,}\d)/i);
  const phone = phoneSectionMatch ? phoneSectionMatch[1].trim()
    : (bodyText.match(/(\+?\d[\d ()\-.\u00A0]{7,}\d)/g) || [])[0] || '';
  const addrMatch = bodyText.match(/Address\s*\n?\s*([^\n]{5,120})/i);
  const address = addrMatch ? addrMatch[1].trim() : '';
  const catMatch = bodyText.match(/\n(Restaurant|Local Business|Shopping & Retail|Product\/Service|Professional Service|Health\/Beauty|Home Improvement|Real Estate|Automotive|Medical & Health|Education|Contractor|Plumbing Service|Roofing Contractor)\n/i);
  const category = catMatch ? catMatch[1] : '';
  const excluded = ['facebook.com','fb.com','fb.me','instagram.com','messenger.com'];
  let website = ''; const hrefRe = /href=["']([^"']+)["']/gi; let m;
  while ((m = hrefRe.exec(html)) !== null) {
    const raw = m[1]; if (!raw.startsWith('http')) continue;
    const resolved = decodeFacebookRedirect(raw);
    try { const host = new URL(resolved).hostname.replace('www.','');
      if (!excluded.some(h => host.includes(h))) { website = resolved; break; }
    } catch (_) {}
  }
  return { name, about, email, phone, address, category, website };
}

// ââ Primary path: raw HTTP fetch (no browser) âââââââââââââââââââââââââââââââââââââââââââââââ
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9', 'Cache-Control': 'no-cache',
  'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1',
};

async function fetchScrape(pageUrl) {
  const aboutUrl = pageUrl.includes('profile.php') ? pageUrl : `${pageUrl}/about`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(aboutUrl, { headers: FETCH_HEADERS, redirect: 'follow', signal: ctrl.signal });
    clearTimeout(t);
    if (isBlocked(res.url || aboutUrl)) return { blocked: true };
    if (!res.ok) { console.log(`  [fetch] HTTP ${res.status}`); return { blocked: true }; }
    const html = await res.text();
    console.log(`  [fetch] ${html.length} chars`);
    if (html.includes('login_form')) return { blocked: true };
    return { blocked: false, ...extractFromHtml(html) };
  } catch (e) {
    console.log(`  [fetch] Error: ${e.message.slice(0,80)}`);
    return { blocked: false, name:'', about:'', email:'', phone:'', website:'', address:'', category:'' };
  }
}

// ââ Fallback path: Playwright + cookies (only if cookies configured) ââââââââââââââââââââââ
async function playwrightScrape(browser, pageUrl) {
  if (!browser || FB_COOKIES.length === 0) return null;
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 }, locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
    Object.defineProperty(navigator, 'plugins',   { get: () => [1,2,3,4,5] });
    window.chrome = { runtime: {} };
  });
  await ctx.addCookies(FB_COOKIES);
  const page = await ctx.newPage();
  try {
    const aboutUrl = pageUrl.includes('profile.php') ? pageUrl : `${pageUrl}/about`;
    await page.goto(aboutUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(randomDelay(AUTH_WAIT_MS));
    if (isBlocked(page.url())) { await ctx.close(); return null; }
    const d = await page.evaluate(() => ({
      title:    document.title.replace(/\s*\|\s*Facebook\s*$/i, '').trim(),
      ogDesc:   document.querySelector('meta[property="og:description"]')?.content || '',
      bodyText: document.body?.innerText || '',
      bodyLen:  (document.body?.innerText || '').length,
      links:    [...document.querySelectorAll('a[href]')].map(a => ({ href: a.href, text: (a.innerText||'').trim() }))
    }));
    console.log(`  [playwright-auth] ${d.bodyLen} chars`);
    const eRe = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
    const email = (d.bodyText.match(eRe) || []).find(e => !e.endsWith('.png') && !e.includes('sentry') && !e.includes('facebook')) || '';
    const phM = d.bodyText.match(/Phone number\s*\n?\s*([+()\d][\d\s().-]{6,}\d)/i);
    const phone = phM ? phM[1].trim() : (d.bodyText.match(/(\+?\d[\d ()\-.\u00A0]{7,}\d)/g) || [])[0] || '';
    const adM = d.bodyText.match(/Address\s*\n?\s*([^\n]{5,120})/i);
    const address = adM ? adM[1].trim() : '';
    const cM = d.bodyText.match(/\n(Restaurant|Local Business|Shopping & Retail|Product\/Service|Professional Service|Health\/Beauty|Home Improvement|Real Estate|Automotive|Medical & Health|Education|Contractor|Plumbing Service|Roofing Contractor)\n/i);
    const category = cM ? cM[1] : '';
    const excl = ['facebook.com','fb.com','fb.me','instagram.com','messenger.com'];
    let website = '';
    for (const lk of d.links) { const r = decodeFacebookRedirect(lk.href);
      try { const h = new URL(r).hostname.replace('www.',''); if (!excl.some(x => h.includes(x))) { website = r; break; } } catch(_){} }
    await ctx.close();
    return { name: d.title, about: d.ogDesc, email, phone, address, category, website };
  } catch (err) { console.log(`  [playwright-auth] Error: ${err.message.slice(0,80)}`); await ctx.close(); return null; }
}

async function scrapePage(browser, rawUrl) {
  const pageUrl = normalizePageUrl(rawUrl);
  console.log(`\n--- Scraping: ${pageUrl} ---`);
  const fr = await fetchScrape(pageUrl);
  let data;
  if (fr.blocked) {
    if (FB_COOKIES.length > 0 && browser) {
      console.log('  [blocked] Retrying with Playwright + cookies...');
      const ar = await playwrightScrape(browser, pageUrl);
      data = ar || { name:'',about:'',email:'',phone:'',website:'',address:'',category:'' };
      if (!ar) console.log('  [playwright] Still blocked â skipping.');
    } else {
      console.log('  [blocked] No cookies â skipping.');
      data = { name:'',about:'',email:'',phone:'',website:'',address:'',category:'' };
    }
  } else { data = fr; }
  const lead = { pageUrl, name: data.name||'', category: data.category||'',
    phone: data.phone||'', email: data.email||'', website: data.website||'',
    address: data.address||'', about: data.about||'' };
  console.log(`  Name:    ${lead.name    || 'â'}`);
  console.log(`  Phone:   ${lead.phone   || 'â'}`);
  console.log(`  Email:   ${lead.email   || 'â'}`);
  console.log(`  Website: ${lead.website || 'â'}`);
  console.log(`  Address: ${lead.address || 'â'}`);
  if (!lead.email && !lead.phone && !lead.website && !lead.address) console.log('  No contact fields found.');
  return lead;
}

async function fetchPageUrlsFromSheet(sheetUrl) {
  let csvUrl = sheetUrl;
  if (sheetUrl.includes('/pubhtml')) { csvUrl = sheetUrl.replace('/pubhtml','/pub'); if (!csvUrl.includes('output=csv')) csvUrl += '&output=csv'; }
  else if (sheetUrl.includes('/edit')) { csvUrl = sheetUrl.replace(/\/edit.*$/, '/export?format=csv'); }
  else if (!sheetUrl.includes('output=csv') && !sheetUrl.includes('format=csv')) { csvUrl = sheetUrl + (sheetUrl.includes('?') ? '&' : '?') + 'output=csv'; }
  console.log('Fetching Facebook URLs from sheet...');
  const res = await fetch(csvUrl);
  if (!res.ok) throw new Error('Sheet fetch failed: ' + res.status);
  const csv = await res.text();
  const rows = csv.split('\n').map(r => r.split(','));
  const urls = rows.slice(1).map(r => (r[0]||'').trim().replace(/^"|"$/g,'')).filter(u => u && u.startsWith('http'));
  console.log('Found ' + urls.length + ' Facebook URLs in sheet.');
  return urls;
}

// ââ Pipeline monitor âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function logToMonitor(stage, status, detail, count, total, emails) {
  if (!SHEET_WEBHOOK_URL) return;
  try {
    const res = await fetch(SHEET_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'log', stage, status, detail,
        count:  count  != null ? count  : '',
        total:  total  != null ? total  : '',
        emails: emails != null ? emails : '',
        runId:  process.env.GITHUB_RUN_ID || '' }),
      redirect: 'follow'
    });
    console.log(`[monitor] ${stage}: HTTP ${res.status}`);
  } catch (e) { console.log('[monitor] Log failed:', e.message); }
}

async function main() {
  const SHEET_READ_URL = process.env.SHEET_READ_URL;
  if (!SHEET_READ_URL)    { console.error('SHEET_READ_URL not set.');    process.exit(1); }
  if (!SHEET_WEBHOOK_URL) { console.error('SHEET_WEBHOOK_URL not set.'); process.exit(1); }

  const allPageUrls = await fetchPageUrlsFromSheet(SHEET_READ_URL);
  if (!allPageUrls.length) {
    await logToMonitor('FB Scraper','Empty Queue','No Facebook URLs in Lead Multiplier â check GScraper output',0,0,0);
    console.log('No URLs found. Exiting.'); process.exit(0);
  }

  const BATCH_SIZE = 10;
  const startIndex = parseInt(process.env.START_INDEX || '0', 10);
  const totalBatches = Math.ceil((allPageUrls.length - startIndex) / BATCH_SIZE);
  console.log(`Total URLs: ${allPageUrls.length} | Start: ${startIndex} | Batches this run: ${totalBatches}`);

  const hasCookies = FB_COOKIES.length > 0;
  await ensureHeaderRow();

  // Only launch Playwright if cookies are set (rare fallback path)
  const browser = hasCookies
    ? await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled','--no-sandbox','--disable-setuid-sandbox'] })
    : null;
  console.log(hasCookies ? '[browser] Playwright ready for blocked-page fallback.' : '[browser] No cookies â fetch-only (no Playwright launched).');

  let totalSent = 0, totalEmails = 0;

  try {
    // â­ SINGLE-RUN LOOP: process ALL batches here, no GitHub Actions chaining
    let batchIndex = startIndex;
    let batchNum   = Math.floor(startIndex / BATCH_SIZE) + 1;

    while (batchIndex < allPageUrls.length) {
      const batchUrls   = allPageUrls.slice(batchIndex, batchIndex + BATCH_SIZE);
      const isLastBatch = batchIndex + BATCH_SIZE >= allPageUrls.length;
      console.log(`\n===== BATCH ${batchNum} | ${batchUrls.length} pages | last=${isLastBatch} =====`);

      await logToMonitor('FB Scraper Start','Running',
        `Batch ${batchNum}: URLs ${batchIndex+1}â${batchIndex+batchUrls.length} of ${allPageUrls.length}`,
        batchIndex + batchUrls.length, allPageUrls.length, 0);

      let emailsThisBatch = 0, sentThisBatch = 0;

      // All pages in batch run simultaneously via fetch
      await pmap(batchUrls, async (url, i) => {
        const lead = await scrapePage(browser, url);
        if (lead.email) emailsThisBatch++;
        try {
          console.log(`  [${batchNum}.${i+1}/${batchUrls.length}] Sending to sheet...`);
          await appendLeads(SHEET_WEBHOOK_URL, SHEET_TAB, [lead]);
          sentThisBatch++;
          console.log(`  [${batchNum}.${i+1}] Sent OK`);
        } catch (we) { console.warn(`  Webhook error: ${we.message.slice(0,100)}`); }
      }, PARALLEL);

      totalSent   += sentThisBatch;
      totalEmails += emailsThisBatch;

      await logToMonitor(`FB Batch ${batchNum}`,'Done',
        `${batchUrls.length} pages scraped, ${emailsThisBatch} emails found`,
        batchIndex + batchUrls.length, allPageUrls.length, emailsThisBatch);

      // Trigger cleanup webhook (marks rows as SCRAPED in Lead Multiplier)
      console.log('\nTriggering processLatestMultiplierRow...');
      try {
        const cr = await fetch(SHEET_WEBHOOK_URL, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ action: 'processLatestMultiplierRow' }), redirect:'follow'
        });
        console.log(`  Cleanup: HTTP ${cr.status} â ${(await cr.text()).slice(0,80)}`);
      } catch (e) { console.warn('  Cleanup failed:', e.message); }

      batchIndex += BATCH_SIZE;
      batchNum++;

      if (!isLastBatch) {
        console.log('Sleeping 45s (Apps Script cleanup + sheet flush)...');
        await sleep(45000);
      }
    }  // end while

    console.log(`\n===== ALL DONE: ${totalSent} sent, ${totalEmails} emails =====`);
    await logToMonitor('Pipeline Complete','Complete',
      `All ${allPageUrls.length} pages processed â triggering Master Lead Cleaner`,
      allPageUrls.length, allPageUrls.length, totalEmails);

    console.log('Waiting 15s before Master Lead Cleaner...');
    await sleep(15000);

    console.log('\nTriggering runMasterLeadCleaner...');
    try {
      const mr = await fetch(SHEET_WEBHOOK_URL, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ action: 'runMasterLeadCleaner' }), redirect:'follow'
      });
      console.log(`  Master Lead Cleaner: HTTP ${mr.status} â ${(await mr.text()).slice(0,80)}`);
    } catch (me) { console.warn('  Master Lead Cleaner failed:', me.message); }

  } finally {
    if (browser) await browser.close();
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });