'use strict';

const { query, getRow, run, tx } = require('../lib/db');
const { addDays, diffDays, todayIso } = require('../lib/dates');
const { batchStock, CALIBERS, round } = require('./inventory');
const { uid, audit, httpError } = require('./ingest');

const DEFAULT_PARAMS = {
  caliber: 'available',
  staleDays: 45,
  deadStockDays: 90,
  nearExpiryDays: 30,
  nearExpiryRatio: 0.25,
  slowMovingCoverDays: 60,
  concentrationRatio: 0.4,
  minBatchQty: 1,
  transferLookbackDays: 30,
  forecastHorizonDays: 45,
  includeSubstitutes: true,
  autoActionRules: {
    expired: 'dispose',
    damaged: 'dispose',
    nearExpiry: 'discount',
    stale: 'transfer',
    slowMoving: 'discount',
  },
};

const ACTION_META = {
  dispose: { label: '报废处置', risk: 'critical' },
  discount: { label: '折价促销', risk: 'warning' },
  transfer: { label: '跨仓调拨', risk: 'serious' },
  substitute: { label: '替代品合并', risk: 'good' },
  keep: { label: '维持观察', risk: 'good' },
  return_to_supplier: { label: '退供应商', risk: 'warning' },
};

function validateParams(params) {
  const p = { ...DEFAULT_PARAMS, ...params, autoActionRules: { ...DEFAULT_PARAMS.autoActionRules, ...(params?.autoActionRules || {}) } };
  const errors = [];
  if (!CALIBERS.includes(p.caliber)) errors.push(`caliber 必须是 ${CALIBERS.join('/')}`);
  for (const key of [
    'staleDays',
    'deadStockDays',
    'nearExpiryDays',
    'slowMovingCoverDays',
    'transferLookbackDays',
    'forecastHorizonDays',
    'minBatchQty',
  ]) {
    if (!(Number.isFinite(p[key]) && p[key] >= 0)) errors.push(`${key} 必须是非负数`);
  }
  if (p.nearExpiryRatio < 0 || p.nearExpiryRatio > 1) errors.push('nearExpiryRatio 必须在 0-1 之间');
  if (p.concentrationRatio < 0 || p.concentrationRatio > 1) errors.push('concentrationRatio 必须在 0-1 之间');
  for (const [trigger, action] of Object.entries(p.autoActionRules)) {
    if (!ACTION_META[action]) errors.push(`规则 ${trigger} 的动作 ${action} 不存在`);
  }
  if (errors.length) throw httpError(400, errors.join('；'));
  return p;
}

