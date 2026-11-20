'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { openDb } = require('../server/lib/db');
const { addDays } = require('../server/lib/dates');
const { seed } = require('../server/domain/seed');
const inv = require('../server/domain/inventory');
const ingest = require('../server/domain/ingest');
const strategy = require('../server/domain/strategy');
const plans = require('../server/domain/plans');

const AS_OF = '2026-11-20';

function fresh() {
  const db = openDb(':memory:');
  seed(db, { asOf: AS_OF });
  return db;
}

function batchByNo(db, no, wh) {
  return inv
    .batchStock(db, { asOf: AS_OF, caliber: 'physical' })
    .find((b) => b.batch_no === no && (!wh || b.warehouse_id === wh));
}

/* ------------------------------ inventory ------------------------------ */

test('availability calibers are monotonic: physical >= good >= available >= sellable', () => {
  const db = fresh();
  const phys = inv.batchStock(db, { asOf: AS_OF, caliber: 'physical' });
  for (const row of phys) {
    assert.ok(row.physical_qty >= row.good_qty, `${row.batch_no} physical>=good`);
    assert.ok(row.good_qty >= row.available_qty, `${row.batch_no} good>=available`);
    assert.ok(row.available_qty >= row.sellable_qty, `${row.batch_no} available>=sellable`);
  }
});

test('expired and quality-hold batches have zero available but keep physical stock', () => {
  const db = fresh();
  const expired = batchByNo(db, 'JAX-2409-GZ');
  assert.equal(expired.expired, true);
  assert.ok(expired.physical_qty > 0);
  assert.equal(expired.available_qty, 0);

  const damaged = batchByNo(db, 'J-2411-DMG');
  assert.equal(damaged.quality_hold, true);
  assert.ok(damaged.physical_qty > 0);
  assert.equal(damaged.good_qty, 0);
  assert.equal(damaged.available_qty, 0);
});

test('reservations reduce available but not physical', () => {
  const db = fresh();
  const b = batchByNo(db, 'M-2411-B');
  assert.equal(b.physical_qty, 200);
  assert.equal(b.reserved_qty, 20);
  assert.equal(b.available_qty, 180);
});

test('sellable caliber removes safety stock from the freshest batch first', () => {
  const db = fresh();
  const rows = inv
    .batchStock(db, { asOf: AS_OF, caliber: 'sellable' })
    .filter((r) => r.warehouse_id === 'wh_sh' && r.sku_id === 'sku_milk' && !r.expired);
  const totalAvailable = rows.reduce((s, r) => s + r.available_qty, 0);
  const totalSellable = rows.reduce((s, r) => s + r.sellable_qty, 0);
  assert.ok(totalSellable < totalAvailable, 'safety stock is carved out');
  const newest = rows.slice().sort((a, b) => (a.expiry_date < b.expiry_date ? 1 : -1))[0];
  assert.ok(newest.sellable_qty < newest.available_qty, 'newest batch carries the buffer');
});

test('timeline replays the ledger and ends at current on-hand', () => {
  const db = fresh();
  const stock = batchByNo(db, 'M-2411-A');
  const line = inv.stockTimeline(db, {
    asOf: AS_OF,
    from: addDays(AS_OF, -30),
    to: AS_OF,
    batchId: stock.batch_id,
  });
  const last = line.points[line.points.length - 1];
  assert.equal(last.physical, stock.physical_qty);
  const first = line.points[0];
  assert.ok(first.physical <= last.physical, 'stock starts at/below its inbound level');
});

test('timeline carries opening balance from before the window and flips to at-risk at expiry', () => {
  const db = fresh();
  const stock = batchByNo(db, 'M-2411-A');
  // Window opens after inbound, so the opening point must already hold stock.
  const line = inv.stockTimeline(db, {
    asOf: AS_OF,
    from: addDays(stock.inbound_date, 2),
    to: addDays(stock.expiry_date, 2),
    batchId: stock.batch_id,
  });
  assert.ok(line.points[0].physical > 0, 'opening balance is not zero');
  const expiryDay = line.points.find((p) => p.date === addDays(stock.expiry_date, 1));
  assert.ok(expiryDay, 'timeline covers the day after expiry');
  assert.equal(expiryDay.available, 0, 'expired stock is not available');
  assert.equal(expiryDay.at_risk, expiryDay.physical, 'expired units move into at-risk');
});

