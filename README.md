<p align="center"><img src="docs/assets/loop-hero.svg" width="100%" alt="Loop — a proactive Android shield against scams and deepfakes. Team ClosedLoop, NYLP AI Hackathon 2026"/></p>

**Loop — a proactive Android shield that checks the link before it opens and the call before you trust it. Built by Team ClosedLoop for the NYLP AI Hackathon 2026.**

Loop is a **proactive** shield, not a reactive scanner. It's built for people who don't yet know to be suspicious — not for people who already do.

- **Live product:** https://loop-2chr.onrender.com (free tier: the first request after idle can take up to a minute to wake)
- **Android app:** [`releases/Loop.apk`](releases/Loop.apk) — install on any Android 8+ phone; it connects to the live server by default

<p align="center"><img src="docs/assets/loop-divider-01-problem.svg" width="100%" alt="Section 01: problem"/></p>

The NYLP AI Hackathon's theme is *Building AI-Powered Products*. The same technology also powers the scams. Generative AI makes cloned voices, fake images and convincing phishing messages cheap to produce, and the people hit hardest are the ones who don't yet know to be suspicious: low-literacy, Urdu-first users in Pakistan, often on a shared Android phone. This is a digital literacy problem as much as a technical one. Existing tools are text-heavy, English-first and reactive: they only help someone who already suspects something is wrong, and they answer in language many users can't read.

<p align="center"><img src="docs/assets/loop-divider-02-solution.svg" width="100%" alt="Section 02: solution — identify, verify, flag"/></p>

<p align="center"><img src="docs/assets/loop-flow-cycle.svg" width="100%" alt="The loop: identify, verify, flag, closing back to protect the next person"/></p>

- **Identify:** paste or share a message, link, photo or video. Loop answers with a colour (green / yellow / red), one plain sentence, and what to do next, shown in English or Urdu and read aloud.
- **Verify:** for voice and video "emergencies" there's no reliable detector, so Loop doesn't pretend to have one. It forces the one defence that beats even a perfect clone: hang up, call back on the saved number, ask the family code word.
- **Flag:** one tap reports a scam link or phone number, and **Warn my family** shares a ready-made warning in Urdu and English.

Android is the core of the design, not an afterthought. Loop registers as a handler for `http`/`https` links, so a tapped link gets checked before it opens. Android's share sheet gives a share-to-Loop flow with no onboarding needed, and a floating bubble keeps Loop one tap away.

Full product reasoning, trust principles, and stated limitations: [`docs/pitch/loop-brief.md`](docs/pitch/loop-brief.md) (concept) and [`docs/pitch/PITCH_BRIEF.md`](docs/pitch/PITCH_BRIEF.md) (as built).

<p align="center"><img src="docs/assets/loop-divider-03-architecture.svg" width="100%" alt="Section 03: architecture — android, node, llm"/></p>

<p align="center"><img src="docs/assets/loop-architecture.svg" width="100%" alt="Architecture diagram: Android app calls the Node server, which routes to Groq for text and Gemini for image and video, and serves the web UI"/></p>

- `server.js` — plain Node `http` server, no framework. Routes `/api/check`, `/api/check-image`, `/api/check-video`, `/api/report` and `/health`, rate-limits `/api/*`, and serves `public/`.
- `verdict.js`, `image-verdict.js`, `video-verdict.js` — build the LLM prompt/response per input type. Each fails safe to a cautious yellow verdict if the API call fails or a key is missing.
- `link-check.js` — AI-free link checks run before the LLM: OpenPhish and URLhaus known-bad lists (refreshed hourly), optional Google Safe Browsing, shortener expansion, and lookalike-brand / punycode detection. Known-bad links return red instantly.
- `gemini.js` — shared Gemini call with fallback to a lighter model on overload/quota errors, plus a verdict cache.
- `community.js`, `db.js`, `client-ip.js` — community scam reports. Users report a link or Pakistani mobile number with one tap; once 3 different devices from at least 2 different networks report the same item within 90 days, everyone who checks it gets a red "N Loop users reported this" verdict. Reports are capped at 20 per device per day. Stored in Turso (hosted SQLite) over its HTTP API; only the extracted item and hashes of an anonymous device ID and the reporter's network are kept, never message text. Known-safe sites can't be reported.
- `load-env.js` — hand-rolled `.env` loader, no dependency.
- `public/index.html` — the UI. Loads inside the app's WebView, also works directly in a browser.
- `android/` — the Android shell: link handler, share target, floating bubble, all pointing at the Node server. Links to a short list of known-safe sites (major banks, Google, YouTube, etc.) open directly without ever reaching the server.

