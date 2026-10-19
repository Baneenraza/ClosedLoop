# Loop — Solution Brief (Android)
### Team ClosedLoop · NYLP AI Hackathon 2026 · Theme: Building AI-Powered Products

**Identity:** A shield that intervenes at the moment of danger — not a scanner that judges artifacts.
**Operating principle:** Where we can check, we check. Where nobody can check, we guard the decision.

---

## Problem Statement

Generative AI has made deepfake video, fake images, and cloned voices trivial to produce, and social platforms are flooded with financial scams — fake helpline calls, phishing links, "wrong transfer" tricks, fake payment screenshots, and cloned-voice "family emergency" calls.

Tech-savvy users spot the red flags. Millions of low-literacy, non-technical users cannot — and existing tools make it worse: they are text-heavy, English-first, reactive, and output verdicts an illiterate user can't read or act on. The gap is not just technical; it is about accessibility and digital literacy.

**The user we design for:** someone who does not know a scam is happening, may not read fluently, speaks a local language, and is on an Android phone.

---

## Why Android

Android is not a compromise here — it is the correct target and it makes the solution stronger:

- **The proactive interception is native to Android.** An app can register as a handler for `http/https` links, so any tapped link routes through Loop *before* it opens. This is the core novelty and it is genuinely hard to do on iOS.
- **Share-to-Loop is a first-class OS gesture.** The Android share sheet is already a habit; the IDENTIFY flow needs no new onboarding.
- **It meets the threat on its home turf.** Android dominates Pakistan's market, and the OTP-stealing malware in our research spreads as Android APKs.

---

## Proposed Solution

Loop does three things — *identify, verify, and flag* — and no more.

### 1. IDENTIFY — the everyday threat (scam text & links)
User shares a message, link, or screenshot → spoken verdict in their language + red/yellow/green light + one plain reason.
- **Links:** checked for real (bad/look-alike domain, http, raw IP).
- **Text:** LLM catches OTP-baiting, urgency, prize/BISP lures, fake-helpline scripts.
- **Screenshots:** one unfalsifiable rule — "Screenshots prove nothing. Open your app, check your balance."

### 2. VERIFY — the undetectable threat (deepfake voice, video, images)
No fake detector. Loop forces the defence that beats even a perfect clone:
- **Voice/video "emergency":** full-screen red interrupt → "Hang up. Call them back on their real number." + a pre-set **family code word**.
- **Live video:** "Ask them to turn their head / say a random word."
- **Images:** the 2–3 real tells + reverse-image check + "who's asking, and why."

### 3. FLAG — warn the next person
After a red verdict, one tap → "Warn my family / mohalla." Shares the scam number or link to a group so the next person is protected before they're hit. Turns one save into many.

---

## The two decisions that are the real innovation

- **Proactive, not reactive.** Loop is an Android **link-handler + share-target**, so it protects the user who doesn't even know to be suspicious. Share-to-check is the fallback, not the headline.
- **Friction as the defence against panic.** The danger interrupt is loud, full-screen, and un-dismissable for 3 seconds. Scams win through urgency; we fight urgency with an enforced pause. The classic weakness ("advice only works if followed") becomes a built feature. On Android this is a full-screen Activity launched by the link-handler; a system-wide overlay (`SYSTEM_ALERT_WINDOW`) is roadmap, not demo scope.

---

## The trust principle, stated on the tin

**"We check the door you're about to walk through — we don't read your house."**
Loop uses only Android's link-handler and share intents — the same OS features users already trust — and deliberately **refuses the permissions scam apps abuse** (`READ_SMS`, notification-listener, accessibility service). On Android these permissions are *available and tempting*; refusing them is a conscious design choice and our differentiator. The moment we add `READ_SMS` "to be more proactive," we become the thing we protect people from.

---

## Its Value

- **Reaches the user we design for.** Voice + colour + local language removes the literacy barrier; the proactive layer removes the need to already suspect a scam.
- **Honest by construction.** Every feature is either genuinely accurate (link/text checks) or advice that cannot be wrong ("call them back to verify"). Nothing ever hands a user a false "safe."
- **Beats even perfect deepfakes.** Verification defeats a scam at its goal (getting you to act), not at the artifact — so it holds as generators improve.
- **Educational, not just protective.** Each verdict speaks one plain reason, so the user learns the *pattern* of deception, not just obedience to a light.
- **Deployable in Pakistan today.** Android-native, low-friction, no invasive permissions, built for local scams and languages.

---

## Limitations (stated before a judge does)

- **We cannot reliably detect deepfake video or voice — and neither can anyone else in real time.** We defend the human decision instead. A deliberate choice, not a gap.
- **Adherence:** advice only helps if followed under panic. Mitigated by the enforced-pause interrupt and urgency-as-red-flag coaching — but it remains a structural soft spot, named honestly.
- **False positives / negatives** in text and link checks. A wrong verdict annoys or misses; crying wolf trains users to ignore warnings. Mitigated with a 3-tier (not binary) verdict + plain reason.
- **The system-wide overlay interrupt** needs `SYSTEM_ALERT_WINDOW`; scoped to link-handler / share contexts for now.
- **Local-language TTS quality** is inconsistent on cheap Android phones; demo uses pre-recorded clips, on-device TTS is roadmap.
- **Connectivity, low-end devices, data cost, and funding at scale** are open constraints, not solved by the prototype.

---

## Proposed Build Plan (~6–12 hours)

**Build for real (the live demo engine):**
- Share/paste message or link → LLM scam check + link safety check → red/yellow/green → **one spoken reason** → plain next action.
- Four hero scenarios: fake OTP/helpline message, "wrong transfer" trick, phishing link, and one normal safe message (builds trust, not just fear).

**Mock, clearly labelled as intended behaviour:**
- The proactive link-interrupt (full-screen red on a tapped scam link; link-check live underneath).
- The FLAG / warn-others share.

**Roleplay + one slide:**
- The VERIFY flow — code word, call-back, head-turn.

| Hours | Focus |
|---|---|
| 0–1 | Lock scope, scenarios, demo language |
| 1–5 | IDENTIFY engine: input → verdict → traffic light → voice |
| 5–7 | Hero flows + proactive interrupt mock + FLAG mock |
| 7–9 | Polish UI to look finished |
| 9–11 | Deck + rehearse demo/roleplay |
| 11–12 | Buffer |

**Stack:** Android-first. LLM call returning a strict verdict · link/domain checks · Android link-handler + share intents · full-screen Activity for the interrupt · pre-recorded voice clips (on-device TTS roadmap) · big icons, colour, minimal text.

**Explicitly out of scope (and why):**
- No share-to-third-party deepfake detector — reintroduces the false-"safe" risk.
- No always-on message/screen monitoring — the invasive-permissions trap that breaks the trust story.

---

*Loop — your digital watchman.*
