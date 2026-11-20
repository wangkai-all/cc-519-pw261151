'use strict';

const crypto = require('node:crypto');
const { query, getRow, run, tx } = require('../lib/db');
const { addDays, diffDays, toIso } = require('../lib/dates');
const { signedQty, round, assertCaliber } = require('./inventory');

const LATE_CUTOFF_DAYS = 1;

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * Movement dates are business dates, never "now": a missing one has no safe
 * default (a late sale must keep its original period), so reject it explicitly
 * instead of letting it surface as a SQLite binding error or a silently wrong
 * posting.
 */
function requireDate(value, field = 'business_date') {
  if (!value) throw httpError(400, `${field} is required (YYYY-MM-DD)`);
  try {
    return toIso(value);
  } catch {
    throw httpError(400, `${field} must be a date (YYYY-MM-DD), got ${JSON.stringify(value)}`);
  }
}

function requireRef(payload, field, kind) {
  if (!payload[field]) throw httpError(400, `${field} is required for ${kind}`);
  return String(payload[field]);
}

function logIngestion(db, externalRef, kind, decision, detail) {
  run(
    db,
    'INSERT INTO ingestion_log (external_ref, kind, decision, detail, received_at) VALUES (?,?,?,?,?)',
    externalRef,
    kind,
    decision,
    detail ? JSON.stringify(detail) : null,
    new Date().toISOString(),
  );
}

function audit(db, actor, action, entity, entityId, detail) {
  run(
    db,
    'INSERT INTO audit_log (ts, actor, action, entity, entity_id, detail) VALUES (?,?,?,?,?,?)',
    new Date().toISOString(),
    actor,
    action,
    entity,
    entityId,
    detail ? JSON.stringify(detail) : null,
  );
}

function batchAvailableAt(db, batchId, isoDate, { reservations = true } = {}) {
  const row = getRow(
    db,
    `SELECT COALESCE(SUM(CASE WHEN business_date <= ? THEN qty ELSE 0 END),0) AS physical,
            COALESCE(SUM(CASE WHEN business_date <= ? AND condition = 'good' THEN qty ELSE 0 END),0) AS good
       FROM movements WHERE batch_id = ?`,
    isoDate,
    isoDate,
    batchId,
  );
  const b = getRow(db, 'SELECT * FROM batches WHERE id = ?', batchId);
  if (!b) return 0;
  if (b.expiry_date < isoDate || b.quality_status !== 'normal') return 0;
  let qty = Math.max(0, round(row.good));
  if (reservations) {
    // Earmarked units are not free to sell, even though they are physically on
    // the shelf. Deposits/orders would otherwise be silently cannibalised.
    const reserved = getRow(
      db,
      `SELECT COALESCE(SUM(qty),0) AS qty FROM reservations
        WHERE batch_id = ? AND status = 'active' AND created_at <= ?`,
      batchId,
      `${isoDate}T23:59:59Z`,
    );
    qty = Math.max(0, round(qty - (reserved ? reserved.qty : 0)));
  }
  return qty;
}

/**
 * On-hand quantity that a write-off may consume. Disposal operates on
 * physical stock, so expired or frozen batches are eligible; only
 * already-sold-out / already-disposed units are not.
 */
function batchPhysicalAt(db, batchId, isoDate) {
  const row = getRow(
    db,
    `SELECT COALESCE(SUM(CASE WHEN business_date <= ? THEN qty ELSE 0 END),0) AS physical
       FROM movements WHERE batch_id = ?`,
    isoDate,
    batchId,
  );
  return Math.max(0, round(row.physical));
}

/**
 * Units removed from a batch by movements dated AFTER a backdated business
 * date (typically a disposal or transfer executed later than a late sale's
 * business date). Derived from the ledger rather than wall-clock execution
 * timestamps so same-day executions are still protected.
 *
 * A late sale for day D must not consume units that were written off on day
 * D+3: the write-off is a fact that already happened, so those units are
 * unavailable for the historical allocation.
 */
function committedAfter(db, batchId, isoDate) {
  const row = getRow(
    db,
    `SELECT COALESCE(SUM(CASE WHEN qty < 0 THEN -qty ELSE 0 END), 0) AS qty FROM movements
      WHERE batch_id = ? AND business_date > ?`,
    batchId,
    isoDate,
  );
  return Math.max(0, round(row ? row.qty : 0));
}

