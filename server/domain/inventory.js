'use strict';

const { query, getRow, run } = require('../lib/db');
const { addDays, diffDays } = require('../lib/dates');

/**
 * Availability calibers
 * ----------------------
 * physical   : every unit in the batch, including damaged / quality-hold / expired.
 * good       : physical minus damaged / quality-hold units (still includes expired).
 * available  : good, unexpired, minus active reservations.
 * sellable   : batch-level available, then warehouse safety stock is subtracted
 *              from the newest batches first (oldest stock stays sellable).
 */
const CALIBERS = ['physical', 'good', 'available', 'sellable'];
const CALIBER_LABELS = {
  physical: '在手 (含残损/过期)',
  good: '良品 (含过期)',
  available: '可用 (良品-预留-过期)',
  sellable: '可售 (可用-安全库存)',
};

function signedQty(type, qty) {
  switch (type) {
    case 'INBOUND':
    case 'RETURN_GOOD':
    case 'RETURN_DAMAGED':
    case 'TRANSFER_IN':
    case 'ADJUSTMENT':
      return Math.abs(qty);
    case 'SALE':
    case 'TRANSFER_OUT':
    case 'DISPOSAL':
      return -Math.abs(qty);
    default:
      throw new Error(`unknown movement type: ${type}`);
  }
}

function assertCaliber(caliber) {
  if (!CALIBERS.includes(caliber)) {
    throw Object.assign(new Error(`unknown caliber: ${caliber}`), { statusCode: 400 });
  }
}

function activeReservationQty(db, batchId, asOf) {
  const row = getRow(
    db,
    `SELECT COALESCE(SUM(qty), 0) AS qty FROM reservations
      WHERE batch_id = ? AND status = 'active' AND created_at <= ?`,
    batchId,
    `${asOf}T23:59:59Z`,
  );
  return row ? row.qty : 0;
}

/**
 * Per-batch stock as of a business date. Movements are always applied on
 * business_date, so a late-arriving sale retroactively lands in the right
 * period without ever decrementing a running counter twice.
 */
function batchStock(db, { asOf, caliber = 'available' }) {
  assertCaliber(caliber);
  const rows = query(
    db,
    `SELECT
        b.id AS batch_id, b.batch_no, b.sku_id, b.warehouse_id,
        b.production_date, b.expiry_date, b.inbound_date, b.quality_status,
        s.code AS sku_code, s.name AS sku_name, s.category, s.unit_cost,
        s.retail_price, s.shelf_life_days, s.safety_days, s.substitute_group,
        w.name AS warehouse_name, w.region,
        COALESCE(SUM(CASE WHEN m.business_date <= ? THEN m.qty ELSE 0 END), 0) AS physical_qty,
        COALESCE(SUM(CASE WHEN m.business_date <= ? AND m.condition = 'good' THEN m.qty ELSE 0 END), 0) AS good_qty
      FROM batches b
      JOIN skus s ON s.id = b.sku_id
      JOIN warehouses w ON w.id = b.warehouse_id
      LEFT JOIN movements m ON m.batch_id = b.id
      GROUP BY b.id
      ORDER BY b.warehouse_id, b.sku_id, b.expiry_date`,
    asOf,
    asOf,
  );

  const reservedByBatch = new Map(
    query(
      db,
      `SELECT batch_id, COALESCE(SUM(qty),0) AS qty FROM reservations
        WHERE status = 'active' AND created_at <= ?
        GROUP BY batch_id`,
      `${asOf}T23:59:59Z`,
    ).map((r) => [r.batch_id, r.qty]),
  );

  const safetyByWarehouseSku = new Map(
    query(
      db,
      `SELECT b.warehouse_id, b.sku_id, s.safety_days, s.shelf_life_days
         FROM batches b JOIN skus s ON s.id = b.sku_id
        GROUP BY b.warehouse_id, b.sku_id`,
    ).map((r) => [`${r.warehouse_id}|${r.sku_id}`, r]),
  );

  const velocity = salesVelocity(db, asOf);

  const rows2 = rows.map((r) => {
    const reserved = reservedByBatch.get(r.batch_id) || 0;
    const expired = r.expiry_date < asOf;
    const hold = r.quality_status !== 'normal';
    const physical = round(r.physical_qty);
    const good = round(r.good_qty);
    const available = expired || hold ? 0 : Math.max(0, round(good - reserved));
    const ageDays = diffDays(r.inbound_date, asOf);
    const residualDays = diffDays(asOf, r.expiry_date);
    const v = velocity.get(`${r.warehouse_id}|${r.sku_id}`) || { daily: 0, lastSale: null };
    return {
      ...r,
      physical_qty: physical,
      good_qty: good,
      reserved_qty: round(reserved),
      available_qty: available,
      sellable_qty: available,
      expired,
      quality_hold: hold,
      age_days: ageDays,
      residual_days: residualDays,
      residual_ratio:
        r.shelf_life_days > 0 ? round(residualDays / r.shelf_life_days, 3) : 0,
      daily_velocity: v.daily,
      last_sale_date: v.lastSale,
      days_since_last_sale: v.lastSale ? diffDays(v.lastSale, asOf) : null,
      stock_value: round(physical * r.unit_cost, 2),
    };
  });

  if (caliber === 'sellable') {
    applySafetyStock(db, rows2);
  }
  for (const r of rows2) {
    r[`qty_${caliber}`] = pickCaliber(r, caliber);
  }
  return rows2;
}

