# Community Flags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users report scam links and phone numbers with one tap; once 3 different devices report the same item within 90 days, everyone who checks it gets a red "N Loop users reported this as a scam" verdict. Reporters can then warn their family through the share sheet.

**Architecture:**
- **`db.js`:** a tiny Turso client over its HTTP API using `fetch`.
- **`community.js`:** turns text into reportable items, records reports, and counts reporters.
- **`verdict.js`:** consults the community count after the known-bad lists, before the AI and its cache.
- **`server.js`:** gains `POST /api/report`.
- **The page** gets Report and Warn-my-family controls; the Android app gets a share bridge.

**Tech Stack:** Node 24 (built-in `fetch`, `crypto`, `assert`; no npm dependencies), Turso (libSQL) HTTP pipeline API v2, plain HTML/JS page, Kotlin Android WebView app.

**Spec:** `docs/superpowers/specs/2026-10-16-community-flags-design.md`

## Global Constraints

- No npm dependencies. `package.json` must stay dependency-free.
- Never store message text, only extracted items: `domain:<host>`, `url:<host><path>`, or `phone:+923XXXXXXXXX`.
- Threshold **3** distinct devices; window **90 days**; daily cap **20** rows per device per 24h; at most **3** items per report.
- Device IDs are stored only as SHA-256 hex hashes.
- Turso calls time out after **3s**. A database failure must never fail a `/api/check`; it only skips the community step.
- Env vars: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` (both `sync: false` in `render.yaml`).
- Every user-visible string has English and Urdu versions in the page's `T` table.
- Commit messages have **no** Claude/Anthropic attribution or co-author trailer.
- Work on branch `community-flags`. Pushing `main` deploys to Render.

## Review Focus

The spec doesn't mention these inputs, but each is likely to break something for a real user. Each one has a test in the task that owns the code:

1. **Urdu punctuation attached to a link:** `http://hbl-secure-verify.com۔` (Urdu full stop) or `،` should still give `domain:hbl-secure-verify.com`, not a host containing `۔`. *Task 2.*
2. **Urdu or Arabic digits in phone numbers:** `۰۳۰۰۱۲۳۴۵۶۷` should normalize to the same item as `03001234567`. *Task 2.*
3. **A domain pasted without `http`/`www`:** `hbl-secure-verify.com` on its own should be reportable. `e.g.`, `file.txt`, emails, and hosts already inside a full URL must not produce extra items. *Task 2.*
4. **Case and `www.` variants:** `HTTP://WWW.HBL-Secure-Verify.COM/x` should count as the same item as `hbl-secure-verify.com`. *Task 2.*
5. **A shortened link whose expansion fails:** `https://bit.ly/abc` must become a full-link item (`url:bit.ly/abc`), never `domain:bit.ly`, which would let three people flag every bit.ly link. *Task 2.*

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `db.js` | Create | Turso HTTP client: `enabled()`, `batch(statements)`, `query(sql, args)`, `ensureSchema()` |
| `community.js` | Create | `extractItems(text, firstExpanded?)`, `defang(item)`, `communityCount(items)`, `report(input, deviceId)`, `THRESHOLD` |
| `test_community.js` | Create | Offline tests for `db.js`, `community.js`, and the `verdict.js`/`community.js` integration |
| `link-check.js` | Modify | Server copy of the safe-site lists, `isTrusted(host)`, export `SHORTENERS` |
| `verdict.js` | Modify | Community step; `reportable` on every verdict |
| `server.js` | Modify | `POST /api/report`; `ensureSchema()` at startup |
| `test_check.js` | Modify | One assertion adjusted (verdicts are now copies) |
| `package.json` | Modify | `test` script runs both test files |
| `public/index.html` | Modify | Device ID, report controls, share, toast, strings |
| `android/app/src/main/java/com/loop/app/CheckActivity.kt` | Modify | `domStorageEnabled`, `Android.share()` bridge, sync comment |
| `render.yaml`, `README.md`, `docs/CHANGELOG.md` | Modify | Env vars, setup, changelog |

---

### Task 0: Branch

- [ ] **Step 1: Create the working branch**

```bash
cd "<repo-root>"
git checkout main && git pull --ff-only origin main
git checkout -b community-flags
```

---

### Task 1: Turso client (`db.js`)

**Files:**
- Create: `db.js`
- Create: `test_community.js`
- Modify: `package.json` (`scripts.test`)

**Interfaces:**
- Produces:
  - `db.enabled(): boolean`
  - `db.batch(statements: {sql: string, args?: (string|number)[]}[]): Promise<object[][]>`: one array of row objects (keyed by column name) per statement.
  - `db.query(sql, args?): Promise<object[]>`
  - `db.ensureSchema(): Promise<boolean>`: memoized; false if disabled or setup failed, and a failed setup is retried on the next call.
  - Integers come back as JS numbers.

- [ ] **Step 1: Write the failing tests**

Create `test_community.js`:

```js
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
```

Later tasks add tests **above** the `// ---- runner ----` line.

- [ ] **Step 2: Run the tests and check they fail**

Run: `node test_community.js`
Expected: crashes with `Cannot find module './db.js'`.

- [ ] **Step 3: Implement `db.js`**