/* ----------------------------- late sales ------------------------------ */

test('a sale replayed with the same sale_id is idempotent and never double-deducts', () => {
  const db = fresh();
  const totalOnHand = () =>
    inv
      .batchStock(db, { asOf: AS_OF, caliber: 'physical' })
      .filter((b) => b.warehouse_id === 'wh_sh' && b.sku_id === 'sku_milk')
      .reduce((s, b) => s + b.physical_qty, 0);
  const before = totalOnHand();
  const payload = {
    sale_id: 'S-REPLAY-1',
    sku_id: 'sku_milk',
    warehouse_id: 'wh_sh',
    qty: 15,
    business_date: addDays(AS_OF, -3),
    late: true,
  };
  const first = ingest.receiveSale(db, payload);
  assert.equal(first.status, 'applied_late');
  const afterFirst = totalOnHand();
  assert.equal(afterFirst, before - 15);

  for (let i = 0; i < 3; i += 1) {
    const again = ingest.receiveSale(db, payload);
    assert.equal(again.status, 'duplicate');
  }
  assert.equal(totalOnHand(), afterFirst, 'no further deduction');
});

test('sales allocation will not consume reserved units', () => {
  const db = fresh();
  const b = batchByNo(db, 'M-2411-B');
  assert.equal(b.reserved_qty, 20);
  // Batch has 200 physical, 20 reserved -> 180 sellable for a new sale.
  const res = ingest.receiveSale(db, {
    sale_id: 'S-RESERVE-1',
    sku_id: 'sku_milk',
    warehouse_id: 'wh_sh',
    qty: 500,
    business_date: AS_OF,
    allow_substitute: false,
  });
  const takenFromB = res.movements
    .filter((m) => m.includes(b.batch_id))
    .length;
  assert.ok(takenFromB > 0, 'the batch was drawn from');
  const after = batchByNo(db, 'M-2411-B');
  assert.ok(after.physical_qty >= 20, 'the reserved 20 units stay on the shelf');
  assert.ok(after.available_qty >= 0);
});

test('a late sale posts exactly one movement per allocated batch', () => {
  const db = fresh();
  const res = ingest.receiveSale(db, {
    sale_id: 'S-LATE-ONCE',
    sku_id: 'sku_juice',
    warehouse_id: 'wh_sh',
    qty: 20,
    business_date: addDays(AS_OF, -5),
    late: true,
    allow_substitute: false,
  });
  const rows = ingest
    .batchAvailableAt; // keep reference explicit
  const movements = db
    .prepare('SELECT * FROM movements WHERE meta LIKE ?')
    .all('%"sale_id":"S-LATE-ONCE"%');
  assert.equal(movements.length, res.movements.length);
  const total = movements.reduce((s, m) => s + m.qty, 0);
  assert.equal(total, -20);
  assert.ok(movements.every((m) => m.late === 1));
  assert.ok(movements.every((m) => m.business_date === addDays(AS_OF, -5)));
});

test('a late sale cannot consume units written off after its business date', () => {
  const db = fresh();
  // Dispose the entire expired batch on the as-of date...
  const expired = batchByNo(db, 'JAX-2409-GZ');
  const plan = plans.createPlan(db, { batch_id: expired.batch_id, action: 'dispose', qty: expired.physical_qty });
  const approved = plans.approvePlan(db, plan.id, { actor: 'qa' });
  const task = approved.tasks[0];
  plans.executeTask(db, task.id, { confirm: true, asOf: AS_OF });

  // ...then a sale backdated to before the write-off must not claim those units.
  const res = ingest.receiveSale(db, {
    sale_id: 'S-BACKDATED-EXPIRED',
    sku_id: 'sku_juice_alt',
    warehouse_id: 'wh_gz',
    qty: 5,
    business_date: addDays(AS_OF, -10),
    allow_substitute: false,
  });
  assert.equal(res.allocated_qty, 0, 'allocation skips the disposed batch');
  assert.equal(res.short_qty, 5);
  assert.equal(batchByNo(db, 'JAX-2409-GZ').physical_qty, 0, 'write-off is not resurrected');
});

