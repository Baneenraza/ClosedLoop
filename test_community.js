'use strict';

// Offline tests: no .env is loaded and every network call is faked.
const assert = require('assert');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Swap global.fetch for the duration of fn.
async function withFetch(fake, fn) {
  const real = global.fetch;
  global.fetch = fake;
  try {
    return await fn();
  } finally {
    global.fetch = real;
  }
}

async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const TURSO = { TURSO_DATABASE_URL: 'libsql://loop-flags-test.turso.io', TURSO_AUTH_TOKEN: 'tok' };

// ---- db.js ----
const db = require('./db.js');

test('db: disabled without both env vars', async () => {
  await withEnv({ TURSO_DATABASE_URL: undefined, TURSO_AUTH_TOKEN: undefined }, async () => {
    assert.strictEqual(db.enabled(), false);
    await assert.rejects(db.query('SELECT 1'), /not configured/);
  });
});

test('db: sends a pipeline request and parses rows', async () => {
  let seen;
  const fake = async (url, opts) => {
    seen = { url, opts, body: JSON.parse(opts.body) };
    return new Response(JSON.stringify({
      results: [
        { type: 'ok', response: { type: 'execute', result: {
          cols: [{ name: 'n' }, { name: 'item' }],
          rows: [[{ type: 'integer', value: '3' }, { type: 'text', value: 'domain:x.com' }]],
        } } },
        { type: 'ok', response: { type: 'close' } },
      ],
    }), { status: 200 });
  };
  await withEnv(TURSO, () => withFetch(fake, async () => {
    const rows = await db.query('SELECT ?', ['domain:x.com', 42]);
    assert.deepStrictEqual(rows, [{ n: 3, item: 'domain:x.com' }]);
  }));
  // libsql:// is accepted and rewritten to https://
  assert.strictEqual(seen.url, 'https://loop-flags-test.turso.io/v2/pipeline');
  assert.strictEqual(seen.opts.headers.Authorization, 'Bearer tok');
  assert.deepStrictEqual(seen.body.requests[0].stmt.args, [
    { type: 'text', value: 'domain:x.com' },
    { type: 'integer', value: '42' },
  ]);
  assert.deepStrictEqual(seen.body.requests[1], { type: 'close' });
});

test('db: statement error rejects', async () => {
  const fake = async () => new Response(JSON.stringify({
    results: [{ type: 'error', error: { message: 'no such table: reports' } }, { type: 'ok', response: { type: 'close' } }],
  }), { status: 200 });
  await withEnv(TURSO, () => withFetch(fake, async () => {
    await assert.rejects(db.query('SELECT * FROM reports'), /no such table/);
  }));
});

test('db: HTTP error rejects', async () => {
  const fake = async () => new Response('nope', { status: 401 });
  await withEnv(TURSO, () => withFetch(fake, async () => {
    await assert.rejects(db.query('SELECT 1'), /Turso HTTP 401/);
  }));
});

// ---- link-check.js safe-site list ----
const linkCheck = require('./link-check.js');

test('isTrusted: exact hosts and whole trusted domains', () => {
  assert.ok(linkCheck.isTrusted('google.com'));
  assert.ok(linkCheck.isTrusted('www.youtube.com'));
  assert.ok(linkCheck.isTrusted('online.ubl.com.pk'));
  assert.ok(linkCheck.isTrusted('en.wikipedia.org'));
  assert.ok(!linkCheck.isTrusted('docs.google.com'), 'user-content subdomains are not trusted');
  assert.ok(!linkCheck.isTrusted('hbl.com.evil.xyz'));
  assert.ok(!linkCheck.isTrusted('nothbl.com'));
});

// ---- community.js: extraction ----
const community = require('./community.js');

test('extract: domain items, lowercase, www stripped (Review Focus 4)', async () => {
  assert.deepStrictEqual(await community.extractItems('Verify now: HTTP://WWW.HBL-Secure-Verify.COM/login?x=1'), ['domain:hbl-secure-verify.com']);
});