```js
'use strict';

// Minimal Turso (libSQL) client over its HTTP pipeline API: plain fetch, no dependency.

const TIMEOUT_MS = 3000;

const SCHEMA = [
  {
    sql: `CREATE TABLE IF NOT EXISTS reports (
      item        TEXT NOT NULL,
      device_hash TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (item, device_hash)
    )`,
  },
  { sql: 'CREATE INDEX IF NOT EXISTS reports_by_device ON reports (device_hash, created_at)' },
];

function enabled() {
  return !!(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);
}

function toArg(value) {
  if (typeof value === 'number') return { type: 'integer', value: String(Math.trunc(value)) };
  return { type: 'text', value: String(value) };
}

function fromValue(v) {
  if (v.type === 'null') return null;
  if (v.type === 'integer' || v.type === 'float') return Number(v.value);
  return v.value;
}

// Runs the statements in order in one HTTP request. Returns one array of row objects per statement.
async function batch(statements) {
  if (!enabled()) throw new Error('Turso not configured');
  // Turso shows libsql:// URLs in its dashboard; the HTTP API wants https://.
  const base = process.env.TURSO_DATABASE_URL.replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');
  const res = await fetch(`${base}/v2/pipeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TURSO_AUTH_TOKEN}` },
    body: JSON.stringify({
      requests: [
        ...statements.map(({ sql, args = [] }) => ({ type: 'execute', stmt: { sql, args: args.map(toArg) } })),
        { type: 'close' },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Turso HTTP ${res.status}`);
  const data = await res.json();
  return statements.map((_, i) => {
    const r = data.results[i];
    if (!r || r.type !== 'ok') throw new Error(`Turso: ${r && r.error ? r.error.message : 'missing result'}`);
    const { cols, rows } = r.response.result;
    return rows.map((row) => Object.fromEntries(row.map((v, j) => [cols[j].name, fromValue(v)])));
  });
}

async function query(sql, args = []) {
  return (await batch([{ sql, args }]))[0];
}

let schemaReady = null;

// Memoized; a failed attempt is forgotten so the next call retries.
function ensureSchema() {
  if (!enabled()) return Promise.resolve(false);
  if (!schemaReady) {
    schemaReady = batch(SCHEMA)
      .then(() => true)
      .catch((err) => {
        console.error('Turso schema setup failed:', err.message);
        schemaReady = null;
        return false;
      });
  }
  return schemaReady;
}

module.exports = { enabled, batch, query, ensureSchema };
```

- [ ] **Step 4: Run the tests and check they pass**

Run: `node test_community.js`
Expected: 4 lines starting `PASS: db:`, exit code 0.

- [ ] **Step 5: Wire both test files into `npm test`**

In `package.json`, change `"test": "node test_check.js"` to:

```json
    "test": "node test_check.js && node test_community.js"
```

Run: `npm test`
Expected: the existing `test_check.js` PASS lines, then the 4 `db:` PASS lines.

- [ ] **Step 6: Commit**

```bash
git add db.js test_community.js package.json
git commit -m "Add dependency-free Turso client for community flags"
```

---

### Task 2: Item extraction (`link-check.js` safe-site lists, `community.js` part 1)

**Files:**
- Modify: `link-check.js` (add safe-site lists, `isTrusted`, export `SHORTENERS`)
- Modify: `android/app/src/main/java/com/loop/app/CheckActivity.kt` (comment only: point at the server copy)
- Create: `community.js`
- Test: `test_community.js`

**Interfaces:**
- Consumes: `parse(url) -> {host, path} | null` and `expandShortener(url) -> Promise<string|null>` from `link-check.js` (existing). `parse` lowercases the host, strips a leading `www.`, and returns `path` = pathname + search with trailing slashes removed (or `/`).
- Produces:
  - `linkCheck.isTrusted(host): boolean`
  - `linkCheck.SHORTENERS: Set<string>`
  - `community.extractItems(text: string, firstExpanded?: string|null): Promise<string[]>`. `firstExpanded` is an already-computed `expandShortener` result for the first URL in `text`; when it is `undefined`, `extractItems` expands the URL itself.
  - `community.defang(item: string): string`

- [ ] **Step 1: Write the failing tests**

Add to `test_community.js` above `// ---- runner ----`:

```js
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
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `node test_community.js`
Expected: crashes with `linkCheck.isTrusted is not a function` (or `Cannot find module './community.js'`).

- [ ] **Step 3: Add the safe-site lists to `link-check.js`**

After the `SHORTENERS` line, add:

```js
// Server copy of the app's safe-site list. Keep in sync with TRUSTED_HOSTS / TRUSTED_DOMAINS in
// android/app/src/main/java/com/loop/app/CheckActivity.kt.
// Exact hosts only: sibling subdomains like docs.google.com host user content.
const TRUSTED_HOSTS = new Set([
  'google.com', 'google.com.pk', 'youtube.com', 'm.youtube.com', 'youtu.be',
  'facebook.com', 'm.facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'linkedin.com',
  'daraz.pk', 'dawn.com', 'geo.tv', 'bbc.com', 'bbc.co.uk',
]);

// Any subdomain is fine: banks, government sites and Wikipedia language editions don't host phishing pages.
const TRUSTED_DOMAINS = [
  'wikipedia.org', 'hbl.com', 'meezanbank.com', 'ubl.com.pk', 'mcb.com.pk', 'bankalfalah.com',
  'jazzcash.com.pk', 'easypaisa.com.pk', 'bisp.gov.pk', 'nadra.gov.pk', 'sbp.org.pk',
];

function isTrusted(host) {
  const h = host.toLowerCase().replace(/^www\./, '');
  return TRUSTED_HOSTS.has(h) || TRUSTED_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}
