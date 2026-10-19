# Community Flags — Design

Date: 2026-10-16
Status: Draft, awaiting review

## Intent

Make the FLAG step of identify → verify → flag real. When a user meets a scam, one tap reports it, and **the next person who meets the same link or phone number is warned**: "23 Loop users reported this as a scam." After reporting, the user can also warn their family through the share sheet, which is the original FLAG idea from `docs/pitch/loop-brief.md`, currently a placeholder.

**Users:** low-literacy, non-technical users in Pakistan, mostly using the Android app's WebView. Reporting must be a single tap, with no typing and no account.

**What success looks like:**
- A scam link or number reported by 3 different devices produces a red community warning for everyone who checks it afterwards.
- Known-safe sites can never be community-flagged.
- Checks keep working exactly as today if the database is down.

**Constraints:**
- Render free tier: no persistent disk, and the instance sleeps.
- No paid services.
- The project stays free of npm dependencies.
- **Trust principle from the brief:** Loop never reads SMS or notifications. Users choose what to report. Message text is never stored.

## Decisions

| Question | Decision |
|---|---|
| What a report does | Feeds a shared database that checks consult, plus a one-tap share to family. |
| When reports become a warning | Automatic: **3 distinct devices within 90 days, from at least 2 different networks** → red. 1–2 reports show nothing. No manual moderation. *(Network rule added after the final code review: device IDs are chosen by the client, so without it one person could invent three IDs and flag any site or phone number alone. A network is an IPv4 /24 or IPv6 /64, stored only as a SHA-256 hash.)* |
| Storage | **Turso** (hosted SQLite): free tier never sleeps, 5 GB storage, 10M writes a month, and it's reachable over HTTP with plain `fetch`, so no new dependency. Rejected: Render Postgres (free databases are deleted after 30 days), Supabase (pauses after a week idle), a file on the Render server (lost on every restart). |
| Reporter identity | Anonymous random device ID kept on the phone; only its SHA-256 hash is stored. IP addresses aren't used for counting, because carrier-grade NAT puts many real users behind one IP. |

## What gets reported

The server pulls **items** out of the checked text, up to **3 per report**. The message text itself is never stored.

**Links:**
- **Unwrapped first** with the existing `expandShortener`, so the real destination is what gets reported.
- **Domain item:** `domain:<host>`, with the host lowercased and any leading `www.` removed. Scam campaigns rotate paths but keep the domain, so this is the default.
- **Full-link item** for hosts where anyone can publish: `url:<host><path>`, with no query string and no trailing slash. The hosts are `docs.google.com`, `sites.google.com`, `drive.google.com`, `script.google.com`, `forms.gle`, `storage.googleapis.com`, `firebasestorage.googleapis.com`, `github.com`, `raw.githubusercontent.com`, `dropbox.com`, `onedrive.live.com`, `1drv.ms`, `pastebin.com` and `t.me`.
- **Also reported as full links** (added after the final code review, because honest reports of different scams would otherwise flag the whole host): `chat.whatsapp.com`, `play.google.com` (keeping the `id` app parameter), `apps.apple.com`, `linktr.ee`, `web.facebook.com`, `m.me`, plus the shorteners `t.ly`, `s.id`, `rebrand.ly`, `lnkd.in`, `bit.do`.
- **Redirect wrappers** (`google.com/url?q=`, `youtube.com/redirect?q=`, `l.facebook.com/l.php?u=`, and any link carrying a full URL in its query): the destination inside is extracted and reported. The wrapper itself is not.
- **WhatsApp click-to-chat links** (`wa.me/<number>`, `api.whatsapp.com/send?phone=<number>`) become a **phone item** for that number.

**Phone numbers (Pakistani mobile numbers only in v1):**
- Normalized to E.164 as `phone:+923XXXXXXXXX`.
- Accepted forms: `03XXXXXXXXX`, `3XXXXXXXXX` after `+92`/`92`/`0092`, with spaces, dashes or dots between digits.
  - Examples: `0300-1234567`, `0300 1234567`, `+92 300 1234567`, `923001234567`, `00923001234567`.
