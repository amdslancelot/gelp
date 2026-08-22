import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { accessTokenFromStored } from "@/lib/drive-oauth";
import { fetchTakeoutZipFrom, trashOlderTakeouts } from "@/lib/drive";
import { parseTakeoutZip } from "@/lib/takeout";
import { analyzeImport, runImport, type ImportMode } from "@/lib/import";
import { createPlacesClient } from "@/lib/places";

export const dynamic = "force-dynamic";

// Import the newest Takeout zip from the user's connected folder, on demand —
// the same work the nightly job does, asked for rather than waited for.
//
// Two steps, like the upload page, and for the same reason: a Takeout export is
// a complete snapshot, so importing one *deletes* any stored list missing from
// it. That is right when the export is current and destructive when it is
// stale, and only the user knows which. `?dryRun=1` answers what it would do
// without writing; the second call does it.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  const row = (
    await db
      .select({
        enc: users.driveRefreshTokenEnc,
        folderId: users.driveFolderId,
        trashOldExports: users.driveTrashOldExports,
      })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1)
  )[0];

  if (!row?.enc || !row.folderId) {
    return NextResponse.json(
      { error: "Connect Google Drive and pick a folder first" },
      { status: 409 },
    );
  }

  let buffer: Buffer;
  let file: { id: string };
  let accessToken: string;
  try {
    accessToken = await accessTokenFromStored(row.enc);
    ({ buffer, file } = await fetchTakeoutZipFrom(accessToken, row.folderId));
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Could not reach Google Drive",
      },
      { status: 502 },
    );
  }

  let parsed;
  try {
    parsed = parseTakeoutZip(buffer);
  } catch {
    return NextResponse.json(
      { error: "The newest zip in that folder could not be read" },
      { status: 422 },
    );
  }

  const params = new URL(req.url).searchParams;
  if (params.get("dryRun") === "1") {
    return NextResponse.json(await analyzeImport(db, session.user.id, parsed));
  }

  // Same default as everywhere else: "queued" guesses at nothing and bills
  // nothing, and a caller that wants an answer right now has to say so.
  const mode: ImportMode = params.get("mode") === "fast" ? "fast" : "queued";
  const result = await runImport(
    db,
    session.user.id,
    parsed,
    createPlacesClient(),
    "drive",
    mode,
  );

  // Same order as the nightly job: import first, tidy second, and never let a
  // folder that failed to tidy report as a failed import.
  let trashed = 0;
  if (row.trashOldExports) {
    try {
      trashed = await trashOlderTakeouts(accessToken, row.folderId, file.id);
    } catch {
      // The import is what mattered and it succeeded.
    }
  }

  // A manual sync counts as a sync: it is the same import from the same folder,
  // so leaving `last_synced_at` at whatever the CronJob last managed would
  // misreport when this map was last brought up to date.
  await db
    .update(users)
    .set({ driveLastSyncedAt: Date.now(), driveLastError: null })
    .where(eq(users.id, session.user.id));

  return NextResponse.json({ ...result, trashed });
}
