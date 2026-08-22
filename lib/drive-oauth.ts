import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

// The user-delegated half of the Drive integration: turning a user's consent
// into a refresh token this app can use while they are asleep, and turning that
// refresh token into a short-lived access token each night.
//
// This is deliberately separate from the sign-in OAuth in auth.ts. Asking for
// Drive during sign-in would put a scope prompt in front of everyone who only
// wants to look at their map, and Google hands back a refresh token only on a
// consent that explicitly asks for one — so the two flows want different
// parameters and different moments. This one runs when a user turns the sync
// on, and never otherwise.

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

// `drive.file` — not `drive.readonly`.
//
// It grants access only to files the user hands over through the Google Picker,
// which is both the smaller thing to lose if this app is breached and, unlike
// `drive.readonly`, not one of Google's *restricted* scopes: no app
// verification stands between this feature and a second user.
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

// Name of the cookie holding the CSRF nonce for an in-flight connect. It is
// short-lived by design — a connect that takes longer than this was abandoned.
export const STATE_COOKIE = "gelp_drive_state";
export const STATE_TTL_SECONDS = 600;

// Everything a Drive connect needs from the environment. Checked up front so
// the settings page can refuse to *offer* a connect it could not complete,
// rather than sending the user to Google and failing on the way back.
export function isDriveOAuthConfigured(): boolean {
  return Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
}

// The callback Google redirects to, derived from AUTH_URL so it matches what is
// registered in the Google console in every environment.
export function driveRedirectUri(): string {
  const base = process.env.AUTH_URL;
  if (!base) throw new Error("AUTH_URL is not set");
  return new URL("/api/drive/callback", base).toString();
}

// A fresh CSRF nonce for one connect attempt.
export function newStateNonce(): string {
  return randomBytes(32).toString("base64url");
}

// Where to send the user to consent.
//
// `access_type=offline` is what asks for a refresh token at all, and
// `prompt=consent` is what makes Google issue one *again* on a re-connect —
// without it a user who has already granted this scope is bounced straight back
// with an access token and no refresh token, and the nightly sync silently has
// nothing to work with.
export function driveConsentUrl(state: string): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", process.env.AUTH_GOOGLE_ID!);
  url.searchParams.set("redirect_uri", driveRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", DRIVE_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

// Raised when Google has told us this grant is gone — the user revoked it in
// their account settings, or it expired. The caller's job is to stop trying:
// turn the user's sync off and ask them to reconnect. Distinct from a transient
// Drive or network failure, which should simply be retried tomorrow.
export class DriveGrantRevokedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriveGrantRevokedError";
  }
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

// POST to Google's token endpoint. Errors carry Google's own wording, which is
// the only useful thing in them, and never the request body — that contains the
// client secret and the refresh token.
async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) {
    const detail = data.error_description ?? data.error ?? `HTTP ${res.status}`;
    // `invalid_grant` is Google's answer for a refresh token that has been
    // revoked, expired, or was issued to another client. All three mean the
    // same thing to us: this grant is finished, stop using it.
    if (data.error === "invalid_grant") {
      throw new DriveGrantRevokedError(detail);
    }
    throw new Error(`Google token request failed: ${detail}`);
  }
  return data;
}

// Exchange the one-time code from the callback for tokens, and hand back the
// refresh token already encrypted — the plaintext never leaves this function,
// so no caller is in a position to store or log it by accident.
export async function exchangeCodeForRefreshToken(code: string): Promise<{
  refreshTokenEnc: string;
  accessToken: string;
}> {
  const data = await postToken({
    code,
    client_id: process.env.AUTH_GOOGLE_ID!,
    client_secret: process.env.AUTH_GOOGLE_SECRET!,
    redirect_uri: driveRedirectUri(),
    grant_type: "authorization_code",
  });

  if (!data.refresh_token) {
    // Reachable if `prompt=consent` is ever dropped from the consent URL. Fail
    // loudly rather than storing a connection that cannot survive the hour.
    throw new Error(
      "Google returned no refresh token, so the nightly sync could not run. Try connecting again.",
    );
  }
  if (!data.access_token) {
    throw new Error("Google returned no access token");
  }

  return {
    refreshTokenEnc: encryptSecret(data.refresh_token),
    accessToken: data.access_token,
  };
}

// Mint a short-lived access token from a stored (encrypted) refresh token.
// This is what the nightly job calls, once per user, with nobody present.
export async function accessTokenFromStored(
  refreshTokenEnc: string,
): Promise<string> {
  const data = await postToken({
    refresh_token: decryptSecret(refreshTokenEnc),
    client_id: process.env.AUTH_GOOGLE_ID!,
    client_secret: process.env.AUTH_GOOGLE_SECRET!,
    grant_type: "refresh_token",
  });
  if (!data.access_token) {
    throw new Error("Google returned no access token");
  }
  return data.access_token;
}

// Tell Google to forget the grant, so disconnecting here also disappears from
// the user's own Google account permissions page rather than leaving a live
// credential behind that merely nothing happens to be using.
//
// Best-effort: a token Google has already dropped answers 400, and that is the
// outcome we wanted anyway. The caller clears its own row regardless.
export async function revokeStoredToken(
  refreshTokenEnc: string,
): Promise<void> {
  const token = decryptSecret(refreshTokenEnc);
  await fetch(REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  }).catch(() => undefined);
}