function pickCaliber(row, caliber) {
  switch (caliber) {
    case 'physical':
      return row.physical_qty;
    case 'good':
      return row.good_qty;
    case 'available':
      return row.available_qty;
    case 'sellable':
      return row.sellable_qty;
    default:
      return row.available_qty;
  }
}

/**
 * Safety stock is a warehouse+SKU buffer expressed in days of cover. It is
 * carved out of the newest batches first so FEFO order and the sellable
 * quantity stay consistent with how a picker would actually consume stock.
 */
function applySafetyStock(db, rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.warehouse_id}|${r.sku_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const [, list] of groups) {
    const fresh = list.filter((r) => !r.expired && !r.quality_hold);
    const daily = fresh.length ? Math.max(...fresh.map((r) => r.daily_velocity)) : 0;
    const safetyDays = fresh.length ? fresh[0].safety_days : 0;
    let buffer = round(daily * safetyDays);
    const order = [...fresh].sort((a, b) => (a.expiry_date < b.expiry_date ? 1 : -1));
    for (const r of order) {
      if (buffer <= 0) break;
      const take = Math.min(buffer, r.available_qty);
      r.sellable_qty = round(r.available_qty - take);
      buffer = round(buffer - take);
    }
    for (const r of list) {
      if (r.expired || r.quality_hold) r.sellable_qty = 0;
    }
  }
}

/**
 * Daily net sales velocity over a trailing window and the last sale date.
 * Late sales count on their business date, which keeps the velocity stable
 * regardless of when the record was received.
 */
function salesVelocity(db, asOf, windowDays = 30) {
  const from = addDays(asOf, -windowDays);
  const rows = query(
    db,
    `SELECT sku_id, warehouse_id,
            COALESCE(SUM(CASE WHEN business_date > ? THEN qty ELSE 0 END), 0) AS net,
            MAX(business_date) AS last_sale
       FROM movements
      WHERE type = 'SALE' AND business_date <= ?
      GROUP BY sku_id, warehouse_id`,
    from,
    asOf,
  );
  const map = new Map();
  for (const r of rows) {
    map.set(`${r.warehouse_id}|${r.sku_id}`, {
      daily: round(Math.max(0, -r.net) / windowDays, 3),
      lastSale: r.last_sale,
    });
  }
  // Sku+warehouse combos with no sales still need an entry for the last-sale date.
  const combos = query(
    db,
    `SELECT DISTINCT sku_id, warehouse_id FROM movements WHERE business_date <= ?`,
    asOf,
  );
  for (const c of combos) {
    const key = `${c.warehouse_id}|${c.sku_id}`;
    if (!map.has(key)) {
      const last = getRow(
        db,
        `SELECT MAX(business_date) AS last_sale FROM movements
          WHERE sku_id = ? AND warehouse_id = ? AND type = 'SALE' AND business_date <= ?`,
        c.sku_id,
        c.warehouse_id,
        asOf,
      );
      map.set(key, { daily: 0, lastSale: last ? last.last_sale : null });
    }
  }
  return map;
}

function warehouseStock(db, { asOf, caliber = 'available', warehouseId, skuId }) {
  const rows = batchStock(db, { asOf, caliber });
  const filtered = rows.filter(
    (r) => (!warehouseId || r.warehouse_id === warehouseId) && (!skuId || r.sku_id === skuId),
  );
  const map = new Map();
  for (const r of filtered) {
    const key = `${r.warehouse_id}|${r.sku_id}`;
    if (!map.has(key)) {
      map.set(key, {
        warehouse_id: r.warehouse_id,
        warehouse_name: r.warehouse_name,
        sku_id: r.sku_id,
        sku_code: r.sku_code,
        sku_name: r.sku_name,
        quantity: 0,
        physical: 0,
        available: 0,
        sellable: 0,
        reserved: 0,
        batches: 0,
      });
    }
    const agg = map.get(key);
    agg.quantity += pickCaliber(r, caliber);
    agg.physical += r.physical_qty;
    agg.available += r.available_qty;
    agg.sellable += r.sellable_qty;
    agg.reserved += r.reserved_qty;
    agg.batches += 1;
  }
  return [...map.values()].map((a) => ({
    ...a,
    quantity: round(a.quantity),
    physical: round(a.physical),
    available: round(a.available),
    sellable: round(a.sellable),
    reserved: round(a.reserved),
  }));
}

