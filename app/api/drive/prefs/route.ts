import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

// Per-user options for the Drive sync. One so far: whether an import should
// leave the folder holding only the export it just read.
//
// Separate from /api/drive/folder because it is a different kind of decision —
// that one is what the sync reads, this one is what it writes back. The write
// deserves its own switch and its own deliberate act of turning on.
export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { trashOldExports?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Expected a JSON body" },
      { status: 400 },
    );
  }

  if (typeof body.trashOldExports !== "boolean") {
    return NextResponse.json(
      { error: "trashOldExports must be true or false" },
      { status: 400 },
    );
  }

  const db = await getDb();
  await db
    .update(users)
    .set({ driveTrashOldExports: body.trashOldExports })
    .where(eq(users.id, session.user.id));

  return NextResponse.json({ trashOldExports: body.trashOldExports });
}