```

Change the `module.exports` line to:

```js
module.exports = { isKnownBad, expandShortener, urlNotes, startFeedRefresh, addToList, parse, isTrusted, SHORTENERS, _setBadList: (l) => { badList = l; } };
```

- [ ] **Step 4: Point the Kotlin list at the server copy**

In `CheckActivity.kt`, replace the comment line:

```kotlin
        // Exact hosts only: sibling subdomains like sites.google.com or docs.google.com host
```

with:

```kotlin
        // Keep in sync with TRUSTED_HOSTS / TRUSTED_DOMAINS in link-check.js (the server copy).
        // Exact hosts only: sibling subdomains like sites.google.com or docs.google.com host
```

- [ ] **Step 5: Implement extraction in `community.js`**

```js
'use strict';

const { parse, expandShortener, isTrusted, SHORTENERS } = require('./link-check.js');

const MAX_ITEMS = 3;

// Hosts where anyone can publish: report the exact page, never the whole host.
const SHARED_HOSTS = new Set([
  'docs.google.com', 'sites.google.com', 'drive.google.com', 'script.google.com', 'forms.gle',
  'storage.googleapis.com', 'firebasestorage.googleapis.com', 'github.com', 'raw.githubusercontent.com',
  'dropbox.com', 'onedrive.live.com', '1drv.ms', 'pastebin.com', 't.me',
]);
// Click-to-chat links: the phone number inside is what matters (picked up by PHONE_RE).
const WHATSAPP_HOSTS = new Set(['wa.me', 'api.whatsapp.com']);

const URL_RE = /https?:\/\/[^\s]+|www\.[^\s]+/gi;
// Bare domains are only recognised for common scam TLDs, so "e.g." or "file.txt" never match.
const BARE_DOMAIN_RE = /(?<![@\w.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|pk|net|org|info|xyz|online|site|top|live|shop|club|vip|app|io|co|me|link|click)(?![\w.-]*\w)/gi;
// Pakistani mobile numbers: 0 / 92 / +92 / 0092, then 3xx and 7 digits, any spaces, dots or dashes between.
const PHONE_RE = /(?<!\d)(?:\+92|0092|92|0)[\s.-]*3\d{2}[\s.-]*\d{3}[\s.-]*\d{4}(?!\d)/g;

// Urdu (۰-۹) and Arabic (٠-٩) digits -> ASCII; both ranges keep the digit value in the low nibble.
function asciiDigits(text) {
  return text.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) & 0xf));
}

function trimUrl(url) {
  return url.replace(/[.,!?)\]'"۔،]+$/, '');
}

function linkItem(url) {
  const p = parse(url);
  if (!p || WHATSAPP_HOSTS.has(p.host) || isTrusted(p.host)) return null;
  if (SHARED_HOSTS.has(p.host) || SHORTENERS.has(p.host)) {
    const path = p.path.split('?')[0].replace(/\/+$/, '');
    return path ? `url:${p.host}${path}` : null;
  }
  return `domain:${p.host}`;
}

// Turns text into report items: links first (shorteners expanded), then bare domains, then phone numbers.
// firstExpanded: an expandShortener() result already computed for the first URL (undefined = compute here).
async function extractItems(text, firstExpanded) {
  const items = [];
  const add = (item) => {
    if (item && !items.includes(item) && items.length < MAX_ITEMS) items.push(item);
  };
  const clean = asciiDigits(text);

  const urls = (clean.match(URL_RE) || []).map(trimUrl).slice(0, MAX_ITEMS);
  for (let i = 0; i < urls.length; i++) {
    const expanded = i === 0 && firstExpanded !== undefined ? firstExpanded : await expandShortener(urls[i]);
    add(linkItem(expanded || urls[i]));
  }

  for (const match of clean.replace(URL_RE, ' ').matchAll(BARE_DOMAIN_RE)) add(linkItem(match[0]));

  for (const match of clean.matchAll(PHONE_RE)) add(`phone:+92${match[0].replace(/\D/g, '').slice(-10)}`);

  return items;
}

// Human-readable, non-clickable form for share messages.
function defang(item) {
  const [kind, value] = [item.slice(0, item.indexOf(':')), item.slice(item.indexOf(':') + 1)];
  if (kind === 'phone') return `0${value.slice(3, 6)}-${value.slice(6)}`;
  const slash = value.indexOf('/');
  const host = slash === -1 ? value : value.slice(0, slash);
  const rest = slash === -1 ? '' : value.slice(slash);
  return host.replace(/\./g, '[.]') + rest;
}

module.exports = { extractItems, defang };
```

- [ ] **Step 6: Run the tests and check they pass**

Run: `node test_community.js`
Expected: all `db:`, `isTrusted`, `extract:` and `defang` tests PASS.

If `extract: Pakistani mobile numbers` fails on `92300…`, check that the `92` alternative in `PHONE_RE` comes **after** `+92` and `0092`. The order matters because the regex takes the first alternative that matches.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: everything PASSES. `test_check.js` is unaffected so far.

- [ ] **Step 8: Commit**

```bash
git add link-check.js community.js test_community.js android/app/src/main/java/com/loop/app/CheckActivity.kt
git commit -m "Extract reportable links and phone numbers from checked text"
```

---

### Task 3: Recording reports and counting reporters (`community.js` part 2)

**Files:**
- Modify: `community.js`
- Test: `test_community.js`

**Interfaces:**
- Consumes:
  - `db.query`, `db.batch`, `db.ensureSchema` (Task 1). They must be called through the module object (`db.query(...)`, not destructured) so tests can swap them.
  - `extractItems` (Task 2).
- Produces:
  - `community.THRESHOLD = 3`
  - `community.communityCount(items: string[]): Promise<number>`: the highest 90-day reporter count among the items; 0 when the database is unavailable. Rejects only if a query throws.
  - `community.report(input: unknown, deviceId: unknown): Promise<{status: number, body: object}>`. Statuses: 200 `{reported, items}`, 400 `{error:'nothing to report'}`, 429 `{error:'daily report limit'}`, 503 `{error:'reports unavailable'}`. It never rejects.

- [ ] **Step 1: Write the failing tests**

Add to `test_community.js` above `// ---- runner ----`:

