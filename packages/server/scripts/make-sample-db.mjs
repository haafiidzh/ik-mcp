// Builds the demo SQLite database from scripts/sample-db.sql.
// Usage: node scripts/make-sample-db.mjs [outputFile]
// Default output: config/data/sample.db (git-ignored; the example config refers to ./data/sample.db
// relative to the config file). An existing output file is replaced.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] ?? path.join(here, "../config/data/sample.db"));
const sql = readFileSync(path.join(here, "sample-db.sql"), "utf8");

mkdirSync(path.dirname(out), { recursive: true });
for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(out + suffix, { force: true });
const db = new Database(out);
try {
  db.exec(sql);
} finally {
  db.close();
}
process.stderr.write(`sample database written: ${out}\n`);
