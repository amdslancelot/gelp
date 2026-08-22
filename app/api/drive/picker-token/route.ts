import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { accessTokenFromStored } from "@/lib/drive-oauth";

export const dynamic = "force-dynamic";

// A short-lived Drive access token for the Google Picker to run on.
//
// The Picker is a Google-hosted component in the user's browser and needs a
// token of its own. Rather than have the page ask Google for one — a second
// OAuth flow, with its own client-side library and its own JavaScript-origins
// registration — this mints one from the refresh token the connect flow already
// stored, server-side, and hands it over.
//
// What is handed over is the user's own token, for their own picker, scoped to
// `drive.file` — which by itself opens nothing: it reaches only files that same
// user has already given this app. It expires in about an hour and is never
// stored by the page. The refresh token behind it never leaves the server.
export async function GET() {
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

  if (!row?.enc) {
    return NextResponse.json(
      { error: "Connect Google Drive first" },
      { status: 409 },
    );
  }

  try {
    return NextResponse.json({
      accessToken: await accessTokenFromStored(row.enc),
    });
  } catch {
    // Same two permanent failures the nightly job knows about — a revoked grant
    // or an unreadable token — and the same answer: reconnect.
    return NextResponse.json(
      { error: "Reconnect Google Drive" },
      { status: 409 },
    );
  }
}