- Landlines and UAN numbers (e.g. `111-xxx-xxx`) are out of scope for v1.

**Never flaggable:** a domain item whose host is on the server-side safe-site list (below) is dropped silently, at report time and at check time. The same applies to `*.gov.pk`, `whatsapp.com`, `web.whatsapp.com`, `mail.google.com` and `apple.com` (server-only list).

## Server-side safe-site list

`link-check.js` gets the same two lists as `CheckActivity.kt`:
- **`TRUSTED_HOSTS`:** exact host match only, e.g. `google.com`, `youtube.com`.
- **`TRUSTED_DOMAINS`:** the domain and all its subdomains, e.g. banks, wallets, BISP/NADRA/SBP, Wikipedia.

Matching ignores a leading `www.`. The two copies must be kept in sync by hand; a comment in each file points to the other.

## Data model (Turso)

```sql
CREATE TABLE IF NOT EXISTS reports (
  item        TEXT NOT NULL,
  device_hash TEXT NOT NULL,
  net_hash    TEXT NOT NULL DEFAULT '',  -- SHA-256 of the reporter's IPv4 /24 or IPv6 /64
  created_at  INTEGER NOT NULL,   -- ms since epoch
  PRIMARY KEY (item, device_hash)
);
CREATE INDEX IF NOT EXISTS reports_by_device ON reports (device_hash, created_at);
```

- Created on server start, so no migration step is needed.
- **Report:** `INSERT ... ON CONFLICT (item, device_hash) DO UPDATE SET created_at = excluded.created_at`. The same device reporting again refreshes its row instead of counting twice.
- **Count:** for each item, `COUNT(*)` of its rows with `created_at` in the last 90 days, counting only items whose rows come from at least 2 distinct `net_hash` values, done in one query for all of a check's items. The community count of a check is the highest count among its items.
- **Daily cap:** `COUNT(*)` of the device's rows in the last 24 hours. At **20 or more**, reports from that device are refused.

## Components

| File | Change |
|---|---|
| `db.js` (new) | `query(sql, args)` sends SQL to Turso's HTTP pipeline endpoint (`POST {TURSO_DATABASE_URL}/v2/pipeline`, bearer `TURSO_AUTH_TOKEN`) using `fetch`, with a 3s timeout. `enabled()` is false when either env var is missing. Exposes `ensureSchema()`. |
| `community.js` (new) | `extractItems(text)` (async, because of shortener expansion), `report(text, deviceId)`, `communityCount(items)`, `defang(item)` for share text (`hbl-secure-verify[.]com`, `0300-1234567`). Uses `db.js` and `link-check.js`. |
| `link-check.js` | Adds the safe-site lists and exports `isTrusted(host)`. |
| `verdict.js` | Community step **after** the known-bad list check and **before** both the Groq-key check and the bare-link cache lookup, so community warnings work without Groq and a cached green can't hide a new community red. Returns the community verdict when the count is 3 or more. Adds `reportable` to every verdict. |
| `server.js` | New `POST /api/report` route, covered by the existing rate limiter. Calls `ensureSchema()` at startup. |
| `public/index.html` | Device ID, Report button and link, thank-you message, Warn-my-family button, Urdu and English text, community count shown in the verdict. |
| `CheckActivity.kt` | `Android.share(text)` JavaScript bridge that opens the share sheet. |
| `render.yaml`, `README.md` | Add `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` (`sync: false`); document the setup. |

## API

**`POST /api/check`:** unchanged request. Every verdict response gains:
- `reportable` (boolean): true when the input has at least one non-trusted item.
- `community_count` (number): present only on a community verdict.

**Community verdict** (red), shown when the count is 3 or more:
- `reason_en`: `"<N> Loop users reported this as a scam."`
- `reason_ur`: `"<N> لوپ صارفین نے اسے دھوکہ قرار دیا ہے۔"`
- `action_en`: `"Do not open it, call it, or send money."`
- `action_ur`: `"اسے نہ کھولیں، کال نہ کریں، پیسے نہ بھیجیں۔"`

