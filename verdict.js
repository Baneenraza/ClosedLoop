'use strict';

const { isKnownBad, expandShortener, urlNotes, parse } = require('./link-check.js');
const community = require('./community.js');

const GROQ_MODEL = 'openai/gpt-oss-20b';

const SCREENSHOT_VERDICT = {
  verdict: 'yellow',
  reason_en: 'Screenshots can be faked in seconds. They prove nothing.',
  reason_ur: 'اسکرین شاٹ سیکنڈوں میں جعلی بنایا جا سکتا ہے۔ یہ کچھ ثابت نہیں کرتا۔',
  action_en: 'Open your own banking app and check your real balance.',
  action_ur: 'اپنی بینکنگ ایپ خود کھولیں اور اصل بیلنس چیک کریں۔',
};

const FALLBACK_VERDICT = {
  verdict: 'yellow',
  reason_en: "We couldn't check this right now, so treat it with caution.",
  reason_ur: 'ہم ابھی اسے چیک نہیں کر سکے، اس لیے احتیاط برتیں۔',
  action_en: 'Do not click links or share codes until you verify another way.',
  action_ur: 'دوسرے ذریعے سے تصدیق کیے بغیر لنکس پر کلک نہ کریں یا کوڈ شیئر نہ کریں۔',
};

const KNOWN_BAD_VERDICT = {
  verdict: 'red',
  reason_en: 'This link is on a list of known scam or harmful websites.',
  reason_ur: 'یہ لنک دھوکہ دہی یا نقصان دہ ویب سائٹس کی فہرست میں ہے۔',
  action_en: 'Do not open it. Never enter passwords, codes, or card details there.',
  action_ur: 'اسے نہ کھولیں۔ وہاں کبھی پاس ورڈ، کوڈ یا کارڈ کی تفصیل نہ ڈالیں۔',
};

function communityVerdict(count) {
  return {
    verdict: 'red',
    reason_en: `${count} Loop users reported this as a scam.`,
    reason_ur: `${count} لوپ صارفین نے اسے دھوکہ قرار دیا ہے۔`,
    action_en: 'Do not open it, call it, or send money.',
    action_ur: 'اسے نہ کھولیں، کال نہ کریں، پیسے نہ بھیجیں۔',
    community_count: count,
  };
}

function findUrl(text) {
  const match = text.match(/https?:\/\/[^\s]+|www\.[^\s]+/i);
  return match ? match[0].replace(/[.,!?)\]'"]+$/, '') : null;
}

function findLinkNote(text, expandedUrl) {
  const url = findUrl(text);
  if (!url) return 'none';
  const notes = urlNotes(url);
  if (expandedUrl) notes.push(`it actually leads to "${expandedUrl}"`, ...urlNotes(expandedUrl));
  return notes.length ? `Link "${url}" is suspicious: ${notes.join('; ')}.` : `Link "${url}" found, no obvious red flags in the URL itself.`;
}

// ponytail: in-memory, lost on restart — only bare links are cached, since a message's
// wording changes the verdict but a link on its own always gets the same answer.
const LINK_CACHE_MAX = 1000;
const LINK_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const linkCache = new Map();

function bareLinkKey(input) {
  const url = findUrl(input);
  if (!url || input.trim().replace(/[.,!?)\]'"]+$/, '') !== url) return null;
  const p = parse(url);
  return p ? p.host + p.path : null;
}

const SYSTEM_PROMPT = `You are Loop, a scam-detection assistant protecting low-literacy users in Pakistan from digital fraud (fake OTP messages, phishing links, fake helpline calls, "wrong transfer" tricks, prize/BISP lures, cloned-voice emergencies).
Given a message and a note about any link in it, output STRICT JSON only (no markdown, no extra text) with exactly these fields:
{"verdict":"red|yellow|green","reason_en":"...","reason_ur":"...","action_en":"...","action_ur":"..."}
Rules:
- reason_en and action_en: max 15 simple words each, no jargon.
- reason_ur and action_ur: same meaning in simple Urdu.
- red = clear fraud indicators (urgency combined with a request for money, OTP, or personal info; fake helpline; threats).
- yellow = suspicious but not certain (unfamiliar sender, unusual request, suspicious link pattern).
- green = ordinary message, no fraud indicators.
- Never output green if urgency and a money/OTP/personal-info request appear together.
- If the link note says a domain is NOT a brand's official website (impersonation) or uses look-alike characters (punycode), output red: real banks and services only use their own domains.
- IMPORTANT fake-helpline pattern: a message that states an OTP/code and then asks the recipient to call a phone number "to verify" is ALWAYS red, even if it also says "don't share this code with anyone." Real banks never send an OTP and then ask you to call a number about it — that callback request is itself the scam, regardless of how trustworthy the wording sounds.

Example:
Message: "Aapka OTP 991122 hai. Kisi ko na dein. Bank se hain, tasdeeq ke liye call karein: 0300-1234567"
Link note: none
Output: {"verdict":"red","reason_en":"Real banks never ask you to call about an OTP they sent.","reason_ur":"اصلی بینک کبھی OTP کے بارے میں کال کرنے کو نہیں کہتا۔","action_en":"Do not call that number. Contact your bank using the number on your card.","action_ur":"اس نمبر پر کال نہ کریں۔ اپنے کارڈ پر موجود نمبر سے بینک سے رابطہ کریں۔"}`;

// Every verdict is returned as a fresh object carrying `reportable`, so shared constants and
// cached verdicts are never mutated.
async function getVerdict(input, kind) {
  if (kind === 'screenshot') return { ...SCREENSHOT_VERDICT, reportable: false };

  const url = findUrl(input);
  const expanded = url ? await expandShortener(url) : null;
  const items = await community.extractItems(input, expanded);
  const verdict = await classify(input, url, expanded, items);
  return { ...verdict, reportable: items.length > 0 };
}

async function classify(input, url, expanded, items) {
  if (url && ((await isKnownBad(url)) || (expanded && (await isKnownBad(expanded))))) return KNOWN_BAD_VERDICT;

  // Before the Groq key check and the link cache: community warnings work without Groq, and a
  // green cached hours ago can't hide reports made since.
  try {
    const count = await community.communityCount(items);
    if (count >= community.THRESHOLD) return communityVerdict(count);
  } catch (err) {
    console.error('Community check failed:', err.message);
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return FALLBACK_VERDICT;

  const cacheKey = bareLinkKey(input);
  const cached = cacheKey && linkCache.get(cacheKey);
  if (cached && Date.now() - cached.at < LINK_CACHE_TTL_MS) return cached.verdict;

  const linkNote = findLinkNote(input, expanded);
  const userMsg = `Message: ${input}\n\nLink note: ${linkNote}`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Groq API ${res.status}`);
    const data = await res.json();
    const parsed = JSON.parse(data.choices[0].message.content);
    if (!['red', 'yellow', 'green'].includes(parsed.verdict)) throw new Error('bad verdict field');
    if (cacheKey) {
      linkCache.delete(cacheKey);
      linkCache.set(cacheKey, { verdict: parsed, at: Date.now() });
      if (linkCache.size > LINK_CACHE_MAX) linkCache.delete(linkCache.keys().next().value);
    }
    return parsed;
  } catch (err) {
    console.error('Groq check failed:', err.message);
    return FALLBACK_VERDICT;
  }
}

module.exports = { getVerdict, findLinkNote, SCREENSHOT_VERDICT, FALLBACK_VERDICT, KNOWN_BAD_VERDICT };
