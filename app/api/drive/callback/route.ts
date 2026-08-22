import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { secretEquals } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { STATE_COOKIE, exchangeCodeForRefreshToken } from "@/lib/drive-oauth";

export const dynamic = "force-dynamic";

// Where the user lands afterwards, with the outcome in the query so the
// settings page can say what happened. The code never renders anything itself:
// this is a redirect target for a browser, not an API for the app's own fetches.
function back(reason: string): NextResponse {
  const url = new URL(
    "/settings",
    process.env.AUTH_URL ?? "http://localhost:3000",
  );
  url.searchParams.set("drive", reason);
  return NextResponse.redirect(url);
}

// Google's redirect back from the consent screen.
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    // The session expired while the user was at Google's consent screen. There
    // is no one to store a token for, so drop the code unused.
    return back("signed_out");
  }

  const params = new URL(req.url).searchParams;

  // The user pressed Cancel, or Google refused. Not an error worth a stack
  // trace — it is a decision, and the settings page just goes back to "off".
  if (params.get("error")) {
    return back("cancelled");
  }

  // CSRF: the nonce must be present in both the callback and this browser's own
  // cookie. Compared in constant time, then cleared either way so one attempt
  // cannot be replayed.
  const jar = await cookies();
  const expected = jar.get(STATE_COOKIE)?.value;
  const state = params.get("state");
  jar.delete(STATE_COOKIE);
  if (!expected || !state || !secretEquals(state, expected)) {
    return back("bad_state");
  }

  const code = params.get("code");
  if (!code) return back("no_code");

  let refreshTokenEnc: string;
  try {
    ({ refreshTokenEnc } = await exchangeCodeForRefreshToken(code));
  } catch {
    // Deliberately not logged: the failure text can echo request parameters,
    // and this request carried an authorization code.
    return back("exchange_failed");
  }

  // Store the grant. It reaches no files by itself — under `drive.file` the
  // Picker is what hands over a file, one at a time — so this is only what lets
  // the Picker be opened later without another trip through Google's consent
  // screen.
  const db = await getDb();
  await db
    .update(users)
    .set({ driveRefreshTokenEnc: refreshTokenEnc, driveLastError: null })
    .where(eq(users.id, session.user.id));

  return back("connected");
}
