'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const AS_OF = '2026-11-20';

let server;
let base;
let dbFile;

async function req(pathname, opts = {}) {
  const res = await fetch(base + pathname, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

test('http api', async (t) => {
  dbFile = path.join(os.tmpdir(), `inv-e2e-${Date.now()}.db`);
  const port = 5400 + Math.floor(Math.random() * 300);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_FILE: dbFile,
      SEED_AS_OF: AS_OF,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('server start timeout')), 10000);
    server.stdout.on('data', (d) => {
      if (String(d).includes('listening')) {
        clearTimeout(to);
        resolve();
      }
    });
    server.stderr.on('data', (d) => process.stderr.write(d));
  });

  t.after(() => {
    server?.kill();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbFile + suffix);
      } catch {
        /* ignore */
      }
    }
  });

  await t.test('serves the dashboard shell', async () => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /库存呆滞分析/);
    assert.match(html, /app\.js/);
  });

  await t.test('meta exposes calibers, warehouses and the active strategy', async () => {
    const { status, data } = await req('/api/meta');
    assert.equal(status, 200);
    assert.deepEqual(
      data.calibers.map((c) => c.id),
      ['physical', 'good', 'available', 'sellable'],
    );
    assert.ok(data.active_strategy.id);
    assert.ok(data.warehouses.length >= 3);
  });

  await t.test('pending sale is idempotent over HTTP', async () => {
    const payload = {
      sale_id: 'HTTP-DUP-1',
      sku_id: 'sku_milk',
      warehouse_id: 'wh_sh',
      qty: 7,
      business_date: AS_OF,
    };
    const a = await req('/api/sales', { method: 'POST', body: payload });
    assert.equal(a.status, 200);
    assert.equal(a.data.results[0].status, 'applied');
    const b = await req('/api/sales', { method: 'POST', body: payload });
    assert.equal(b.data.results[0].status, 'duplicate');
  });

  await t.test('approve → execute → rollback a transfer through the API', async () => {
    const analysis = await req(`/api/analysis?as_of=${AS_OF}`);
    const cand = analysis.data.candidates.find((c) => c.suggested_action === 'transfer');
    assert.ok(cand, 'seed yields a transfer candidate');

    const plan = await req('/api/plans', {
      method: 'POST',
      body: {
        batch_id: cand.batch_id,
        action: 'transfer',
        qty: 10,
        to_warehouse: cand.transfer_target.warehouse_id,
      },
    });
    assert.equal(plan.status, 200);
    assert.equal(plan.data.status, 'pending_approval');

    const approved = await req(`/api/plans/${plan.data.id}/approve`, {
      method: 'POST',
      body: { actor: 'manager' },
    });
    assert.equal(approved.data.status, 'approved');
    const task = approved.data.tasks[0];
    assert.equal(task.current_version, 1);

    const before = await req(`/api/stock/warehouses?as_of=${AS_OF}&caliber=physical`);
    const snap = (rows) =>
      rows
        .filter((r) => r.sku_id === cand.sku_id)
        .map((r) => [r.warehouse_id, r.quantity])
        .sort();

    const exec = await req(`/api/tasks/${task.id}/execute`, {
      method: 'POST',
      body: { confirm: true, as_of: AS_OF },
    });
    assert.equal(exec.status, 200);
    assert.equal(exec.data.status, 'executed');

    const mid = await req(`/api/stock/warehouses?as_of=${AS_OF}&caliber=physical`);
    assert.notDeepEqual(snap(mid.data.rows), snap(before.data.rows));

    const rb = await req(`/api/tasks/${task.id}/rollback`, {
      method: 'POST',
      body: { confirm: true, as_of: AS_OF },
    });
    assert.equal(rb.status, 200);
    assert.equal(rb.data.status, 'rolled_back');

    const after = await req(`/api/stock/warehouses?as_of=${AS_OF}&caliber=physical`);
    assert.deepEqual(snap(after.data.rows), snap(before.data.rows));
  });

  await t.test('strategy activation needs explicit acknowledgement', async () => {
    const bare = await req('/api/strategies/stg_aggressive_v1/activate', {
      method: 'POST',
      body: { as_of: AS_OF, confirm: true },
    });
    assert.equal(bare.status, 409);
    assert.match(bare.data.error, /migration_acknowledged/);

    const ok = await req('/api/strategies/stg_aggressive_v1/activate', {
      method: 'POST',
      body: { as_of: AS_OF, confirm: true, migration_acknowledged: true },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.status, 'activated');
    assert.equal(ok.data.strategy.status, 'active');
  });

  await t.test('late-sales report links each sale to a single ledger entry', async () => {
    const { data } = await req(`/api/stock/late-sales?as_of=${AS_OF}`);
    assert.ok(data.sales.length > 0);
    const filled = data.sales.filter((s) => !s.unfulfilled);
    assert.ok(filled.length > 0, 'at least one late sale deducted stock');
    for (const s of filled) {
      assert.equal(s.single_application, true);
      assert.ok(s.movements.length > 0);
      for (const m of s.movements) assert.equal(m.late, 1);
    }
  });

  await t.test('static path traversal is rejected', async () => {
    const res = await fetch(base + '/../server/index.js');
    assert.ok([403, 404].includes(res.status));
  });
});
