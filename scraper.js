// scraper.js  v7 — website-first + DDG search fallback (no Playwright, no long waits)
// STRATEGY:  1) Fast FB fetch  2) Scrape business website  3) DuckDuckGo search
// SPEED WIN: No Playwright install (saves 4min), no 30s timeouts, inter-batch sleep 45s→5s
// UNCHANGED: webhook, monitor logs, cleanup, Master Lead Cleaner subsystems

import { ensureHeaderRow, appendLeads } from './sheets.js';

const SHEET_WEBHOOK_URL = process.env.SHEET_WEBHOOK_URL;
const SHEET_TAB         = process.env.SHEET_TAB || 'FB Leads';
const FETCH_TIMEOUT_MS  = 6000;
const SITE_TIMEOUT_MS   = 8000;
const DDG_TIMEOUT_MS    = 8000;
const PARALLEL          = 10;
const INTER_BATCH_SLEEP = 5000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function normalizePageUrl(rawUrl) {
  let url = rawUrl.trim();
  if (!url.startsWith('http')) url = `https://${url}`;
  if (!url.includes('profile.php')) url = url.split('?')[0].replace(/\/+$/, '');
  return url;
}
function extractSlug(pageUrl) {
  try { const parts = new URL(pageUrl).pathname.split('/').filter(Boolean); return parts[0] || ''; }
  catch { return ''; }
}
function slugToName(slug) {
  return slug.replace(/[._-]+/g,' ').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/\s+/g,' ').trim();
}
function decodeFbRedirect(href) {
  try {
    const p = new URL(href);
    if (p.hostname.includes('l.facebook.com') && p.searchParams.has('u'))
      return decodeURIComponent(p.searchParams.get('u'));
    return href;
  } catch { return href; }
}
function isBlocked(url) {
  return url.includes('/login') || url.includes('checkpoint') || url.includes('meta.com/login');
}
async function pmap(items, fn, concurrency) {
  const results = new Array(items.length); let idx = 0;
  async function worker() { while (idx < items.length) { const i = idx++; results[i] = await fn(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ── HTML extraction (shared by all phases) ──────────────────────────────────
const EXCL_HOSTS = ['facebook.com','fb.com','fb.me','instagram.com','messenger.com','twitter.com','linkedin.com','youtube.com','duckduckgo.com','google.com','bing.com','apple.com','microsoft.com'];
function extractFromHtml(html) {
  const titleM = html.match(/<title>([^<]+)<\/title>/i);
  const name   = titleM ? titleM[1].replace(/\s*\|.*$/,'').replace(/\s*-.*Facebook.*/i,'').trim() : '';
  const ogM    = html.match(/<meta\s[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i)
              || html.match(/<meta\s[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["']/i);
  const about  = ogM ? ogM[1].replace(/&#039;/g,"'").replace(/&amp;/g,'&') : '';

  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi,' ')
    .replace(/<style[\s\S]*?<\/style>/gi,' ')
    .replace(/<[^>]+>/g,' ')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/\u00A0/g,' ')
    .replace(/\s+/g,' ').trim();

  // Email
  const eRe = /([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})/g;
  let email = (body.match(eRe)||[]).find(e =>
    !e.endsWith('.png') && !e.includes('sentry') && !e.includes('facebook') &&
    !e.includes('@example') && !e.includes('wordpress') && !e.includes('wix') && !e.includes('schema')) || '';
  if (!email) {
    const m = html.match(/"email"\s*:\s*"([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})"/i);
    if (m && !m[1].includes('facebook') && !m[1].includes('sentry')) email = m[1];
  }

  // Phone
  let phone = '';
  const phLabel = body.match(/[Pp]hone(?:\s*[Nn]umber)?\s*[:\-]?\s*([+\d][\d\s().\-]{6,}\d)/);
  if (phLabel) { phone = phLabel[1].trim(); }
  if (!phone) {
    const candidates = (body.match(/(\+?\(?\d{1,4}\)?[\s.\-]?\(?\d{2,4}\)?[\s.\-]?\d{3,4}[\s.\-]?\d{3,4})/g)||[])
      .filter(p => { const d = p.replace(/\D/g,''); return d.length >= 8 && d.length <= 15; });
    phone = candidates[0] || '';
  }
  if (!phone) {
    const m = html.match(/"phone(?:_number)?":"([^"]{6,20})"/i);
    if (m) phone = m[1];
  }

  // Website
  let website = '';
  const hrefRe = /href=["']([^"']+)["']/gi; let hm;
  while ((hm = hrefRe.exec(html)) !== null) {
    const raw = hm[1]; if (!raw.startsWith('http')) continue;
    const resolved = decodeFbRedirect(raw);
    try {
      const host = new URL(resolved).hostname.replace('www.','');
      if (!EXCL_HOSTS.some(h => host.includes(h))) { website = resolved; break; }
    } catch {}
  }
  if (!website) {
    const wm = html.match(/"website(?:_url)?":"(https?:[^\\"]+)"/i);
    if (wm) website = wm[1].replace(/\\u002F/g,'/').replace(/\\\//g,'/');
  }

  // Address / category
  const addrM = body.match(/[Aa]ddress\s*[:\-]?\s*([^\n]{5,120})/);
  const address = addrM ? addrM[1].trim() : '';
  const catM = body.match(/\n(Restaurant|Local Business|Shopping & Retail|Professional Service|Health\/Beauty|Home Improvement|Real Estate|Contractor|Plumbing|Roofing|Landscaping|Cleaning|Electrical|HVAC|Paving|Asphalt)\n/i);
  const category = catM ? catM[1] : '';

  return { name, about, email, phone, address, category, website };
}

// ── Phase 1: Facebook fetch ─────────────────────────────────────────────────
const FETCH_HEADERS = {
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language':'en-US,en;q=0.9','Cache-Control':'no-cache',
  'Sec-Fetch-Mode':'navigate','Sec-Fetch-Site':'none','Sec-Fetch-User':'?1',
};
async function fetchFacebook(pageUrl) {
  const aboutUrl = pageUrl.includes('profile.php') ? pageUrl : `${pageUrl}/about`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(aboutUrl, { headers: FETCH_HEADERS, redirect: 'follow', signal: ctrl.signal });
    clearTimeout(t);
    if (isBlocked(res.url || aboutUrl) || !res.ok) {
      console.log(`  [fb] HTTP ${res.status} — blocked`);
      return { blocked: true };
    }
    const html = await res.text();
    if (html.length < 5000 || html.includes('login_form')) return { blocked: true };
    console.log(`  [fb] ${html.length} chars`);
    return { blocked: false, ...extractFromHtml(html) };
  } catch (e) {
    console.log(`  [fb] ${e.message.slice(0,60)}`);
    return { blocked: true };
  }
}

// ── Phase 2: Scrape the actual business website ──────────────────────────────
async function scrapeWebsite(url) {
  if (!url) return {};
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), SITE_TIMEOUT_MS);
    const res = await fetch(url, { headers: FETCH_HEADERS, redirect: 'follow', signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return {};
    const html = await res.text();
    console.log(`  [site] ${html.length} chars from ${url.slice(0,60)}`);
    return extractFromHtml(html);
  } catch (e) {
    console.log(`  [site] ${e.message.slice(0,60)}`);
    return {};
  }
}

// ── Phase 3: DuckDuckGo search → scrape first result ────────────────────────
async function searchAndScrape(name, slug) {
  const q = (name && name.length > 2) ? name : slugToName(slug);
  if (!q || q.length < 3) return {};
  try {
    await sleep(1000 + Math.random() * 1000); // gentle rate-limit protection
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), DDG_TIMEOUT_MS);
    const encoded = encodeURIComponent(q + ' phone email contact');
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
      headers: { ...FETCH_HEADERS, Referer: 'https://duckduckgo.com/' },
      redirect: 'follow', signal: ctrl.signal
    });
    clearTimeout(t);
    if (!res.ok) return {};
    const html = await res.text();
    console.log(`  [ddg] ${html.length} chars for "${q}"`);

    // Extract first non-social external URL from DDG results
    const ddgLinkRe = /href="https:\/\/duckduckgo\.com\/l\/\?uddg=([^"&]+)/g;
    let siteUrl = ''; let lm;
    while ((lm = ddgLinkRe.exec(html)) !== null) {
      try {
        const decoded = decodeURIComponent(lm[1]);
        const host = new URL(decoded).hostname.replace('www.','');
        if (!EXCL_HOSTS.some(h => host.includes(h)) && !host.includes('yelp') && !host.includes('yellowpages')) {
          siteUrl = decoded; break;
        }
      } catch {}
    }
    const snippetData = extractFromHtml(html);
    if (siteUrl) {
      console.log(`  [ddg→site] ${siteUrl.slice(0,60)}`);
      const siteData = await scrapeWebsite(siteUrl);
      return {
        name:     snippetData.name     || siteData.name     || '',
        email:    siteData.email       || snippetData.email  || '',
        phone:    siteData.phone       || snippetData.phone  || '',
        website:  siteUrl,
        address:  siteData.address     || snippetData.address|| '',
        category: snippetData.category || siteData.category  || '',
        about:    snippetData.about    || siteData.about     || '',
      };
    }
    return snippetData;
  } catch (e) {
    console.log(`  [ddg] ${e.message.slice(0,60)}`);
    return {};
  }
}