test('extract: Urdu punctuation after a link (Review Focus 1)', async () => {
  assert.deepStrictEqual(await community.extractItems('یہ لنک کھولیں http://hbl-secure-verify.com۔'), ['domain:hbl-secure-verify.com']);
  assert.deepStrictEqual(await community.extractItems('http://bisp-gov.online/apply، فوراً'), ['domain:bisp-gov.online']);
});

test('extract: bare domains without scheme (Review Focus 3)', async () => {
  assert.deepStrictEqual(await community.extractItems('open hbl-secure-verify.com now'), ['domain:hbl-secure-verify.com']);
  assert.deepStrictEqual(await community.extractItems('e.g. see file.txt or mail me at ali@scam-mail.com'), []);
  // A host already inside a full URL must not be added again as a bare domain.
  assert.deepStrictEqual(await community.extractItems('https://docs.google.com/forms/d/abc123/viewform'), ['url:docs.google.com/forms/d/abc123/viewform']);
});

test('extract: shared hosts become full-link items, bare shared host is ignored', async () => {
  assert.deepStrictEqual(await community.extractItems('https://sites.google.com/view/hbl-prize/'), ['url:sites.google.com/view/hbl-prize']);
  assert.deepStrictEqual(await community.extractItems('https://docs.google.com/'), []);
});

test('extract: trusted sites produce nothing', async () => {
  assert.deepStrictEqual(await community.extractItems('https://www.hbl.com/personal and https://online.ubl.com.pk'), []);
});

test('extract: Pakistani mobile numbers in every accepted form', async () => {
  for (const s of ['0300-1234567', '0300 1234567', '03001234567', '+92 300 1234567', '923001234567', '00923001234567', '+92-300-123-4567']) {
    assert.deepStrictEqual(await community.extractItems(`call ${s} now`), ['phone:+923001234567'], s);
  }
  assert.deepStrictEqual(await community.extractItems('UAN 111-111-425 or 021-34567890'), []);
  assert.deepStrictEqual(await community.extractItems('id 030012345678901'), [], 'longer digit runs are not phone numbers');
});

test('extract: Urdu/Arabic digits (Review Focus 2)', async () => {
  assert.deepStrictEqual(await community.extractItems('اس نمبر پر کال کریں ۰۳۰۰۱۲۳۴۵۶۷'), ['phone:+923001234567']);
  assert.deepStrictEqual(await community.extractItems('٠٣٠٠١٢٣٤٥٦٧'), ['phone:+923001234567']);
});

test('extract: WhatsApp click-to-chat links become phone items', async () => {
  assert.deepStrictEqual(await community.extractItems('https://wa.me/923001234567'), ['phone:+923001234567']);
  assert.deepStrictEqual(await community.extractItems('https://api.whatsapp.com/send?phone=923001234567'), ['phone:+923001234567']);
});

test('extract: shortener uses the expanded destination', async () => {
  const items = await community.extractItems('https://bit.ly/abc', 'https://hbl-secure-verify.com/login');
  assert.deepStrictEqual(items, ['domain:hbl-secure-verify.com']);
});

test('extract: unexpandable shortener is a full-link item, never the whole shortener (Review Focus 5)', async () => {
  assert.deepStrictEqual(await community.extractItems('https://bit.ly/abc', null), ['url:bit.ly/abc']);
  // No firstExpanded: extractItems expands itself; a failing fetch must still give url:bit.ly/abc.
  const items = await withFetch(async () => { throw new Error('offline'); }, () => community.extractItems('https://bit.ly/abc'));
  assert.deepStrictEqual(items, ['url:bit.ly/abc']);
});

