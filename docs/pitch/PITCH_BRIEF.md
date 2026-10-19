# Loop — Pitch Brief (as actually built)
### Team ClosedLoop · NYLP AI Hackathon 2026 · Theme: Building AI-Powered Products

This reflects what is **actually running** right now, not the concept doc (`loop-brief.md`). Use this for slides.

---

## 1. Core idea & shielding mechanism

Loop is a **proactive** Android shield, not a reactive scanner. Two real, working layers:

- **Native floating bubble** — a shield icon that lives on top of every app (system overlay). Tap it → quick menu: "Check a message/link" or "I'm on a call."
- **Real link interception** — Loop is registered as the phone's default browser handler. Tapping *any* link, anywhere (SMS, WhatsApp, notes), routes it through Loop's check screen first, with a red "⛔ caught this before it opened" banner — before the user ever reaches the real site. If they still want to proceed, "Continue to website anyway" hands off to Chrome.

Under the hood, checks return one of three colors (red/yellow/green), a one-sentence plain-language reason, and a next action — spoken aloud via TTS, shown in English or Urdu (toggle).

## 2. What's real vs. mocked today

| Feature | Status | How |
|---|---|---|
| Text/link scam check (IDENTIFY) | **Real** | Groq LLM (`openai/gpt-oss-20b`) classifies pasted/shared text; local regex heuristics flag suspicious links (raw IPs, no-https, trust-bait domains, shorteners) before the LLM call |
| Image manipulation check | **Real** | Gemini vision (`gemini-3.6-flash`) analyzes an uploaded/captured photo for visual tells (warped features, lighting inconsistencies, screenshot-of-payment patterns); every verdict carries a code-enforced "not proof, verify independently" disclaimer — never an unqualified "safe" |
| Real link interception | **Real** | Native Android `VIEW` intent-filter + default-browser role; reuses the same check engine |
| Floating bubble | **Real** | System overlay (`TYPE_APPLICATION_OVERLAY`), draggable, no invasive permissions |
| Screenshot rule | **Real** | Fixed, unfalsifiable response: "Screenshots prove nothing — check your own app" — no image analysis attempted on screenshots specifically, by design |
| VERIFY (deepfake voice/video defense) | **Real (guided flow, by design)** | Coaching screen: hang up, call back on the saved number, ask for a family code word. Deliberately not a detector |
| FLAG (warn others) | **Real** | One-tap Report this scam (3 devices / 2 networks / 90 days → red for everyone, stored in Turso) and Warn my family share message in Urdu and English |

## 3. Why Android

- Link-handler + share-target + system overlay are OS-level capabilities that don't exist the same way on iOS — this is the actual technical differentiator, not a platform-of-convenience choice.
- Android dominates the target market, and the SMS-stealing malware this problem targets is itself Android-native.

## 4. Target audience

Low-literacy, non-technical Android users in Pakistan — people who don't already suspect they're being scammed, may not read fluently, and speak a local language. The proactive layer specifically serves the user who wouldn't think to open a checking app in the first place.

## 5. Why it works (accessibility)

- Voice + color + minimal text removes the literacy barrier.
- Proactive interception removes the need to already be suspicious — the check happens *to* the user, not something they have to remember to do.
- Bilingual (English/Urdu) throughout, including spoken output.

## 6. The trust principle

**"We check the door you're about to walk through — we don't read your house."** Loop deliberately refuses the permissions scam apps abuse: no `READ_SMS`, no notification-listener, no accessibility service, no live call-audio capture. This isn't a missing feature — several of these are architecturally impossible for any third-party Android app to obtain (e.g. `CAPTURE_AUDIO_OUTPUT`, needed for live call audio, is a signature-only permission restricted to OS-signed apps).

## 7. Honest, stated limitations

- **No live deepfake video/voice detection.** Nobody can do this reliably in real time — a well-known, published limitation of deepfake detection research (models don't generalize to generation methods they weren't trained on). We defend the human decision instead (VERIFY flow), which holds even against a *perfect* clone.
- **We tested this claim directly, not just cited it.** We ran two independent local deepfake-image classifiers — an EfficientNet-B0 model (2019-era FaceForensics++-style training) and a Vision Transformer trained on Community Forensics (2.7M images across 4,803 different generators, specifically built for broader generalization) — against one real photo and two confirmed deepfakes. Result: each model caught a *different* one of the two deepfakes and missed the other, while both correctly passed the real photo. Two independently-trained models, two independent misses. That's concrete evidence, not just theory: a "better" model moves the blind spot, it doesn't close it — which is exactly why Loop doesn't attempt detection and defends the human decision instead.
- **Link interception shows a chooser, not silent magic.** Android can't verify ownership of arbitrary scam domains, so intercepting them requires the user to set Loop as their default browser once — after that, all links route through it automatically.
- **Image check is a best-effort AI read**, not a certified forensic tool — always paired with "verify independently," never a bare "safe."

## 8. Tech stack

- **Backend**: Node.js, zero npm dependencies (built-in `http`), Groq API (text), Gemini API (vision)
- **Frontend**: single-page vanilla HTML/JS, mobile-first, bilingual, Web Speech API for TTS
- **Android**: native Kotlin — `WindowManager` overlay bubble, `VIEW` intent-filter for link interception, WebView-wrapped check UI with a JS↔native bridge for browser handoff

---

*Loop — your digital watchman.*
