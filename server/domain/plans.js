'use strict';

const { query, getRow, run, tx } = require('../lib/db');
const { todayIso, addDays } = require('../lib/dates');
const { round } = require('./inventory');
const {
  uid,
  audit,
  httpError,
  batchAvailableAt,
  batchPhysicalAt,
  committedAfter,
} = require('./ingest');
const { ACTION_META } = require('./strategy');

const PLAN_STATUS = ['pending_approval', 'approved', 'rejected', 'executed', 'rolled_back', 'cancelled'];

function createPlan(db, input, actor = 'planner') {
  const { batch_id, action, qty } = input;
  if (!ACTION_META[action]) throw httpError(400, `unknown action: ${action}`);
  if (!(qty > 0)) throw httpError(400, 'qty must be > 0');
  const batch = getRow(
    db,
    `SELECT b.*, s.code AS sku_code, s.name AS sku_name FROM batches b JOIN skus s ON s.id = b.sku_id WHERE b.id = ?`,
    batch_id,
  );
  if (!batch) throw httpError(404, 'batch not found');
  const strategyId = input.strategy_id || getRow(db, "SELECT id FROM strategies WHERE status='active'")?.id || null;
  return tx(db, () => {
    const id = uid('plan');
    let toWarehouse = input.to_warehouse || null;
    if (action === 'transfer') {
      if (!toWarehouse) throw httpError(400, '调拨计划必须指定 to_warehouse');
      if (toWarehouse === batch.warehouse_id) throw httpError(400, '目标仓不能与来源仓相同');
      if (!getRow(db, 'SELECT id FROM warehouses WHERE id = ?', toWarehouse)) {
        throw httpError(400, 'target warehouse not found');
      }
      const available = round(
        batchAvailableAt(db, batch_id, todayIso()) - committedAfter(db, batch_id, todayIso()),
      );
      if (qty > available) {
        throw httpError(409, `调拨数量超过可用量：可用 ${available}`);
      }
    }
    run(
      db,
      `INSERT INTO plans (id, strategy_id, sku_id, warehouse_id, batch_id, action, qty, to_warehouse,
          rationale, causes, status, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      strategyId,
      batch.sku_id,
      batch.warehouse_id,
      batch_id,
      action,
      round(qty),
      toWarehouse,
      input.rationale || null,
      JSON.stringify(input.causes || []),
      'pending_approval',
      actor,
      new Date().toISOString(),
    );
    audit(db, actor, 'plan.created', 'plan', id, { action, qty, batch_id, to_warehouse: toWarehouse });
    return getPlan(db, id);
  });
}

function getPlan(db, id) {
  const p = getRow(db, 'SELECT * FROM plans WHERE id = ?', id);
  if (!p) return null;
  const tasks = query(db, 'SELECT * FROM tasks WHERE plan_id = ? ORDER BY created_at', id).map((t) => ({
    ...t,
    versions: query(db, 'SELECT * FROM task_versions WHERE task_id = ? ORDER BY version', t.id).map(
      (v) => ({ ...v, payload: JSON.parse(v.payload), result: v.result ? JSON.parse(v.result) : null }),
    ),
  }));
  return { ...p, causes: p.causes ? JSON.parse(p.causes) : [], tasks };
}

function listPlans(db, { status, batchId, warehouseId, skuId, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (status) {
    where.push('p.status = ?');
    args.push(status);
  }
  if (batchId) {
    where.push('p.batch_id = ?');
    args.push(batchId);
  }
  if (warehouseId) {
    where.push('p.warehouse_id = ?');
    args.push(warehouseId);
  }
  if (skuId) {
    where.push('p.sku_id = ?');
    args.push(skuId);
  }
  const rows = query(
    db,
    `SELECT p.*, b.batch_no, s.code AS sku_code, s.name AS sku_name, w.name AS warehouse_name,
            (SELECT COUNT(*) FROM tasks t WHERE t.plan_id = p.id) AS task_count
       FROM plans p
       JOIN batches b ON b.id = p.batch_id
       JOIN skus s ON s.id = p.sku_id
       JOIN warehouses w ON w.id = p.warehouse_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY p.created_at DESC LIMIT ?`,
    ...args,
    limit,
  );
  return rows.map((r) => ({ ...r, causes: r.causes ? JSON.parse(r.causes) : [] }));
}

function approvePlan(db, id, { actor = 'approver', decision = 'approve', note } = {}) {
  const plan = getRow(db, 'SELECT * FROM plans WHERE id = ?', id);
  if (!plan) throw httpError(404, 'plan not found');
  if (plan.status !== 'pending_approval') {
    throw httpError(409, `计划状态为 ${plan.status}，不能审批`);
  }
  return tx(db, () => {
    if (decision === 'reject') {
      run(
        db,
        `UPDATE plans SET status = 'rejected', rejected_by = ?, rejected_at = ? WHERE id = ?`,
        actor,
        new Date().toISOString(),
        id,
      );
      audit(db, actor, 'plan.rejected', 'plan', id, { note: note || null });
      return getPlan(db, id);
    }
    // The plan may have aged while it sat in the queue; re-check what the batch
    // can still support before turning it into an executable task.
    const asOf = todayIso();
    const batch = getRow(db, 'SELECT * FROM batches WHERE id = ?', plan.batch_id);
    if (!batch) throw httpError(409, '计划对应批次已不存在');
    if (plan.action === 'dispose') {
      const onHand = batchPhysicalAt(db, plan.batch_id, asOf);
      if (plan.qty > onHand) {
        throw httpError(409, `审批时在手量不足：在手 ${onHand}，计划 ${plan.qty}`);
      }
    } else if (plan.action === 'transfer') {
      const free = round(
        batchAvailableAt(db, plan.batch_id, asOf) - committedAfter(db, plan.batch_id, asOf),
      );
      if (plan.qty > free) {
        throw httpError(409, `审批时可用量不足：可用 ${free}，计划 ${plan.qty}`);
      }
    }
    const taskId = uid('task');
    const payload = {
      action: plan.action,
      qty: plan.qty,
      batch_id: plan.batch_id,
      sku_id: plan.sku_id,
      from_warehouse: plan.warehouse_id,
      to_warehouse: plan.to_warehouse,
      plan_id: plan.id,
    };
    const kind = plan.action === 'transfer' ? 'TRANSFER' : plan.action === 'dispose' ? 'DISPOSAL' : plan.action === 'discount' ? 'PRICE_MARKDOWN' : 'SUBSTITUTE_MERGE';
    run(
      db,
      `INSERT INTO tasks (id, plan_id, kind, sku_id, batch_id, from_warehouse, to_warehouse, qty,
          status, current_version, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      taskId,
      plan.id,
      kind,
      plan.sku_id,
      plan.batch_id,
      plan.warehouse_id,
      plan.to_warehouse,
      plan.qty,
      'ready',
      1,
      new Date().toISOString(),
    );
    run(
      db,
      `INSERT INTO task_versions (task_id, version, payload, status, created_at)
       VALUES (?,?,?,?,?)`,
      taskId,
      1,
      JSON.stringify(payload),
      'ready',
      new Date().toISOString(),
    );
    run(
      db,
      `UPDATE plans SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?`,
      actor,
      new Date().toISOString(),
      id,
    );
    audit(db, actor, 'plan.approved', 'plan', id, { task_id: taskId, note: note || null });
    return getPlan(db, id);
  });
}

function getTask(db, id) {
  const t = getRow(db, 'SELECT * FROM tasks WHERE id = ?', id);
  if (!t) return null;
  const versions = query(db, 'SELECT * FROM task_versions WHERE task_id = ? ORDER BY version', id).map(
    (v) => ({
      ...v,
      payload: JSON.parse(v.payload),
      result: v.result ? JSON.parse(v.result) : null,
    }),
  );
  return { ...t, versions };
}

function listTasks(db, { status, planId, limit = 200 } = {}) {
  const rows = query(
    db,
    `SELECT t.*, p.action, b.batch_no, s.code AS sku_code, s.name AS sku_name
       FROM tasks t JOIN plans p ON p.id = t.plan_id
       JOIN batches b ON b.id = t.batch_id JOIN skus s ON s.id = t.sku_id
      ${status ? 'WHERE t.status = ?' : ''}
      ${planId ? (status ? 'AND' : 'WHERE') + ' t.plan_id = ?' : ''}
      ORDER BY t.created_at DESC LIMIT ?`,
    ...(status ? [status] : []),
    ...(planId ? [planId] : []),
    limit,
  );
  // The task list feeds the approval UI, which renders the version strip, so
  // versions travel with the rows instead of requiring one request per task.
  return rows.map((t) => ({
    ...t,
    versions: query(db, 'SELECT * FROM task_versions WHERE task_id = ? ORDER BY version', t.id).map(
      (v) => ({
        ...v,
        payload: JSON.parse(v.payload),
        result: v.result ? JSON.parse(v.result) : null,
      }),
    ),
  }));
}

/**
 * Revise a task. Bumping the version supersedes the prior one; the old row is
 * kept for audit. Executed versions can only be revised by an execution that
 * creates a compensating (rollback) version, never by rewriting history.
 */
function reviseTask(db, id, patch, actor = 'planner') {
  const task = getTask(db, id);
  if (!task) throw httpError(404, 'task not found');
  if (task.status === 'rolled_back') throw httpError(409, '已回滚任务不可再修订');
  if (task.status === 'executed') {
    throw httpError(409, '已执行任务需先回滚生成新版本，不能直接修订');
  }
  const current = task.versions.find((v) => v.version === task.current_version);
  if (!current) throw httpError(409, 'current version missing');
  if (current.status === 'executed') throw httpError(409, '当前版本已执行，不能修订');
  const qty = patch.qty != null ? round(patch.qty) : current.payload.qty;
  if (!(qty > 0)) throw httpError(400, 'qty must be > 0');
  const toWarehouse = patch.to_warehouse ?? current.payload.to_warehouse;
  if (current.payload.action === 'transfer') {
    if (!toWarehouse) throw httpError(400, '调拨必须指定目标仓');
    if (toWarehouse === current.payload.from_warehouse) throw httpError(400, '目标仓不能与来源仓相同');
    const available = round(
      batchAvailableAt(db, current.payload.batch_id, todayIso()) -
        committedAfter(db, current.payload.batch_id, todayIso()),
    );
    if (qty > available) throw httpError(409, `修订数量超过可用量：可用 ${available}`);
  }
  return tx(db, () => {
    const nextVersion = task.current_version + 1;
    const payload = {
      ...current.payload,
      qty,
      to_warehouse: toWarehouse,
      reason: patch.reason || null,
    };
    run(
      db,
      `UPDATE task_versions SET status = 'superseded', superseded_at = ? WHERE task_id = ? AND version = ?`,
      new Date().toISOString(),
      id,
      task.current_version,
    );
    run(
      db,
      `INSERT INTO task_versions (task_id, version, payload, status, created_at)
       VALUES (?,?,?,?,?)`,
      id,
      nextVersion,
      JSON.stringify(payload),
      'ready',
      new Date().toISOString(),
    );
    run(db, 'UPDATE tasks SET current_version = ?, qty = ?, to_warehouse = ? WHERE id = ?', nextVersion, qty, toWarehouse, id);
    audit(db, actor, 'task.revised', 'task', id, {
      version: nextVersion,
      qty,
      previous_qty: current.payload.qty,
      reason: patch.reason || null,
    });
    return getTask(db, id);
  });
}

function applyTaskMovements(db, task, version, asOf, direction = 1) {
  const p = version.payload;
  const qty = round(p.qty) * direction;
  const receivedAt = new Date().toISOString();
  const refBase = `TASK:${task.id}:v${version.version}:${direction > 0 ? 'EXEC' : 'RB'}`;
  const movements = [];
  const negative = direction > 0;
  if (p.action === 'dispose') {
    const rollback = !negative;
    if (negative) {
      // Write-offs consume physical stock, so expired/frozen batches are valid.
      const available = round(batchPhysicalAt(db, p.batch_id, asOf));
      if (qty > available) {
        throw httpError(409, `可处置量不足：在手 ${available}，计划处置 ${qty}`);
      }
    }
    // Execution posts a negative DISPOSAL; rollback posts a positive ADJUSTMENT
    // so the batch's on-hand is restored instead of being written off twice.
    const externalRef = `${refBase}:${rollback ? 'ADJ' : 'DISP'}`;
    run(
      db,
      `INSERT INTO movements (external_ref, type, sku_id, warehouse_id, batch_id, qty, condition,
          business_date, received_at, late, meta)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      externalRef,
      rollback ? 'ADJUSTMENT' : 'DISPOSAL',
      p.sku_id,
      p.from_warehouse,
      p.batch_id,
      rollback ? Math.abs(qty) : -Math.abs(qty),
      'good',
      asOf,
      receivedAt,
      0,
      JSON.stringify({ task_id: task.id, version: version.version, direction, rollback }),
    );
    movements.push(externalRef);
  } else if (p.action === 'transfer') {
    const source = getRow(db, 'SELECT * FROM batches WHERE id = ?', p.batch_id);
    if (!source) throw httpError(404, 'source batch not found');
    if (direction > 0) {
      const available = round(
        batchAvailableAt(db, p.batch_id, asOf) - committedAfter(db, p.batch_id, asOf),
      );
      if (qty > available) {
        throw httpError(409, `源仓可用量不足：可用 ${available}，调拨 ${qty}`);
      }
    }
    const destNo = `${source.batch_no}@${p.to_warehouse}`;
    let dest = getRow(db, 'SELECT * FROM batches WHERE batch_no = ? AND warehouse_id = ?', destNo, p.to_warehouse);
    if (direction > 0) {
      if (!dest) {
        dest = { id: uid('bat') };
        run(
          db,
          `INSERT INTO batches (id, batch_no, sku_id, warehouse_id, production_date, expiry_date,
              inbound_date, quality_status, source_batch_no)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          dest.id,
          destNo,
          source.sku_id,
          p.to_warehouse,
          source.production_date,
          source.expiry_date,
          asOf,
          source.quality_status,
          source.batch_no,
        );
      }
      const outRef = `${refBase}:OUT`;
      run(
        db,
        `INSERT INTO movements (external_ref, type, sku_id, warehouse_id, batch_id, qty, condition,
            business_date, received_at, late, meta)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        outRef,
        'TRANSFER_OUT',
        source.sku_id,
        source.warehouse_id,
        source.id,
        -Math.abs(qty),
        'good',
        asOf,
        receivedAt,
        0,
        JSON.stringify({ task_id: task.id, to_warehouse: p.to_warehouse }),
      );
      const inRef = `${refBase}:IN`;
      run(
        db,
        `INSERT INTO movements (external_ref, type, sku_id, warehouse_id, batch_id, qty, condition,
            business_date, received_at, late, meta)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        inRef,
        'TRANSFER_IN',
        source.sku_id,
        p.to_warehouse,
        dest.id,
        Math.abs(qty),
        'good',
        asOf,
        receivedAt,
        0,
        JSON.stringify({ task_id: task.id, from_warehouse: source.warehouse_id }),
      );
      movements.push(outRef, inRef);
    } else {
      if (!dest) throw httpError(409, '目标仓批次不存在，无法回滚');
      const destAvail = round(
        batchAvailableAt(db, dest.id, asOf) - committedAfter(db, dest.id, asOf),
      );
      if (qty > destAvail) {
        throw httpError(409, `目标仓可回滚量不足：可用 ${destAvail}，回滚 ${qty}`);
      }
      const outRef = `${refBase}:OUT`;
      run(
        db,
        `INSERT INTO movements (external_ref, type, sku_id, warehouse_id, batch_id, qty, condition,
            business_date, received_at, late, meta)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        outRef,
        'TRANSFER_OUT',
        source.sku_id,
        p.to_warehouse,
        dest.id,
        -Math.abs(qty),
        'good',
        asOf,
        receivedAt,
        0,
        JSON.stringify({ task_id: task.id, rollback: true }),
      );
      const inRef = `${refBase}:IN`;
      run(
        db,
        `INSERT INTO movements (external_ref, type, sku_id, warehouse_id, batch_id, qty, condition,
            business_date, received_at, late, meta)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        inRef,
        'TRANSFER_IN',
        source.sku_id,
        p.from_warehouse,
        source.id,
        Math.abs(qty),
        'good',
        asOf,
        receivedAt,
        0,
        JSON.stringify({ task_id: task.id, rollback: true }),
      );
      movements.push(outRef, inRef);
    }
  } else if (p.action === 'discount' || p.action === 'substitute') {
    // No quantity movement: these are commercial actions; record in audit only.
  } else {
    throw httpError(400, `unsupported task action: ${p.action}`);
  }
  return movements;
}

