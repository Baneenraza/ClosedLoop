'use strict';

const crypto = require('crypto');

// Each model has its own free-tier quota, so falling back to a lighter one
// usually succeeds when the primary is overloaded (503) or rate-limited (429).
const MODELS = ['gemini-3.6-flash', 'gemini-flash-lite-latest'];
const RETRYABLE = new Set([429, 500, 503]);

// ponytail: in-memory, lost on restart/sleep — enough to avoid re-analysing the same viral image in a burst.
const CACHE_MAX = 500;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit) {
    // Re-insert so Map order tracks recency; the oldest entry is evicted first.
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function cacheSet(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// Returns the parsed JSON verdict, or throws. Successful verdicts are cached by
// prompt + file content, so identical media is analysed once.
async function geminiVerdict(prompt, mimeType, base64Data, timeoutMs) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const key = crypto.createHash('sha256').update(prompt).update(mimeType).update(base64Data).digest('hex');
  const cached = cacheGet(key);
  if (cached) return { ...cached };

  let lastErr;
  for (const model of MODELS) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64Data } }] }],
          generationConfig: { response_mime_type: 'application/json', temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      }
    );
    if (!res.ok) {
      lastErr = new Error(`Gemini API ${res.status} (${model})`);
      if (RETRYABLE.has(res.status)) {
        console.error(`${lastErr.message}, trying next model`);
        continue;
      }
      throw lastErr;
    }
    const data = await res.json();
    const parsed = JSON.parse(data.candidates[0].content.parts[0].text);
    if (!['red', 'yellow', 'green'].includes(parsed.verdict)) throw new Error('bad verdict field');
    cacheSet(key, parsed);
    return { ...parsed };
  }
  throw lastErr;
}

module.exports = { geminiVerdict };