test('extract: deduplicated and capped at 3 items', async () => {
  const text = 'a.xyz http://a.xyz b.xyz c.xyz d.xyz 03001234567';
  assert.deepStrictEqual(await community.extractItems(text), ['domain:a.xyz', 'domain:b.xyz', 'domain:c.xyz']);
});

test('defang: links are not clickable, phones readable', () => {
  assert.strictEqual(community.defang('domain:hbl-secure-verify.com'), 'hbl-secure-verify[.]com');
  assert.strictEqual(community.defang('url:docs.google.com/forms/d/x'), 'docs[.]google[.]com/forms/d/x');
  assert.strictEqual(community.defang('phone:+923001234567'), '0300-1234567');
});

// ---- community.js: reports and counts (fake db) ----

// In-memory stand-in for the three SQL shapes community.js uses.
function installFakeDb() {
  const saved = { batch: db.batch, query: db.query, ensureSchema: db.ensureSchema };
  const rows = [];
  db.ensureSchema = async () => true;
  db.batch = async (stmts) => stmts.map(({ sql, args = [] }) => {
    if (sql.startsWith('INSERT INTO reports')) {
      const [item, device_hash, net_hash, created_at] = args;
      const existing = rows.find((r) => r.item === item && r.device_hash === device_hash);
      if (existing) Object.assign(existing, { net_hash, created_at });
      else rows.push({ item, device_hash, net_hash, created_at });
      return [];
    }
    if (sql.includes('WHERE device_hash = ?')) {
      const [hash, since] = args;
      return [{ n: rows.filter((r) => r.device_hash === hash && r.created_at > since).length }];
    }
    if (sql.includes('WHERE item IN')) {
      const since = args[args.length - 1];
      const items = args.slice(0, -1);
      const minNets = sql.includes('HAVING COUNT(DISTINCT net_hash) >= 2') ? 2 : 1;
      const counts = items
        .map((i) => rows.filter((r) => r.item === i && r.created_at > since))
        .filter((rs) => rs.length > 0 && new Set(rs.map((r) => r.net_hash)).size >= minNets)
        .map((rs) => rs.length)
        .sort((a, b) => b - a);
      return counts.length ? [{ n: counts[0] }] : [];
    }
    throw new Error(`fake db: unexpected SQL ${sql}`);
  });
  db.query = async (sql, args = []) => (await db.batch([{ sql, args }]))[0];
  rows.restore = () => Object.assign(db, saved);
  return rows;
}

const DEV = (n) => `device-${String(n).padStart(4, '0')}`;
// One network (/24) per test device, so distinct devices also count as distinct networks.
const IP = (n) => `10.${n}.0.1`;

test('report: stores items with hashed device id, returns defanged items', async () => {
  const rows = installFakeDb();
  try {
    const r = await community.report('Your HBL account is blocked: http://hbl-secure-verify.com/login call 0300-1234567', DEV(1), IP(1));
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { reported: 2, items: ['hbl-secure-verify[.]com', '0300-1234567'] });
    assert.deepStrictEqual(rows.map((x) => x.item), ['domain:hbl-secure-verify.com', 'phone:+923001234567']);
    assert.match(rows[0].device_hash, /^[0-9a-f]{64}$/);
    assert.ok(!rows.some((x) => x.device_hash.includes('device-')), 'raw device id is never stored');
  } finally {
    rows.restore();
  }
});

test('report: validation and nothing-to-report give 400', async () => {
  const rows = installFakeDb();
  try {
    assert.strictEqual((await community.report('', DEV(1), IP(1))).status, 400);
    assert.strictEqual((await community.report('x'.repeat(2001), DEV(1), IP(1))).status, 400);
    assert.strictEqual((await community.report('http://a.xyz', 'short')).status, 400);
    assert.strictEqual((await community.report('http://a.xyz', 42)).status, 400);
    assert.strictEqual((await community.report('hello, how are you?', DEV(1), IP(1))).status, 400);
    assert.strictEqual((await community.report('https://www.hbl.com', DEV(1), IP(1))).status, 400, 'trusted sites cannot be reported');
    assert.strictEqual(rows.length, 0);
  } finally {
    rows.restore();
  }
});