function executeTask(db, id, { actor = 'operator', asOf = todayIso(), version, confirm = false } = {}) {
  const task = getTask(db, id);
  if (!task) throw httpError(404, 'task not found');
  if (task.status === 'executed') throw httpError(409, '任务已执行');
  if (task.status === 'rolled_back') throw httpError(409, '任务已回滚');
  if (task.status === 'cancelled') throw httpError(409, '任务已取消，不能执行');
  const vNum = version || task.current_version;
  const v = task.versions.find((x) => x.version === vNum);
  if (!v) throw httpError(404, 'version not found');
  if (v.status === 'superseded') throw httpError(409, '该版本已被新版本替代');
  if (v.status === 'executed') throw httpError(409, '该版本已执行');
  if (v.status === 'rolled_back') throw httpError(409, '该版本已回滚');
  const preview = previewTask(db, task, v, asOf);
  if (!confirm) return { status: 'preview_required', preview };
  if (preview.blockers.length) {
    throw httpError(409, preview.blockers.join('；'));
  }
  return tx(db, () => {
    const movements = applyTaskMovements(db, task, v, asOf, 1);
    const result = {
      movements,
      as_of: asOf,
      executed_qty: v.payload.qty,
      action: v.payload.action,
      version: v.version,
    };
    run(
      db,
      `UPDATE task_versions SET status = 'executed', executed_at = ?, result = ? WHERE task_id = ? AND version = ?`,
      new Date().toISOString(),
      JSON.stringify(result),
      id,
      v.version,
    );
    run(db, "UPDATE tasks SET status = 'executed' WHERE id = ?", id);
    run(db, "UPDATE plans SET status = 'executed' WHERE id = ?", task.plan_id);
    audit(db, actor, 'task.executed', 'task', id, result);
    return { status: 'executed', task: getTask(db, id), preview };
  });
}

