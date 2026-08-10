/**
 * Apps Script Web App — receives FB Page leads via POST and appends them
 * as rows. Deploy this from INSIDE your Google Sheet: Extensions > Apps
 * Script, paste this in, then Deploy > New deployment > Web app.
 *
 * Runs entirely under your own Google account. No Cloud Console project,
 * no service account, no billing setup required.
 *
 * If you're using the SAME Sheet as your Maps scraper, you can deploy
 * this into the same Apps Script project as that one — Apps Script
 * supports multiple functions/files in one project, and this doPost
 * already branches by "tab" name, so either script works for both as
 * long as the tab names differ (e.g. "Leads" vs "FB Leads").
 */

const HEADER_ROW = [
  'Page URL', 'Name', 'Category', 'Phone', 'Email', 'Website', 'Address', 'About', 'Scraped At'
];

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const tabName = body.tab || 'FB Leads';
    const rows = body.rows || [];

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      sheet = ss.insertSheet(tabName);
    }

    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADER_ROW);
    }

    if (rows.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADER_ROW.length)
        .setValues(rows);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, written: rows.length }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(error) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet() {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, message: 'FB Pages scraper webhook is live.' }))
    .setMimeType(ContentService.MimeType.JSON);
}