function receiveInbound(db, payload, actor = 'system') {
  const externalRef = requireRef(payload, 'external_ref', 'inbound');
  const businessDate = requireDate(payload.business_date);
  const result = tx(db, () => {
    const dupe = getRow(db, 'SELECT id FROM movements WHERE external_ref = ?', externalRef);
    if (dupe) {
      logIngestion(db, externalRef, 'INBOUND', 'DUPLICATE', { movement_id: dupe.id });
      return { status: 'duplicate', external_ref: externalRef };
    }
    if (!payload.sku_id) throw httpError(400, 'inbound requires sku_id');
    if (!payload.warehouse_id) throw httpError(400, 'inbound requires warehouse_id');
    const sku = getRow(db, 'SELECT * FROM skus WHERE id = ?', payload.sku_id);
    if (!sku) throw httpError(400, `unknown sku: ${payload.sku_id}`);
    const wh = getRow(db, 'SELECT * FROM warehouses WHERE id = ?', payload.warehouse_id);
    if (!wh) throw httpError(400, `unknown warehouse: ${payload.warehouse_id}`);
    if (!(payload.qty > 0)) throw httpError(400, 'inbound qty must be > 0');

    const productionDate = toIso(payload.production_date || businessDate);
    const expiryDate = toIso(
      payload.expiry_date || addDays(productionDate, sku.shelf_life_days),
    );
    const batchNo = payload.batch_no || `B${businessDate.replace(/-/g, '')}${externalRef.slice(-4)}`;
    const existingBatch = getRow(
      db,
      'SELECT * FROM batches WHERE batch_no = ? AND warehouse_id = ?',
      batchNo,
      payload.warehouse_id,
    );
    const batchId = existingBatch ? existingBatch.id : uid('bat');
    if (!existingBatch) {
      run(
        db,
        `INSERT INTO batches (id, batch_no, sku_id, warehouse_id, production_date, expiry_date,
            inbound_date, quality_status, source_batch_no)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        batchId,
        batchNo,
        payload.sku_id,
        payload.warehouse_id,
        productionDate,
        expiryDate,
        businessDate,
        payload.quality_status || 'normal',
        payload.source_batch_no || null,
      );
    }
    run(
      db,
      `INSERT INTO movements (external_ref, type, sku_id, warehouse_id, batch_id, qty,
          condition, business_date, received_at, late, meta)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      externalRef,
      'INBOUND',
      payload.sku_id,
      payload.warehouse_id,
      batchId,
      Math.abs(payload.qty),
      payload.condition === 'damaged' ? 'damaged' : 'good',
      businessDate,
      new Date().toISOString(),
      0,
      JSON.stringify({ supplier: payload.supplier || null }),
    );
    logIngestion(db, externalRef, 'INBOUND', 'APPLIED', { batch_id: batchId, qty: payload.qty });
    audit(db, actor, 'inbound.applied', 'batch', batchId, {
      qty: payload.qty,
      business_date: businessDate,
    });
    return { status: 'applied', external_ref: externalRef, batch_id: batchId };
  });
  return result;
}

/**
 * Allocate a sale FEFO across batches using the given caliber, optionally
 * within one sku (for substitute fallback it is called again with another sku).
 */
function allocate(db, { skuId, warehouseId, qty, businessDate, caliber = 'available' }) {
  // An unknown caliber would silently fall back to `available`, quietly
  // allocating more (or less) than the caller asked for.
  assertCaliber(caliber);
  const batches = query(
    db,
    `SELECT * FROM batches
      WHERE sku_id = ? AND warehouse_id = ? AND expiry_date >= ? AND quality_status = 'normal'
      ORDER BY expiry_date ASC, inbound_date ASC`,
    skuId,
    warehouseId,
    businessDate,
  );
  const allocations = [];
  let remaining = round(qty);
  let safetyRemaining = 0;
  if (caliber === 'sellable') {
    // Safety stock is a demand buffer, not a per-batch property: size it from
    // recent velocity and hold it back from the freshest batch so FEFO still
    // consumes the oldest stock first.
    const sku = getRow(db, 'SELECT * FROM skus WHERE id = ?', skuId);
    const velocityRows = query(
      db,
      `SELECT -SUM(qty) AS sold FROM movements
        WHERE sku_id = ? AND warehouse_id = ? AND type = 'SALE'
          AND business_date > ? AND business_date <= ?`,
      skuId,
      warehouseId,
      addDays(businessDate, -30),
      businessDate,
    );
    const daily = Math.max(0, (velocityRows[0]?.sold || 0) / 30);
    safetyRemaining = round(daily * (sku?.safety_days || 0));
  }
  for (const b of batches) {
    if (remaining <= 0) break;
    let free = batchAvailableAt(db, b.id, businessDate);
    free = round(free - committedAfter(db, b.id, businessDate));
    if (free <= 0) continue;
    if (safetyRemaining > 0) {
      const hold = Math.min(free, safetyRemaining);
      free = round(free - hold);
      safetyRemaining = round(safetyRemaining - hold);
    }
    if (free <= 0) continue;
    const take = Math.min(free, remaining);
    allocations.push({ batch_id: b.id, qty: round(take), batch_no: b.batch_no });
    remaining = round(remaining - take);
  }
  return { allocations, short: Math.max(0, round(remaining)) };
}

function receiveSale(db, payload, actor = 'system') {
  // EDI feeds sometimes only carry a source reference; either identifier works,
  // but one of them must exist because it is the idempotency key.
  const saleId = payload.sale_id || payload.external_ref;
  if (!saleId) throw httpError(400, 'sale_id is required for sale');
  const businessDate = requireDate(payload.business_date);
  return tx(db, () => {
    const existing = getRow(db, 'SELECT * FROM sale_headers WHERE sale_id = ?', saleId);
    if (existing) {
      logIngestion(db, saleId, 'SALE', 'DUPLICATE', { sale_id: saleId });
      return {
        status: 'duplicate',
        sale_id: saleId,
        note: '重复回传已忽略，库存不重复扣减',
        allocated_qty: existing.allocated_qty,
      };
    }
    if (!payload.sku_id) throw httpError(400, 'sale requires sku_id');
    if (!payload.warehouse_id) throw httpError(400, 'sale requires warehouse_id');
    const sku = getRow(db, 'SELECT * FROM skus WHERE id = ?', payload.sku_id);
    if (!sku) throw httpError(400, `unknown sku: ${payload.sku_id}`);
    if (!(payload.qty > 0)) throw httpError(400, 'sale qty must be > 0');
    const receivedAt = new Date().toISOString();
    const late = diffDays(businessDate, receivedAt.slice(0, 10)) > LATE_CUTOFF_DAYS ? 1 : payload.late ? 1 : 0;

    let alloc = allocate(db, {
      skuId: payload.sku_id,
      warehouseId: payload.warehouse_id,
      qty: payload.qty,
      businessDate,
      caliber: payload.caliber || 'available',
    });
    const movements = [];
    for (const a of alloc.allocations) {
      const ref = `SALE:${saleId}:${a.batch_id}`;
      run(
        db,
        `INSERT INTO movements (external_ref, type, sku_id, warehouse_id, batch_id, qty,
            condition, business_date, received_at, late, meta)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ref,
        'SALE',
        payload.sku_id,
        payload.warehouse_id,
        a.batch_id,
        -Math.abs(a.qty),
        'good',
        businessDate,
        receivedAt,
        late,
        JSON.stringify({ sale_id: saleId }),
      );
      movements.push(ref);
    }

    let substitute = null;
    let short = alloc.short;
    if (short > 0 && payload.allow_substitute !== false) {
      const subs = query(
        db,
        `SELECT * FROM skus WHERE substitute_group = ? AND id != ? ORDER BY id`,
        sku.substitute_group,
        sku.id,
      );
      for (const sub of subs) {
        if (short <= 0) break;
        const subAlloc = allocate(db, {
          skuId: sub.id,
          warehouseId: payload.warehouse_id,
          qty: short,
          businessDate,
          caliber: 'available',
        });
        if (!subAlloc.allocations.length) continue;
        for (const a of subAlloc.allocations) {
          const ref = `SALE:${saleId}:sub:${sub.id}:${a.batch_id}`;
          run(
            db,
            `INSERT INTO movements (external_ref, type, sku_id, warehouse_id, batch_id, qty,
                condition, business_date, received_at, late, meta)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            ref,
            'SALE',
            sub.id,
            payload.warehouse_id,
            a.batch_id,
            -Math.abs(a.qty),
            'good',
            businessDate,
            receivedAt,
            late,
            JSON.stringify({ sale_id: saleId, substitution_for: sku.id }),
          );
          movements.push(ref);
        }
        substitute = {
          sku_id: sub.id,
          sku_code: sub.code,
          qty: round(short - subAlloc.short),
        };
        short = subAlloc.short;
      }
    }

    const allocated = round(payload.qty - short);
    run(
      db,
      `INSERT INTO sale_headers (sale_id, sku_id, warehouse_id, qty, allocated_qty, short_qty,
          business_date, received_at, late, status)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      saleId,
      payload.sku_id,
      payload.warehouse_id,
      payload.qty,
      allocated,
      short,
      businessDate,
      receivedAt,
      late,
      short > 0 ? 'PARTIAL' : 'POSTED',
    );
    logIngestion(db, saleId, 'SALE', late ? 'APPLIED_LATE' : 'APPLIED', {
      business_date: businessDate,
      allocated,
      short,
      substitute,
    });
    audit(db, actor, 'sale.applied', 'sale', saleId, {
      qty: payload.qty,
      allocated,
      short,
      late: Boolean(late),
      business_date: businessDate,
    });
    return {
      status: late ? 'applied_late' : 'applied',
      sale_id: saleId,
      late: Boolean(late),
      allocated_qty: allocated,
      short_qty: short,
      substitute,
      movements,
      note: late
        ? '迟到销售按原业务日期回填，只扣减一次；已处置批次不会被追溯占用'
        : undefined,
    };
  });
}

function receiveReturn(db, payload, actor = 'system') {
  const externalRef = requireRef(payload, 'external_ref', 'return');
  const businessDate = requireDate(payload.business_date);
  return tx(db, () => {
    const dupe = getRow(db, 'SELECT id FROM movements WHERE external_ref = ?', externalRef);
    if (dupe) {
      logIngestion(db, externalRef, 'RETURN', 'DUPLICATE', { movement_id: dupe.id });
      return { status: 'duplicate', external_ref: externalRef };
    }
    const sale = payload.sale_id
      ? getRow(db, 'SELECT * FROM sale_headers WHERE sale_id = ?', payload.sale_id)
      : null;
    const skuId = payload.sku_id || sale?.sku_id;
    const warehouseId = payload.warehouse_id || sale?.warehouse_id;
    if (!skuId) throw httpError(400, 'return requires sku_id or a resolvable sale_id');
    if (!warehouseId) throw httpError(400, 'return requires warehouse_id or a resolvable sale_id');
    const sku = getRow(db, 'SELECT * FROM skus WHERE id = ?', skuId);
    if (!sku) throw httpError(400, `unknown sku: ${skuId}`);
    if (!(payload.qty > 0)) throw httpError(400, 'return qty must be > 0');

    const damaged = payload.condition === 'damaged' || payload.disposition === 'scrap';
    // Only a sale reference can identify the batch the goods came from; a
    // return without one gets a fresh batch rather than a guess.
    const sourceBatch = payload.sale_id
      ? query(
          db,
          `SELECT b.* FROM batches b JOIN movements m ON m.batch_id = b.id
            WHERE m.type = 'SALE' AND m.meta LIKE ? AND b.warehouse_id = ?
            ORDER BY b.expiry_date DESC LIMIT 1`,
          `%"sale_id":"${payload.sale_id}"%`,
          warehouseId,
        )[0]
      : undefined;

    let batchId;
    if (damaged) {
      const batchNo = payload.batch_no || `RTN-D-${externalRef}`;
      batchId = uid('bat');
      run(
        db,
        `INSERT INTO batches (id, batch_no, sku_id, warehouse_id, production_date, expiry_date,
            inbound_date, quality_status, source_batch_no)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        batchId,
        batchNo,
        skuId,
        warehouseId,
        sourceBatch?.production_date || businessDate,
        sourceBatch?.expiry_date || addDays(businessDate, sku.shelf_life_days),
        businessDate,
        'damaged',
        sourceBatch?.batch_no || null,
      );
    } else {
      const expiry = toIso(payload.expiry_date || sourceBatch?.expiry_date || addDays(businessDate, sku.shelf_life_days));
      if (expiry < businessDate) {
        throw httpError(409, '退回批次已过保质期，请按残损/报废处理');
      }
      batchId = payload.new_batch_id || sourceBatch?.id;
      if (!batchId) {
        batchId = uid('bat');
        run(
          db,
          `INSERT INTO batches (id, batch_no, sku_id, warehouse_id, production_date, expiry_date,
              inbound_date, quality_status, source_batch_no)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          batchId,
          payload.batch_no || `RTN-${externalRef}`,
          skuId,
          warehouseId,
          sourceBatch?.production_date || businessDate,
          expiry,
          businessDate,
          'normal',
          sourceBatch?.batch_no || null,
        );
      }
    }
    const type = damaged ? 'RETURN_DAMAGED' : 'RETURN_GOOD';
    run(
      db,
      `INSERT INTO movements (external_ref, type, sku_id, warehouse_id, batch_id, qty,
          condition, business_date, received_at, late, meta)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      externalRef,
      type,
      skuId,
      warehouseId,
      batchId,
      Math.abs(payload.qty),
      damaged ? 'damaged' : 'good',
      businessDate,
      new Date().toISOString(),
      0,
      JSON.stringify({ sale_id: payload.sale_id || null, reason: payload.reason || null }),
    );
    logIngestion(db, externalRef, 'RETURN', 'APPLIED', {
      batch_id: batchId,
      damaged,
      qty: payload.qty,
    });
    audit(db, actor, 'return.applied', 'batch', batchId, {
      qty: payload.qty,
      damaged,
      sale_id: payload.sale_id || null,
    });
    return {
      status: 'applied',
      external_ref: externalRef,
      batch_id: batchId,
      condition: damaged ? 'damaged' : 'good',
      note: damaged ? '残损退回进入不可用口径，参与呆滞计算但不计入可售' : undefined,
    };
  });
}