function previewTask(db, task, v, asOf) {
  const p = v.payload;
  const blockers = [];
  const effects = [];
  if (p.action === 'dispose') {
    const available = round(batchPhysicalAt(db, p.batch_id, asOf));
    if (p.qty > available) blockers.push(`可处置量不足：在手 ${available}，计划处置 ${p.qty}`);
    effects.push({ warehouse_id: p.from_warehouse, batch_id: p.batch_id, delta: -p.qty });
  } else if (p.action === 'transfer') {
    const available = round(batchAvailableAt(db, p.batch_id, asOf) - committedAfter(db, p.batch_id, asOf));
    if (p.qty > available) blockers.push(`源仓可用量不足：可用 ${available}，调拨 ${p.qty}`);
    if (!getRow(db, 'SELECT id FROM warehouses WHERE id = ?', p.to_warehouse)) blockers.push('目标仓不存在');
    effects.push({ warehouse_id: p.from_warehouse, batch_id: p.batch_id, delta: -p.qty });
    effects.push({ warehouse_id: p.to_warehouse, batch_id: null, delta: p.qty });
  } else if (p.action === 'discount' || p.action === 'substitute') {
    effects.push({ warehouse_id: p.from_warehouse, batch_id: p.batch_id, delta: 0, note: '仅商务动作，不改变库存数量' });
  }
  return {
    task_id: task.id,
    version: v.version,
    action: p.action,
    qty: p.qty,
    as_of: asOf,
    effects,
    blockers,
    reversible: p.action !== 'substitute',
  };
}

