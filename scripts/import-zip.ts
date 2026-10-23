// Import a Takeout zip from the command line — the same import the /import page
// runs, for `scripts/sync-maps.sh` to call after it has fetched the export.
//
// The upload route takes its user from the session; here there is no session,
// so the owner is named by email and looked up in `users`. It must be someone
// who has already signed in once, since that is what creates the row.
//
//   scripts/db-target.sh prod npx tsx scripts/import-zip.ts data/takeout/x.zip \
//     --email=you@example.com --apply
//
// A dry run unless told otherwise: without --apply it prints what the import
// would do — the /import page's summary — and writes nothing.
//
// The mode is "queued", the upload route's default — nothing is guessed and
// nothing is billed; unknown places wait for `npm run queue:resolve`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import * as schema from "../lib/db/schema";
import { users } from "../lib/db/schema";
import { parseTakeoutZip } from "../lib/takeout";
import { analyzeImport, runImport } from "../lib/import";
import { createPlacesClient } from "../lib/places";

async function main() {
  const args = process.argv.slice(2);
  const zipArg = args.find((a) => !a.startsWith("--"));
  const email = args.find((a) => a.startsWith("--email="))?.split("=")[1];
  const apply = args.includes("--apply");
  if (!zipArg || !email) {
    console.error(
      "usage: import-zip.ts <takeout.zip> --email=<owner> [--apply]",
    );
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — run through scripts/db-target.sh");
    process.exit(1);
  }

  const parsed = parseTakeoutZip(readFileSync(resolve(zipArg)));
  const placeCount = parsed.lists.reduce((n, l) => n + l.places.length, 0);
  console.log(`parsed ${parsed.lists.length} lists, ${placeCount} places`);

  // Not getDb(): that also runs migrations, and a laptop checkout migrating
  // production is a deploy that skipped the deploy.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const db = drizzle(pool, { schema });
    const [owner] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    if (!owner) {
      console.error(`no user with email ${email} — sign in to Gelp once first`);
      process.exit(1);
    }

    // The same report the /import page shows before its buttons.
    const plan = await analyzeImport(db, owner.id, parsed);
    const fresh = plan.lists.filter((l) => l.status === "new").length;
    console.log(
      `${fresh} new lists, ${plan.lists.length - fresh} replaced, ` +
        `${plan.wouldQueue} places would be queued`,
    );
    for (const l of plan.removed) {
      console.log(`  would mark expired: ${l.name} (${l.places} places)`);
    }

    if (!apply) {
      console.log("\ndry run — nothing written. Pass --apply to write.");
      return;
    }

    let last = 0;
    const result = await runImport(
      db,
      owner.id,
      parsed,
      createPlacesClient(),
      "upload",
      "queued",
      (p) => {
        // One line per tenth, not per place: this goes to a terminal.
        const pct = Math.floor((p.processed / Math.max(p.total, 1)) * 10);
        if (pct > last) {
          last = pct;
          console.log(`  ${pct * 10}%`);
        }
      },
    );
    console.log(
      `imported ${result.lists} lists, ${result.places} places — ` +
        `${result.queued} queued, ${result.gone} gone, ` +
        `${result.listsExpired} lists marked expired`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