## Tech stack

- **Backend:** Node.js (plain `http` server, no framework, no npm dependencies), deployed on Render.
- **Frontend:** single-page HTML/CSS/JS (`public/index.html`), loaded in the app's WebView or any browser.
- **Android:** Kotlin app (link handler, share target, floating bubble, WebView).
- **Database:** Turso (hosted SQLite) over its HTTP API, for community reports.

## AI methodology and third-party AI APIs

| Task | Third-party AI API | Model | File |
|---|---|---|---|
| Message and link classification | [Groq](https://groq.com) Chat Completions API | `openai/gpt-oss-20b` | `verdict.js` |
| Image manipulation / AI-generation check | [Google Gemini API](https://ai.google.dev) | `gemini-3.6-flash`, falling back to `gemini-flash-lite-latest` | `image-verdict.js`, `gemini.js` |
| Video deepfake check | Google Gemini API | same as above | `video-verdict.js`, `gemini.js` |

No models are trained or fine-tuned by us; Loop uses these hosted models through prompting. Non-AI services used alongside them: OpenPhish, URLhaus and Google Safe Browsing (known-bad link lists).

**How a text/link check works** (`verdict.js`):
1. Screenshots get a fixed answer ("screenshots prove nothing — check your own app"); they are never analysed.
2. Shortened links are expanded, then checked against the known-bad lists — a hit returns red with no AI call.
3. Community reports are checked next — enough independent reports return red with no AI call.
4. Otherwise the message goes to Groq with a system prompt describing Pakistani scam patterns (fake OTP helplines, "wrong transfer", prize/BISP lures) plus a rule-based *link note* (lookalike brand domains, punycode, the real destination of a short link). The model must return strict JSON (`response_format: json_object`, temperature 0.2): a red/yellow/green verdict, a reason and an action in English and Urdu. The prompt includes hard rules (e.g. urgency + OTP/money request is never green) and a worked example.
5. The output is validated; any API error, timeout or malformed answer returns a cautious yellow verdict instead.

**Images and video** (`image-verdict.js`, `video-verdict.js`): Gemini receives the file with a prompt listing concrete visual tells (hands, edges, lighting, lip sync, blinking) and is told never to claim certainty. A "best-effort, not proof" disclaimer is appended in code, so it appears even if the model ignores the instruction. Payment/balance screenshots are at least yellow.

**Limitations:** no model can reliably detect a good deepfake video or cloned voice, so for voice/video "emergencies" Loop relies on the Verify flow (hang up, call back, family code word) rather than a detector. LLM verdicts can be wrong; Loop always pairs them with a safe next step. Verdict caches are in-memory and reset when the server restarts.

**Development tools:** an AI coding assistant (Claude Code) was used during development. All code was reviewed and tested by the team (`npm test`).

<p align="center"><img src="docs/assets/loop-divider-04-running.svg" width="100%" alt="Section 04: running it"/></p>

```bash
npm start        # http://localhost:3000
npm test         # test_check.js + test_community.js
```

Requires a `.env` in the project root (not committed):

```
GROQ_API_KEY=...
GEMINI_API_KEY=...
SAFE_BROWSING_API_KEY=...   # optional
TURSO_DATABASE_URL=https://<db>-<user>.turso.io   # community reports; optional
TURSO_AUTH_TOKEN=...
```

No keys, no crash — the server still runs and returns a generic cautious verdict instead of failing.

To run the Android app: install [`releases/Loop.apk`](releases/Loop.apk) (allow installs from unknown sources), or open `android/` in Android Studio and run it on a device. It uses the live server by default; to use a local server, enter `http://<laptop-LAN-IP>:3000` on the app's home screen.

**Deploying (Render, free tier):** the repo includes a `render.yaml` blueprint. In the Render dashboard choose *New → Blueprint*, pick this repo, and paste `GROQ_API_KEY` / `GEMINI_API_KEY` when prompted. Free instances sleep after ~15 minutes idle, so the first request after a quiet spell takes up to a minute while it wakes.

<p align="center"><img src="docs/assets/loop-divider-05-screenshots.svg" width="100%" alt="Section 05: screenshots"/></p>

| Home | Safe (green) | Scam (red) |
|---|---|---|
| <img src="docs/screenshots/home.png" width="220"> | <img src="docs/screenshots/green.png" width="220"> | <img src="docs/screenshots/red.png" width="220"> |
| Paste a message/link, or try a live demo | No suspicious content — nothing to do | Fake-OTP-helpline scam caught, with one plain reason |

| Proactive link interception | Verify (voice/video emergency) |
|---|---|
| <img src="docs/screenshots/intercept.png" width="220"> | <img src="docs/screenshots/verify.png" width="220"> |
| A tapped scam link is caught *before* it opens | Forces the one defence that beats even a perfect clone: hang up, call back, family code word |

## Features — built for the NYLP AI Hackathon 2026

Loop was designed and built by Team ClosedLoop for the NYLP AI Hackathon 2026 (Oct 17–19). See the [changelog](docs/CHANGELOG.md) for details.

**Identify: AI scam checks**
- Message and link checks with a green / yellow / red verdict, one plain reason and a next step — `verdict.js` (Groq).
- Image and video checks for fake screenshots, fake images and deepfakes — `image-verdict.js`, `video-verdict.js` (Gemini).
- Verdicts in English or Urdu, read aloud with the phone's text-to-speech (`ur-PK`) — `public/index.html`.
- Fails safe: a missing key or failed API call returns a cautious yellow verdict instead of an error.

**AI-free link checks**
- OpenPhish / URLhaus known-bad lists (refreshed hourly) and optional Google Safe Browsing — known-bad links go red instantly — `link-check.js`.
- Shortener expansion, lookalike-brand and punycode warnings — `link-check.js`.
- Gemini model fallback on overload/quota errors, plus a verdict cache — `gemini.js`.

**Verify: voice/video emergencies**
- A guided flow for "family emergency" calls: hang up, call back on the saved number, ask the family code word — `public/index.html`.

**Flag: community scam reporting**
- One-tap **Report this scam** on red/yellow verdicts and a **Warn my family** share message in Urdu and English, with the scam link defanged (`[.]`) — `public/index.html`, `CheckActivity.kt` (share bridge) ([design](docs/superpowers/specs/2026-10-16-community-flags-design.md)).
- `POST /api/report`, item extraction (domains, user-content pages, Pakistani mobile numbers, redirect unwrapping), 3-devices / 2-networks / 90-days threshold, 20-per-day cap — `community.js`, `server.js`.
- Turso storage over plain `fetch` — `db.js`. Spoof-resistant client IP via Cloudflare's `cf-connecting-ip` — `client-ip.js`.

**Android app**
- Registers as the `http`/`https` link handler, so a tapped link is checked before it opens — `CheckActivity.kt`.
- Share-to-Loop from any app, a floating bubble for one-tap access — `BubbleService.kt`, `MainActivity.kt`.
- On-device known-safe list (banks, Google, YouTube…) opens directly; loading/error screens and Android 15 edge-to-edge support.

**Deployment and tests**
- Render deployment with `/health` and per-IP rate limiting — `render.yaml`, `server.js`.
- Test suites — `test_check.js`, `test_community.js`.

### Roadmap (not yet built)

- **Urdu voice-first verdicts.** Today verdicts can be shown in Urdu and read aloud with the phone's text-to-speech (`ur-PK`, in `public/index.html`), but it is still screen-first: the user taps a toggle and reads. A voice-first flow (spoken input, Urdu audio as the primary output, no reading required) is not implemented.

<p align="center"><img src="docs/assets/loop-divider-06-credits.svg" width="100%" alt="Section 06: team and license"/></p>

**Team ClosedLoop** — [NYLP AI Hackathon 2026](https://www.nylp.com.pk/careers), part of the Global Summit on Digital Literacy & Leadership, organised by the National Youth Leadership Programme (NYLP).

| Member | Role | Contribution |
|---|---|---|
| Muhammad Arham | Team Lead | Product direction, coordination, integration and Render deployment |
| Baneen Raza | Backend Developer, AI/ML Engineer | Node server, Groq/Gemini prompts and verdict pipeline, link checks, community reports |
| Rabia Basre | Frontend Developer (Android) | Android app: link interception, share target, floating bubble, WebView bridge |
| Asra Ahmed | Frontend Developer, UI/UX Designer | Web UI, verdict screens, English/Urdu copy and visual assets |
| Muhammad Ali | Researcher, Documentation/Presenter | Scam-pattern research, README and pitch docs, demo and presentation |

[MIT](LICENSE)
