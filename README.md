# FB Business Pages Cloud (Personal Edition)

A stripped-down, account-free, cloud-hosted Facebook Business Page scraper.
No login, no cookies, no session — you give it Page URLs, it scrapes
publicly visible contact info in the cloud on a free GitHub Actions runner,
and writes results straight into a Google Sheet.

**Deliberately logged-out.** This only reads what Facebook shows to a
visitor who isn't logged in. Business Pages generally expose contact info
(phone, email, website, address) publicly since that's the point of having
a Page — unlike personal profiles, which mostly require login to view.
That's what makes this the *safe* version: no account, no cookies, no risk
of an account getting flagged or locked.

## What you get

- `page_urls` in → cloud scrape → rows land directly in your Google Sheet
- Runs on GitHub's free Actions minutes — no server to host or pay for
- No login required, no proxies needed at personal, non-concurrent usage
- Randomized pacing between pages (same idea as your other scrapers)

## What it can't do

- **No personal profiles.** Almost all personal-profile content requires
  login. This won't return useful data for those, by design.
- **No fields that require login to view.** Some Pages hide more behind a
  login wall than others — if a Page returns nothing, that's likely why
  (see the debug tips below).
- **Not identical to your extension's logged-in scraper.** This is the
  safer, lower-data-yield version of that, on purpose.

## One-time setup

### 1. Deploy the Sheet-writing webhook (no Cloud Console)

If you already deployed the webhook for your Maps scraper on the **same**
Sheet, you can reuse that exact deployment — this scraper just writes to a
different tab (`FB Leads` by default) within it, and the Apps Script code
in `AppsScript_Code.gs` here is compatible with the same project. Otherwise:

1. Open (or create) the Google Sheet you want leads to land in.
2. Go to **Extensions → Apps Script**.
3. Paste in the contents of `AppsScript_Code.gs` from this folder.
4. **Deploy → New deployment → Web app.**
5. **Execute as: Me**, **Who has access: Anyone.**
6. **Deploy**, authorize when prompted, then copy the **Web app URL**
   (`https://script.google.com/macros/s/.../exec`) — this is your
   `SHEET_WEBHOOK_URL`.

Sanity-check by opening that URL in a browser — it should return
`{"ok":true,"message":"FB Pages scraper webhook is live."}`.

### 2. Push this folder to a GitHub repo

Same as before — a new private repo, or a new folder in the same repo as
your Maps scraper if you'd rather keep one repo for both (adjust the
workflow file paths if you go that route).

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### 3. Add your secret

**Settings → Secrets and variables → Actions → New repository secret:**

| Name | Value |
|---|---|
| `SHEET_WEBHOOK_URL` | The Web app URL from step 1 (same one as your Maps scraper if reusing) |

Optional variable:

| Name | Value |
|---|---|
| `FB_SHEET_TAB` | Tab name to write to (defaults to `FB Leads`) |

## Running a scrape

1. **Actions** tab → **Scrape FB Business Pages to Sheet** → **Run
   workflow**.
2. Paste your Page URLs, one per line or `|`-separated:
   ```
   https://www.facebook.com/somebusiness
   https://www.facebook.com/anotherbusiness
   ```
3. Turn on `debug` if you want verbose logging for troubleshooting.
4. **Run workflow**. Leads write to the Sheet as each Page finishes.

## If a Page comes back empty

This is expected sometimes — not every Business Page exposes the same
fields when logged out. With `debug` on, the log will tell you when a page
returned no contact fields. A few things that help:

- Double-check the URL is a Page (not a personal profile, group, or a
  redirect link).
- Some Pages genuinely just don't list a phone/email/website publicly —
  nothing to fix there, that's the Page owner's choice.
- If it happens on *every* page, Facebook's About-page layout may have
  changed — the regex patterns in `scraper.js` (look for `Phone number`,
  `Address`, category list) would need updating to match.

## Notes and limits

- **Entirely free**, no Cloud Console, no service account — same as your
  Maps scraper.
- **No proxies, no cookies.** This is intentionally the lower-risk,
  lower-data-yield sibling to your logged-in extension.
- **GitHub Actions free minutes are shared account-wide** across all your
  private repos (2,000+ min/month on the Free plan) — this draws from the
  same pool as your Maps scraper if both are private repos.
- **This is not the full extension's functionality.** It won't match what
  a logged-in browser sees. That trade is deliberate — see the earlier
  conversation about why the logged-in cloud version carries real account
  risk.
