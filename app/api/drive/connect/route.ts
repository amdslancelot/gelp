import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { isTokenKeyConfigured } from "@/lib/crypto";
import {
  STATE_COOKIE,
  STATE_TTL_SECONDS,
  driveConsentUrl,
  isDriveOAuthConfigured,
  newStateNonce,
} from "@/lib/drive-oauth";

export const dynamic = "force-dynamic";

// Start a Drive connect: send the signed-in user to Google's consent screen.
//
// A GET rather than a POST because it is a redirect the browser follows, and it
// changes nothing on its own — the only thing it leaves behind is the CSRF
// nonce, which is worthless without a matching callback.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isDriveOAuthConfigured()) {
    return NextResponse.json(
      { error: "Google OAuth is not configured on this server" },
      { status: 503 },
    );
  }
  // Refuse before sending the user to Google rather than after: without a key
  // we could obtain their refresh token and then have nowhere safe to put it,
  // and the fix — set DRIVE_TOKEN_KEY — is the operator's, not theirs.
  if (!isTokenKeyConfigured()) {
    return NextResponse.json(
      {
        error:
          "Drive sync is not configured: DRIVE_TOKEN_KEY is missing, so a refresh token could not be stored safely",
      },
      { status: 503 },
    );
  }

  // The nonce goes two places — the `state` parameter Google echoes back, and
  // an httpOnly cookie only this browser has — so a callback forged by another
  // site cannot present both.
  const nonce = newStateNonce();
  (await cookies()).set(STATE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax", // must survive the top-level redirect back from Google
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: STATE_TTL_SECONDS,
  });

  return NextResponse.redirect(driveConsentUrl(nonce));
}
