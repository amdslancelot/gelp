// Report categories in the database that `lib/category-tree.ts` has not placed.
//
// The tree is hand-written, so it goes stale the moment Google invents a label
// this repo has not seen. Nothing breaks when that happens — `tier1Of` guesses
// from the suffix — but a guess is not a decision, and the filter quietly gains
// an entry nobody chose. Run this after every resolve run.
//
//   npm run db:up
//   set -a; . ./.env; set +a
//   npx tsx scripts/check-categories.ts
//
// Exits non-zero when anything is unplaced, so it can gate a release.

import { getDb } from "../lib/db";
import { sql } from "drizzle-orm";
import { isPlaced, tier1Of } from "../lib/category-tree";

async function main() {
  const db = await getDb();
  const rows = await db.execute<{ category: string; n: number }>(sql`
    select category, count(*)::int as n
    from (
      select coalesce(pc.category, c.category) as category
      from place_cache c
      left join place_coords pc on pc.maps_url = c.key
    ) t
    where category is not null and category <> ''
    group by category
    order by n desc
  `);

  const all = rows.rows;
  const unplaced = all.filter((r) => !isPlaced(r.category));

  console.log(`${all.length} categories in use, ${all.length - unplaced.length} placed by hand`);

  if (unplaced.length === 0) {
    console.log("every category is placed.");
    process.exit(0);
  }

  console.log(`\n${unplaced.length} unplaced — guessed by suffix, decide where they belong:`);
  for (const r of unplaced) {
    console.log(`  ${r.category.padEnd(40)} ${String(r.n).padStart(4)} places   → guessed ${tier1Of(r.category)}`);
  }
  process.exit(1);
}

main();
