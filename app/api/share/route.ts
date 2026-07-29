import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";
import {
  ensureShare,
  getShareToken,
  revokeShare,
  rotateShare,
} from "@/lib/share";

export const dynamic = "force-dynamic";

// Every method here acts on the *session's* user and never on a user id from
// the request, so one account can neither read nor revoke another's link.
async function requireUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

// The caller's current link, or `{ token: null }` when they are not sharing.
export async function GET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  return NextResponse.json({ token: await getShareToken(db, userId) });
}

// Start sharing, or hand back the existing link unchanged. `?rotate=1` issues a
// new token instead, which invalidates the previous link.
export async function POST(req: Request) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  const rotate = new URL(req.url).searchParams.get("rotate") === "1";
  const token = rotate
    ? await rotateShare(db, userId)
    : await ensureShare(db, userId);

  return NextResponse.json({ token });
}

// Stop sharing. The link stops resolving immediately.
export async function DELETE() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  await revokeShare(db, userId);
  return NextResponse.json({ token: null });
}
