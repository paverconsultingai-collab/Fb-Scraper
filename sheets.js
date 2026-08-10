// sheets.js
// Writes scraped leads to your Google Sheet via an Apps Script Web App
// webhook — deployed directly from the Sheet itself (Extensions > Apps
// Script). No Google Cloud Console, no service account, no billing setup.

const HEADER_ORDER = [
    'pageUrl', 'name', 'category', 'phone', 'email', 'website', 'address', 'about'
];

function leadToRow(lead) {
    return [
        ...HEADER_ORDER.map(key => lead[key] || ''),
        new Date().toISOString()
    ];
}

export async function ensureHeaderRow() {
    // No-op: the Apps Script webhook creates the header row itself the
    // first time it receives data for a tab. Kept as a function so
    // scraper.js doesn't need to change its call site.
}

export async function appendLeads(webhookUrl, tabName, leads) {
    if (!leads.length) return;

    const rows = leads.map(leadToRow);

    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tab: tabName, rows }),
        redirect: 'follow'
    });

    // Read as text first — if Apps Script ever returns something that
    // isn't JSON (an auth interstitial page, a redirect target we didn't
    // expect, an HTML error page), we want to see exactly what it was
    // instead of silently treating it as a null/failed parse.
    const rawText = await response.text();

    let result;
    try {
        result = JSON.parse(rawText);
    } catch (parseError) {
        throw new Error(
            `Sheet webhook returned a non-JSON response (HTTP ${response.status} ${response.statusText}). ` +
            `First 300 chars of what it actually sent back:\n${rawText.slice(0, 300)}`
        );
    }

    if (!result || !result.ok) {
        throw new Error(
            `Sheet webhook reported failure: ${result?.error || 'no error message given'} ` +
            `(HTTP ${response.status} ${response.statusText})`
        );
    }
}
