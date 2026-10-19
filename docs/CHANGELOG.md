# Changelog

## 2026-10-16 (evening) — Community flags

Users can now report a scam link or phone number with one tap. Once enough different people report the same thing, **everyone** who meets it afterwards sees **red: "N Loop users reported this as a scam."** This makes the FLAG step real: it used to be a placeholder pop-up.

Design: `docs/superpowers/specs/2026-10-16-community-flags-design.md` · Plan: `docs/superpowers/plans/2026-10-16-community-flags.md`

### What changed

- **Report button.** On red and yellow verdicts there's a big **🚩 Report this scam** button. On green verdicts there's a small "Think it's a scam? Report it" link. After reporting, **📤 Warn my family** opens the share sheet with a ready-made warning in Urdu and English. The link in it is written as `hbl-secure-verify[.]com`, so the warning can't spread a tappable scam link.
- **What's stored.** Only the dangerous item is stored, never the message text:
  - A domain (`domain:hbl-secure-verify.com`).
  - For sites where anyone can publish (Google Docs/Sites/Drive, WhatsApp group invites, Play Store apps by `id`, App Store, linktr.ee, Facebook pages, shorteners), the exact page instead.
  - A Pakistani mobile number in one standard form (`phone:+923001234567`). Urdu and Arabic digits are accepted.
  - Redirect links (`google.com/url?q=…`, `l.facebook.com`) are reported as their real destination.
- **Who reported.** Each phone gets an anonymous random device ID. Only a hash of it is stored, plus a hash of the reporter's **network** (IPv4 /24 or IPv6 /64).
- **When it becomes a warning.** **3 different devices within 90 days, from at least 2 different networks.** The network rule was added after the final code review: device IDs are chosen by the phone, so without it one person could invent three IDs and flag a rival's site or someone's real phone number alone.
- **Never flaggable:** the safe-site list (banks, wallets, BISP/NADRA/SBP, Google, YouTube…), plus `*.gov.pk`, WhatsApp, Gmail and apple.com.
- **Limits:** 20 reports per device per day, on top of the existing per-IP rate limit.
- **Where it runs in a check.** After the scam lists, before the AI and its saved verdicts. A community warning needs no AI call, and a green saved hours ago can't hide new reports.
- **Storage:** Turso (hosted SQLite), called with plain `fetch`, so there's still no npm dependency. `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are set in Render. If the database is down, checks carry on as before and reporting shows "Couldn't send your report, please try again later."
- **App:** page storage is now turned on in the WebView, so the device ID persists. A new `Android.share()` bridge opens the native share sheet.

### Security fix found during live testing

`X-Forwarded-For` can be faked on Render: Render's proxy passes a client-sent value straight through. Live, three reports from one laptop with fake values produced a community warning. The same flaw let anyone dodge the per-IP rate limit. The server now uses Cloudflare's `cf-connecting-ip`, which a client can't set: Cloudflare rejects forged values with a 403. Re-tested live: fake headers now count as one network, and request 31 in a minute is blocked even with a fake header on every request.

### Verification

| What | Result |
|---|---|
| `npm test` | 49/49 pass. 41 of the tests are new (community, database client, client IP), and every one was seen failing before its code was written. |
| Final code review (a fresh reviewer) | 0 Critical, 3 Important (one person faking devices, popular hosts flagged as a whole, the redirect-link bypass), all fixed with tests. A 4th, the Urdu `؟` after a link, was upgraded to Important and fixed. |
| Real Turso database | Request format, table creation, report upsert, distinct-device count and network rule verified. 3 devices on 1 network → 0; adding a 2nd network → counted. |
| Page in phone Chrome (against a local server) | Report → thank-you → Warn my family (share sheet, link written with `[.]`, both languages). The Urdu toggle keeps the reported state. A harmless message and `hbl.com` show no report button. |
| **Live, end to end** | 2 reports from the laptop (home Wi-Fi) didn't trigger a warning. A 3rd report from the **Loop app on 4G**, then a fresh tap on a never-checked page of the same domain → **"3 Loop users reported this as a scam."** The database showed 3 devices / 2 networks. |
| Live spoofing check | 3 reports with fake `X-Forwarded-For` → stored as 1 network, no community warning. A forged `cf-connecting-ip` → 403 from Cloudflare. |
| Cleanup | All test rows deleted (table: 0 rows). Phone Wi-Fi and mobile-data settings restored. |

