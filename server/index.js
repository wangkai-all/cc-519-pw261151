'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const { openDb, query, getRow, run, tx, resetDb } = require('./lib/db');
const { todayIso, addDays } = require('./lib/dates');
const inv = require('./domain/inventory');
const ingest = require('./domain/ingest');
const strategy = require('./domain/strategy');
const plans = require('./domain/plans');
const { seed } = require('./domain/seed');

const WEB_ROOT = path.join(__dirname, '..', 'web');
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'inventory.db');
const SEED = process.env.SEED !== '0';

let db;

function getDb() {
  if (!db) {
    db = openDb(DB_FILE);
    if (SEED) {
      const n = getRow(db, 'SELECT COUNT(*) AS n FROM skus');
      if (n.n === 0) seed(db);
    }
  }
  return db;
}

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

function qNum(url, key, fallback) {
  const v = url.searchParams.get(key);
  if (v == null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, `${key} 必须是数字`);
  return n;
}

function qStr(url, key) {
  const v = url.searchParams.get(key);
  return v == null || v === '' ? null : v;
}

/* ------------------------------- routes -------------------------------- */

const routes = [];
function route(method, pattern, handler) {
  const parts = pattern.split('/').filter(Boolean);
  routes.push({ method, parts, handler });
}

function match(method, pathname) {
  const segs = pathname.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== method) continue;
    if (r.parts.length !== segs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < r.parts.length; i += 1) {
      const p = r.parts[i];
      if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(segs[i]);
      else if (p !== segs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

/* metadata */
route('GET', '/api/health', () => ({ ok: true, db: DB_FILE, seeded: SEED }));

route('GET', '/api/meta', () => {
  const d = getDb();
  return {
    as_of: todayIso(),
    calibers: inv.CALIBERS.map((c) => ({ id: c, label: inv.CALIBER_LABELS[c] })),
    warehouses: query(d, 'SELECT * FROM warehouses ORDER BY id'),
    categories: query(d, 'SELECT DISTINCT category FROM skus ORDER BY category').map((r) => r.category),
    strategies: query(d, 'SELECT * FROM strategies ORDER BY version DESC').map((s) => ({
      ...s,
      params: JSON.parse(s.params),
    })),
    active_strategy: strategy.activeStrategy(d),
    actions: Object.entries(strategy.ACTION_META).map(([id, m]) => ({ id, ...m })),
    demo_as_of: getRow(d, "SELECT MAX(business_date) AS d FROM movements").d,
  };
});

/* stock */
route('GET', '/api/stock/batches', (req, url) => {
  const d = getDb();
  const asOf = qStr(url, 'as_of') || todayIso();
  const caliber = qStr(url, 'caliber') || 'available';
  const rows = inv.batchStock(d, { asOf, caliber });
  const filtered = rows
    .filter((r) => !qStr(url, 'warehouse_id') || r.warehouse_id === qStr(url, 'warehouse_id'))
    .filter((r) => !qStr(url, 'sku_id') || r.sku_id === qStr(url, 'sku_id'))
    .filter((r) => !qStr(url, 'category') || r.category === qStr(url, 'category'));
  return {
    as_of: asOf,
    caliber,
    caliber_label: inv.CALIBER_LABELS[caliber],
    batches: filtered,
    totals: {
      physical: inv.round(filtered.reduce((s, r) => s + r.physical_qty, 0)),
      good: inv.round(filtered.reduce((s, r) => s + r.good_qty, 0)),
      available: inv.round(filtered.reduce((s, r) => s + r.available_qty, 0)),
      sellable: inv.round(filtered.reduce((s, r) => s + r.sellable_qty, 0)),
      value: inv.round(filtered.reduce((s, r) => s + r.stock_value, 0), 2),
    },
  };
});

route('GET', '/api/stock/warehouses', (req, url) => {
  const d = getDb();
  const asOf = qStr(url, 'as_of') || todayIso();
  const caliber = qStr(url, 'caliber') || 'available';
  return {
    as_of: asOf,
    caliber,
    rows: inv.warehouseStock(d, { asOf, caliber }),
  };
});

route('GET', '/api/stock/timeline', (req, url) => {
  const d = getDb();
  const asOf = qStr(url, 'as_of') || todayIso();
  return inv.stockTimeline(d, {
    asOf,
    from: qStr(url, 'from'),
    to: qStr(url, 'to') || asOf,
    skuId: qStr(url, 'sku_id'),
    warehouseId: qStr(url, 'warehouse_id'),
    batchId: qStr(url, 'batch_id'),
  });
});

route('GET', '/api/stock/late-sales', (req, url) => {
  const d = getDb();
  const asOf = qStr(url, 'as_of') || todayIso();
  const cutoff = qNum(url, 'cutoff_days', ingest.LATE_CUTOFF_DAYS);
  const rows = inv.lateSales(d, { asOf, cutoffDays: cutoff });
  const detail = rows.map((r) => {
    const applied = query(
      d,
      `SELECT m.id, m.batch_id, m.qty, m.business_date, m.late, m.external_ref, b.batch_no
         FROM movements m JOIN batches b ON b.id = m.batch_id
        WHERE m.type = 'SALE' AND m.meta LIKE ?
        ORDER BY m.business_date`,
      `%"sale_id":"${r.sale_id}"%`,
    );
    const deducted = inv.round(applied.reduce((s, m) => s + Math.abs(m.qty), 0));
    return {
      ...r,
      movements: applied,
      deducted_qty: deducted,
      // Every late sale that moved stock must resolve to exactly one ledger row
      // per batch. A sale with zero allocation never created a row - that is an
      // unfilled sale, not a duplication risk.
      single_application: applied.length > 0 || r.allocated_qty === 0,
      unfulfilled: r.allocated_qty === 0,
    };
  });
  return { as_of: asOf, cutoff_days: cutoff, sales: detail };
});

/* ingestion */
route('POST', '/api/inbound', async (req) => {
  const d = getDb();
  const body = await readBody(req);
  const items = Array.isArray(body) ? body : body.items || [body];
  const results = items.map((it) => {
    try {
      return ingest.receiveInbound(d, it, body.actor || 'api');
    } catch (e) {
      return { status: 'error', external_ref: it.external_ref, error: e.message };
    }
  });
  return { results };
});

route('POST', '/api/sales', async (req, url) => {
  const d = getDb();
  const body = await readBody(req);
  const items = Array.isArray(body) ? body : body.items || [body];
  const results = items.map((it) => {
    try {
      return ingest.receiveSale(d, it, body.actor || 'api');
    } catch (e) {
      return { status: 'error', sale_id: it.sale_id, error: e.message };
    }
  });
  return { results };
});

route('POST', '/api/returns', async (req) => {
  const d = getDb();
  const body = await readBody(req);
  const items = Array.isArray(body) ? body : body.items || [body];
  const results = items.map((it) => {
    try {
      return ingest.receiveReturn(d, it, body.actor || 'api');
    } catch (e) {
      return { status: 'error', external_ref: it.external_ref, error: e.message };
    }
  });
  return { results };
});

route('POST', '/api/transfers/inbound', async (req) => {
  const d = getDb();
  const body = await readBody(req);
  const items = Array.isArray(body) ? body : body.items || [body];
  const results = items.map((it) => {
    try {
      return ingest.receiveTransferIn(d, it, body.actor || 'api');
    } catch (e) {
      return { status: 'error', external_ref: it.external_ref, error: e.message };
    }
  });
  return { results };
});

route('GET', '/api/ingestion-log', (req, url) => {
  const d = getDb();
  return {
    entries: query(d, 'SELECT * FROM ingestion_log ORDER BY id DESC LIMIT ?', qNum(url, 'limit', 100)),
  };
});

/* strategies */
route('GET', '/api/strategies', () => {
  const d = getDb();
  return {
    strategies: query(d, 'SELECT * FROM strategies ORDER BY version DESC').map((s) => ({
      ...s,
      params: JSON.parse(s.params),
    })),
    migrations: query(d, 'SELECT * FROM strategy_migrations ORDER BY id DESC LIMIT 20').map((m) => ({
      ...m,
      summary: JSON.parse(m.summary),
    })),
    defaults: strategy.DEFAULT_PARAMS,
    action_meta: strategy.ACTION_META,
  };
});

route('POST', '/api/strategies', async (req) => {
  const d = getDb();
  const body = await readBody(req);
  return strategy.createStrategy(d, { name: body.name, params: body.params, actor: body.actor });
});

route('PATCH', '/api/strategies/:id', async (req, url, params) => {
  const d = getDb();
  const body = await readBody(req);
  return strategy.updateStrategyParams(d, params.id, body.params, body.actor);
});

route('GET', '/api/strategies/:id/compare', (req, url, params) => {
  const d = getDb();
  const asOf = qStr(url, 'as_of') || todayIso();
  return strategy.compareStrategies(d, qStr(url, 'from') || strategy.activeStrategy(d)?.id, params.id, asOf);
});

route('POST', '/api/strategies/:id/activate', async (req, url, params) => {
  const d = getDb();
  const body = await readBody(req);
  return strategy.activateStrategy(d, params.id, {
    asOf: body.as_of || qStr(url, 'as_of') || todayIso(),
    actor: body.actor || 'planner',
    confirm: body.confirm === true,
    migrationAcknowledged: body.migration_acknowledged === true,
  });
});

route('GET', '/api/analysis', (req, url) => {
  const d = getDb();
  const asOf = qStr(url, 'as_of') || todayIso();
  const strategyId = qStr(url, 'strategy_id');
  const s = strategyId ? strategy.getStrategy(d, strategyId) : strategy.activeStrategy(d);
  return strategy.evaluate(d, {
    strategy: s,
    asOf,
    warehouseId: qStr(url, 'warehouse_id'),
    skuId: qStr(url, 'sku_id'),
    category: qStr(url, 'category'),
    caliber: qStr(url, 'caliber'),
  });
});

route('GET', '/api/analysis/compare', (req, url) => {
  const d = getDb();
  const to = qStr(url, 'to');
  if (!to) throw new HttpError(400, 'to 策略必填');
  return strategy.compareStrategies(
    d,
    qStr(url, 'from') || strategy.activeStrategy(d)?.id,
    to,
    qStr(url, 'as_of') || todayIso(),
  );
});

/* plans */
route('GET', '/api/plans', (req, url) => {
  const d = getDb();
  return {
    plans: plans.listPlans(d, {
      status: qStr(url, 'status'),
      batchId: qStr(url, 'batch_id'),
      warehouseId: qStr(url, 'warehouse_id'),
      skuId: qStr(url, 'sku_id'),
      limit: qNum(url, 'limit', 200),
    }),
  };
});

route('POST', '/api/plans', async (req) => {
  const d = getDb();
  const body = await readBody(req);
  return plans.createPlan(d, body, body.actor || 'planner');
});

route('POST', '/api/plans/bulk', async (req) => {
  const d = getDb();
  const body = await readBody(req);
  const items = body.items || [];
  const created = [];
  const errors = [];
  for (const it of items) {
    try {
      created.push(plans.createPlan(d, { ...it, strategy_id: body.strategy_id }, body.actor || 'planner'));
    } catch (e) {
      errors.push({ item: it, error: e.message });
    }
  }
  return { created, errors };
});

route('GET', '/api/plans/:id', (req, url, params) => {
  const d = getDb();
  const p = plans.getPlan(d, params.id);
  if (!p) throw new HttpError(404, 'plan not found');
  return p;
});

route('POST', '/api/plans/:id/approve', async (req, url, params) => {
  const d = getDb();
  const body = await readBody(req);
  return plans.approvePlan(d, params.id, {
    actor: body.actor || 'approver',
    decision: body.decision || 'approve',
    note: body.note,
  });
});

route('POST', '/api/plans/:id/cancel', async (req, url, params) => {
  const d = getDb();
  const body = await readBody(req);
  return plans.cancelPlan(d, params.id, { actor: body.actor || 'planner' });
});

/* tasks */
route('GET', '/api/tasks', (req, url) => {
  const d = getDb();
  return {
    tasks: plans.listTasks(d, {
      status: qStr(url, 'status'),
      planId: qStr(url, 'plan_id'),
      limit: qNum(url, 'limit', 200),
    }),
  };
});

route('GET', '/api/tasks/:id', (req, url, params) => {
  const d = getDb();
  const t = plans.getTask(d, params.id);
  if (!t) throw new HttpError(404, 'task not found');
  return t;
});

route('POST', '/api/tasks/:id/revise', async (req, url, params) => {
  const d = getDb();
  const body = await readBody(req);
  return plans.reviseTask(d, params.id, body, body.actor || 'planner');
});

route('POST', '/api/tasks/:id/execute', async (req, url, params) => {
  const d = getDb();
  const body = await readBody(req);
  return plans.executeTask(d, params.id, {
    actor: body.actor || 'operator',
    asOf: body.as_of || todayIso(),
    version: body.version,
    confirm: body.confirm === true,
  });
});

route('POST', '/api/tasks/:id/rollback', async (req, url, params) => {
  const d = getDb();
  const body = await readBody(req);
  return plans.rollbackTask(d, params.id, {
    actor: body.actor || 'operator',
    asOf: body.as_of || todayIso(),
    version: body.version,
    reason: body.reason,
    confirm: body.confirm === true,
  });
});

/* audit + admin */
route('GET', '/api/audit', (req, url) => {
  const d = getDb();
  return {
    entries: query(d, 'SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', qNum(url, 'limit', 100)),
  };
});

route('POST', '/api/admin/reset', async (req) => {
  const d = getDb();
  const body = await readBody(req);
  if (body.confirm !== 'RESET') throw new HttpError(400, '需要 confirm="RESET"');
  resetDb(d);
  if (body.seed !== false) seed(d);
  return { ok: true };
});

/* ------------------------------- server -------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(WEB_ROOT, rel);
  if (!target.startsWith(WEB_ROOT + path.sep) && target !== WEB_ROOT) {
    send(res, 403, { error: 'forbidden' });
    return;
  }
  fs.readFile(target, (err, buf) => {
    if (err) {
      send(res, 404, { error: 'not found' });
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(target)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(buf);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (!url.pathname.startsWith('/api/')) {
      serveStatic(req, res, url.pathname);
      return;
    }
    const found = match(req.method, url.pathname);
    if (!found) {
      send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
      return;
    }
    try {
      const body = await found.handler(req, url, found.params);
      send(res, 200, body);
    } catch (err) {
      const status = err.statusCode || err.status || 500;
      if (status >= 500) console.error(err);
      send(res, status, { error: err.message, ...(err.extra || {}) });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 5178);
  getDb();
  const server = createServer();
  server.listen(port, () => {
    console.log(`inventory-dashboard listening on http://localhost:${port}`);
    console.log(`db: ${DB_FILE}`);
  });
}

module.exports = { createServer, getDb, routes, match };