// ── Main scrape: 3-phase ─────────────────────────────────────────────────────
async function scrapePage(rawUrl) {
  const pageUrl = normalizePageUrl(rawUrl);
  const slug    = extractSlug(pageUrl);
  console.log(`\n--- Scraping: ${pageUrl} ---`);

  // Phase 1 — Facebook
  const fbRes = await fetchFacebook(pageUrl);
  let d = fbRes.blocked ? {} : fbRes;

  // Phase 2 — business website (if URL found and still missing contact)
  if (d.website && (!d.email || !d.phone)) {
    const s = await scrapeWebsite(d.website);
    d = { ...d, email: d.email || s.email || '', phone: d.phone || s.phone || '', address: d.address || s.address || '' };
  }

  // Phase 3 — DuckDuckGo + first-result site scrape
  if (!d.phone && !d.email) {
    const s = await searchAndScrape(d.name, slug);
    d = {
      name:     d.name     || s.name     || '',
      about:    d.about    || s.about    || '',
      email:    s.email    || '',
      phone:    s.phone    || '',
      website:  d.website  || s.website  || '',
      address:  d.address  || s.address  || '',
      category: d.category || s.category || '',
    };
  }

  const lead = { pageUrl,
    name:     d.name     || '',
    category: d.category || '',
    phone:    d.phone    || '',
    email:    d.email    || '',
    website:  d.website  || '',
    address:  d.address  || '',
    about:    d.about    || '',
  };
  console.log(`  Name:    ${lead.name    || '—'}`);
  console.log(`  Phone:   ${lead.phone   || '—'}`);
  console.log(`  Email:   ${lead.email   || '—'}`);
  console.log(`  Website: ${lead.website || '—'}`);
  if (!lead.email && !lead.phone && !lead.website) console.log('  No contact fields found.');
  return lead;
}