### Known limitations

- **Someone with two connections can still do it alone.** One person with two connections (e.g. home Wi-Fi plus mobile data) and three invented device IDs can still trigger a warning. Reports age out after 90 days, but there is no removal or appeal path.
- **Shared networks.** Real reporters who all share one carrier's network block need a reporter on a different network before the warning shows.
- **Minor items deferred from the review:**
  - Messages over 2,000 characters can be checked but not reported.
  - The older link check doesn't trim Urdu punctuation.
  - Extra shortened links in a message are unwrapped one after another, which adds delay.
  - The daily cap can reach 22 rows.
  - Scams that rotate random subdomains don't pool their reports.

## 2026-10-16 — Cloud deployment, link checks, and fixing the Android app

Loop went from "only works on the event Wi-Fi" to a public server on Render, with faster and more private link checks, sturdier image/video checks, and an Android app verified working on a real device (Realme RMX3830, Android 15).

Live server: https://loop-2chr.onrender.com

### 1. Why the app was broken

Users saw a white screen on the dashboard, and tapping a link spun for minutes before a connection error. Three separate causes:

| Cause | Symptom | Fix |
|---|---|---|
| The server address was hardcoded to the laptop's IP on the event Wi-Fi (`10.25.0.132`). | The page never loaded, so the WebView stayed white. The OS connect timeout kept link checks spinning for minutes. | The address is now set from the home screen (stored in SharedPreferences) and defaults to the Render URL. |
| An old build with the package name `com.chokidaar.app`, also labelled "Loop" with the same icon, was still installed **and set as the default browser**. | Every tapped link opened in the old, broken app. The bubble people saw was the old app's too. | Uninstalled the old app and made `com.loop.app` the default browser. *Not a code change: do this on any phone that had the old build.* |
| Android 15 draws apps edge-to-edge, so the native title bar covered the top of the page. | The page header and the **Urdu language toggle** were hidden. | The dashboard has no native title bar any more and pads itself clear of the status and navigation bars. |

The app also had no error handling. Failed loads only went to the log. Now:

- A **"Connecting to Loop…"** screen shows while the page loads, instead of a white screen.
- Loading gives up after **75 seconds**, which leaves room for a Render free instance to wake up.
- If the server can't be reached, a readable error page shows the address it tried and has a **Try again** link.
- The home screen has an **Open Loop** button and a **server address** field.

### 2. Cloud deployment (Render, free tier)

- **`render.yaml`** blueprint: a free Node web service in the Singapore region, with a health check at `/health` and automatic deploys on every push to `main`.
- **Environment variables**, set in the Render dashboard and never committed:
  - `GROQ_API_KEY`: text and link verdicts.
  - `GEMINI_API_KEY`: image and video verdicts.
  - `SAFE_BROWSING_API_KEY`: optional, turns on Google Safe Browsing.
- **Server hardening:**
  - `GET /health` returns `ok`.
  - Rate limit of **30 requests per minute per IP** on `/api/*`. The real client IP is read from `X-Forwarded-For`, because Render sits behind a proxy.
  - Timeouts on upstream AI calls: Groq 20s, Gemini 45s. A hung call falls back to the cautious yellow verdict instead of hanging the request.
- **Free-tier catch:** the instance sleeps after about 15 minutes idle, and the first request after that takes up to a minute. An uptime pinger hitting `/health` every 10 minutes keeps it awake if needed.

### 3. Image and video checks: Gemini resilience (`gemini.js`)

In production the free Gemini key hit two failures: `503` (model overloaded) and `429` (the free tier allows **5 requests per minute**, shared by all users). To cope with both:

- **Model fallback:** on a 429, 500 or 503 from `gemini-3.6-flash`, the server retries with `gemini-flash-lite-latest`, which has its own quota.
- **Verdict cache:** successful verdicts are cached in memory, keyed by a SHA-256 of the prompt and file. A repeated image (such as a viral forward) is answered instantly without using quota. Up to 500 entries, oldest dropped first.
- The shared code moved out of `image-verdict.js` and `video-verdict.js` into `gemini.js`.

