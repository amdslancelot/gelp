// Write the pending resolve queue out as JSON Lines, for the scraper to work
// through.
//
// The queue lives in Postgres and the scraper runs on a laptop with a browser,
// so this is the seam between them. Keeping it a file rather than giving the
// scraper a database connection means the work list can be read, trimmed, or
// re-ordered by hand before anything opens a single page — which matters for a
// step that is slow, deliberate, and deals with Google's terms.
//
//   npm run db:up
//   DATABASE_URL=... npx tsx scripts/dump-queue.ts
//
// The queue is not emptied here. Rows stay `pending` until `load-resolved.ts`
// has actually written coordinates for them, so an interrupted run resumes
// simply by dumping again.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { asc, eq } from "drizzle-orm";
import { Pool } from "pg";
import * as schema from "../lib/db/schema";
import { placeQueue } from "../lib/db/schema";

async function main() {
  const args = process.argv.slice(2);
  const out = resolve(
    args.find((a) => !a.startsWith("--")) ?? "data/queue.jsonl",
  );
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : 0;

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (try: npm run db:up)");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  try {
    // Oldest first, so a place that has been waiting is not overtaken forever
    // by newer arrivals.
    const rows = await db
      .select({
        mapsUrl: placeQueue.mapsUrl,
        title: placeQueue.title,
        reason: placeQueue.reason,
      })
      .from(placeQueue)
      .where(eq(placeQueue.status, "pending"))
      .orderBy(asc(placeQueue.createdAt));

    const work = limit > 0 ? rows.slice(0, limit) : rows;

    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      // `key` rather than `mapsUrl`, matching the shape the scraper reads and
      // writes, so the same file format flows through the whole pipeline.
      work
        .map((r) =>
          JSON.stringify({
            key: r.mapsUrl,
            title: r.title ?? "",
            reason: r.reason,
          }),
        )
        .join("\n") + (work.length > 0 ? "\n" : ""),
      "utf8",
    );

    const flagged = work.filter((r) => r.reason === "flagged").length;
    console.log(`${work.length} pending -> ${out}`);
    if (work.length > 0) {
      console.log(
        `  ${flagged} reported as wrongly pinned, ${work.length - flagged} from imports`,
      );
    }
    if (limit > 0 && rows.length > work.length) {
      console.log(`  ${rows.length - work.length} left for a later run`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
