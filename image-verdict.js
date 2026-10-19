'use strict';

const { geminiVerdict } = require('./gemini.js');

const DISCLAIMER_EN = 'This is a best-effort visual check, not proof. When in doubt, verify with the sender directly.';
const DISCLAIMER_UR = 'یہ ایک اندازہ ہے، ثبوت نہیں۔ شک ہو تو براہ راست بھیجنے والے سے تصدیق کریں۔';

const FALLBACK_VERDICT = {
  verdict: 'yellow',
  reason_en: "We couldn't analyze this image right now, so treat it with caution.",
  reason_ur: 'ہم ابھی اس تصویر کا جائزہ نہیں لے سکے، اس لیے احتیاط برتیں۔',
  action_en: DISCLAIMER_EN,
  action_ur: DISCLAIMER_UR,
};

const SYSTEM_PROMPT = `You are Loop, helping low-literacy users in Pakistan judge whether a photo might be AI-generated, digitally manipulated, or a screenshot being used to fake proof (e.g. a fake payment/transfer confirmation).
Look for real visual tells: unnatural hands/fingers/ears/teeth, warped or melted background objects or text, inconsistent lighting or shadows, overly smooth "waxy" skin, mismatched reflections, blending artifacts at the edges of a face or object.
If the image is a screenshot of a chat, payment, or balance, treat it as automatically at least "yellow" — screenshots are trivially edited and prove nothing on their own.
You are NOT a certain fake/real detector — no one can be certain from pixels alone. Never claim certainty.
Output STRICT JSON only (no markdown, no extra text) with exactly these fields:
{"verdict":"red|yellow|green","reason_en":"...","reason_ur":"...","action_en":"...","action_ur":"..."}
- reason_en/action_en: max 20 simple words each, no jargon.
- reason_ur/action_ur: same meaning in simple Urdu.
- red = visible manipulation/AI-generation tells, or a payment/balance screenshot.
- yellow = can't tell either way, or minor ambiguous signs.
- green = ordinary photo, no visible tells (still not certain).`;

async function getImageVerdict(base64Data, mimeType) {
  if (!process.env.GEMINI_API_KEY) return FALLBACK_VERDICT;

  try {
    const parsed = await geminiVerdict(SYSTEM_PROMPT, mimeType, base64Data, 45000);

    // Enforced in code, not just prompted — never let a dropped instruction produce an unqualified verdict.
    parsed.action_en = `${parsed.action_en} ${DISCLAIMER_EN}`;
    parsed.action_ur = `${parsed.action_ur} ${DISCLAIMER_UR}`;
    return parsed;
  } catch (err) {
    console.error('Gemini image check failed:', err.message);
    return FALLBACK_VERDICT;
  }
}

module.exports = { getImageVerdict };
