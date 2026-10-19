# Loop — Technical Pitch Script & Engine Reference

Companion doc to `PITCH_BRIEF.md`. This is for rehearsal and judge Q&A prep — the spoken script for the technical slides, plus the precise engine/model breakdown so you never have to guess or overclaim under questioning.

---

## Part 1 — Spoken Script (Slides 2, 3, 6, 7, 8)

Written to sound natural when spoken aloud, not read word-for-word. Bracketed notes are delivery cues, not things to say.

### Slide 2 — Core Idea

Most safety apps have the same flaw: they wait for you to already be suspicious before you open them. If you don't suspect anything, they never help you.

Loop flips that. It sits on your phone at all times, and puts itself between you and the danger — before a scam link ever loads, before a scam message ever gets acted on.

**[Pause. Say this one slowly — it's your best line:]**

*"We check the door you're about to walk through — we don't read your house."*

That line isn't just a tagline — it's an architecture decision. Loop never asks for `READ_SMS`, notification access, accessibility service, or live call-audio capture — the exact permissions every scam app abuses. It only ever intercepts the moment you're about to act, nothing more.

Two things make that real, not theoretical. First — a floating shield bubble, a system overlay that lives on top of every app. Tap it, get a quick menu: check a message, or "I'm on a call." Second — Loop registers itself as the phone's default browser. Any link you tap, anywhere — SMS, WhatsApp, notes — routes through Loop's check screen first, before the real site opens.

### Slide 3 — Check Engine

Under the hood, it's one engine, not three separate tools. Whatever you give it — a pasted message, an intercepted link, a photo — collapses to the same simple output: a color, one plain-language reason, spoken aloud, in English or Urdu.

Red — stop, this is a scam. Yellow — be careful, verify first. Green — looks safe.

For text and links, we run local regex checks first — raw IPs, missing HTTPS, trust-bait domains — before it ever reaches the LLM, which is Groq's `gpt-oss-20b` model doing the actual classification. For images, Gemini vision reads for manipulation tells, always paired with "verify independently" — never a bare "safe."

**[Good line to volunteer, not wait to be asked:]** And for screenshots specifically — we don't analyze them at all. The reply is fixed: "screenshots prove nothing, check your own app." That's not a missing feature. Screenshots are trivially faked, so pretending to analyze one would just be lying more convincingly.

### Slide 6 — Credibility

**[Lead with confidence here, not an apology:]** We want to tell you what doesn't work before you ask.

Everything on the left — text check, image check, link interception, the floating bubble, the screenshot rule — is real and running, not a mockup. FLAG is live too: one-tap reports, and once 3 devices on 2 networks report the same link or number, everyone sees it red. VERIFY is a guided checklist, not a detector, and that's deliberate. Here's why.

Here's the one I actually want you to remember: nobody can reliably detect a deepfake video or voice in real time — that's a published, unsolved limitation, not an excuse. We didn't just cite that — we tested it. We ran two independent deepfake-detection models, an EfficientNet-B0 classifier and a modern Vision Transformer trained on 2.7 million images across almost 5,000 different generators, against two confirmed deepfakes. Each model caught a *different one* of the two, and missed the other.

**[Pause, let that land.]**

That's not bad luck. That's the generalization problem, proven on our own machine, with our own test. A "better" model doesn't close that gap — it just moves it. That's exactly why Loop defends the human decision instead — hang up, call back, ask for the family code word — because that holds even against a perfect clone, which no detector can ever claim.

### Slide 7 — Implementation

Why Android, specifically — not a convenience choice, a technical one. Link-handler intent-filters, share-target, system-overlay windows — these are OS-level capabilities that don't exist the same way on iOS. Build this cross-platform and you lose the exact mechanism the whole idea is built around.

Stack, quickly: native Kotlin on Android — `WindowManager` for the overlay, a `VIEW` intent-filter for interception, a WebView with a JS-to-native bridge so the check screen can hand off to a real browser. Backend is deliberately boring: Node.js, zero npm dependencies, built-in `http` module — Groq for text, Gemini for image and video. Frontend's a single-page vanilla HTML page, mobile-first, bilingual throughout.

### Slide 8 — Proof

**[Say this explicitly, don't assume it's obvious:]** Every screenshot on this slide is from the actual app, running on a physical Android device — not a design mockup, not a Figma file. Home screen with the check flow, a scam caught in real time, a safe message correctly passed, a link intercepted before it opened, and the VERIFY screen mid-flow.

### Delivery notes

- Don't rush the two-model evidence on slide 6 — it's the strongest technical credibility moment in the deck, and it lands harder with a pause before and after.
- Say "Groq" and "Gemini" and the model names out loud rather than just "an AI" — it's a small thing that visibly signals you built this, not described it.

---

## Part 2 — Engine & Model Reference (for Q&A)

There are **three different engines**. Do not mix them up under questioning.

### 1. Scam engine (text/links) — shipped, live in the app

- **Model**: Groq, `openai/gpt-oss-20b`
- **How it works**: Local regex heuristics run first (raw IP, missing HTTPS, trust-bait domain words, URL shorteners) — zero-cost, no API call. That heuristic note plus the raw message text go to the LLM with a system prompt defining red/yellow/green rules and hardcoded example patterns (e.g. the fake-helpline OTP-callback pattern, added after testing caught the model missing it on one phrasing).
- **Accuracy/baseline**: **No formal benchmark.** `test_check.js` has 4 hand-crafted scenarios and passes all 4 — that's a regression smoke test, not an accuracy measurement.
- **If asked for a number**: "We don't have a statistically valid accuracy figure — this is LLM reasoning per-message, not a trained classifier with a labeled test set."

### 2. Image/video check — shipped, live in the app

- **Model**: Gemini, `gemini-3.6-flash` — a **general-purpose vision-language model**, not a dedicated deepfake classifier.
- **How it works**: Image/video bytes go directly to Gemini with a prompt asking it to reason about visual tells (warped features, lighting inconsistency, lip-sync mismatch for video). The disclaimer text is **enforced in code**, not just prompted — even if the model forgets to hedge, the server appends "not proof, verify independently" itself.
- **Accuracy/baseline**: **Deliberately none, by design.** The point is it never claims a real detection accuracy, because a general vision model reasoning about pixels isn't a validated forensic tool.

### 3. Experimental deepfake classifiers — sandbox only, NOT shipped

**Do not quote this as an accuracy percentage.** n=3 is not a real sample size — a technical judge will spot a fake-precision claim like "66% accuracy" from three images instantly.

- **Models tested**:
  - EfficientNet-B0 (`Saksham09-arch/Deepfake-Detection-Model`, weights from `vipulbhattt/deepfake-detection-models` on Hugging Face) — 2019-era FaceForensics++-style training.
  - Vision Transformer (`buildborderless/CommunityForensics-DeepfakeDet-ViT`) — trained on 2.7M images across 4,803 generators, specifically built for better generalization.
- **How they work**: Real dedicated binary classifiers — face detection crop, then a CNN/ViT forward pass outputting a fake-probability score. Architecturally different from engine #2 — an actual trained detector, not an LLM reasoning about an image.
- **What was actually measured**: 1 real photo + 2 confirmed deepfakes, run through both models. Each model correctly caught one of the two deepfakes and missed the other (called it "real" with near-100% confidence). **This is a demonstration of a specific failure mode** (different models have different blind spots), not an accuracy percentage — describe it exactly that way.
- **Published baseline context** (general knowledge, not personally verified for these exact checkpoints): academic benchmarks like FaceForensics++ typically report 90%+ accuracy for architectures like these — but *only in-distribution*, on the same generator family they were trained on. Out-of-distribution, published research shows accuracy can collapse toward chance. The confident, wrong "real" verdict observed here is a small, real instance of that documented collapse, not a coincidence.

### The fallback answer if pushed for any specific accuracy number

*"We didn't run a statistically valid benchmark — this was a 3-day build timeframe. What we did instead was design every engine to fail toward caution rather than false confidence, and we have direct evidence, not just theory, that dedicated detection models fail unpredictably even when 'better.'"*

That answer is more credible to a technical judge than a fabricated percentage would be.
