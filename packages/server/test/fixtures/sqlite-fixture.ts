import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * Deterministic sample SQLite database, built on demand in a temp dir (nothing
 * binary is committed). Schema: customers <- orders <- order_items -> products,
 * a composite-key table, a view, a table with an implicit FK target, a blob and
 * a long-text row. AUTOINCREMENT creates sqlite_sequence (an internal table the
 * adapter must hide).
 */

export interface SqliteFixture {
  dir: string;
  /** Absolute path of the sample database file. */
  dbPath: string;
  cleanup(): void;
}

export const SAMPLE_LONG_TEXT_CHARS = 5000;

export function buildSampleDatabase(file: string): void {
  const db = new Database(file);
  try {
    db.exec(`
      CREATE TABLE customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        note TEXT DEFAULT 'none'
      );
      CREATE TABLE products (
        sku TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        price REAL NOT NULL,
        photo BLOB
      );
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        customer_id INTEGER NOT NULL REFERENCES customers(id),
        placed_at TEXT NOT NULL
      );
      CREATE TABLE order_items (
        order_id INTEGER NOT NULL,
        line_no INTEGER NOT NULL,
        sku TEXT NOT NULL,
        qty INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (order_id, line_no),
        FOREIGN KEY (order_id) REFERENCES orders(id),
        FOREIGN KEY (sku) REFERENCES products
      );
      CREATE INDEX idx_orders_customer ON orders(customer_id);
      CREATE VIEW customer_totals AS
        SELECT c.id AS customer_id, c.name AS name, count(o.id) AS order_count
        FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
        GROUP BY c.id;
    `);
    const insertCustomer = db.prepare("INSERT INTO customers (name, email, note) VALUES (?, ?, ?)");
    insertCustomer.run("Ada", "ada@example.test", "x".repeat(SAMPLE_LONG_TEXT_CHARS));
    insertCustomer.run("Grace", "grace@example.test", null);
    insertCustomer.run("Linus", null, "plain");
    const insertProduct = db.prepare("INSERT INTO products (sku, title, price, photo) VALUES (?, ?, ?, ?)");
    insertProduct.run("P-1", "Widget", 9.5, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    insertProduct.run("P-2", "Gadget", 19.25, null);
    const insertOrder = db.prepare("INSERT INTO orders (id, customer_id, placed_at) VALUES (?, ?, ?)");
    insertOrder.run(1, 1, "2026-01-01");
    insertOrder.run(2, 1, "2026-01-02");
    insertOrder.run(3, 2, "2026-01-03");
    const insertItem = db.prepare("INSERT INTO order_items (order_id, line_no, sku, qty) VALUES (?, ?, ?, ?)");
    insertItem.run(1, 1, "P-1", 2);
    insertItem.run(1, 2, "P-2", 1);
    insertItem.run(3, 1, "P-2", 5);
  } finally {
    db.close();
  }
}

export function makeSqliteFixture(): SqliteFixture {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "dwmcp-sqlite-")));
  const dbPath = path.join(dir, "sample.db");
  buildSampleDatabase(dbPath);
  return { dir, dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Content hash + size + mtime of a file: "unchanged" means all three are equal. */
export function fileFingerprint(file: string): { sha256: string; size: number; mtimeMs: number } {
  const st = statSync(file);
  return { sha256: createHash("sha256").update(readFileSync(file)).digest("hex"), size: st.size, mtimeMs: st.mtimeMs };
}