```js
// ---- community.js: reports and counts (fake db) ----

// In-memory stand-in for the three SQL shapes community.js uses.
function installFakeDb() {
  const saved = { batch: db.batch, query: db.query, ensureSchema: db.ensureSchema };
  const rows = [];
  db.ensureSchema = async () => true;
  db.batch = async (stmts) => stmts.map(({ sql, args = [] }) => {
    if (sql.startsWith('INSERT INTO reports')) {
      const [item, device_hash, created_at] = args;
      const existing = rows.find((r) => r.item === item && r.device_hash === device_hash);
      if (existing) existing.created_at = created_at;
      else rows.push({ item, device_hash, created_at });
      return [];
    }
    if (sql.includes('WHERE device_hash = ?')) {
      const [hash, since] = args;
      return [{ n: rows.filter((r) => r.device_hash === hash && r.created_at > since).length }];
    }
    if (sql.includes('WHERE item IN')) {
      const since = args[args.length - 1];
      const items = args.slice(0, -1);
      const counts = items
        .map((i) => rows.filter((r) => r.item === i && r.created_at > since).length)
        .filter((n) => n > 0)
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

test('report: stores items with hashed device id, returns defanged items', async () => {
  const rows = installFakeDb();
  try {
    const r = await community.report('Your HBL account is blocked: http://hbl-secure-verify.com/login call 0300-1234567', DEV(1));
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
    assert.strictEqual((await community.report('', DEV(1))).status, 400);
    assert.strictEqual((await community.report('x'.repeat(2001), DEV(1))).status, 400);
    assert.strictEqual((await community.report('http://a.xyz', 'short')).status, 400);
    assert.strictEqual((await community.report('http://a.xyz', 42)).status, 400);
    assert.strictEqual((await community.report('hello, how are you?', DEV(1))).status, 400);
    assert.strictEqual((await community.report('https://www.hbl.com', DEV(1))).status, 400, 'trusted sites cannot be reported');
    assert.strictEqual(rows.length, 0);
  } finally {
    rows.restore();
  }
});

test('count: threshold needs 3 distinct devices; same device counts once', async () => {
  const rows = installFakeDb();
  try {
    const item = ['domain:scam-one.xyz'];
    await community.report('http://scam-one.xyz', DEV(1));
    await community.report('http://scam-one.xyz', DEV(1));
    assert.strictEqual(await community.communityCount(item), 1);
    await community.report('scam-one.xyz', DEV(2));
    assert.strictEqual(await community.communityCount(item), 2);
    await community.report('http://www.SCAM-ONE.xyz/other-page', DEV(3));
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
    rows.push({ item: 'domain:old-scam.xyz', device_hash: 'a', created_at: old });
    rows.push({ item: 'domain:old-scam.xyz', device_hash: 'b', created_at: old });
    rows.push({ item: 'domain:old-scam.xyz', device_hash: 'c', created_at: Date.now() });
    assert.strictEqual(await community.communityCount(['domain:old-scam.xyz']), 1);
  } finally {
    rows.restore();
  }
});

test('count: highest count among items; empty list is 0', async () => {
  const rows = installFakeDb();
  try {
    for (const d of [1, 2]) await community.report('http://two.xyz', DEV(d));
    for (const d of [1, 2, 3, 4]) await community.report('http://four.xyz', DEV(d));
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
      assert.strictEqual((await community.report(`http://cap-${i}.xyz`, DEV(9))).status, 200);
    }
    const r = await community.report('http://cap-20.xyz', DEV(9));
    assert.strictEqual(r.status, 429);
    assert.deepStrictEqual(r.body, { error: 'daily report limit' });
    assert.strictEqual((await community.report('http://cap-20.xyz', DEV(10))).status, 200, 'other devices unaffected');
  } finally {
    rows.restore();
  }
});

test('report/count: database unavailable or failing', async () => {
  const saved = { batch: db.batch, query: db.query, ensureSchema: db.ensureSchema };
  try {
    db.ensureSchema = async () => false;
    assert.deepStrictEqual(await community.report('http://a.xyz', DEV(1)), { status: 503, body: { error: 'reports unavailable' } });
    assert.strictEqual(await community.communityCount(['domain:a.xyz']), 0);

    db.ensureSchema = async () => true;
    db.query = async () => { throw new Error('Turso HTTP 500'); };
    db.batch = async () => { throw new Error('Turso HTTP 500'); };
    assert.strictEqual((await community.report('http://a.xyz', DEV(1))).status, 503);
    await assert.rejects(community.communityCount(['domain:a.xyz']), /Turso HTTP 500/);
  } finally {
    Object.assign(db, saved);
  }
});
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `node test_community.js`
Expected: the new tests FAIL with `community.report is not a function`.