function receiveTransferIn(db, payload, actor = 'system') {
  const externalRef = requireRef(payload, 'external_ref', 'transfer');
  const businessDate = requireDate(payload.business_date);
  return tx(db, () => {
    const dupe = getRow(db, 'SELECT id FROM movements WHERE external_ref = ?', externalRef);
    if (dupe) {
      logIngestion(db, externalRef, 'TRANSFER_IN', 'DUPLICATE', { movement_id: dupe.id });
      return { status: 'duplicate', external_ref: externalRef };
    }
    const sourceBatch = getRow(db, 'SELECT * FROM batches WHERE id = ?', payload.batch_id);
    if (!sourceBatch) throw httpError(400, 'unknown source batch');
    const destWarehouse = payload.warehouse_id || payload.to_warehouse;
    if (!destWarehouse) throw httpError(400, 'warehouse_id required');
    if (destWarehouse === sourceBatch.warehouse_id) {
      throw httpError(400, 'destination must differ from source warehouse');
    }
    const qty = Math.abs(payload.qty);
    if (!(qty > 0)) throw httpError(400, 'transfer qty must be > 0');
    const destNo = `${sourceBatch.batch_no}@${destWarehouse}`;
    let dest = getRow(db, 'SELECT * FROM batches WHERE batch_no = ? AND warehouse_id = ?', destNo, destWarehouse);
    if (!dest) {
      dest = { id: uid('bat') };
      run(
        db,
        `INSERT INTO batches (id, batch_no, sku_id, warehouse_id, production_date, expiry_date,
            inbound_date, quality_status, source_batch_no)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        dest.id,
        destNo,
        sourceBatch.sku_id,
        destWarehouse,
        sourceBatch.production_date,
        sourceBatch.expiry_date,
        businessDate,
        sourceBatch.quality_status,
        sourceBatch.batch_no,
      );
    }
    // Only one of the two legs is written by the caller; if the caller sent a
    // TRANSFER_OUT we already deducted the source, otherwise deduct here.
    const outRef = `TRANSFER_OUT:${externalRef}`;
    const outExists = getRow(db, 'SELECT id FROM movements WHERE external_ref = ?', outRef);
    if (!outExists) {
      const available = batchAvailableAt(db, sourceBatch.id, businessDate);
      if (available < qty) {
        throw httpError(409, `源仓可用量不足：可用 ${available}，调拨 ${qty}`);
      }
      run(
        db,
        `INSERT INTO movements (external_ref, type, sku_id, warehouse_id, batch_id, qty,
            condition, business_date, received_at, late, meta)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        outRef,
        'TRANSFER_OUT',
        sourceBatch.sku_id,
        sourceBatch.warehouse_id,
        sourceBatch.id,
        -qty,
        'good',
        businessDate,
        new Date().toISOString(),
        0,
        JSON.stringify({ to_warehouse: destWarehouse }),
      );
    }
    run(
      db,
      `INSERT INTO movements (external_ref, type, sku_id, warehouse_id, batch_id, qty,
          condition, business_date, received_at, late, meta)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      externalRef,
      'TRANSFER_IN',
      sourceBatch.sku_id,
      destWarehouse,
      dest.id,
      qty,
      'good',
      businessDate,
      new Date().toISOString(),
      0,
      JSON.stringify({ from_batch: sourceBatch.id, from_warehouse: sourceBatch.warehouse_id }),
    );
    logIngestion(db, externalRef, 'TRANSFER_IN', 'APPLIED', { dest_batch: dest.id, qty });
    audit(db, actor, 'transfer.applied', 'batch', dest.id, { qty, from: sourceBatch.id });
    return { status: 'applied', external_ref: externalRef, batch_id: dest.id };
  });
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

module.exports = {
  LATE_CUTOFF_DAYS,
  uid,
  audit,
  logIngestion,
  receiveInbound,
  receiveSale,
  receiveReturn,
  receiveTransferIn,
  allocate,
  batchAvailableAt,
  batchPhysicalAt,
  committedAfter,
  httpError,
};
