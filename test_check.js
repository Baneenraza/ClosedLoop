'use strict';

require('./load-env.js');
const assert = require('assert');
const { getVerdict, findLinkNote, KNOWN_BAD_VERDICT } = require('./verdict.js');
const { geminiVerdict } = require('./gemini.js');
const linkCheck = require('./link-check.js');

const scenarios = [
  {
    name: 'OTP / fake helpline scam',
    input: 'Aapka OTP 483920 hai. Kisi ko na dein. Agar aapne register nahi kiya, is number par foran call karein: 0300-1234567',
    notGreen: true,
  },
  {
    name: 'Wrong transfer trick',
    input: 'Assalam o Alaikum, maine ghalti se aapke account mein 15000 transfer kar diye hain, please yeh number par wapas bhej dein: 0333-9876543',
    notGreen: true,
  },
  {
    name: 'Phishing link',
    input: 'Your account will be suspended! Verify now: http://hbl-secure-verify.com/login',
    notGreen: true,
  },
  {
    name: 'Normal safe message',
    input: 'Salam bhai, kal ka match dekha? Kya score tha?',
    expect: 'green',
  },
];

async function main() {
  assert.strictEqual(findLinkNote('no links here'), 'none');
  assert.ok(findLinkNote('go to http://1.2.3.4/login').includes('raw IP'));
  console.log('PASS: findLinkNote heuristics');

  await geminiFallbackAndCache();
  await linkChecks();

  if (!process.env.GROQ_API_KEY) {
    console.log('SKIP: GROQ_API_KEY not set, skipping live LLM verdict checks.');
    return;
  }

  for (const s of scenarios) {
    const result = await getVerdict(s.input, 'message');
    assert.ok(['red', 'yellow', 'green'].includes(result.verdict), `${s.name}: invalid verdict "${result.verdict}"`);
    if (s.expect) {
      assert.strictEqual(result.verdict, s.expect, `${s.name}: expected ${s.expect}, got ${result.verdict}`);
    }
    if (s.notGreen) {
      assert.notStrictEqual(result.verdict, 'green', `${s.name}: should not be green, got green — reason: ${result.reason_en}`);
    }
    console.log(`PASS: ${s.name} -> ${result.verdict} (${result.reason_en})`);
  }

  const screenshot = await getVerdict('anything', 'screenshot');
  assert.strictEqual(screenshot.verdict, 'yellow');
  console.log('PASS: screenshot rule');
}

// Mocked fetch: exercises model fallback and caching without spending Gemini quota.
async function geminiFallbackAndCache() {
  const realFetch = global.fetch;
  const realKey = process.env.GEMINI_API_KEY;
  const calls = [];
  process.env.GEMINI_API_KEY = 'test-key';
  global.fetch = async (url) => {
    calls.push(url.match(/models\/([^:]+)/)[1]);
    if (calls.length === 1) return new Response('{}', { status: 503 });
    const text = JSON.stringify({ verdict: 'red', reason_en: 'r', reason_ur: 'r', action_en: 'a', action_ur: 'a' });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
  };
  try {
    const first = await geminiVerdict('prompt', 'image/png', 'AAAA', 1000);
    assert.strictEqual(first.verdict, 'red');
    assert.deepStrictEqual(calls, ['gemini-3.6-flash', 'gemini-flash-lite-latest']);
    first.action_en += ' mutated';

    const second = await geminiVerdict('prompt', 'image/png', 'AAAA', 1000);
    assert.strictEqual(calls.length, 2, 'cached verdict should not call the API again');
    assert.strictEqual(second.action_en, 'a', 'caller mutations must not leak into the cache');

    await geminiVerdict('prompt', 'image/png', 'BBBB', 1000);
    assert.strictEqual(calls.length, 3, 'different media should not hit the cache');
  } finally {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = realKey;
  }
  console.log('PASS: Gemini model fallback and verdict cache');
}

async function linkChecks() {
  const list = new Map();
  linkCheck.addToList(list, 'http://evil-site.example/');
  linkCheck.addToList(list, 'https://docs.google.com/forms/d/scam123');
  linkCheck._setBadList(list);

  // Whole-host entries flag every page; path entries flag only that path, not the whole shared host.
  for (const [input, bad] of [
    ['https://www.evil-site.example/anything', true],
    ['https://docs.google.com/forms/d/scam123/viewform', true],
    ['https://docs.google.com/forms/d/legit456', false],
    ['https://docs.google.com/forms/d/scam1234', false],
  ]) {
    assert.strictEqual(await linkCheck.isKnownBad(input), bad, input);
  }

  // Known-bad links return red without needing the AI, even with no Groq key.
  const realKey = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  try {
    const v = await getVerdict('Claim your prize: http://evil-site.example/win!', 'message');
    assert.strictEqual(v.reason_en, KNOWN_BAD_VERDICT.reason_en);
  } finally {
    if (realKey !== undefined) process.env.GROQ_API_KEY = realKey;
    linkCheck._setBadList(new Map());
  }

  assert.ok(findLinkNote('http://hbl-secure-verify.com/login').includes('NOT its official website'));
  assert.ok(findLinkNote('http://meezanbank-rewards.xyz').includes('"meezan"'));
  assert.ok(!findLinkNote('https://www.hbl.com/personal').includes('official'));
  assert.ok(!findLinkNote('https://online.ubl.com.pk').includes('official'));
  assert.ok(!findLinkNote('https://public-news.com').includes('official'), 'short brand "ubl" must not match inside "public"');
  assert.ok(findLinkNote('https://xn--pypal-4ve.com').includes('punycode'));
  assert.strictEqual(await linkCheck.expandShortener('https://example.com/a'), null, 'non-shorteners are never fetched');
  console.log('PASS: link lists, lookalike brands, punycode');
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