function seedStrategies(db, actor = 'seed') {
  const existing = getRow(db, 'SELECT COUNT(*) AS n FROM strategies');
  if (existing.n > 0) return;
  const conservative = validateParams({
    caliber: 'available',
    staleDays: 60,
    deadStockDays: 120,
    nearExpiryDays: 21,
    slowMovingCoverDays: 90,
    autoActionRules: { stale: 'discount', nearExpiry: 'discount' },
  });
  const aggressive = validateParams({
    caliber: 'sellable',
    staleDays: 30,
    deadStockDays: 60,
    nearExpiryDays: 45,
    slowMovingCoverDays: 45,
    autoActionRules: { stale: 'transfer', nearExpiry: 'dispose' },
  });
  const now = new Date().toISOString();
  const ins = db.prepare(
    `INSERT INTO strategies (id, version, name, params, status, created_by, created_at, activated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  ins.run('stg_conservative_v1', 1, '保守口径 v1', JSON.stringify(conservative), 'active', actor, now, now);
  ins.run('stg_aggressive_v1', 1, '激进去化 v1', JSON.stringify(aggressive), 'draft', actor, now, null);
  const s = getRow(db, 'SELECT * FROM strategies WHERE id = ?', 'stg_conservative_v1');
  const after = getRow(db, 'SELECT * FROM strategies WHERE id = ?', 'stg_aggressive_v1');
  runMigration(db, null, s, todayIso(), { note: '初始策略' });
  runMigration(db, s, after, todayIso(), { note: '初始策略（草稿）' });
}

function runMigration(db, from, to, asOf, extra = {}) {
  const snap = (s) => {
    if (!s) return null;
    // Accept either a raw row (params is a JSON string) or a hydrated strategy
    // object (params already parsed) - both reach this from different callers.
    const params = typeof s.params === 'string' ? JSON.parse(s.params) : s.params || {};
    return { id: s.id, name: s.name, version: s.version, params };
  };
  const summary = {
    from: snap(from),
    to: snap(to),
    note: extra.note || null,
  };
  if (extra.migration) summary.migration = extra.migration;
  if (extra.acknowledged != null) summary.acknowledged = extra.acknowledged;
  run(
    db,
    `INSERT INTO strategy_migrations (from_strategy, to_strategy, as_of, summary, created_at)
     VALUES (?,?,?,?,?)`,
    from?.id || null,
    to.id,
    asOf,
    JSON.stringify(summary),
    new Date().toISOString(),
  );
}

function getStrategy(db, id) {
  const s = getRow(db, 'SELECT * FROM strategies WHERE id = ?', id);
  if (!s) return null;
  return { ...s, params: JSON.parse(s.params) };
}

function activeStrategy(db) {
  return getStrategy(
    db,
    (getRow(db, "SELECT id FROM strategies WHERE status = 'active' ORDER BY activated_at DESC LIMIT 1") || {}).id,
  );
}

function createStrategy(db, { name, params, actor = 'planner' }) {
  const p = validateParams(params);
  const id = uid('stg');
  const version = (getRow(db, 'SELECT COALESCE(MAX(version),0) AS v FROM strategies').v || 0) + 1;
  run(
    db,
    `INSERT INTO strategies (id, version, name, params, status, created_by, created_at, activated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    id,
    version,
    name || `策略 v${version}`,
    JSON.stringify(p),
    'draft',
    actor,
    new Date().toISOString(),
    null,
  );
  audit(db, actor, 'strategy.created', 'strategy', id, { version });
  return getStrategy(db, id);
}

function updateStrategyParams(db, id, params, actor = 'planner') {
  const s = getStrategy(db, id);
  if (!s) throw httpError(404, 'strategy not found');
  if (s.status === 'active') throw httpError(409, '已激活策略不可原地修改，请复制为新版本');
  const p = validateParams(params);
  run(db, 'UPDATE strategies SET params = ? WHERE id = ?', JSON.stringify(p), id);
  audit(db, actor, 'strategy.updated', 'strategy', id, {});
  return getStrategy(db, id);
}

function activateStrategy(
  db,
  id,
  { asOf = todayIso(), actor = 'planner', confirm = false, migrationAcknowledged = false } = {},
) {
  const target = getStrategy(db, id);
  if (!target) throw httpError(404, 'strategy not found');
  if (target.status === 'active') throw httpError(409, '策略已激活');
  const current = activeStrategy(db);
  const preview = compareStrategies(db, current?.id, id, asOf);
  if (!confirm) {
    return { status: 'preview_required', preview };
  }
  if (preview.migration.requires_acknowledgement && !migrationAcknowledged) {
    throw httpError(
      409,
      '策略变更会迁移呆滞名单并产生潜在缺货影响，需显式确认 migration_acknowledged=true',
    );
  }
  return tx(db, () => {
    const now = new Date().toISOString();
    run(db, "UPDATE strategies SET status = 'retired' WHERE status = 'active'");
    run(db, 'UPDATE strategies SET status = ?, activated_at = ? WHERE id = ?', 'active', now, id);
    runMigration(db, current, target, asOf, {
      note: '策略切换',
      migration: preview.migration.summary,
      acknowledged: migrationAcknowledged,
    });
    audit(db, actor, 'strategy.activated', 'strategy', id, {
      from: current?.id || null,
      migration: preview.migration.summary,
      stockout_risk: preview.stockout_impact.total_projected_shortfall,
    });
    return {
      status: 'activated',
      strategy: getStrategy(db, id),
      preview,
      migration: { ...preview.migration, acknowledged: migrationAcknowledged },
    };
  });
}

/* ------------------------------------------------------------------ */
/* Analysis                                                            */
/* ------------------------------------------------------------------ */

function evaluate(db, { strategy, asOf, warehouseId, skuId, category, caliber }) {
  const p = strategy?.params || validateParams({});
  const effCaliber = caliber || p.caliber;
  const rows = batchStock(db, { asOf, caliber: effCaliber });
  const openDemand = demandForecast(db, asOf, p);
  const transferOptions = transferCandidates(db, asOf, p);

  const candidates = [];
  for (const r of rows) {
    if (warehouseId && r.warehouse_id !== warehouseId) continue;
    if (skuId && r.sku_id !== skuId) continue;
    if (category && r.category !== category) continue;
    if (r.physical_qty <= 0) continue;
    if (r.physical_qty < p.minBatchQty) continue;

    // Expired / frozen units are outside every selling caliber, so their
    // disposal quantity is the physical count, not the caliber quantity.
    const qty = r.expired || r.quality_hold ? r.physical_qty : r[`qty_${effCaliber}`];
    const target = bestTransferTarget(r, p, transferOptions);
    r.transfer_target = target;
    const causes = diagnose(r, p, qty, openDemand, transferOptions);
    if (!causes.length) continue;
    r.primary_cause = causes.slice().sort((a, b) => b.weight - a.weight)[0];
    const risk = riskScore(r, p, causes);
    const action = chooseAction(r, p, causes);
    candidates.push({
      batch_id: r.batch_id,
      batch_no: r.batch_no,
      sku_id: r.sku_id,
      sku_code: r.sku_code,
      sku_name: r.sku_name,
      category: r.category,
      warehouse_id: r.warehouse_id,
      warehouse_name: r.warehouse_name,
      production_date: r.production_date,
      expiry_date: r.expiry_date,
      inbound_date: r.inbound_date,
      age_days: r.age_days,
      residual_days: r.residual_days,
      residual_ratio: r.residual_ratio,
      physical_qty: r.physical_qty,
      good_qty: r.good_qty,
      available_qty: r.available_qty,
      sellable_qty: r.sellable_qty,
      reserved_qty: r.reserved_qty,
      expired: r.expired,
      quality_hold: r.quality_hold,
      caliber: effCaliber,
      qty,
      stock_value: round(qty * r.unit_cost, 2),
      unit_cost: r.unit_cost,
      daily_velocity: r.daily_velocity,
      days_cover: r.daily_velocity > 0 ? round(qty / r.daily_velocity, 1) : null,
      days_since_last_sale: r.days_since_last_sale,
      risk_score: risk,
      risk_level: risk >= 70 ? 'critical' : risk >= 45 ? 'warning' : 'watch',
      causes,
      primary_cause: r.primary_cause.code,
      transfer_target: target,
      suggested_action: action,
      alternatives: buildAlternatives(db, r, p, causes, transferOptions, qty),
    });
  }
  candidates.sort((a, b) => b.risk_score - a.risk_score || b.stock_value - a.stock_value);
  return {
    as_of: asOf,
    strategy: strategy ? { id: strategy.id, name: strategy.name, params: p } : { id: null, name: '临时口径', params: p },
    caliber: effCaliber,
    candidates,
    summary: summarize(db, candidates, p),
  };
}

function demandForecast(db, asOf, p) {
  // Daily sales velocity per warehouse+sku over a trailing window.
  const from = addDays(asOf, -p.transferLookbackDays);
  const rows = query(
    db,
    `SELECT sku_id, warehouse_id, -SUM(qty) AS sold
       FROM movements WHERE type = 'SALE' AND business_date > ? AND business_date <= ?
      GROUP BY sku_id, warehouse_id`,
    from,
    asOf,
  );
  const map = new Map();
  for (const r of rows) {
    map.set(`${r.warehouse_id}|${r.sku_id}`, round(r.sold / p.transferLookbackDays, 3));
  }
  return map;
}

function transferCandidates(db, asOf, p) {
  // For each sku, warehouses whose projected demand exceeds their supply.
  const stockRows = batchStock(db, { asOf, caliber: 'available' });
  const supply = new Map();
  const batchCount = new Map();
  for (const r of stockRows) {
    const key = `${r.warehouse_id}|${r.sku_id}`;
    supply.set(key, (supply.get(key) || 0) + r.available_qty);
    if (r.available_qty > 0) batchCount.set(key, (batchCount.get(key) || 0) + 1);
  }
  const velocity = demandForecast(db, asOf, p);
  const deficits = new Map();
  for (const [key, daily] of velocity) {
    const [, sku] = key.split('|');
    const horizon = p.forecastHorizonDays;
    const forecast = daily * horizon;
    const have = supply.get(key) || 0;
    if (forecast > have) deficits.set(key, round(forecast - have));
  }
  // Also account for warehouses with stock but no sales: they are donors.
  const donors = [];
  for (const [key, qty] of supply) {
    const [wh, sku] = key.split('|');
    const daily = velocity.get(key) || 0;
    if (qty > daily * p.forecastHorizonDays) donors.push({ warehouse_id: wh, sku_id: sku, surplus: round(qty - daily * p.forecastHorizonDays) });
  }
  return { deficits, donors, supply, velocity, batchCount };
}

function diagnose(r, p, qty, demand, transferOptions) {
  const causes = [];
  if (r.expired) {
    causes.push(cause('expired', '已过保质期', 100, `到期日 ${r.expiry_date}，已过期`, { qty }));
  }
  if (r.quality_hold) {
    causes.push(cause('quality_hold', '质量冻结', 95, '批次处于质量冻结/残损状态', { qty: r.physical_qty }));
  }
  if (!r.expired && r.residual_days <= p.nearExpiryDays) {
    const weight = 40 + Math.round(40 * (1 - Math.max(0, r.residual_days) / Math.max(1, p.nearExpiryDays)));
    causes.push(
      cause('near_expiry', '临近保质期', weight, `剩余 ${r.residual_days} 天 (阈值 ${p.nearExpiryDays} 天)`, {
        residual_days: r.residual_days,
      }),
    );
  } else if (!r.expired && r.residual_ratio <= p.nearExpiryRatio) {
    causes.push(
      cause('low_residual_ratio', '剩余货架期占比低', 35, `剩余 ${Math.round(r.residual_ratio * 100)}% (阈值 ${Math.round(p.nearExpiryRatio * 100)}%)`, {
        residual_ratio: r.residual_ratio,
      }),
    );
  }
  if (r.days_since_last_sale != null && r.days_since_last_sale >= p.deadStockDays) {
    causes.push(
      cause('dead_stock', '长期无销售', 60 + Math.min(30, r.days_since_last_sale - p.deadStockDays), `${r.days_since_last_sale} 天无销售 (阈值 ${p.deadStockDays} 天)`, {
        days_since_last_sale: r.days_since_last_sale,
      }),
    );
  } else if (r.days_since_last_sale != null && r.days_since_last_sale >= p.staleDays) {
    causes.push(
      cause('slow_moving', '销售停滞', 30 + Math.round(25 * Math.min(1, (r.days_since_last_sale - p.staleDays) / Math.max(1, p.deadStockDays - p.staleDays))), `${r.days_since_last_sale} 天无销售 (阈值 ${p.staleDays} 天)`, {
        days_since_last_sale: r.days_since_last_sale,
      }),
    );
  }
  if (r.daily_velocity > 0 && qty > 0) {
    const cover = qty / r.daily_velocity;
    if (cover >= p.slowMovingCoverDays) {
      causes.push(
        cause('overstock', '库存周转过慢', 35 + Math.min(25, Math.round(cover / p.slowMovingCoverDays * 10)), `可售覆盖 ${round(cover, 1)} 天 (阈值 ${p.slowMovingCoverDays} 天)`, {
          days_cover: round(cover, 1),
        }),
      );
    }
  }
  if (r.daily_velocity === 0 && r.age_days >= p.staleDays && !causes.some((c) => c.code === 'dead_stock')) {
    causes.push(cause('no_demand', '窗口内无动销', 25, `近 ${p.transferLookbackDays} 天该仓无销售`, {}));
  }
  if (qty <= 0 && r.physical_qty > 0 && !r.expired && !r.quality_hold) {
    causes.push(cause('fully_reserved', '可用量已扣减至零', 20, '全部数量被预留/安全库存占用', { reserved: r.reserved_qty }));
  }
  // Concentration: one batch holds most of the warehouse+sku stock.
  const concentration = concentrationFor(r, p, transferOptions);
  if (concentration >= p.concentrationRatio && qty > 0) {
    causes.push(
      cause('concentration', '库存集中', 15, `该批次占该仓该 SKU 库存 ${Math.round(concentration * 100)}%`, {
        concentration: round(concentration, 2),
      }),
    );
  }
  if (r.transfer_target && !r.expired && !r.quality_hold && r.residual_days > p.nearExpiryDays) {
    causes.push(
      cause('transfer_opportunity', '存在跨仓缺口', 30, `目标仓 ${r.transfer_target.warehouse_id} 未来 ${p.forecastHorizonDays} 天缺 ${r.transfer_target.gap}`, {
        target: r.transfer_target,
      }),
    );
  }
  return causes;
}

function bestTransferTarget(r, p, transferOptions) {
  // Expired or frozen stock cannot be shipped to fill another warehouse's gap.
  if (r.expired || r.quality_hold) return null;
  let best = null;
  for (const [key, gap] of transferOptions.deficits) {
    const [wh, sku] = key.split('|');
    if (sku !== r.sku_id || wh === r.warehouse_id) continue;
    if (!best || gap > best.gap) best = { warehouse_id: wh, gap: round(gap) };
  }
  return best;
}

function concentrationFor(r, p, transferOptions) {
  const supply = transferOptions.supply.get(`${r.warehouse_id}|${r.sku_id}`) || 0;
  const batchCount = transferOptions.batchCount.get(`${r.warehouse_id}|${r.sku_id}`) || 0;
  // A single-batch pair is trivially 100% "concentrated" - that is not a signal.
  if (supply <= 0 || batchCount < 2) return 0;
  return Math.min(1, r.available_qty / supply);
}

function cause(code, label, weight, evidence, data) {
  return { code, label, weight, evidence, data };
}

function riskScore(r, p, causes) {
  const w = causes.reduce((s, c) => s + c.weight, 0);
  const expiryPressure = r.residual_days >= 0 ? Math.max(0, 1 - r.residual_days / 120) * 20 : 20;
  const valuePressure = Math.min(15, Math.log10(1 + r.physical_qty * r.unit_cost) * 4);
  return Math.min(100, Math.round(w * 0.6 + expiryPressure + valuePressure));
}

function chooseAction(r, p, causes) {
  const codes = new Set(causes.map((c) => c.code));
  // Expired / frozen stock can only be written off or returned; no commercial
  // action can restore it to sellable.
  if (codes.has('expired') || codes.has('quality_hold')) {
    return p.autoActionRules.expired === 'return_to_supplier' ? 'return_to_supplier' : 'dispose';
  }
  const scores = { dispose: 2, discount: 6, transfer: 4, return_to_supplier: 1, keep: 5 };
  const transferable = Boolean(r.transfer_target);
  const primary = r.primary_cause;

  if (codes.has('near_expiry')) {
    scores.discount += 45;
    if (transferable) scores.transfer += 55;
  }
  if (codes.has('low_residual_ratio')) {
    scores.discount += 30;
    if (transferable) scores.transfer += 25;
  }
  if (codes.has('dead_stock')) {
    scores.return_to_supplier += 45;
    scores.discount += 25;
    if (transferable) scores.transfer += 20;
  }
  if (codes.has('no_demand') || codes.has('slow_moving')) {
    if (transferable) scores.transfer += 35;
    scores.return_to_supplier += 20;
  }
  if (codes.has('overstock')) {
    scores.transfer += transferable ? 30 : 0;
    scores.discount += 15;
  }
  // Strategy preferences act as a tie-breaker, not an override: an infeasible
  // preference (e.g. transfer with no deficit elsewhere) must not win.
  const preferred = {
    near_expiry: p.autoActionRules.nearExpiry,
    low_residual_ratio: p.autoActionRules.nearExpiry,
    dead_stock: p.autoActionRules.stale,
    no_demand: p.autoActionRules.stale,
    slow_moving: p.autoActionRules.slowMoving,
    overstock: p.autoActionRules.slowMoving,
  };
  for (const [code, action] of Object.entries(preferred)) {
    if (codes.has(code) && action && scores[action] != null) scores[action] += 8;
  }
  let best = 'keep';
  for (const [action, score] of Object.entries(scores)) {
    if (action === 'transfer' && !transferable) continue;
    if (scores[best] == null || score > scores[best]) best = action;
  }
  return best;
}

function buildAlternatives(db, r, p, causes, transferOptions, qty) {
  const alts = [];
  const target = r.transfer_target;
  if (target && qty > 0) {
    alts.push({
      action: 'transfer',
      label: `调拨至 ${r.transfer_target.warehouse_id}`,
      warehouse_id: target.warehouse_id,
      qty: Math.min(qty, target.gap),
      rationale: `目标仓未来 ${p.forecastHorizonDays} 天预计缺口 ${target.gap}`,
      score: 90,
    });
  }
  if (p.includeSubstitutes) {
    const subs = query(
      db,
      `SELECT s.*, COALESCE(SUM(CASE WHEN m.business_date <= ? THEN m.qty ELSE 0 END),0) AS on_hand
         FROM skus s LEFT JOIN batches b ON b.sku_id = s.id
         LEFT JOIN movements m ON m.batch_id = b.id
        WHERE s.substitute_group = ? AND s.id != ?
        GROUP BY s.id ORDER BY s.id`,
      new Date().toISOString().slice(0, 10),
      r.substitute_group,
      r.sku_id,
    );
    for (const s of subs) {
      alts.push({
        action: 'substitute',
        label: `替代品 ${s.code}`,
        sku_id: s.id,
        qty,
        rationale: `同替代组 ${r.substitute_group}，可承接促销/调拨需求`,
        score: 60,
      });
    }
  }
  if (qty > 0) {
    alts.push({
      action: 'discount',
      label: '折价促销',
      qty,
      discount_pct: Math.min(60, 10 + Math.round(riskScore(r, p, causes) / 2)),
      rationale: '以毛利换周转，避免进入报废',
      score: 50,
    });
  }
  alts.push({
    action: 'dispose',
    label: '报废处置',
    qty: r.expired || r.quality_hold ? r.physical_qty : qty,
    rationale: causes[0] ? causes[0].evidence : '按策略处置',
    score: r.expired || r.quality_hold ? 95 : 20,
  });
  return alts.sort((a, b) => b.score - a.score);
}

function summarize(db, candidates, p) {
  const byWarehouse = new Map();
  const byAction = new Map();
  const byCause = new Map();
  let value = 0;
  for (const c of candidates) {
    value += c.stock_value;
    byWarehouse.set(c.warehouse_id, (byWarehouse.get(c.warehouse_id) || 0) + c.qty);
    byAction.set(c.suggested_action, (byAction.get(c.suggested_action) || 0) + 1);
    for (const cause of c.causes) byCause.set(cause.code, (byCause.get(cause.code) || 0) + 1);
  }
  return {
    candidates: candidates.length,
    qty: round(candidates.reduce((s, c) => s + c.qty, 0)),
    value: round(value, 2),
    critical: candidates.filter((c) => c.risk_level === 'critical').length,
    by_warehouse: [...byWarehouse].map(([id, qty]) => ({ warehouse_id: id, qty: round(qty) })),
    by_action: [...byAction].map(([action, n]) => ({ action, label: ACTION_META[action]?.label || action, count: n })),
    by_cause: [...byCause].map(([code, n]) => ({ code, count: n })),
    params: p,
  };
}

/**
 * Strategy migration preview: what leaves / enters / changes on the slow-moving
 * list, plus the projected stockout impact of each newly proposed disposal.
 */
function compareStrategies(db, fromId, toId, asOf) {
  const from = fromId ? getStrategy(db, fromId) : null;
  const to = getStrategy(db, toId);
  if (!to) throw httpError(404, 'target strategy not found');
  const before = from ? evaluate(db, { strategy: from, asOf }) : { candidates: [], summary: summarize(db, [], to.params) };
  const after = evaluate(db, { strategy: to, asOf });
  const beforeMap = new Map(before.candidates.map((c) => [c.batch_id, c]));
  const afterMap = new Map(after.candidates.map((c) => [c.batch_id, c]));
  const added = [...afterMap].filter(([id]) => !beforeMap.has(id)).map(([, c]) => c);
  const removed = [...beforeMap].filter(([id]) => !afterMap.has(id)).map(([, c]) => c);
  const changed = [...afterMap]
    .filter(([id]) => beforeMap.has(id))
    .map(([, c]) => ({ ...c, previous_action: beforeMap.get(c.batch_id).suggested_action }))
    .filter((c) => c.previous_action !== c.suggested_action);

  const impact = stockoutImpact(db, to, asOf, after.candidates, beforeMap);
  const valueDelta = round(after.summary.value - before.summary.value, 2);
  return {
    as_of: asOf,
    from: from ? { id: from.id, name: from.name, params: from.params } : null,
    to: { id: to.id, name: to.name, params: to.params },
    before: before.summary,
    after: after.summary,
    migration: {
      added,
      removed,
      changed,
      summary: {
        added: added.length,
        removed: removed.length,
        changed: changed.length,
        value_delta: valueDelta,
      },
      requires_acknowledgement: added.length + removed.length + changed.length > 0,
      acknowledged: false,
    },
    stockout_impact: impact,
  };
}

function stockoutImpact(db, strategy, asOf, candidates, beforeMap) {
  const p = strategy.params;
  const horizon = p.forecastHorizonDays;
  const risk = [];
  for (const c of candidates) {
    const action = c.suggested_action;
    if (!['dispose', 'discount', 'transfer'].includes(action)) continue;
    const prev = beforeMap.get(c.batch_id);
    if (prev && prev.suggested_action === action) continue; // not new pressure
    const daily = c.daily_velocity || 0;
    const projectedDemand = round(daily * horizon);
    const loss = action === 'dispose' ? c.qty : action === 'transfer' ? c.qty : 0;
    const supplyAfter = round(Math.max(0, c.available_qty - loss));
    if (projectedDemand > supplyAfter) {
      const other = otherSupply(db, asOf, c.warehouse_id, c.sku_id, c.batch_id);
      const gap = round(projectedDemand - supplyAfter - other);
      if (gap > 0) {
        risk.push({
          warehouse_id: c.warehouse_id,
          warehouse_name: c.warehouse_name,
          sku_id: c.sku_id,
          sku_code: c.sku_code,
          batch_id: c.batch_id,
          action,
          projected_demand: projectedDemand,
          supply_after: supplyAfter,
          other_supply: other,
          projected_shortfall: gap,
          severity: gap > projectedDemand * 0.5 ? 'critical' : 'warning',
          note:
            action === 'transfer'
              ? '调拨后本仓覆盖不足，需同步补货'
              : '处置后未来需求可能无法满足',
        });
      }
    }
  }
  const frozenInventory = candidates.filter((c) => c.suggested_action === 'dispose').reduce((s, c) => s + c.qty, 0);
  return {
    horizon_days: horizon,
    at_risk: risk.sort((a, b) => b.projected_shortfall - a.projected_shortfall),
    total_projected_shortfall: round(risk.reduce((s, r) => s + r.projected_shortfall, 0)),
    disposal_qty: round(frozenInventory),
  };
}

function otherSupply(db, asOf, warehouseId, skuId, excludeBatchId) {
  const rows = batchStock(db, { asOf, caliber: 'available' }).filter(
    (r) => r.warehouse_id === warehouseId && r.sku_id === skuId && r.batch_id !== excludeBatchId,
  );
  return round(rows.reduce((s, r) => s + r.available_qty, 0));
}

module.exports = {
  DEFAULT_PARAMS,
  ACTION_META,
  validateParams,
  seedStrategies,
  getStrategy,
  activeStrategy,
  createStrategy,
  updateStrategyParams,
  activateStrategy,
  evaluate,
  compareStrategies,
  stockoutImpact,
  demandForecast,
};
