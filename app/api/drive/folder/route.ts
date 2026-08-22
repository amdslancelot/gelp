import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

// Record the folder the user picked, and switch the nightly sync on.
//
// This is the step that actually enables syncing. Connecting stores a grant;
// under `drive.file` that grant reaches nothing until the user hands over a
// folder through the Picker, so "enabled" only becomes true here — with a
// folder to look in, which is the only state the nightly job can act on.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { folderId?: unknown; folderName?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Expected a JSON body" },
      { status: 400 },
    );
  }

  const folderId =
    typeof body.folderId === "string" ? body.folderId.trim() : "";
  if (folderId === "") {
    return NextResponse.json(
      { error: "No folder was picked" },
      { status: 400 },
    );
  }
  const folderName =
    typeof body.folderName === "string" && body.folderName.trim() !== ""
      ? body.folderName.trim()
      : "Selected folder";

  const db = await getDb();
  const row = (
    await db
      .select({ enc: users.driveRefreshTokenEnc })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1)
  )[0];

  // A folder without a grant is not something to remember: the picker cannot
  // have run without one, so this means the connection was dropped mid-flow.
  if (!row?.enc) {
    return NextResponse.json(
      { error: "Connect Google Drive first" },
      { status: 409 },
    );
  }

  await db
    .update(users)
    .set({
      driveFolderId: folderId,
      driveFolderName: folderName,
      driveSyncEnabled: true,
      // Whatever went wrong before, the user has just fixed the input to it.
      driveLastError: null,
    })
    .where(eq(users.id, session.user.id));

  return NextResponse.json({ enabled: true, folderId, folderName });
}
