// sheets.js
// Sends each scraped FB lead to the Apps Script webhook as an individual POST.
// The webhook routes payloads with 'Facebook URL' key -> doPostLeadMultiplier,
// which finds the matching row in Lead Multiplier and fills Email + Phone.

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

    const response = await fetch(webhookUrl, {
      method:   'POST',
      headers:  { 'Content-Type': 'application/json' },
      body:     JSON.stringify(payload),
      redirect: 'follow'
    });

    const rawText = await response.text();
    // Truncate log to prevent GitHub Actions log overflow
    console.log(`Webhook [${lead.pageUrl}]: ${rawText.slice(0, 200)}`);

    if (!response.ok) {
      throw new Error(
        `Webhook HTTP error ${response.status} for ${lead.pageUrl}: ${rawText.slice(0, 200)}`
      );
    }
  }
}
