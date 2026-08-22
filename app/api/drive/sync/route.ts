import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { accessTokenFromStored } from "@/lib/drive-oauth";
import { fetchDriveFile } from "@/lib/drive";
import { parseTakeoutZip } from "@/lib/takeout";
import { analyzeImport, runImport, type ImportMode } from "@/lib/import";
import { createPlacesClient } from "@/lib/places";

export const dynamic = "force-dynamic";

// Import a Takeout zip straight from the user's Drive — the file they just
// picked in the Google Picker, identified by the id it handed back.
//
// Two calls, like the upload page, and for the same reason: a Takeout export is
// a complete snapshot, so importing one deletes any stored list missing from
// it. That is right when the export is current and destructive when it is
// stale, and only the user knows which. `?dryRun=1` answers what it would do
// without writing; the second call does it.
//
// The file id is not a permission. The `drive.file` scope reaches only what its
// owner picked for this app, so an id from anywhere else — guessed, or copied
// from someone else's Drive — answers 404 at Google rather than here.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { fileId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Expected a JSON body" },
      { status: 400 },
    );
  }
  const fileId = typeof body.fileId === "string" ? body.fileId.trim() : "";
  if (fileId === "") {
    return NextResponse.json({ error: "No file was picked" }, { status: 400 });
  }

  const db = await getDb();
  const row = (
    await db
      .select({ enc: users.driveRefreshTokenEnc })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1)
  )[0];

  if (!row?.enc) {
    return NextResponse.json(
      { error: "Connect Google Drive first" },
      { status: 409 },
    );
  }

  let buffer: Buffer;
  try {
    buffer = await fetchDriveFile(await accessTokenFromStored(row.enc), fileId);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not reach Google Drive";
    await db
      .update(users)
      .set({ driveLastError: message })
      .where(eq(users.id, session.user.id));
    return NextResponse.json({ error: message }, { status: 502 });
  }

  let parsed;
  try {
    parsed = parseTakeoutZip(buffer);
  } catch {
    return NextResponse.json(
      { error: "That file could not be read as a Takeout zip" },
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

  await db
    .update(users)
    .set({ driveLastSyncedAt: Date.now(), driveLastError: null })
    .where(eq(users.id, session.user.id));

  return NextResponse.json(result);
}
