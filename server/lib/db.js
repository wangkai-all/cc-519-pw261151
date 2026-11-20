'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS warehouses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  region TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skus (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  shelf_life_days INTEGER NOT NULL,
  unit_cost REAL NOT NULL,
  retail_price REAL NOT NULL,
  safety_days INTEGER NOT NULL DEFAULT 3,
  substitute_group TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  batch_no TEXT NOT NULL,
  sku_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  production_date TEXT NOT NULL,
  expiry_date TEXT NOT NULL,
  inbound_date TEXT NOT NULL,
  quality_status TEXT NOT NULL DEFAULT 'normal',
  source_batch_no TEXT,
  UNIQUE(batch_no, warehouse_id)
);

CREATE TABLE IF NOT EXISTS movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_ref TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  sku_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  qty REAL NOT NULL,
  condition TEXT NOT NULL DEFAULT 'good',
  business_date TEXT NOT NULL,
  received_at TEXT NOT NULL,
  late INTEGER NOT NULL DEFAULT 0,
  meta TEXT
);

CREATE INDEX IF NOT EXISTS idx_movements_batch ON movements(batch_id);
CREATE INDEX IF NOT EXISTS idx_movements_sku_date ON movements(sku_id, business_date);
CREATE INDEX IF NOT EXISTS idx_movements_date ON movements(business_date);

CREATE TABLE IF NOT EXISTS sale_headers (
  sale_id TEXT PRIMARY KEY,
  sku_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  qty REAL NOT NULL,
  allocated_qty REAL NOT NULL DEFAULT 0,
  short_qty REAL NOT NULL DEFAULT 0,
  business_date TEXT NOT NULL,
  received_at TEXT NOT NULL,
  late INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'POSTED'
);

CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  sku_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  qty REAL NOT NULL,
  ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  released_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_reservations_batch ON reservations(batch_id);

CREATE TABLE IF NOT EXISTS strategies (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  params TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT
);

CREATE TABLE IF NOT EXISTS strategy_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_strategy TEXT,
  to_strategy TEXT NOT NULL,
  as_of TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  strategy_id TEXT,
  sku_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  action TEXT NOT NULL,
  qty REAL NOT NULL,
  to_warehouse TEXT,
  rationale TEXT,
  causes TEXT,
  status TEXT NOT NULL DEFAULT 'pending_approval',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  rejected_by TEXT,
  rejected_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  sku_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  from_warehouse TEXT NOT NULL,
  to_warehouse TEXT,
  qty REAL NOT NULL,
  status TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  created_at TEXT NOT NULL,
  executed_at TEXT,
  rolled_back_at TEXT,
  superseded_at TEXT,
  UNIQUE(task_id, version)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS ingestion_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_ref TEXT NOT NULL,
  kind TEXT NOT NULL,
  decision TEXT NOT NULL,
  detail TEXT,
  received_at TEXT NOT NULL
);
`;

function openDb(file = ':memory:') {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

function query(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

function getRow(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

function run(db, sql, ...params) {
  return db.prepare(sql).run(...params);
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  }
}

function resetDb(db) {
  const tables = [
    'task_versions',
    'tasks',
    'plans',
    'strategy_migrations',
    'strategies',
    'ingestion_log',
    'audit_log',
    'reservations',
    'sale_headers',
    'movements',
    'batches',
    'skus',
    'warehouses',
  ];
  for (const t of tables) db.exec(`DELETE FROM ${t}`);
  try {
    db.exec(
      "DELETE FROM sqlite_sequence WHERE name IN ('movements','task_versions','audit_log','ingestion_log','strategy_migrations')",
    );
  } catch {
    /* sqlite_sequence may not exist yet */
  }
}

module.exports = { openDb, query, getRow, run, tx, resetDb, SCHEMA };
