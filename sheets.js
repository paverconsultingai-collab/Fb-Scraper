// sheets.js
// Sends each scraped FB lead to the Apps Script webhook as an individual POST.
// The webhook routes payloads with 'Facebook URL' key -> doPostLeadMultiplier.
// Resilient: logs warnings on webhook errors but re-throws to caller.

export async function ensureHeaderRow() {
  // No-op: header management is handled by the Apps Script side.
}

export async function appendLeads(webhookUrl, tabName, leads) {
  if (!leads.length) return;

  for (const lead of leads) {
    const payload = {
      'Facebook URL': lead.pageUrl || '',
      'Email':        lead.email   || '',
      'Phone':        lead.phone   || '',
      'Phone 2':      lead.phone2  || ''
    };

    try {
      const response = await fetch(webhookUrl, {
        method:   'POST',
        headers:  { 'Content-Type': 'application/json' },
        body:     JSON.stringify(payload),
        redirect: 'follow'
      });

      const rawText = await response.text();
      // Truncate log to prevent GitHub Actions log overflow
      const preview = rawText.slice(0, 120);
      if (!response.ok) {
        console.warn(`  Webhook HTTP ${response.status} for ${lead.pageUrl}: ${preview}`);
      } else {
        console.log(`  Webhook [${lead.pageUrl}]: ${preview}`);
      }
    } catch (fetchErr) {
      console.warn(`  Webhook fetch error for ${lead.pageUrl}: ${fetchErr.message.slice(0, 120)}`);
            throw fetchErr; // re-throw — caller will not count this lead as sent
    }
  }
}
