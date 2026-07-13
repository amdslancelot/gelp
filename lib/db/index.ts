import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

let cached: Db | null = null;

// Resolve the database file path from the environment, defaulting to a local
// file. The connection is created lazily so that `next build` never opens the
// database and never assumes a writable data directory exists.
function resolveDbPath(): string {
  return resolve(process.env.DATABASE_PATH ?? "./data/gelp.db");
}

// Return the shared Drizzle database handle, creating and migrating it on the
// first call. The migrations folder is committed and applied at runtime.
export function getDb(): Db {
  if (cached) return cached;

  const dbPath = resolveDbPath();
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolve("./drizzle") });

  cached = db;
  return cached;
}