function rollbackTask(
  db,
  id,
  { actor = 'operator', asOf = todayIso(), version, reason = null, confirm = false, force = false } = {},
) {
  const task = getTask(db, id);
  if (!task) throw httpError(404, 'task not found');
  const vNum = version || task.current_version;
  const v = task.versions.find((x) => x.version === vNum);
  if (!v) throw httpError(404, 'version not found');
  if (v.status !== 'executed') throw httpError(409, `版本状态为 ${v.status}，无法回滚`);
  if ((v.result && v.result.rolled_back) === true) throw httpError(409, '该版本已回滚');
  const preview = previewRollback(db, task, v, asOf);
  if (!confirm) return { status: 'preview_required', preview };
  // A forced rollback is only permitted with an explicit written reason so the
  // override is auditable; it bypasses policy blockers, never quantity checks.
  if (preview.blockers.length && !(force && reason)) {
    throw httpError(409, preview.blockers.join('；'));
  }
  const quantityBlockers = preview.blockers.filter((b) => b.includes('量不足') || b.includes('不存在'));
  if (force && quantityBlockers.length) {
    throw httpError(409, `数量性阻断不可强制回滚：${quantityBlockers.join('；')}`);
  }
  return tx(db, () => {
    const movements = applyTaskMovements(db, task, v, asOf, -1);
    const result = {
      ...(v.result || {}),
      rolled_back: true,
      rollback_movements: movements,
      rolled_back_at: new Date().toISOString(),
      rollback_reason: reason,
      forced: Boolean(force && preview.blockers.length),
      waived_blockers: force ? preview.blockers : [],
    };
    run(
      db,
      `UPDATE task_versions SET status = 'rolled_back', rolled_back_at = ?, result = ? WHERE task_id = ? AND version = ?`,
      new Date().toISOString(),
      JSON.stringify(result),
      id,
      v.version,
    );
    run(db, "UPDATE tasks SET status = 'rolled_back' WHERE id = ?", id);
    run(db, "UPDATE plans SET status = 'rolled_back' WHERE id = ?", task.plan_id);
    audit(db, actor, 'task.rolled_back', 'task', id, {
      version: v.version,
      reason,
      movements,
      forced: result.forced,
      waived_blockers: result.waived_blockers,
    });
    return { status: 'rolled_back', task: getTask(db, id), preview };
  });
}

