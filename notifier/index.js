const { Pool } = require('pg');

const BASE = 'https://ec.2ndstreetusa.com';
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MINUTES || '10') * 60 * 1000;

if (!NTFY_TOPIC) { console.error('NTFY_TOPIC is required'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seen_products (
      product_id BIGINT PRIMARY KEY,
      first_seen_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

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

function formatTitle(product) {
  // title is slash-delimited: "Brand/Category/Size/Material/Color/Description"
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

async function notify(product) {
  const price = getPrice(product);
  const store = extractStore(product);
  const url = `${BASE}/products/${product.handle}`;
  const img = product.images?.[0]?.src;

  const headers = {
    'Title': formatTitle(product).slice(0, 250),
    'Priority': 'default',
    'Click': url,
    'Tags': 'shopping',
  };
  if (img) headers['Attach'] = `${img}&width=600`;

  const body = [product.vendor, price, store].filter(Boolean).join(' — ');

  const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: 'POST',
    headers,
    body,
  });

  if (!res.ok) {
    throw new Error(`ntfy ${res.status}: ${await res.text()}`);
  }
}

async function poll() {
  if (process.env.ENABLED === 'false') {
    console.log(`[${new Date().toISOString()}] Skipping — ENABLED=false`);
    return;
  }

  console.log(`[${new Date().toISOString()}] Polling...`);

  try {
    const [products, seenIds] = await Promise.all([fetchProducts(), getSeenIds()]);
    const newProducts = products.filter(p => !seenIds.has(String(p.id)));

    console.log(`  ${products.length} products fetched, ${newProducts.length} new`);

    for (const product of newProducts) {
      try {
        await notify(product);
        console.log(`  Notified: ${product.title.split('/').slice(0, 3).join('/')}`);
      } catch (err) {
        console.error(`  Notify failed for ${product.id}:`, err.message);
      }
    }

    if (newProducts.length) {
      await markSeen(newProducts);
    }
  } catch (err) {
    console.error(`  Poll failed:`, err.message);
  }
}

async function main() {
  await init();
  console.log(`ibuyrick-notifier started`);
  console.log(`  Topic:    ${NTFY_TOPIC}`);
  console.log(`  Interval: ${process.env.POLL_INTERVAL_MINUTES || 10} minutes`);
  console.log(`  Enabled:  ${process.env.ENABLED !== 'false'}`);

  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