test('count: threshold needs 3 distinct devices; same device counts once', async () => {
  const rows = installFakeDb();
  try {
    const item = ['domain:scam-one.xyz'];
    await community.report('http://scam-one.xyz', DEV(1), IP(1));
    await community.report('http://scam-one.xyz', DEV(1), IP(1));
    assert.strictEqual(await community.communityCount(item), 0, 'a single network never counts');
    await community.report('scam-one.xyz', DEV(2), IP(2));
    assert.strictEqual(await community.communityCount(item), 2);
    await community.report('http://www.SCAM-ONE.xyz/other-page', DEV(3), IP(3));
    assert.strictEqual(await community.communityCount(item), 3);
    assert.strictEqual(community.THRESHOLD, 3);
  } finally {
    rows.restore();
  }
});

test('count: reports older than 90 days are ignored', async () => {
  const rows = installFakeDb();
  try {
    const old = Date.now() - 91 * 24 * 60 * 60 * 1000;
    rows.push({ item: 'domain:old-scam.xyz', device_hash: 'a', net_hash: 'n1', created_at: old });
    rows.push({ item: 'domain:old-scam.xyz', device_hash: 'b', net_hash: 'n2', created_at: old });
    rows.push({ item: 'domain:old-scam.xyz', device_hash: 'c', net_hash: 'n3', created_at: Date.now() });
    rows.push({ item: 'domain:old-scam.xyz', device_hash: 'd', net_hash: 'n4', created_at: Date.now() });
    assert.strictEqual(await community.communityCount(['domain:old-scam.xyz']), 2);
  } finally {
    rows.restore();
  }
});

test('count: highest count among items; empty list is 0', async () => {
  const rows = installFakeDb();
  try {
    for (const d of [1, 2]) await community.report('http://two.xyz', DEV(d), IP(d));
    for (const d of [1, 2, 3, 4]) await community.report('http://four.xyz', DEV(d), IP(d));
    assert.strictEqual(await community.communityCount(['domain:two.xyz', 'domain:four.xyz']), 4);
    assert.strictEqual(await community.communityCount([]), 0);
  } finally {
    rows.restore();
  }
});

test('report: daily cap of 20 rows per device gives 429', async () => {
  const rows = installFakeDb();
  try {
    for (let i = 0; i < 20; i++) {
      assert.strictEqual((await community.report(`http://cap-${i}.xyz`, DEV(9), IP(9))).status, 200);
    }
    const r = await community.report('http://cap-20.xyz', DEV(9), IP(9));
    assert.strictEqual(r.status, 429);
    assert.deepStrictEqual(r.body, { error: 'daily report limit' });
    assert.strictEqual((await community.report('http://cap-20.xyz', DEV(10), IP(10))).status, 200, 'other devices unaffected');
  } finally {
    rows.restore();
  }
});

test('report/count: database unavailable or failing', async () => {
  const saved = { batch: db.batch, query: db.query, ensureSchema: db.ensureSchema };
  try {
    db.ensureSchema = async () => false;
    assert.deepStrictEqual(await community.report('http://a.xyz', DEV(1), IP(1)), { status: 503, body: { error: 'reports unavailable' } });
    assert.strictEqual(await community.communityCount(['domain:a.xyz']), 0);

    db.ensureSchema = async () => true;
    db.query = async () => { throw new Error('Turso HTTP 500'); };
    db.batch = async () => { throw new Error('Turso HTTP 500'); };
    assert.strictEqual((await community.report('http://a.xyz', DEV(1), IP(1))).status, 503);
    await assert.rejects(community.communityCount(['domain:a.xyz']), /Turso HTTP 500/);
  } finally {
    Object.assign(db, saved);
  }
});