- [ ] **Step 3: Implement reports and counts**

In `community.js`, add at the top, below `'use strict';`:

```js
const crypto = require('crypto');
const db = require('./db.js');
```

Below `const MAX_ITEMS = 3;`, add:

```js
const THRESHOLD = 3;
const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_CAP = 20;

const UPSERT_SQL =
  'INSERT INTO reports (item, device_hash, created_at) VALUES (?, ?, ?) ' +
  'ON CONFLICT (item, device_hash) DO UPDATE SET created_at = excluded.created_at';
```

Above `module.exports`, add:

```js
// Highest number of distinct devices that reported any of the items in the last 90 days.
async function communityCount(items) {
  if (!items.length || !(await db.ensureSchema())) return 0;
  const rows = await db.query(
    `SELECT COUNT(*) AS n FROM reports WHERE item IN (${items.map(() => '?').join(', ')}) AND created_at > ? ` +
      'GROUP BY item ORDER BY n DESC LIMIT 1',
    [...items, Date.now() - WINDOW_MS]
  );
  return rows.length ? rows[0].n : 0;
}

const reply = (status, body) => ({ status, body });

async function report(input, deviceId) {
  if (typeof input !== 'string' || input.length < 1 || input.length > 2000) return reply(400, { error: 'nothing to report' });
  if (typeof deviceId !== 'string' || deviceId.length < 8 || deviceId.length > 100) return reply(400, { error: 'nothing to report' });
  if (!(await db.ensureSchema())) return reply(503, { error: 'reports unavailable' });

  const items = await extractItems(input);
  if (!items.length) return reply(400, { error: 'nothing to report' });

  const deviceHash = crypto.createHash('sha256').update(deviceId).digest('hex');
  const now = Date.now();
  try {
    const [{ n }] = await db.query('SELECT COUNT(*) AS n FROM reports WHERE device_hash = ? AND created_at > ?', [deviceHash, now - DAY_MS]);
    if (n >= DAILY_CAP) return reply(429, { error: 'daily report limit' });
    await db.batch(items.map((item) => ({ sql: UPSERT_SQL, args: [item, deviceHash, now] })));
  } catch (err) {
    console.error('Report failed:', err.message);
    return reply(503, { error: 'reports unavailable' });
  }
  return reply(200, { reported: items.length, items: items.map(defang) });
}
```

Change `module.exports` to:

```js
module.exports = { extractItems, defang, communityCount, report, THRESHOLD };
```

- [ ] **Step 4: Run the tests and check they pass**

Run: `node test_community.js`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add community.js test_community.js
git commit -m "Record community scam reports and count distinct reporters"
```

---

### Task 4: Wire into checks and the API (`verdict.js`, `server.js`)

**Files:**
- Modify: `verdict.js` (`getVerdict`)
- Modify: `server.js` (route and startup)
- Modify: `test_check.js` (one assertion)
- Test: `test_community.js`

**Interfaces:**
- Consumes: `community.extractItems(text, firstExpanded)`, `community.communityCount(items)`, `community.THRESHOLD`, `community.report(input, deviceId)`, `db.ensureSchema()`.
- Produces:
  - Every `getVerdict` result is a **new object**, with `reportable: boolean` added.
  - A community verdict also has `community_count: number`.
  - `POST /api/report` returns `report()`'s status and body as JSON.

- [ ] **Step 1: Write the failing tests**

Add to `test_community.js` above `// ---- runner ----`:

```js
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
    for (const d of [1, 2, 3]) await community.report('http://flagged-scam.xyz', DEV(d));
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
    for (const d of [1, 2, 3]) await community.report('0300-7654321', DEV(d));
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
    for (const d of [1, 2]) await community.report('http://almost-flagged.xyz', DEV(d));
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
      for (const d of [1, 2, 3]) await community.report(link, DEV(d));
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
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `node test_community.js`
Expected: the `verdict:` tests FAIL (no `community_count`, no `reportable`).

- [ ] **Step 3: Restructure `getVerdict` in `verdict.js`**

Add below the existing `require('./link-check.js')` line:

```js
const community = require('./community.js');
```

Add below `KNOWN_BAD_VERDICT`:

```js
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
```

Replace the head of `getVerdict`, from `async function getVerdict(input, kind) {` down to and including `if (!apiKey) return FALLBACK_VERDICT;`:

```js
async function getVerdict(input, kind) {
  if (kind === 'screenshot') return SCREENSHOT_VERDICT;

  const url = findUrl(input);
  const expanded = url ? await expandShortener(url) : null;
  if (url && ((await isKnownBad(url)) || (expanded && (await isKnownBad(expanded))))) return KNOWN_BAD_VERDICT;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return FALLBACK_VERDICT;
```

with:

```js
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
```

The rest of the old function body (from `const cacheKey = bareLinkKey(input);` to the closing `}`) stays unchanged and is now the rest of `classify`.

- [ ] **Step 4: Update the one existing assertion in `test_check.js`**

In `test_check.js` (inside `linkChecks`), replace:

```js
    assert.strictEqual(v, KNOWN_BAD_VERDICT);
```

with:

```js
    assert.strictEqual(v.reason_en, KNOWN_BAD_VERDICT.reason_en);
```

- [ ] **Step 5: Add the `/api/report` route and schema setup in `server.js`**

Add below the existing `require('./link-check.js')` line:

```js
const { report } = require('./community.js');
const db = require('./db.js');
```

Add this block immediately **before** the line `if (req.method === 'POST' && req.url === '/api/check-image') {`:

```js
  if (req.method === 'POST' && req.url === '/api/report') {
    readBody(req, 10000)
      .then(async (body) => {
        let result;
        try {
          const { input, deviceId } = JSON.parse(body) || {};
          result = await report(input, deviceId);
        } catch (err) {
          result = { status: 400, body: { error: 'nothing to report' } };
        }
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
      })
      .catch(() => {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload too large' }));
      });
    return;
  }
```

Replace:

```js
startFeedRefresh();
```

with:

```js
startFeedRefresh();
db.ensureSchema();
```

In the `server.listen` callback, after the `GEMINI_API_KEY` warning, add:

```js
  if (!db.enabled()) {
    console.log('WARNING: TURSO_DATABASE_URL / TURSO_AUTH_TOKEN not set — community reports are disabled.');
  }
```

- [ ] **Step 6: Run the tests and check they pass**

Run: `npm test`
Expected: every `test_check.js` and `test_community.js` line PASSES. The live Groq scenarios in `test_check.js` still give the same red/green verdicts.

- [ ] **Step 7: Smoke-test the route locally (database disabled)**

```bash
cd "<repo-root>"
PORT=3999 TURSO_DATABASE_URL= TURSO_AUTH_TOKEN= node server.js > "$TMPDIR/srv.log" 2>&1 &
sleep 2
curl -s -w " [%{http_code}]\n" -X POST localhost:3999/api/report -H "Content-Type: application/json" -d '{"input":"http://scam.xyz","deviceId":"device-0001"}'
curl -s -w " [%{http_code}]\n" -X POST localhost:3999/api/report -H "Content-Type: application/json" -d 'not json'
curl -s -X POST localhost:3999/api/check -H "Content-Type: application/json" -d '{"input":"hello friend"}' | grep -o '"reportable":[a-z]*'
grep -i turso "$TMPDIR/srv.log"
```

Expected:
- `{"error":"reports unavailable"} [503]`
- `{"error":"nothing to report"} [400]`
- `"reportable":false`
- The `WARNING: TURSO_DATABASE_URL ...` line in the log.

Then stop the server: in PowerShell, `Get-NetTCPConnection -LocalPort 3999 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Confirm:$false }`.

- [ ] **Step 8: Commit**

```bash
git add verdict.js server.js test_check.js test_community.js
git commit -m "Warn on community-flagged links and numbers; add /api/report"
```

---

### Task 5: Page UI and Android share bridge

**Files:**
- Modify: `public/index.html` (CSS, result-screen markup, `T` strings, `applyLang`, verdict rendering, report and share logic)
- Modify: `android/app/src/main/java/com/loop/app/CheckActivity.kt` (`domStorageEnabled`, `share` bridge)

**Interfaces:**
- Consumes: `POST /api/check` → `reportable`, `community_count`; `POST /api/report {input, deviceId}` → `{reported, items}` or an error status (Task 4).
- Produces: `window.Android.share(text: String)` (Kotlin → JS bridge).

- [ ] **Step 1: Enable page storage and add the share bridge in `CheckActivity.kt`**

After `webView.settings.mediaPlaybackRequiresUserGesture = false`, add:

```kotlin
        // localStorage keeps the anonymous device ID used for community reports.
        webView.settings.domStorageEnabled = true
```

Inside `private inner class BrowserBridge { ... }`, after `openInBrowser`, add:

```kotlin
        @JavascriptInterface
        fun share(text: String) {
            runOnUiThread {
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, text)
                }
                startActivity(Intent.createChooser(send, null))
            }
        }
```

Build:

```bash
cd "<repo-root>/android" && JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew assembleDebug -q
```

Expected: no output, and `app/build/outputs/apk/debug/app-debug.apk` has a fresh timestamp.

- [ ] **Step 2: Add the CSS**

In `public/index.html`, immediately before the `#toast {` rule, add:

```css
  .link-btn {
    background: none; border: none; color: var(--muted); text-decoration: underline;
    font-size: 0.95rem; padding: 6px; cursor: pointer; font-family: inherit;
  }
  #report-thanks { color: var(--green); text-align: center; font-weight: 600; }
```

- [ ] **Step 3: Add the result-screen markup**

Replace:

```html
    <button class="btn-secondary hidden" id="btn-continue">➡️ Continue to website anyway</button>
```

with:

```html
    <button class="btn-danger hidden" id="btn-report">🚩 Report this scam</button>
    <button class="link-btn hidden" id="btn-report-small">Think it's a scam? Report it</button>
    <div id="report-thanks" class="hidden">Thank you, you helped protect others.</div>
    <button class="btn-primary hidden" id="btn-share">📤 Warn my family</button>
    <button class="btn-secondary hidden" id="btn-continue">➡️ Continue to website anyway</button>
```

- [ ] **Step 4: Add the strings**

In `T.en`, after `loading: 'Checking...', continueBtn: '➡️ Continue to website anyway',`, add:

```js
    report: '🚩 Report this scam', reportSmall: "Think it's a scam? Report it",
    reportThanks: 'Thank you, you helped protect others.', share: '📤 Warn my family',
    reportLimit: "You've sent a lot of reports, thank you. Please try again later.",
    reportFailed: "Couldn't send your report, please try again later.",
    copied: 'Warning copied — paste it in your family group.',
    shareMsg: (items) => `⚠️ Loop scam warning: don't open / call ${items}. Never share your OTP or PIN.`,
