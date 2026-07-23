import { resolve } from "node:path";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

let cached: Promise<Db> | null = null;

// Resolve the Postgres connection string from the environment.
function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set (e.g. postgres://gelp:gelp@localhost:5432/gelp)",
    );
  }
  return url;
}

// Return the shared Drizzle database handle, creating the pool and applying
// migrations on the first call. The connection is created lazily so that
// `next build` never opens the database. The promise is cached so concurrent
// first callers share a single pool and a single migration run.
//
// On failure the cache is cleared (and the half-open pool closed) so the next
// call retries: Postgres is a separate workload that may not be accepting
// connections yet when the app's first DB request arrives, and a transient
// failure must not poison the handle for the process's lifetime.
export function getDb(): Promise<Db> {
  if (cached) return cached;

  cached = (async () => {
    const pool = new Pool({ connectionString: connectionString() });
    try {
      const db = drizzle(pool, { schema });
      // The migrations folder is committed and applied at runtime.
      await migrate(db, { migrationsFolder: resolve("./drizzle") });
      return db;
    } catch (err) {
      await pool.end().catch(() => {});
      cached = null;
      throw err;
    }
  })();

  return cached;
}