test('late sales appear in the late-sales report with their applied movements', () => {
  const db = fresh();
  const rows = inv.lateSales(db, { asOf: AS_OF });
  assert.ok(rows.length >= 2);
  for (const r of rows) {
    assert.ok(r.lag_days > 1);
  }
});

/* ------------------------------ ingestion ------------------------------ */

test('duplicate inbound external_ref is rejected without changing stock', () => {
  const db = fresh();
  const before = batchByNo(db, 'S-2409-A').physical_qty;
  const payload = {
    external_ref: 'IN-0001',
    sku_id: 'sku_snack',
    warehouse_id: 'wh_sh',
    batch_no: 'S-2409-A',
    qty: 500,
    business_date: addDays(AS_OF, -150),
  };
  const res = ingest.receiveInbound(db, payload);
  assert.equal(res.status, 'duplicate');
  assert.equal(batchByNo(db, 'S-2409-A').physical_qty, before);
});

test('a good return goes back to the original batch; a damaged return is quarantined', () => {
  const db = fresh();
  const returnedBatch = db
    .prepare("SELECT m.batch_id, b.batch_no FROM movements m JOIN batches b ON b.id = m.batch_id WHERE m.meta LIKE '%\"sale_id\":\"S-0002\"%' LIMIT 1")
    .get();
  assert.ok(returnedBatch, 'sale S-0002 allocated a batch');
  const goodBefore = batchByNo(db, returnedBatch.batch_no).physical_qty;

  const res = ingest.receiveReturn(db, {
    external_ref: 'RTN-T1',
    sale_id: 'S-0002',
    sku_id: 'sku_milk',
    warehouse_id: 'wh_sh',
    qty: 4,
    condition: 'good',
    business_date: AS_OF,
  });
  assert.equal(res.batch_id, returnedBatch.batch_id, 'good returns reuse the sold batch');
  assert.equal(batchByNo(db, returnedBatch.batch_no).physical_qty, goodBefore + 4);

  const damaged = ingest.receiveReturn(db, {
    external_ref: 'RTN-T2',
    sale_id: 'S-0007',
    sku_id: 'sku_yogurt',
    warehouse_id: 'wh_gz',
    qty: 2,
    condition: 'damaged',
    business_date: AS_OF,
  });
  const damagedRow = db
    .prepare('SELECT * FROM batches WHERE id = ?')
    .get(damaged.batch_id);
  assert.ok(damagedRow, 'damaged return materialised a batch');
  const stock = inv
    .batchStock(db, { asOf: AS_OF, caliber: 'physical' })
    .find((b) => b.batch_id === damaged.batch_id);
  assert.equal(stock.quality_hold, true);
  assert.equal(stock.available_qty, 0);
});

test('sales fall back to substitutes in the same group and record the short', () => {
  const db = fresh();
  const res = ingest.receiveSale(db, {
    sale_id: 'S-SUB-TEST',
    sku_id: 'sku_juice',
    warehouse_id: 'wh_cd',
    qty: 500,
    business_date: AS_OF,
    allow_substitute: true,
  });
  assert.ok(res.substitute, 'a substitute was used');
  assert.equal(res.substitute.sku_id, 'sku_juice_alt');
  assert.ok(res.short_qty >= 0);
  assert.equal(round(res.allocated_qty + res.short_qty), 500);
});

function round(n) {
  return Math.round(n * 100) / 100;
}

/* ------------------------------ strategies ----------------------------- */