```

In `T.ur`, after `loading: 'جانچ کی جا رہی ہے...', continueBtn: '➡️ پھر بھی ویب سائٹ پر جائیں',`, add:

```js
    report: '🚩 اس فراڈ کی رپورٹ کریں', reportSmall: 'فراڈ لگتا ہے؟ رپورٹ کریں',
    reportThanks: 'شکریہ، آپ نے دوسروں کو بچانے میں مدد کی۔', share: '📤 گھر والوں کو خبردار کریں',
    reportLimit: 'آپ نے بہت سی رپورٹس بھیجی ہیں، شکریہ۔ براہ کرم بعد میں کوشش کریں۔',
    reportFailed: 'آپ کی رپورٹ نہیں بھیجی جا سکی، براہ کرم بعد میں کوشش کریں۔',
    copied: 'وارننگ کاپی ہو گئی — اپنے فیملی گروپ میں پیسٹ کریں۔',
    shareMsg: (items) => `⚠️ لوپ وارننگ: ${items} نہ کھولیں / کال نہ کریں۔ اپنا OTP یا PIN کبھی شیئر نہ کریں۔`,
```

In `applyLang()`, after `$('btn-continue').textContent = t.continueBtn;`, add:

```js
  $('btn-report').textContent = t.report;
  $('btn-report-small').textContent = t.reportSmall;
  $('report-thanks').textContent = t.reportThanks;
  $('btn-share').textContent = t.share;
```

- [ ] **Step 5: Track report state and render the controls**

Replace:

```js
let lastVerdict = null;
let viaIntercept = false;
let lastLink = null;
```

with:

```js
let lastVerdict = null;
let viaIntercept = false;
let lastLink = null;
let lastInput = null;     // text of the last message check, sent with a report
let reportedItems = null; // defanged items once the current verdict has been reported

// Anonymous ID so the server can count distinct reporters. Storage can be blocked, so fall back
// to an ID for this session only.
let deviceId = null;
function getDeviceId() {
  if (deviceId) return deviceId;
  try { deviceId = localStorage.getItem('loop_device_id'); } catch (e) { /* storage blocked */ }
  if (!deviceId) {
    deviceId = window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try { localStorage.setItem('loop_device_id', deviceId); } catch (e) { /* session-only ID */ }
  }
  return deviceId;
}

let toastTimer = null;
function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

function updateReportControls() {
  const v = lastVerdict;
  const canReport = !!(v && v.reportable) && !reportedItems;
  $('btn-report').classList.toggle('hidden', !canReport || v.verdict === 'green');
  $('btn-report-small').classList.toggle('hidden', !canReport || v.verdict !== 'green');
  $('report-thanks').classList.toggle('hidden', !reportedItems);
  $('btn-share').classList.toggle('hidden', !reportedItems);
}

// A verdict from a new check (not a language re-render) resets the report state.
function showNewVerdict(v) {
  reportedItems = null;
  renderVerdict(v);
}
```

In `renderVerdict(v)`, after `$('btn-continue').classList.toggle('hidden', !viaIntercept);`, add:

```js
  updateReportControls();
```

- [ ] **Step 6: Route new verdicts through `showNewVerdict` and remember the input**

Replace **all three** occurrences of:

```js
    const v = await res.json();
    renderVerdict(v);
```

with:

```js
    const v = await res.json();
    showNewVerdict(v);
```

Then in `check(kind)`, replace:

```js
  if (kind === 'message') lastLink = input;
```

with:

```js
  if (kind === 'message') lastLink = input;
  lastInput = kind === 'screenshot' ? null : input;
```

The `lang-toggle` handler keeps calling `renderVerdict(lastVerdict)`. That's deliberate: switching language must not reset a report that was already sent.

- [ ] **Step 7: Add report and share actions**

Immediately before the line `$('btn-back').addEventListener('click', ...`, add:

```js
async function sendReport() {
  if (!lastInput) return;
  try {
    const res = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: lastInput, deviceId: getDeviceId() }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && Array.isArray(data.items)) {
      reportedItems = data.items;
      updateReportControls();
      return;
    }
    showToast(res.status === 429 ? T[lang].reportLimit : T[lang].reportFailed);
  } catch (e) {
    showToast(T[lang].reportFailed);
  }
}