// ---- verdict.js integration ----
const { getVerdict } = require('./verdict.js');

// Fake Groq: always answers with the given verdict and counts calls.
function fakeGroq(verdict) {
  const calls = { n: 0 };
  const fetch = async (url) => {
    if (!String(url).includes('api.groq.com')) throw new Error(`unexpected fetch ${url}`);
    calls.n++;
    const content = JSON.stringify({ verdict, reason_en: 'r', reason_ur: 'r', action_en: 'a', action_ur: 'a' });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };
  return { fetch, calls };
}

test('verdict: community red after 3 reports, before AI, no Groq call', async () => {
  const rows = installFakeDb();
  const groq = fakeGroq('green');
  try {
    for (const d of [1, 2, 3]) await community.report('http://flagged-scam.xyz', DEV(d), IP(d));
    const v = await withEnv({ GROQ_API_KEY: 'test' }, () => withFetch(groq.fetch, () => getVerdict('check http://flagged-scam.xyz/win', 'message')));
    assert.strictEqual(v.verdict, 'red');
    assert.strictEqual(v.community_count, 3);
    assert.strictEqual(v.reason_en, '3 Loop users reported this as a scam.');
    assert.strictEqual(v.reason_ur, '3 لوپ صارفین نے اسے دھوکہ قرار دیا ہے۔');
    assert.strictEqual(v.reportable, true);
    assert.strictEqual(groq.calls.n, 0);
  } finally {
    rows.restore();
  }
});

test('verdict: community red works with no Groq key', async () => {
  const rows = installFakeDb();
  try {
    for (const d of [1, 2, 3]) await community.report('0300-7654321', DEV(d), IP(d));
    const v = await withEnv({ GROQ_API_KEY: undefined }, () => getVerdict('Call 03007654321 to claim', 'message'));
    assert.strictEqual(v.verdict, 'red');
    assert.strictEqual(v.community_count, 3);
  } finally {
    rows.restore();
  }
});

test('verdict: below threshold falls through to the AI', async () => {
  const rows = installFakeDb();
  const groq = fakeGroq('yellow');
  try {
    for (const d of [1, 2]) await community.report('http://almost-flagged.xyz', DEV(d), IP(d));
    const v = await withEnv({ GROQ_API_KEY: 'test' }, () => withFetch(groq.fetch, () => getVerdict('http://almost-flagged.xyz/a', 'message')));
    assert.strictEqual(v.verdict, 'yellow');
    assert.strictEqual(v.community_count, undefined);
    assert.strictEqual(groq.calls.n, 1);
  } finally {
    rows.restore();
  }
});

test('verdict: a cached green bare link cannot hide a new community red', async () => {
  const rows = installFakeDb();
  const groq = fakeGroq('green');
  try {
    const link = 'http://cached-then-flagged.xyz/page';
    await withEnv({ GROQ_API_KEY: 'test' }, async () => {
      const first = await withFetch(groq.fetch, () => getVerdict(link, 'message'));
      assert.strictEqual(first.verdict, 'green');
      for (const d of [1, 2, 3]) await community.report(link, DEV(d), IP(d));
      const second = await withFetch(groq.fetch, () => getVerdict(link, 'message'));
      assert.strictEqual(second.verdict, 'red');
      assert.strictEqual(groq.calls.n, 1);
    });
  } finally {
    rows.restore();
  }
});

test('verdict: database failure is skipped, check still answers', async () => {
  const saved = { batch: db.batch, query: db.query, ensureSchema: db.ensureSchema };
  const groq = fakeGroq('yellow');
  try {
    db.ensureSchema = async () => true;
    db.query = async () => { throw new Error('Turso HTTP 500'); };
    const v = await withEnv({ GROQ_API_KEY: 'test' }, () => withFetch(groq.fetch, () => getVerdict('http://db-down.xyz', 'message')));
    assert.strictEqual(v.verdict, 'yellow');
    assert.strictEqual(v.reportable, true);
  } finally {
    Object.assign(db, saved);
  }
});