test('the active strategy is unique and seed provides two versions', () => {
  const db = fresh();
  const active = db.prepare("SELECT COUNT(*) AS n FROM strategies WHERE status='active'").get();
  assert.equal(active.n, 1);
  const all = db.prepare('SELECT COUNT(*) AS n FROM strategies').get();
  assert.equal(all.n, 2);
});

test('strategy comparison reports list migration and stockout impact', () => {
  const db = fresh();
  const cmp = strategy.compareStrategies(db, 'stg_conservative_v1', 'stg_aggressive_v1', AS_OF);
  assert.ok(cmp.migration.summary.added + cmp.migration.summary.removed + cmp.migration.summary.changed > 0);
  assert.equal(cmp.migration.requires_acknowledgement, true);
  assert.ok(Array.isArray(cmp.stockout_impact.at_risk));
  // The aggressive strategy disposes near-expiry stock, so any shortfall it
  // projects must reference a real batch and a positive gap.
  for (const r of cmp.stockout_impact.at_risk) {
    assert.ok(r.projected_shortfall > 0);
    assert.ok(r.warehouse_id && r.sku_code);
  }
});

test('activation requires an explicit migration acknowledgement when lists change', () => {
  const db = fresh();
  assert.throws(
    () =>
      strategy.activateStrategy(db, 'stg_aggressive_v1', {
        asOf: AS_OF,
        confirm: true,
        migrationAcknowledged: false,
      }),
    /migration_acknowledged/,
  );
  const res = strategy.activateStrategy(db, 'stg_aggressive_v1', {
    asOf: AS_OF,
    confirm: true,
    migrationAcknowledged: true,
  });
  assert.equal(res.status, 'activated');
  const active = strategy.activeStrategy(db);
  assert.equal(active.id, 'stg_aggressive_v1');
  const mig = db.prepare('SELECT * FROM strategy_migrations ORDER BY id DESC LIMIT 1').get();
  assert.equal(mig.to_strategy, 'stg_aggressive_v1');
  assert.ok(JSON.parse(mig.summary).migration);
});

test('activation is blocked without confirmation and returns a preview', () => {
  const db = fresh();
  const res = strategy.activateStrategy(db, 'stg_aggressive_v1', { asOf: AS_OF });
  assert.equal(res.status, 'preview_required');
  assert.ok(res.preview.migration);
  assert.equal(strategy.activeStrategy(db).id, 'stg_conservative_v1');
});

/* -------------------------------- plans -------------------------------- */

function approveAndGetTask(db, plan) {
  const approved = plans.approvePlan(db, plan.id, { actor: 'approver' });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.tasks.length, 1);
  return approved.tasks[0];
}

test('disposal executes against physical stock and reduces on-hand', () => {
  const db = fresh();
  const b = batchByNo(db, 'JAX-2409-GZ');
  const plan = plans.createPlan(db, { batch_id: b.batch_id, action: 'dispose', qty: b.physical_qty });
  const task = approveAndGetTask(db, plan);
  assert.equal(task.kind, 'DISPOSAL');
  const out = plans.executeTask(db, task.id, { confirm: true, asOf: AS_OF });
  assert.equal(out.status, 'executed');
  assert.equal(batchByNo(db, 'JAX-2409-GZ').physical_qty, 0);
});

test('transfer moves quantity between warehouses atomically and rolls back exactly', () => {
  const db = fresh();
  const src = batchByNo(db, 'J-2410-A');
  const snapshot = () =>
    inv
      .warehouseStock(db, { asOf: AS_OF, caliber: 'physical' })
      .filter((w) => w.sku_id === 'sku_juice')
      .map((w) => [w.warehouse_id, w.quantity])
      .sort();
  const before = snapshot();
  const plan = plans.createPlan(db, {
    batch_id: src.batch_id,
    action: 'transfer',
    qty: 60,
    to_warehouse: 'wh_gz',
  });
  const task = approveAndGetTask(db, plan);
  plans.executeTask(db, task.id, { confirm: true, asOf: AS_OF });
  const after = snapshot();
  const whShBefore = before.find((x) => x[0] === 'wh_sh')[1];
  const whShAfter = after.find((x) => x[0] === 'wh_sh')[1];
  const whGzBefore = before.find((x) => x[0] === 'wh_gz')[1];
  const whGzAfter = after.find((x) => x[0] === 'wh_gz')[1];
  assert.equal(whShAfter, whShBefore - 60);
  assert.equal(whGzAfter, whGzBefore + 60);

  plans.rollbackTask(db, task.id, { confirm: true, asOf: AS_OF });
  assert.deepEqual(snapshot(), before, 'rollback restores the exact pre-task state');
});