async function shareWarning() {
  if (!reportedItems) return;
  const items = reportedItems.join(', ');
  const text = `${T.en.shareMsg(items)}\n\n${T.ur.shareMsg(items)}`;
  if (window.Android && window.Android.share) {
    window.Android.share(text);
    return;
  }
  if (navigator.share) {
    try { await navigator.share({ text }); } catch (e) { /* user cancelled */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast(T[lang].copied);
  } catch (e) {
    showToast(T[lang].reportFailed);
  }
}

$('btn-report').addEventListener('click', sendReport);
$('btn-report-small').addEventListener('click', sendReport);
$('btn-share').addEventListener('click', shareWarning);
```

- [ ] **Step 8: Check the page in a desktop browser against a local server**

Start the server with the real Turso credentials from `.env`:

```bash
cd "<repo-root>" && PORT=3999 node server.js
```

The owner needs to add `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` to the local `.env` for this step. Without them, expect the 503 path (red toast) instead of the success path.

Open `http://localhost:3999`, paste `Your HBL account is blocked http://loop-selftest-1.xyz/login call 0300-0000001`, and press **Check it**. Expected:
1. A red/yellow verdict shows the **🚩 Report this scam** button. The small green-verdict link is hidden.
2. Clicking it hides the button and shows the green **Thank you…** text plus **📤 Warn my family**.
3. **Warn my family** in desktop Chrome copies the text, and a toast shows "Warning copied…". The pasted text contains `loop-selftest-1[.]xyz, 0300-0000001` in both languages.
4. Toggling **اردو** keeps the thank-you state and shows Urdu labels.
5. Checking `salam, kal milte hain` shows **no** report controls.
6. Checking `https://www.hbl.com` shows **no** report controls.

Stop the server afterwards.

- [ ] **Step 9: Commit**

```bash
git add public/index.html android/app/src/main/java/com/loop/app/CheckActivity.kt
git commit -m "Add one-tap scam reporting and warn-my-family sharing"
```

---

### Task 6: Config, docs, deploy, live verification

**Files:**
- Modify: `render.yaml`, `README.md`, `docs/CHANGELOG.md`

- [ ] **Step 1: Declare the env vars in `render.yaml`**

Append under `envVars:`:

```yaml
      - key: TURSO_DATABASE_URL
        sync: false
      - key: TURSO_AUTH_TOKEN
        sync: false
```

- [ ] **Step 2: Document setup in `README.md`**

In the `.env` code block, after `SAFE_BROWSING_API_KEY=...   # optional`, add:

```
TURSO_DATABASE_URL=https://<db>-<user>.turso.io   # community reports; optional
TURSO_AUTH_TOKEN=...
```

In the file list, after the `gemini.js` bullet, add:

```markdown
- `community.js`, `db.js` — community scam reports. Users report a link or Pakistani mobile number with one tap; once 3 different devices report the same item within 90 days, everyone who checks it gets a red "N Loop users reported this" verdict. Stored in Turso (hosted SQLite) over its HTTP API; only the extracted item and a hash of an anonymous device ID are kept, never message text. Known-safe sites can't be reported.
```

- [ ] **Step 3: Add a changelog entry**

At the top of `docs/CHANGELOG.md`, under `# Changelog`, add a `## <date> — Community flags` section. Summarize:
- What a report stores.
- The 3-device / 90-day rule.
- The safe-site protection.
- The warn-my-family share with defanged links.
- The Turso setup.
- The verification results from Steps 6–8 below, filled in with what actually happened.

- [ ] **Step 4: Run the full suite one last time**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit, merge, push (deploys)**

```bash
git add render.yaml README.md docs/CHANGELOG.md
git commit -m "Document community reports and Turso setup"
git checkout main
git merge --ff-only community-flags
git push origin main
git branch -d community-flags
```

- [ ] **Step 6: Live verification on Render (about 3 minutes after the push)**

```bash
U=https://loop-2chr.onrender.com
for d in selftest-device-0001 selftest-device-0002 selftest-device-0003; do
  curl -s -w " [%{http_code}]\n" -X POST $U/api/report -H "Content-Type: application/json" \
    -d "{\"input\":\"http://loop-selftest-1.xyz/login call 0300-0000001\",\"deviceId\":\"$d\"}"
done
curl -s -X POST $U/api/check -H "Content-Type: application/json" -d '{"input":"http://loop-selftest-1.xyz/other"}'
curl -s -X POST $U/api/check -H "Content-Type: application/json" -d '{"input":"Call 0300 0000001 now"}'
```

Expected:
- Three `{"reported":2,"items":["loop-selftest-1[.]xyz","0300-0000001"]} [200]` lines.
- Both checks return `"verdict":"red"`, `"reason_en":"3 Loop users reported this as a scam."` and `"community_count":3`.

If the reports return 503, check the Render logs for `Turso` errors. Likely causes: a wrong `TURSO_DATABASE_URL` form or an expired token.

- [ ] **Step 7: Delete the self-test rows**

Using the local `.env` Turso credentials:

```bash
cd "<repo-root>" && node -e "
require('./load-env.js');
const db = require('./db.js');
db.query(\"DELETE FROM reports WHERE item IN ('domain:loop-selftest-1.xyz', 'phone:+923000000001')\")
  .then(() => db.query(\"SELECT COUNT(*) AS n FROM reports WHERE item IN ('domain:loop-selftest-1.xyz', 'phone:+923000000001')\"))
  .then((r) => console.log('remaining self-test rows:', r[0].n));
"
```

Expected: `remaining self-test rows: 0`.

If Turso isn't in the local `.env`, run the same `DELETE` in the Turso dashboard's SQL shell instead.

- [ ] **Step 8: Phone verification (Realme RMX3830 over adb)**

```bash
ADB=~/AppData/Local/Android/Sdk/platform-tools/adb.exe
cd "<repo-root>/android" && $ADB install -r app/build/outputs/apk/debug/app-debug.apk
$ADB shell am start -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d "http://loop-selftest-2.xyz/login"
```

Expected on the phone, confirmed with `adb exec-out screencap -p` screenshots:
1. The verdict screen shows **🚩 Report this scam** (or the small link if green).
2. Tapping it (`adb shell input tap` at the button, or by hand) shows the thank-you text and **📤 Warn my family**.
3. Tapping **Warn my family** opens the Android share sheet with the text containing `loop-selftest-2[.]xyz`.

Afterwards, delete `domain:loop-selftest-2.xyz` the same way as Step 7.
