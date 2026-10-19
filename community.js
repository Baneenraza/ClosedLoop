'use strict';

const crypto = require('crypto');
const db = require('./db.js');

const { parse, expandShortener, isTrusted, SHORTENERS } = require('./link-check.js');

const MAX_ITEMS = 3;
const THRESHOLD = 3;
const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_CAP = 20;

// A warning also needs reports from at least this many networks, so one person inventing
// device IDs on one connection can't flag a site or phone number alone.
const MIN_NETWORKS = 2;

const UPSERT_SQL =
  'INSERT INTO reports (item, device_hash, net_hash, created_at) VALUES (?, ?, ?, ?) ' +
  'ON CONFLICT (item, device_hash) DO UPDATE SET net_hash = excluded.net_hash, created_at = excluded.created_at';

// Hosts where anyone can publish: report the exact page, never the whole host.
const SHARED_HOSTS = new Set([
  'docs.google.com', 'sites.google.com', 'drive.google.com', 'script.google.com', 'forms.gle',
  'storage.googleapis.com', 'firebasestorage.googleapis.com', 'github.com', 'raw.githubusercontent.com',
  'dropbox.com', 'onedrive.live.com', '1drv.ms', 'pastebin.com', 't.me',
  'chat.whatsapp.com', 'play.google.com', 'apps.apple.com', 'linktr.ee', 'web.facebook.com', 'm.me',
]);
// Shared hosts whose pages differ only by a query parameter: keep that parameter in the item.
const SHARED_QUERY = { 'play.google.com': 'id' };
// Never flaggable, even though the app doesn't open them without a check.
const NEVER_FLAG_HOSTS = new Set(['whatsapp.com', 'web.whatsapp.com', 'mail.google.com', 'apple.com']);
const NEVER_FLAG_DOMAINS = ['gov.pk'];
// Redirect wrappers: only the destination inside them is reported.
const REDIRECT_HOSTS = new Set(['l.facebook.com', 'lm.facebook.com', 'l.instagram.com']);
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
  return url.replace(/[.,!?)\]'"۔،؟]+$/, '');
}

function neverFlag(host) {
  return NEVER_FLAG_HOSTS.has(host) || NEVER_FLAG_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
}

function linkItem(url) {
  const p = parse(url);
  if (!p || WHATSAPP_HOSTS.has(p.host) || REDIRECT_HOSTS.has(p.host) || isTrusted(p.host) || neverFlag(p.host)) return null;
  if (SHARED_HOSTS.has(p.host) || SHORTENERS.has(p.host)) {
    const [pathname, search = ''] = p.path.split('?');
    const path = pathname.replace(/\/+$/, '');
    if (!path) return null;
    const key = SHARED_QUERY[p.host];
    if (!key) return `url:${p.host}${path}`;
    const value = new URLSearchParams(search).get(key);
    return value ? `url:${p.host}${path}?${key}=${value}` : null;
  }
  return `domain:${p.host}`;
}

// URLs carried in the query string, e.g. google.com/url?q=https://... or l.facebook.com/l.php?u=...
function embeddedUrls(url) {
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(url) ? url : `http://${url}`);
    return [...u.searchParams.values()].filter((v) => /^https?:\/\//i.test(v));
  } catch {
    return [];
  }
}

// IPv4 /24 or IPv6 /64, so reporters behind one connection count as one network.
function networkOf(ip) {
  if (typeof ip !== 'string' || !ip) return 'unknown';
  const v4 = ip.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}`;
  return ip.toLowerCase().split(':').slice(0, 4).join(':');
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
    const target = expanded || urls[i];
    add(linkItem(target));
    for (const inner of embeddedUrls(target)) add(linkItem(inner));
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

// Highest number of distinct devices that reported any of the items in the last 90 days.
async function communityCount(items) {
  if (!items.length || !(await db.ensureSchema())) return 0;
  const rows = await db.query(
    `SELECT COUNT(*) AS n FROM reports WHERE item IN (${items.map(() => '?').join(', ')}) AND created_at > ? ` +
      `GROUP BY item HAVING COUNT(DISTINCT net_hash) >= ${MIN_NETWORKS} ORDER BY n DESC LIMIT 1`,
    [...items, Date.now() - WINDOW_MS]
  );
  return rows.length ? rows[0].n : 0;
}

const reply = (status, body) => ({ status, body });

async function report(input, deviceId, ip) {
  if (typeof input !== 'string' || input.length < 1 || input.length > 2000) return reply(400, { error: 'nothing to report' });
  if (typeof deviceId !== 'string' || deviceId.length < 8 || deviceId.length > 100) return reply(400, { error: 'nothing to report' });
  if (!(await db.ensureSchema())) return reply(503, { error: 'reports unavailable' });

  const items = await extractItems(input);
  if (!items.length) return reply(400, { error: 'nothing to report' });

  const deviceHash = crypto.createHash('sha256').update(deviceId).digest('hex');
  const netHash = crypto.createHash('sha256').update(networkOf(ip)).digest('hex');
  const now = Date.now();
  try {
    const [{ n }] = await db.query('SELECT COUNT(*) AS n FROM reports WHERE device_hash = ? AND created_at > ?', [deviceHash, now - DAY_MS]);
    if (n >= DAILY_CAP) return reply(429, { error: 'daily report limit' });
    await db.batch(items.map((item) => ({ sql: UPSERT_SQL, args: [item, deviceHash, netHash, now] })));
  } catch (err) {
    console.error('Report failed:', err.message);
    return reply(503, { error: 'reports unavailable' });
  }
  return reply(200, { reported: items.length, items: items.map(defang) });
}

module.exports = { extractItems, defang, communityCount, report, THRESHOLD };
