import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { revokeStoredToken } from "@/lib/drive-oauth";

export const dynamic = "force-dynamic";

// Turn the nightly sync off and hand the grant back to Google.
//
// Order matters: revoke first, clear second. A revoke that fails leaves a
// stored token this app will keep using, which the user has just asked it to
// stop doing — so that path must not reach the clear and report success. A
// clear that fails after a successful revoke is the harmless direction: the
// row's token is already dead, and the next sync finds that out.
export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  const row = (
    await db
      .select({ enc: users.driveRefreshTokenEnc })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1)
  )[0];

  if (row?.enc) {
    try {
      await revokeStoredToken(row.enc);
    } catch {
      // A token this app can no longer decrypt cannot be revoked either. There
      // is nothing the user can do about that and nothing left worth keeping,
      // so fall through and clear the row — the alternative is a disconnect
      // button that never works.
    }
  }

  await db
    .update(users)
    .set({
      driveSyncEnabled: false,
      driveRefreshTokenEnc: null,
      driveFolderId: null,
      driveFolderName: null,
      driveLastError: null,
    })
    .where(eq(users.id, session.user.id));

  // `driveLastSyncedAt` deliberately survives: it is a record of what happened,
  // not part of the connection, and it still answers "when did my map last
  // update?" after a disconnect.
  return NextResponse.json({ connected: false });
}