/**
 * Daily on-hand / available / expired / damaged series for a batch or a
 * sku+warehouse pair. Used by the inventory timeline chart and by the
 * late-sale impact panel.
 */
function stockTimeline(db, { asOf, from, to, skuId, warehouseId, batchId }) {
  const start = from || addDays(asOf, -90);
  const end = to || asOf;
  const batches = query(
    db,
    `SELECT id, expiry_date, quality_status, sku_id, warehouse_id, inbound_date
       FROM batches WHERE inbound_date <= ?
         ${skuId ? 'AND sku_id = ?' : ''}
         ${warehouseId ? 'AND warehouse_id = ?' : ''}
         ${batchId ? 'AND id = ?' : ''}`,
    end,
    ...[skuId, warehouseId, batchId].filter(Boolean),
  );
  const batchIds = new Set(batches.map((b) => b.id));
  const movements = query(db, 'SELECT * FROM movements WHERE business_date <= ?', end).filter((m) =>
    batchIds.has(m.batch_id),
  );
  // Seed each batch's running balance with everything that happened BEFORE the
  // window opens, so the timeline opens at real on-hand instead of zero.
  const opening = new Map();
  for (const m of movements) {
    if (m.business_date >= start) continue;
    const cur = opening.get(m.batch_id) || { physical: 0, good: 0 };
    cur.physical += m.qty;
    if (m.condition === 'good') cur.good += m.qty;
    opening.set(m.batch_id, cur);
  }
  const byDate = new Map();
  for (const m of movements) {
    if (m.business_date < start) continue;
    const key = `${m.batch_id}|${m.business_date}`;
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(m);
  }
  const batchMeta = new Map(batches.map((b) => [b.id, b]));
  const running = new Map([...opening].map(([id, v]) => [id, { ...v }]));
  const days = [];
  let cursor = start;
  let guard = 0;
  while (cursor <= end && guard < 2000) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
    guard += 1;
  }
  const series = [];
  for (const day of days) {
    for (const b of batches) {
      const rows = byDate.get(`${b.id}|${day}`);
      if (!rows) continue;
      for (const m of rows) {
        const cur = running.get(b.id) || { physical: 0, good: 0 };
        cur.physical += m.qty;
        if (m.condition === 'good') cur.good += m.qty;
        running.set(b.id, cur);
      }
    }
    let physical = 0;
    let available = 0;
    let expiredQty = 0;
    let damaged = 0;
    for (const [bId, qty] of running) {
      const meta = batchMeta.get(bId);
      if (!meta) continue;
      const p = Math.max(0, round(qty.physical));
      const g = Math.max(0, round(qty.good));
      physical += p;
      if (meta.expiry_date < day || meta.quality_status !== 'normal') expiredQty += p;
      else available += g;
      damaged += Math.max(0, p - Math.max(0, g));
    }
    series.push({
      date: day,
      physical: round(physical),
      available: round(available),
      at_risk: round(expiredQty),
      damaged: round(damaged),
    });
  }
  // Collapse to at most ~60 points for readability while keeping the endpoints.
  const step = Math.max(1, Math.ceil(series.length / 60));
  const sampled = series.filter((_, i) => i % step === 0);
  if (series.length && sampled[sampled.length - 1].date !== series[series.length - 1].date) {
    sampled.push(series[series.length - 1]);
  }
  return { from: start, to: end, points: sampled };
}

/**
 * Late-arriving sales: a sale is "late" when it is received more than
 * `cutoffDays` after its business date. We never mutate a running balance;
 * the movement carries the original business date and is applied once.
 */
function lateSales(db, { asOf, cutoffDays = 1 }) {
  // `late` is stamped at ingestion against the business date. The lag filter
  // only refines that flag for callers who want a stricter window; a sale
  // flagged late is reported even if its lag later looks smaller.
  return query(
    db,
    `SELECT sale_id, sku_id, warehouse_id, qty, allocated_qty, short_qty,
            business_date, received_at,
            CAST(julianday(received_at) - julianday(business_date) AS INTEGER) AS lag_days
       FROM sale_headers
      WHERE late = 1 AND business_date <= ?
      ORDER BY business_date DESC, received_at DESC`,
    asOf,
  ).filter((r) => cutoffDays <= 1 || r.lag_days > cutoffDays);
}

function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
}

module.exports = {
  CALIBERS,
  CALIBER_LABELS,
  signedQty,
  assertCaliber,
  batchStock,
  warehouseStock,
  stockTimeline,
  salesVelocity,
  lateSales,
  round,
};