test('verdict: reportable flag', async () => {
  const rows = installFakeDb();
  const groq = fakeGroq('green');
  try {
    await withEnv({ GROQ_API_KEY: 'test' }, () => withFetch(groq.fetch, async () => {
      assert.strictEqual((await getVerdict('salam, kal milte hain', 'message')).reportable, false);
      assert.strictEqual((await getVerdict('https://www.hbl.com/personal', 'message')).reportable, false);
      assert.strictEqual((await getVerdict('anything', 'screenshot')).reportable, false);
    }));
  } finally {
    rows.restore();
  }
});

// ---- final-review fixes ----

test('fix: Urdu question mark after a link is trimmed', async () => {
  assert.deepStrictEqual(await community.extractItems('یہ لنک ٹھیک ہے؟ https://hbl-secure-verify.com؟'), ['domain:hbl-secure-verify.com']);
});

test('fix: one network alone can never reach the threshold', async () => {
  const rows = installFakeDb();
  try {
    // One person inventing device IDs from one connection (same /24).
    for (const d of [1, 2, 3, 4, 5]) await community.report('http://rival-shop.xyz', DEV(d), `10.9.9.${d}`);
    assert.strictEqual(await community.communityCount(['domain:rival-shop.xyz']), 0);
    // A report from a second network makes it count.
    await community.report('http://rival-shop.xyz', DEV(6), '10.8.0.1');
    assert.strictEqual(await community.communityCount(['domain:rival-shop.xyz']), 6);
    assert.match(rows[0].net_hash, /^[0-9a-f]{64}$/);
    assert.ok(!rows.some((r) => r.net_hash.includes('10.')), 'raw IPs are never stored');
  } finally {
    rows.restore();
  }
});

test('fix: IPv6 /64 and IPv4-mapped addresses group into networks', async () => {
  const rows = installFakeDb();
  try {
    await community.report('http://v6-scam.xyz', DEV(1), '2001:db8:1:2::a');
    await community.report('http://v6-scam.xyz', DEV(2), '2001:db8:1:2::b');
    await community.report('http://v6-scam.xyz', DEV(3), '::ffff:10.20.30.1');
    await community.report('http://v6-scam.xyz', DEV(4), '10.20.30.2');
    const nets = new Set(rows.map((r) => r.net_hash));
    assert.strictEqual(nets.size, 2, 'same /64 = one network; ::ffff:10.20.30.x and 10.20.30.x = one network');
  } finally {
    rows.restore();
  }
});

test('fix: verdict stays non-community when all reports share a network', async () => {
  const rows = installFakeDb();
  const groq = fakeGroq('yellow');
  try {
    for (const d of [1, 2, 3]) await community.report('0300-5551234', DEV(d), '10.7.7.7');
    const v = await withEnv({ GROQ_API_KEY: 'test' }, () => withFetch(groq.fetch, () => getVerdict('call 03005551234', 'message')));
    assert.strictEqual(v.community_count, undefined);
  } finally {
    rows.restore();
  }
});

test('fix: popular user-content hosts report the exact page, never the whole host', async () => {
  const cases = [
    ['https://chat.whatsapp.com/AbCdEf123', 'url:chat.whatsapp.com/AbCdEf123'],
    ['https://apps.apple.com/pk/app/fake-loan/id123456', 'url:apps.apple.com/pk/app/fake-loan/id123456'],
    ['https://linktr.ee/fakeprize', 'url:linktr.ee/fakeprize'],
    ['https://web.facebook.com/FakeBISPpage', 'url:web.facebook.com/FakeBISPpage'],
    ['https://m.me/fakepage', 'url:m.me/fakepage'],
  ];
  for (const [input, item] of cases) assert.deepStrictEqual(await community.extractItems(input), [item], input);
});

