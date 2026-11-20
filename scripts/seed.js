'use strict';

// Rebuild the demo database from scratch. Writes to data/inventory.db by
// default; pass a path as the first argument to target another file.
const path = require('node:path');
const fs = require('node:fs');
const { openDb } = require('../server/lib/db');
const { seed } = require('../server/domain/seed');
const { todayIso } = require('../server/lib/dates');

const file = process.argv[2] || path.join(__dirname, '..', 'data', 'inventory.db');
for (const suffix of ['', '-wal', '-shm']) {
  try {
    fs.unlinkSync(file + suffix);
  } catch {
    /* nothing to remove */
  }
}
const db = openDb(file);
const asOf = process.env.SEED_AS_OF || todayIso();
const { asOf: used } = seed(db, { asOf });
const counts = db
  .prepare(
    `SELECT
       (SELECT COUNT(*) FROM warehouses) AS warehouses,
       (SELECT COUNT(*) FROM skus) AS skus,
       (SELECT COUNT(*) FROM batches) AS batches,
       (SELECT COUNT(*) FROM movements) AS movements,
       (SELECT COUNT(*) FROM sale_headers) AS sales`,
  )
  .get();
console.log(`seeded ${file} as of ${used}`);
console.log(counts);