### 4. Link checks: fast, private, and AI-free where possible

A tapped link now goes through these layers in order:

1. **On the phone** (`CheckActivity.kt`): links to a short list of known-safe sites open straight in the browser and **never reach the server**.
   - The list covers major Pakistani banks and wallets, BISP, NADRA, the State Bank, Google, YouTube, Wikipedia, Daraz and major news sites.
   - Sibling subdomains that host user content, like `docs.google.com` and `sites.google.com`, are deliberately excluded.
   - So are links with another web address in the query string (redirects).
2. **Shortened links** (bit.ly, tinyurl, …) are unwrapped. The server only ever contacts known shortening services, never the destination site, to avoid being used to fetch arbitrary or internal addresses.
3. **Known-bad lists** (`link-check.js`): OpenPhish and URLhaus, refreshed every hour, plus Google Safe Browsing when a key is set. A match returns **red instantly with no AI call**.
   - A list entry with a path flags only that path, so shared hosts aren't blocked wholesale.
   - Feed lines must start with `http`, because a rate-limited feed can answer with an HTML error page.
4. **New warnings passed to the AI:**
   - **Fake-brand domains:** the domain mentions a brand (HBL, Meezan, JazzCash, Easypaisa, BISP…) but isn't the brand's official domain.
   - **Disguised characters** (punycode) in the domain.
   - The prompt now treats a fake-brand domain as **red**.
5. **Saved verdicts:** a link sent on its own is cached for 6 hours. A link inside a message isn't, because the wording around it changes the verdict.

### 5. Build fixes

- The Gradle wrapper was bumped from 9.3.0 to **9.4.1**, which Android Gradle Plugin 9.2.0 requires. Command-line builds failed without it.
- The local Gradle 9.3.0 download was corrupted (a truncated jar) and was moved aside so it could be downloaded again.

### 6. Verification

| What | Result |
|---|---|
| `npm test` | 8/8 pass, including new tests for Gemini fallback and cache (with a fake Gemini), list matching, instant red, fake-brand and punycode detection |
| Live `/health`, page load | `ok`, page loads in under 1s |
| Live phishing message | red (real Groq verdict) |
| Live URLhaus-listed link | red in 0.33s, no AI call |
| Live lookalike `easypaisa-gift.com` | red |
| Live repeated link | answered from the cache |
| Live image check | real Gemini verdict (14s); repeat from the cache in 0.18s. Fallback to the lite model confirmed locally while the main model was returning 503 |
| Lookalike domains, repeated runs | `hbl-secure-verify.com`: red 3/3. `bisp-8171-gov.online` and `easypaisa-gift.com`: red in 4 of 5 runs; the one yellow each came in a batch where Groq was rate-limiting, so it may have been the fallback verdict |
| Real bank link `hbl.com` | green |
| **Phone:** tapped scam link | "Loop caught this before it opened", red verdict |
| **Phone:** tapped `hbl.com` | opened directly in Chrome; Loop never showed |
| **Phone:** dashboard | header and Urdu toggle visible |
| **Phone:** floating shield | running |

### 7. Known limitations

- **Free AI quotas are the bottleneck.** Gemini (5 requests per minute) and Groq both hit 429 errors under a handful of quick requests. The fallbacks and caches stretch this, but real usage needs paid tiers.
- **Caches live in memory.** They're lost whenever the Render instance sleeps or restarts.
- **The AI is inconsistent on borderline messages.** A real HBL PSL ticket message was judged red once and green once. The link-layer checks are deterministic; the AI's verdict on message wording isn't.
- **Licensing:** Google Safe Browsing's free API and OpenPhish's free feed are for non-commercial use. Check their terms (or use Google Web Risk) before a commercial launch.
- **The safe-site list is built into the app**, so changing it means a new app build.
- **Phones need setup:** Loop must be the default browser and have permission to draw over other apps.

### Next

Community **flag database**: let users report scams, so one person's report protects the next person.
