import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.js';
import { seedDb } from './seed.js';

// `npm run seed` — wipe the local database and reseed from scratch.
const dbFile = process.env.QUARRY_DB ?? path.join(process.cwd(), 'data', 'quarry.db');
for (const suffix of ['', '-wal', '-shm']) {
  const f = dbFile + suffix;
  if (fs.existsSync(f)) fs.rmSync(f);
}
const db = openDb(dbFile);
seedDb(db);
console.log(`[quarry] fresh database written to ${dbFile}`);