function previewRollback(db, task, v, asOf) {
  const p = v.payload;
  const blockers = [];
  const effects = [];
  if (p.action === 'dispose') {
    // Rollback of a disposal re-adds goods, which would resurrect expired stock.
    const batch = getRow(db, 'SELECT * FROM batches WHERE id = ?', p.batch_id);
    if (batch && batch.expiry_date < asOf) {
      blockers.push('批次已过期，回滚会重新引入不可售库存，请改走称重/调整流程');
    }
    effects.push({ warehouse_id: p.from_warehouse, batch_id: p.batch_id, delta: p.qty });
  } else if (p.action === 'transfer') {
    const source = getRow(db, 'SELECT * FROM batches WHERE id = ?', p.batch_id);
    const destNo = source ? `${source.batch_no}@${p.to_warehouse}` : null;
    const dest = destNo
      ? getRow(db, 'SELECT * FROM batches WHERE batch_no = ? AND warehouse_id = ?', destNo, p.to_warehouse)
      : null;
    if (!dest) {
      blockers.push('目标仓批次不存在，无法回滚');
    } else {
      const avail = round(batchAvailableAt(db, dest.id, asOf) - committedAfter(db, dest.id, asOf));
      if (p.qty > avail) blockers.push(`目标仓可回滚量不足：可用 ${avail}，计划回滚 ${p.qty}`);
    }
    effects.push({ warehouse_id: p.to_warehouse, batch_id: dest?.id || null, delta: -p.qty });
    effects.push({ warehouse_id: p.from_warehouse, batch_id: p.batch_id, delta: p.qty });
  } else if (p.action === 'discount') {
    effects.push({ warehouse_id: p.from_warehouse, batch_id: p.batch_id, delta: 0, note: '撤销价格标记' });
  }
  return { task_id: task.id, version: v.version, action: p.action, qty: p.qty, as_of: asOf, effects, blockers, reversible: p.action !== 'substitute' };
}