**`POST /api/report`:** body `{ "input": string, "deviceId": string }`.

| Response | When |
|---|---|
| `200 { "reported": n, "items": ["hbl-secure-verify[.]com", ...] }` | Success. `items` is defanged, for building the share text. |
| `400 { "error": "nothing to report" }` | No non-trusted items, or a missing or invalid field. `input` must be 1–2000 characters and `deviceId` 8–100. |
| `429 { "error": "daily report limit" }` | The device has made 20 or more reports in the last 24 hours. Also used by the existing per-IP limiter. |
| `503 { "error": "reports unavailable" }` | Turso is not configured or is unreachable. |

## Page behaviour

- **Device ID:** `crypto.randomUUID()` stored in `localStorage` under the key `loop_device_id`. Every `localStorage` access is wrapped in try/catch. If storage is unavailable, an ID is generated for the session only; reports still work.
- **Report controls**, shown when `reportable` is true:
  - **Red/yellow verdicts:** a prominent **🚩 Report this scam** button.
  - **Green verdicts:** a small "Think it's a scam? Report it" link.
- **After a successful report:**
  - Thank-you text ("Thank you, you helped protect others.").
  - The report control is replaced by **📤 Warn my family**.
- **Share text**, bilingual, built from the defanged `items`:
  > ⚠️ Loop scam warning: don't open / call **{items}**. Never share your OTP or PIN.
  > ⚠️ لوپ وارننگ: **{items}** نہ کھولیں / کال نہ کریں۔ اپنا OTP یا PIN کبھی شیئر نہ کریں۔
- **Share mechanism, first available wins:**
  1. `window.Android.share(text)` (the app).
  2. `navigator.share({ text })` (browsers that support it).
  3. `navigator.clipboard.writeText(text)`, then a "Warning copied" message.
- **Errors:** a 429 (from either the daily cap or the per-IP limiter) shows "You've sent a lot of reports, thank you. Please try again later." A 503 or a network error shows "Couldn't send your report, please try again later."
- All new text has Urdu versions and follows the existing language toggle.

## Error handling

- **Turso down or not configured:** the community step is skipped with a logged error, and the check continues through the AI exactly as today. A database call never adds more than 3 seconds to a check.
- **Shortener expansion fails:** the link is kept as given, matching current behaviour.
- **Malformed input:** `/api/report` returns 400.

## Testing

**Automated** (`npm test`, with a fake `db.js` so no network is used):
- Phone normalization: every accepted form maps to the same E.164 item; landlines and short numbers are rejected.
- Domain vs. full-link items; a `wa.me` link becomes a phone item; at most 3 items per report.
- Safe sites (`hbl.com`, `online.ubl.com.pk`) produce no items.
- Threshold: 2 devices give no community verdict, 3 devices give red with `community_count: 3`.
- The same device reporting twice counts once.
- The daily cap returns 429 at 20 reports.
- With the database throwing or disabled, `/api/check` still returns an AI verdict and `/api/report` returns 503.
- Ordering: a community red beats a cached green for a bare link.

**After deploying:**
- Three test device IDs report a test domain and a test number; a fresh check then shows the community red.
- The test rows are deleted afterwards.

**On a phone (Realme RMX3830):** check a scam link → Report → Warn my family → the share sheet opens with the defanged warning.

## Setup (one time, by the owner)

1. Create a free Turso account and a database in the region closest to Pakistan (Mumbai, if offered).
2. Create a database auth token.
3. In Render, set `TURSO_DATABASE_URL` (the `https://` form of the database URL) and `TURSO_AUTH_TOKEN`.

## Out of scope

- Accounts, a "my reports" history, a public scam list, and moderation or admin tools.
- Landline and UAN numbers.
- Reporting images and videos.
- Removing reports, or an appeal process for wrongly flagged items. Reports age out after 90 days; safe sites are protected by the safe-site list.
- Reading SMS or notifications, which is excluded by the trust principle.
