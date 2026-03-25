const http = require('http');
const { Pool } = require('pg');
const webpush = require('web-push');

// --- Config ---
const BASE = 'https://ec.2ndstreetusa.com';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MINUTES || '10') * 60 * 1000;
const PORT = process.env.PORT || 3000;

const required = ['DATABASE_URL', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_EMAIL'];
for (const key of required) {
  if (!process.env[key]) { console.error(`${key} is required`); process.exit(1); }
}

webpush.setVapidDetails(
  `mailto:${process.env.VAPID_EMAIL}`,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- DB ---
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seen_products (
      product_id BIGINT PRIMARY KEY,
      first_seen_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      endpoint TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

async function getSeenIds() {
  const { rows } = await pool.query('SELECT product_id FROM seen_products');
  return new Set(rows.map(r => String(r.product_id)));
}

async function markSeen(products) {
  if (!products.length) return;
  const placeholders = products.map((_, i) => `($${i + 1})`).join(', ');
  await pool.query(
    `INSERT INTO seen_products (product_id) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
    products.map(p => p.id)
  );
}

async function getSubscriptions() {
  const { rows } = await pool.query('SELECT endpoint, data FROM subscriptions');
  return rows;
}

async function removeSubscription(endpoint) {
  await pool.query('DELETE FROM subscriptions WHERE endpoint = $1', [endpoint]);
}

// --- Fetch ---
async function fetchProducts() {
  const products = [];
  let page = 1;
  while (true) {
    const res = await fetch(`${BASE}/collections/rick-raf/products.json?limit=250&page=${page}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { products: batch = [] } = await res.json();
    if (!batch.length) break;
    products.push(...batch.filter(p => p.vendor?.toLowerCase().includes('rick owens')));
    if (batch.length < 250) break;
    page++;
  }
  return products;
}

// --- Formatting ---
function formatTitle(product) {
  const parts = product.title.split('/');
  return parts.length > 2 ? parts.slice(1).join(' · ') : product.title;
}

function getPrice(product) {
  const prices = (product.variants || []).map(v => parseFloat(v.price)).filter(p => !isNaN(p));
  if (!prices.length) return null;
  const min = Math.min(...prices);
  return min % 1 === 0 ? `$${min}` : `$${min.toFixed(2)}`;
}

function extractStore(product) {
  const tag = (product.tags || []).find(t => t.toLowerCase().startsWith('2nd street '));
  return tag ? tag.slice('2nd street '.length).trim() : '';
}

// --- Push ---
async function pushToAll(payload) {
  const subs = await getSubscriptions();
  if (!subs.length) return;

  const results = await Promise.allSettled(
    subs.map(row => webpush.sendNotification(row.data, JSON.stringify(payload)))
  );

  // Remove subscriptions that are gone (410 Gone, 404 Not Found)
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected' && [404, 410].includes(r.reason?.statusCode)) {
      await removeSubscription(subs[i].endpoint);
    }
  }
}

// --- Poll ---
async function poll() {
  if (process.env.ENABLED === 'false') {
    console.log(`[${new Date().toISOString()}] Skipping — ENABLED=false`);
    return;
  }

  console.log(`[${new Date().toISOString()}] Polling...`);

  try {
    const [products, seenIds] = await Promise.all([fetchProducts(), getSeenIds()]);
    const newProducts = products.filter(p => !seenIds.has(String(p.id)));

    console.log(`  ${products.length} products, ${newProducts.length} new`);

    for (const product of newProducts) {
      const price = getPrice(product);
      const store = extractStore(product);
      const img = product.images?.[0]?.src;

      try {
        await pushToAll({
          title: formatTitle(product).slice(0, 100),
          body: [product.vendor, price, store].filter(Boolean).join(' — '),
          icon: img ? `${img}&width=192` : undefined,
          url: `${BASE}/products/${product.handle}`,
        });
        console.log(`  Pushed: ${product.title.split('/').slice(0, 3).join('/')}`);
      } catch (err) {
        console.error(`  Push failed for ${product.id}:`, err.message);
      }
    }

    if (newProducts.length) await markSeen(newProducts);
  } catch (err) {
    console.error(`  Poll failed:`, err.message);
  }
}

// --- HTTP server ---
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const json = (code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  try {
    if (req.method === 'GET' && req.url === '/vapid-public-key') {
      return json(200, { key: process.env.VAPID_PUBLIC_KEY });
    }

    if (req.method === 'POST' && req.url === '/subscribe') {
      const sub = JSON.parse(await readBody(req));
      await pool.query(
        `INSERT INTO subscriptions (endpoint, data) VALUES ($1, $2)
         ON CONFLICT (endpoint) DO UPDATE SET data = $2`,
        [sub.endpoint, JSON.stringify(sub)]
      );
      return json(201, { ok: true });
    }

    if (req.method === 'POST' && req.url === '/unsubscribe') {
      const { endpoint } = JSON.parse(await readBody(req));
      await removeSubscription(endpoint);
      return json(200, { ok: true });
    }

    if (req.method === 'GET' && req.url === '/') {
      const { rows } = await pool.query('SELECT COUNT(*) FROM subscriptions');
      return json(200, {
        status: 'running',
        enabled: process.env.ENABLED !== 'false',
        subscribers: parseInt(rows[0].count),
        interval_minutes: parseInt(process.env.POLL_INTERVAL_MINUTES || '10'),
      });
    }

    res.writeHead(404); res.end();
  } catch (err) {
    console.error('Request error:', err.message);
    json(500, { error: err.message });
  }
});

// --- Start ---
async function main() {
  await init();
  server.listen(PORT, () => console.log(`HTTP server on :${PORT}`));

  console.log('ibuyrick-notifier started');
  console.log(`  Interval: ${process.env.POLL_INTERVAL_MINUTES || 10} minutes`);
  console.log(`  Enabled:  ${process.env.ENABLED !== 'false'}`);

  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