function cancelPlan(db, id, { actor = 'planner' } = {}) {
  const plan = getRow(db, 'SELECT * FROM plans WHERE id = ?', id);
  if (!plan) throw httpError(404, 'plan not found');
  if (!['pending_approval', 'approved'].includes(plan.status)) {
    throw httpError(409, `计划状态为 ${plan.status}，不能取消`);
  }
  const executed = getRow(
    db,
    "SELECT COUNT(*) AS n FROM tasks WHERE plan_id = ? AND status = 'executed'",
    id,
  );
  if (executed.n > 0) throw httpError(409, '计划已执行任务，不能取消');
  return tx(db, () => {
    run(db, "UPDATE plans SET status = 'cancelled' WHERE id = ?", id);
    run(db, "UPDATE tasks SET status = 'cancelled' WHERE plan_id = ? AND status = 'ready'", id);
    run(
      db,
      "UPDATE task_versions SET status = 'cancelled', superseded_at = ? WHERE task_id IN (SELECT id FROM tasks WHERE plan_id = ?) AND status = 'ready'",
      new Date().toISOString(),
      id,
    );
    audit(db, actor, 'plan.cancelled', 'plan', id, {});
    return getPlan(db, id);
  });
}

module.exports = {
  PLAN_STATUS,
  createPlan,
  getPlan,
  listPlans,
  approvePlan,
  getTask,
  listTasks,
  reviseTask,
  executeTask,
  previewTask,
  rollbackTask,
  previewRollback,
  cancelPlan,
};
