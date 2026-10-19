'use strict';

// Minimal Turso (libSQL) client over its HTTP pipeline API: plain fetch, no dependency.

const TIMEOUT_MS = 3000;

const SCHEMA = [
  {
    sql: `CREATE TABLE IF NOT EXISTS reports (
      item        TEXT NOT NULL,
      device_hash TEXT NOT NULL,
      net_hash    TEXT NOT NULL DEFAULT '',
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