test('revision supersedes the previous version and keeps history', () => {
  const db = fresh();
  const b = batchByNo(db, 'S-2409-A');
  const plan = plans.createPlan(db, { batch_id: b.batch_id, action: 'dispose', qty: 20 });
  const task = approveAndGetTask(db, plan);
  const revised = plans.reviseTask(db, task.id, { qty: 35, reason: '复称' });
  assert.equal(revised.current_version, 2);
  assert.equal(revised.versions.length, 2);
  assert.equal(revised.versions[0].status, 'superseded');
  assert.equal(revised.versions[1].status, 'ready');
  assert.equal(revised.versions[1].payload.qty, 35);

  // Executing the superseded version is refused.
  assert.throws(() => plans.executeTask(db, task.id, { version: 1, confirm: true }), /已被新版本替代/);
  const before = batchByNo(db, 'S-2409-A').physical_qty;
  plans.executeTask(db, task.id, { version: 2, confirm: true, asOf: AS_OF });
  assert.equal(batchByNo(db, 'S-2409-A').physical_qty, before - 35, 'only the revised qty is written off');
});

test('an executed task cannot be revised and must be rolled back first', () => {
  const db = fresh();
  const b = batchByNo(db, 'S-2409-GZ');
  const plan = plans.createPlan(db, { batch_id: b.batch_id, action: 'dispose', qty: 10 });
  const task = approveAndGetTask(db, plan);
  plans.executeTask(db, task.id, { confirm: true, asOf: AS_OF });
  assert.throws(() => plans.reviseTask(db, task.id, { qty: 12 }), /先回滚/);
});

test('disposal rollback of expired stock is blocked, but a documented force works', () => {
  const db = fresh();
  const b = batchByNo(db, 'JAX-2409-GZ');
  const plan = plans.createPlan(db, { batch_id: b.batch_id, action: 'dispose', qty: b.physical_qty });
  const task = approveAndGetTask(db, plan);
  plans.executeTask(db, task.id, { confirm: true, asOf: AS_OF });

  assert.throws(() => plans.rollbackTask(db, task.id, { confirm: true, asOf: AS_OF }), /已过期/);
  const forced = plans.rollbackTask(db, task.id, {
    confirm: true,
    asOf: AS_OF,
    force: true,
    reason: '质量复检后撤销报废',
  });
  assert.equal(forced.status, 'rolled_back');
  assert.equal(forced.task.versions[0].result.forced, true);
  assert.deepEqual(forced.task.versions[0].result.waived_blockers.length, 1);
  assert.equal(batchByNo(db, 'JAX-2409-GZ').physical_qty, b.physical_qty, 'stock restored');
});

test('transfer over availability is rejected at planning time', () => {
  const db = fresh();
  const b = batchByNo(db, 'M-2411-A');
  assert.throws(
    () =>
      plans.createPlan(db, {
        batch_id: b.batch_id,
        action: 'transfer',
        qty: b.available_qty + 100,
        to_warehouse: 'wh_cd',
      }),
    /超过可用量|可用量不足/,
  );
});

test('a transfer task cannot be executed twice', () => {
  const db = fresh();
  const b = batchByNo(db, 'J-2410-A');
  const plan = plans.createPlan(db, { batch_id: b.batch_id, action: 'transfer', qty: 10, to_warehouse: 'wh_gz' });
  const task = approveAndGetTask(db, plan);
  plans.executeTask(db, task.id, { confirm: true, asOf: AS_OF });
  assert.throws(() => plans.executeTask(db, task.id, { confirm: true, asOf: AS_OF }), /已执行/);
});