// ── Sheet URL fetcher ────────────────────────────────────────────────────────
async function fetchPageUrlsFromSheet(sheetUrl) {
  let csvUrl = sheetUrl;
  if (sheetUrl.includes('/pubhtml')) { csvUrl = sheetUrl.replace('/pubhtml','/pub'); if (!csvUrl.includes('output=csv')) csvUrl += '&output=csv'; }
  else if (sheetUrl.includes('/edit')) { csvUrl = sheetUrl.replace(/\/edit.*$/, '/export?format=csv'); }
  else if (!sheetUrl.includes('output=csv') && !sheetUrl.includes('format=csv')) { csvUrl += (sheetUrl.includes('?') ? '&' : '?') + 'output=csv'; }
  console.log('Fetching Facebook URLs from sheet...');
  const res = await fetch(csvUrl);
  if (!res.ok) throw new Error('Sheet fetch failed: ' + res.status);
  const csv  = await res.text();
  const rows = csv.split('\n').map(r => r.split(','));
  const urls = rows.slice(1).map(r => (r[0]||'').trim().replace(/^"|"$/g,'')).filter(u => u && u.startsWith('http'));
  console.log('Found ' + urls.length + ' Facebook URLs in sheet.');
  return urls;
}

// ── Pipeline monitor ─────────────────────────────────────────────────────────
async function logToMonitor(stage, status, detail, count, total, emails) {
  if (!SHEET_WEBHOOK_URL) return;
  try {
    const res = await fetch(SHEET_WEBHOOK_URL, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'log', stage, status, detail,
        count: count!=null?count:'', total: total!=null?total:'',
        emails: emails!=null?emails:'', runId: process.env.GITHUB_RUN_ID||'' }),
      redirect:'follow'
    });
    console.log(`[monitor] ${stage}: HTTP ${res.status}`);
  } catch (e) { console.log('[monitor] Log failed:', e.message); }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const SHEET_READ_URL = process.env.SHEET_READ_URL;
  if (!SHEET_READ_URL)    { console.error('SHEET_READ_URL not set.');    process.exit(1); }
  if (!SHEET_WEBHOOK_URL) { console.error('SHEET_WEBHOOK_URL not set.'); process.exit(1); }

  const allPageUrls = await fetchPageUrlsFromSheet(SHEET_READ_URL);
  if (!allPageUrls.length) {
    await logToMonitor('FB Scraper','Empty Queue','No Facebook URLs found',0,0,0);
    console.log('No URLs. Exiting.'); process.exit(0);
  }

  const BATCH_SIZE  = 10;
  const startIndex  = parseInt(process.env.START_INDEX || '0', 10);
  const totalBatches = Math.ceil((allPageUrls.length - startIndex) / BATCH_SIZE);
  console.log(`Total URLs: ${allPageUrls.length} | Start: ${startIndex} | Batches: ${totalBatches}`);
  await ensureHeaderRow();

  let totalSent = 0, totalEmails = 0;
  let batchIndex = startIndex;
  let batchNum   = Math.floor(startIndex / BATCH_SIZE) + 1;

  while (batchIndex < allPageUrls.length) {
    const batchUrls   = allPageUrls.slice(batchIndex, batchIndex + BATCH_SIZE);
    const isLastBatch = batchIndex + BATCH_SIZE >= allPageUrls.length;
    console.log(`\n===== BATCH ${batchNum} | ${batchUrls.length} pages | last=${isLastBatch} =====`);

    await logToMonitor('FB Scraper Start','Running',
      `Batch ${batchNum}: URLs ${batchIndex+1}–${batchIndex+batchUrls.length} of ${allPageUrls.length}`,
      batchIndex + batchUrls.length, allPageUrls.length, 0);

    let emailsThisBatch = 0, sentThisBatch = 0;

    await pmap(batchUrls, async (url, i) => {
      const lead = await scrapePage(url);
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
      `Batch ${batchNum} complete: ${sentThisBatch} sent, ${emailsThisBatch} with email`,
      batchIndex + batchUrls.length, allPageUrls.length, emailsThisBatch);

    // Cleanup per batch
    try {
      const cr = await fetch(SHEET_WEBHOOK_URL, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ action: 'processLatestMultiplierRow' }), redirect:'follow'
      });
      console.log(`[cleanup] processLatestMultiplierRow: HTTP ${cr.status}`);
    } catch (ce) { console.warn(`[cleanup] ${ce.message}`); }

    batchIndex += BATCH_SIZE;
    batchNum++;
    if (batchIndex < allPageUrls.length) await sleep(INTER_BATCH_SLEEP);
  }

  // Final: Master Lead Cleaner
  console.log('\n[final] Firing runMasterLeadCleaner...');
  try {
    const fr = await fetch(SHEET_WEBHOOK_URL, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action: 'runMasterLeadCleaner' }), redirect:'follow'
    });
    console.log(`[final] runMasterLeadCleaner: HTTP ${fr.status}`);
    await logToMonitor('Master Lead Cleaner','Done','Master Lead Cleaner fired',allPageUrls.length,allPageUrls.length,totalEmails);
  } catch (fe) { console.warn(`[final] ${fe.message}`); }

  await logToMonitor('Pipeline Complete','Done',
    `All ${allPageUrls.length} URLs processed. Emails: ${totalEmails}`,
    allPageUrls.length, allPageUrls.length, totalEmails);

  console.log(`\n✅ Done. Sent: ${totalSent} | Emails found: ${totalEmails}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
