import { NextResponse } from "next/server";
import { and, eq, like } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";
import { lists } from "@/lib/db/schema";
import { EXPIRED_PREFIX } from "@/lib/place-view";

export const dynamic = "force-dynamic";

// Delete one expired list, places and notes with it (by cascade).
//
// Only an expired list: one an import renamed because Google no longer has it.
// A live list would just come back on the next import, so there is no reason
// to delete one here — and refusing it on the server means a stray request
// cannot take out a list the export still holds. The prefix is checked in the
// same statement as the delete, so there is no gap for a rename to slip into.
//
// Scoped to the session's user like every list read: someone else's list id
// gets the same 404 as one that does not exist.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const db = await getDb();
  const deleted = await db
    .delete(lists)
    .where(
      and(
        eq(lists.id, decodeURIComponent(id)),
        eq(lists.userId, session.user.id),
        // No % or _ in the prefix, so it needs no LIKE escaping.
        like(lists.name, `${EXPIRED_PREFIX}%`),
      ),
    )
    .returning({ id: lists.id });

  if (deleted.length === 0) {
    return NextResponse.json(
      { error: "No expired list with that id" },
      { status: 404 },
    );
  }
  return NextResponse.json({ deleted: deleted[0].id });
}