/* ------------------------------ analysis ------------------------------- */

test('every candidate explains itself with at least one cause and an action', () => {
  const db = fresh();
  const res = strategy.evaluate(db, { strategy: strategy.activeStrategy(db), asOf: AS_OF });
  assert.ok(res.candidates.length > 0);
  for (const c of res.candidates) {
    assert.ok(c.causes.length > 0, `${c.batch_no} has causes`);
    assert.ok(c.risk_score >= 0 && c.risk_score <= 100);
    assert.ok(c.alternatives.length > 0);
    assert.ok(['dispose', 'discount', 'transfer', 'substitute', 'keep', 'return_to_supplier'].includes(c.suggested_action));
  }
});

test('expired stock is only ever proposed for disposal, never transfer', () => {
  const db = fresh();
  const res = strategy.evaluate(db, { strategy: strategy.activeStrategy(db), asOf: AS_OF });
  for (const c of res.candidates.filter((x) => x.expired)) {
    assert.equal(c.suggested_action, 'dispose', `${c.batch_no} must be disposed`);
    assert.equal(c.transfer_target, null);
  }
});

test('caliber override changes the quantity basis but not the batch identity', () => {
  const db = fresh();
  const s = strategy.activeStrategy(db);
  const avail = strategy.evaluate(db, { strategy: s, asOf: AS_OF, caliber: 'available' });
  const sellable = strategy.evaluate(db, { strategy: s, asOf: AS_OF, caliber: 'sellable' });
  assert.notEqual(avail.summary.qty, sellable.summary.qty);
  const ids = new Set(avail.candidates.map((c) => c.batch_id));
  for (const c of sellable.candidates) assert.ok(ids.has(c.batch_id));
});

/* ------------------------------ validation ----------------------------- */

test('ingest rejects a missing business_date instead of posting a malformed row', () => {
  const db = fresh();
  const before = inv.batchStock(db, { asOf: AS_OF, caliber: 'physical' });
  assert.throws(
    () => ingest.receiveInbound(db, { external_ref: 'V-1', sku_id: 'sku_milk', warehouse_id: 'wh_sh', qty: 1 }),
    /business_date is required/,
  );
  assert.throws(
    () => ingest.receiveSale(db, { sale_id: 'V-2', sku_id: 'sku_milk', warehouse_id: 'wh_sh', qty: 1 }),
    /business_date is required/,
  );
  assert.throws(
    () => ingest.receiveReturn(db, { external_ref: 'V-3', sale_id: 'S-LATE-01', qty: 1, condition: 'good' }),
    /business_date is required/,
  );
  const after = inv.batchStock(db, { asOf: AS_OF, caliber: 'physical' });
  assert.deepEqual(
    after.map((b) => [b.batch_id, b.physical_qty]),
    before.map((b) => [b.batch_id, b.physical_qty]),
    'rejected payloads must not touch stock',
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM movements WHERE external_ref LIKE 'V-%'").get().n,
    0,
  );
});

test('ingest rejects unknown identifiers with a 400, not a driver error', () => {
  const db = fresh();
  assert.throws(
    () => ingest.receiveSale(db, { sale_id: 'V-4', sku_id: 'sku_milk', warehouse_id: 'wh_sh', qty: 1, business_date: AS_OF, caliber: 'bogus' }),
    (e) => e.statusCode === 400,
  );
  assert.throws(
    () => ingest.receiveReturn(db, { external_ref: 'V-5', qty: 1, condition: 'good', business_date: AS_OF }),
    (e) => e.statusCode === 400 && /sku_id or a resolvable sale_id/.test(e.message),
  );
  assert.throws(
    () => ingest.receiveTransferIn(db, { external_ref: 'V-6', batch_id: 'bat_nope', warehouse_id: 'wh_gz', qty: 1, business_date: AS_OF }),
    (e) => e.statusCode === 400,
  );
});
