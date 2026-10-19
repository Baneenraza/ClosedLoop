'use strict';

// Fast, AI-free link checks: known-bad lists, shortener expansion, and URL heuristics.

const FEEDS = [
  'https://openphish.com/feed.txt',
  'https://urlhaus.abuse.ch/downloads/text_online/',
];
const FEED_REFRESH_MS = 60 * 60 * 1000;

// Official domains for brands scammers impersonate in Pakistan. A host that mentions the
// brand but isn't on its official domain is a classic lookalike.
const BRANDS = {
  hbl: ['hbl.com', 'hblpsl.com'],
  meezan: ['meezanbank.com'],
  ubl: ['ubl.com.pk', 'ubldigital.com'],
  mcb: ['mcb.com.pk'],
  alfalah: ['bankalfalah.com'],
  jazzcash: ['jazzcash.com.pk'],
  easypaisa: ['easypaisa.com.pk'],
  bisp: ['bisp.gov.pk'],
  nadra: ['nadra.gov.pk'],
  sbp: ['sbp.org.pk'],
  daraz: ['daraz.pk', 'daraz.com'],
  paypal: ['paypal.com'],
  whatsapp: ['whatsapp.com', 'whatsapp.net'],
};

const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'cutt.ly', 'rb.gy', 'ow.ly', 'shorturl.at', 'tiny.cc', 't.ly', 's.id', 'rebrand.ly', 'lnkd.in', 'bit.do']);

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

// host -> list of path prefixes. An empty-path entry ('/') flags the whole host.
let badList = new Map();

function parse(url) {
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(url) ? url : `http://${url}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    const path = (u.pathname + u.search).replace(/\/+$/, '') || '/';
    return { host, path };
  } catch {
    return null;
  }
}

function addToList(list, url) {
  const p = parse(url.trim());
  if (!p) return;
  if (!list.has(p.host)) list.set(p.host, []);
  list.get(p.host).push(p.path);
}

async function refreshFeeds() {
  const next = new Map();
  for (const feed of FEEDS) {
    try {
      const res = await fetch(feed, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const line of (await res.text()).split('\n')) {
        // Only real URLs: a rate-limited feed can answer 200 with an HTML error page.
        if (/^https?:\/\//i.test(line)) addToList(next, line.trim());
      }
    } catch (err) {
      console.error(`Feed ${feed} failed: ${err.message}`);
    }
  }
  // Keep the previous list if every feed failed, rather than silently going blind.
  if (next.size) badList = next;
  console.log(`Known-bad link list: ${badList.size} hosts`);
}

function inBadList(url) {
  const p = parse(url);
  if (!p) return false;
  const paths = badList.get(p.host);
  return !!paths && paths.some((prefix) => prefix === '/' || p.path === prefix || p.path.startsWith(prefix + '/') || p.path.startsWith(prefix + '?'));
}

async function inSafeBrowsing(url) {
  const key = process.env.SAFE_BROWSING_API_KEY;
  if (!key) return false;
  try {
    const res = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client: { clientId: 'loop', clientVersion: '1.0' },
        threatInfo: {
          threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'],
          platformTypes: ['ANY_PLATFORM'],
          threatEntryTypes: ['URL'],
          threatEntries: [{ url }],
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return !!(data.matches && data.matches.length);
  } catch (err) {
    console.error('Safe Browsing check failed:', err.message);
    return false;
  }
}

async function isKnownBad(url) {
  return inBadList(url) || (await inSafeBrowsing(url));
}

// Follows redirects only while the host is a known shortener, so the server never
// requests arbitrary (possibly internal) addresses on a scammer's behalf.
async function expandShortener(url) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const p = parse(current);
    if (!p || !SHORTENERS.has(p.host)) break;
    try {
      const res = await fetch(/^https?:\/\//i.test(current) ? current : `https://${current}`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });
      const next = res.headers.get('location');
      if (!next) break;
      current = new URL(next, current).href;
    } catch {
      break;
    }
  }
  return current === url ? null : current;
}

// Very rough registrable domain: handles two-level country suffixes like .com.pk.
function baseDomain(host) {
  const labels = host.split('.');
  const n = /^(com|gov|org|net|edu)$/.test(labels[labels.length - 2]) && labels[labels.length - 1].length === 2 ? 3 : 2;
  return labels.slice(-n).join('.');
}

function lookalikeBrand(host) {
  const base = baseDomain(host);
  const tokens = host.split(/[.-]/);
  for (const [brand, official] of Object.entries(BRANDS)) {
    if (official.includes(base)) continue;
    const mentions = brand.length >= 5 ? tokens.some((t) => t.includes(brand)) : tokens.includes(brand);
    if (mentions) return brand;
  }
  return null;
}

function urlNotes(url) {
  const p = parse(url);
  if (!p) return [];
  const notes = [];
  if (!/^https:\/\//i.test(url)) notes.push('not using https');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(p.host)) notes.push('raw IP address instead of a domain name');
  if (/(secure|verify|update|login|account)[.-]/i.test(p.host) || /-(secure|verify|update|login)/i.test(p.host)) {
    notes.push('domain uses trust words like "secure/verify/login" which scammers add to look official');
  }
  if (SHORTENERS.has(p.host)) notes.push('shortened link hides the real destination');
  if (p.host.split('.').some((l) => l.startsWith('xn--'))) {
    notes.push('domain uses look-alike foreign characters (punycode) to imitate a real site');
  }
  const brand = lookalikeBrand(p.host);
  if (brand) notes.push(`domain mentions "${brand}" but is NOT its official website — likely an impersonation`);
  return notes;
}

function startFeedRefresh() {
  refreshFeeds();
  setInterval(refreshFeeds, FEED_REFRESH_MS).unref();
}

module.exports = { isKnownBad, expandShortener, urlNotes, startFeedRefresh, addToList, parse, isTrusted, SHORTENERS, _setBadList: (l) => { badList = l; } };
