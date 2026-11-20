'use strict';

const { run, tx, query } = require('../lib/db');
const { addDays, todayIso, diffDays } = require('../lib/dates');
const { receiveInbound, receiveSale, receiveReturn, receiveTransferIn, uid } = require('./ingest');
const { seedStrategies } = require('./strategy');

const AS_OF = process.env.SEED_AS_OF || todayIso();

function seed(db, { asOf = AS_OF, actor = 'seed' } = {}) {
  seedStrategies(db, actor);
  const warehouses = [
    ['wh_sh', '上海主仓', '华东'],
    ['wh_gz', '广州仓', '华南'],
    ['wh_cd', '成都仓', '西南'],
  ];
  const skus = [
    // id, code, name, category, shelf_life_days, unit_cost, retail_price, safety_days, substitute_group
    ['sku_milk', 'SKU-MILK-1L', '鲜牛奶 1L', '乳品', 21, 6.2, 12.5, 2, 'fresh_milk'],
    ['sku_yogurt', 'SKU-YOG-4', '常温酸奶 4 连杯', '乳品', 45, 8.4, 16.8, 2, 'yogurt'],
    ['sku_juice', 'SKU-JUI-OR', '橙汁 900ml', '饮品', 60, 5.1, 11.0, 3, 'juice_orange'],
    ['sku_juice_alt', 'SKU-JUI-AP', '苹果汁 900ml', '饮品', 60, 5.4, 11.0, 3, 'juice_orange'],
    ['sku_snack', 'SKU-SNK-CHP', '薯片 大包', '零食', 180, 4.8, 9.9, 5, 'snack_salty'],
    ['sku_cookie', 'SKU-CKE-01', '曲奇礼盒', '零食', 240, 22.0, 49.0, 5, 'snack_sweet'],
  ];
  const now = new Date().toISOString();

  tx(db, () => {
    for (const [id, name, region] of warehouses) {
      run(db, 'INSERT INTO warehouses (id, name, region) VALUES (?,?,?)', id, name, region);
    }
    for (const s of skus) {
      run(
        db,
        `INSERT INTO skus (id, code, name, category, shelf_life_days, unit_cost, retail_price,
            safety_days, substitute_group)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        ...s,
      );
    }
  });

  // ---- Inbound: a spread of ages so every aging band is populated. ----
  const inboundPlan = [
    // sku, wh, batch, qty, producedDaysAgo, shelfLife, quality
    ['sku_milk', 'wh_sh', 'M-2411-A', 120, 20, 21, 'normal'],
    ['sku_milk', 'wh_sh', 'M-2411-B', 200, 5, 21, 'normal'],
    ['sku_milk', 'wh_gz', 'M-2411-GZ', 90, 18, 21, 'normal'],
    ['sku_yogurt', 'wh_sh', 'Y-2410-A', 300, 44, 45, 'normal'],
    ['sku_yogurt', 'wh_sh', 'Y-2411-B', 260, 10, 45, 'normal'],
    ['sku_yogurt', 'wh_gz', 'Y-2410-GZ', 180, 40, 45, 'normal'],
    ['sku_juice', 'wh_sh', 'J-2410-A', 400, 55, 60, 'normal'],
    ['sku_juice', 'wh_gz', 'J-2410-GZ', 150, 52, 60, 'normal'],
    ['sku_juice', 'wh_cd', 'J-2410-CD', 80, 57, 60, 'normal'],
    ['sku_juice_alt', 'wh_sh', 'JA-2411-A', 220, 20, 60, 'normal'],
    ['sku_juice_alt', 'wh_cd', 'JA-2411-CD', 140, 15, 60, 'normal'],
    ['sku_snack', 'wh_sh', 'S-2409-A', 500, 150, 180, 'normal'],
    ['sku_snack', 'wh_gz', 'S-2409-GZ', 260, 140, 180, 'normal'],
    ['sku_snack', 'wh_cd', 'S-2409-CD', 120, 145, 180, 'normal'],
    ['sku_cookie', 'wh_sh', 'C-2408-A', 60, 230, 240, 'normal'],
    ['sku_cookie', 'wh_cd', 'C-2408-CD', 40, 220, 240, 'normal'],
    // Already expired - exercises the disposal path end to end.
    ['sku_juice_alt', 'wh_gz', 'JAX-2409-GZ', 36, 80, 60, 'normal'],
  ];
  inboundPlan.forEach(([sku, wh, batchNo, qty, ago, shelf, quality], i) => {
    const businessDate = addDays(asOf, -ago);
    receiveInbound(
      db,
      {
        external_ref: `IN-${String(i + 1).padStart(4, '0')}`,
        sku_id: sku,
        warehouse_id: wh,
        batch_no: batchNo,
        qty,
        production_date: businessDate,
        expiry_date: addDays(businessDate, shelf),
        business_date: businessDate,
        quality_status: quality,
        supplier: 'SUP-01',
        condition: 'good',
      },
      actor,
    );
  });

  // ---- A damaged inbound batch already in quality hold. ----
  receiveInbound(
    db,
    {
      external_ref: 'IN-DMG-01',
      sku_id: 'sku_juice',
      warehouse_id: 'wh_sh',
      batch_no: 'J-2411-DMG',
      qty: 24,
      production_date: addDays(asOf, -30),
      expiry_date: addDays(asOf, 30),
      business_date: addDays(asOf, -30),
      quality_status: 'damaged',
      condition: 'damaged',
    },
    actor,
  );

  // ---- Sales: create stale, slow, and healthy velocity patterns. ----
  const salesPlan = [
    // sku, wh, qty, daysAgo
    ['sku_milk', 'wh_sh', 30, 3],
    ['sku_milk', 'wh_sh', 25, 2],
    ['sku_milk', 'wh_sh', 28, 1],
    ['sku_milk', 'wh_gz', 4, 12],
    ['sku_yogurt', 'wh_sh', 12, 2],
    ['sku_yogurt', 'wh_sh', 10, 1],
    ['sku_yogurt', 'wh_gz', 3, 20],
    ['sku_juice', 'wh_sh', 6, 18],
    ['sku_juice', 'wh_sh', 4, 9],
    ['sku_juice', 'wh_gz', 0.0, 40], // skipped below (qty 0)
    ['sku_juice_alt', 'wh_sh', 8, 4],
    ['sku_juice_alt', 'wh_cd', 6, 3],
    ['sku_snack', 'wh_sh', 20, 6],
    ['sku_snack', 'wh_gz', 1, 30],
    ['sku_cookie', 'wh_sh', 2, 70],
  ];
  let saleNo = 0;
  const normalSaleIds = [];
  for (const [sku, wh, qty, ago] of salesPlan) {
    if (qty <= 0) continue;
    saleNo += 1;
    const saleId = `S-${String(saleNo).padStart(4, '0')}`;
    normalSaleIds.push(saleId);
    receiveSale(
      db,
      {
        sale_id: saleId,
        sku_id: sku,
        warehouse_id: wh,
        qty,
        business_date: addDays(asOf, -ago),
        allow_substitute: false,
      },
      actor,
    );
  }
  // Seeded history is "received the next day"; only the explicit EDI replays
  // below are genuinely late. Without this every backfilled sale looks late.
  for (const saleId of normalSaleIds) {
    const row = query(db, 'SELECT business_date FROM sale_headers WHERE sale_id = ?', saleId)[0];
    if (!row) continue;
    run(
      db,
      'UPDATE sale_headers SET received_at = ?, late = 0 WHERE sale_id = ?',
      `${addDays(row.business_date, 1)}T23:00:00Z`,
      saleId,
    );
    run(
      db,
      "UPDATE movements SET received_at = ?, late = 0 WHERE type = 'SALE' AND meta LIKE ?",
      `${addDays(row.business_date, 1)}T23:00:00Z`,
      `%"sale_id":"${saleId}"%`,
    );
  }

  // ---- A genuine stockout + substitute fallback scenario. ----
  // Drain milk in Guangzhou so a sale there falls back to... no substitute
  // (milk is alone in its group), so it records a short.
  receiveSale(
    db,
    {
      sale_id: 'S-SHORT-01',
      sku_id: 'sku_milk',
      warehouse_id: 'wh_cd',
      qty: 5,
      business_date: addDays(asOf, -1),
      allow_substitute: true,
    },
    actor,
  );
  // Juice is grouped with apple juice, so a short in juice falls back.
  receiveSale(
    db,
    {
      sale_id: 'S-SUB-01',
      sku_id: 'sku_juice',
      warehouse_id: 'wh_cd',
      qty: 200,
      business_date: addDays(asOf, -1),
      allow_substitute: true,
    },
    actor,
  );

  // ---- Late sales: business date well before received date. ----
  // The trick is that receiveSale stamps received_at = now, so we backdate
  // business_date and mark it late explicitly to reproduce an EDI replay.
  receiveSale(
    db,
    {
      sale_id: 'S-LATE-01',
      sku_id: 'sku_yogurt',
      warehouse_id: 'wh_sh',
      qty: 18,
      business_date: addDays(asOf, -9),
      late: true,
      allow_substitute: false,
    },
    actor,
  );
  receiveSale(
    db,
    {
      sale_id: 'S-LATE-02',
      sku_id: 'sku_snack',
      warehouse_id: 'wh_sh',
      qty: 40,
      business_date: addDays(asOf, -6),
      late: true,
      allow_substitute: false,
    },
    actor,
  );
  run(db, "UPDATE sale_headers SET late = 1 WHERE sale_id IN ('S-LATE-01','S-LATE-02')");
  run(
    db,
    "UPDATE movements SET late = 1 WHERE meta LIKE '%S-LATE-01%' OR meta LIKE '%S-LATE-02%'",
  );

  // ---- Returns: one good, one damaged, one stale (expired) attempt. ----
  receiveReturn(
    db,
    {
      external_ref: 'RTN-0001',
      sale_id: 'S-0002',
      sku_id: 'sku_milk',
      warehouse_id: 'wh_sh',
      qty: 6,
      condition: 'good',
      business_date: addDays(asOf, -1),
      reason: '多拍',
    },
    actor,
  );
  receiveReturn(
    db,
    {
      external_ref: 'RTN-0002',
      sale_id: 'S-0007',
      sku_id: 'sku_yogurt',
      warehouse_id: 'wh_gz',
      qty: 3,
      condition: 'damaged',
      business_date: addDays(asOf, -1),
      reason: '运输破损',
    },
    actor,
  );

  // ---- Inter-warehouse transfer history (for lookback and rollback tests). ----
  const cookieBatch = query(db, "SELECT * FROM batches WHERE batch_no = 'C-2408-A'")[0];
  if (cookieBatch) {
    receiveTransferIn(
      db,
      {
        external_ref: 'TRF-IN-0001',
        batch_id: cookieBatch.id,
        warehouse_id: 'wh_gz',
        qty: 10,
        business_date: addDays(asOf, -8),
      },
      actor,
    );
  }

  // Reservations: earmarked stock reduces available but not physical.
  const milkB = query(db, "SELECT * FROM batches WHERE batch_no = 'M-2411-B'")[0];
  if (milkB) {
    run(
      db,
      'INSERT INTO reservations (id, batch_id, sku_id, warehouse_id, qty, ref, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      uid('res'),
      milkB.id,
      'sku_milk',
      'wh_sh',
      20,
      'ORD-8891',
      'active',
      `${addDays(asOf, -2)}T09:00:00Z`,
    );
  }
  const yogurtB = query(db, "SELECT * FROM batches WHERE batch_no = 'Y-2411-B'")[0];
  if (yogurtB) {
    run(
      db,
      'INSERT INTO reservations (id, batch_id, sku_id, warehouse_id, qty, ref, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      uid('res'),
      yogurtB.id,
      'sku_yogurt',
      'wh_sh',
      30,
      'ORD-8892',
      'active',
      `${addDays(asOf, -1)}T09:00:00Z`,
    );
  }

  return { asOf };
}

module.exports = { seed, AS_OF };