test('fix: Play Store links keep the app id; no id means nothing to report', async () => {
  assert.deepStrictEqual(await community.extractItems('https://play.google.com/store/apps/details?id=com.fake.loan&hl=en'), ['url:play.google.com/store/apps/details?id=com.fake.loan']);
  assert.deepStrictEqual(await community.extractItems('https://play.google.com/store/apps/details?id=com.other.app'), ['url:play.google.com/store/apps/details?id=com.other.app']);
  assert.deepStrictEqual(await community.extractItems('https://play.google.com/store/apps'), []);
});

test('fix: government sites, WhatsApp and Gmail can never be flagged', async () => {
  for (const s of ['https://www.fbr.gov.pk/login', 'https://pakistan.gov.pk', 'https://whatsapp.com/download', 'https://web.whatsapp.com', 'https://mail.google.com/mail/u/0']) {
    assert.deepStrictEqual(await community.extractItems(s), [], s);
  }
});

test('fix: more shorteners are treated as shorteners', async () => {
  for (const host of ['t.ly', 's.id', 'rebrand.ly', 'lnkd.in', 'bit.do']) {
    assert.deepStrictEqual(await community.extractItems(`https://${host}/abc`, null), [`url:${host}/abc`], host);
  }
});

test('fix: redirect wrappers report the real destination', async () => {
  assert.deepStrictEqual(await community.extractItems('https://www.google.com/url?q=https://evil-redirect.xyz/login&sa=D'), ['domain:evil-redirect.xyz']);
  assert.deepStrictEqual(await community.extractItems('https://l.facebook.com/l.php?u=https%3A%2F%2Fevil-redirect.xyz%2Flogin&h=AT0'), ['domain:evil-redirect.xyz']);
  assert.deepStrictEqual(await community.extractItems('https://www.youtube.com/redirect?q=https://evil-redirect.xyz'), ['domain:evil-redirect.xyz']);
  // A scam site carrying a "next" URL is still reported itself.
  assert.deepStrictEqual(await community.extractItems('https://scam-login.xyz/?next=https://www.hbl.com'), ['domain:scam-login.xyz']);
});

test('fix: a community-flagged site behind a redirect wrapper is still caught', async () => {
  const rows = installFakeDb();
  const groq = fakeGroq('green');
  try {
    for (const d of [1, 2, 3]) await community.report('http://wrapped-scam.xyz', DEV(d), IP(d));
    const v = await withEnv({ GROQ_API_KEY: 'test' }, () => withFetch(groq.fetch, () => getVerdict('https://www.google.com/url?q=https://wrapped-scam.xyz/win', 'message')));
    assert.strictEqual(v.verdict, 'red');
    assert.strictEqual(v.community_count, 3);
    assert.strictEqual(v.reportable, true);
  } finally {
    rows.restore();
  }
});

// ---- client IP (proxy headers) ----
const { clientIp } = require('./client-ip.js');

test('clientIp: trusts Cloudflare cf-connecting-ip, never a client-sent X-Forwarded-For', () => {
  assert.strictEqual(clientIp({ 'cf-connecting-ip': '39.40.1.2', 'x-forwarded-for': '203.0.1.10, 10.0.0.1' }, '10.0.0.9'), '39.40.1.2');
  assert.strictEqual(clientIp({ 'x-forwarded-for': '203.0.1.10, 10.0.0.1' }, '10.0.0.9'), '10.0.0.9', 'spoofable header ignored');
  assert.strictEqual(clientIp({}, '127.0.0.1'), '127.0.0.1');
  assert.strictEqual(clientIp({ 'cf-connecting-ip': '  ' }, '127.0.0.1'), '127.0.0.1');
});

// ---- runner ----
(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`PASS: ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL: ${t.name}\n  ${err.stack}`);
    }
  }
  if (failed) {
    console.error(`${failed} test(s) failed`);
    process.exit(1);
  }
})();
