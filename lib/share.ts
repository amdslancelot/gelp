import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "./db";
import { shares, users } from "./db/schema";

// Bytes of entropy behind a share token. The token is an unauthenticated
// bearer credential — knowing it is the entire permission to read someone's
// map — so it is sized to be unguessable rather than short: 24 random bytes is
// 192 bits, rendered as 32 URL-safe characters.
const TOKEN_BYTES = 24;

// Mint a fresh, unguessable share token.
export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

// The user's current share token, or null if they are not sharing.
export async function getShareToken(
  db: Db,
  userId: string,
): Promise<string | null> {
  const rows = await db
    .select()
    .from(shares)
    .where(eq(shares.userId, userId))
    .limit(1);
  return rows[0]?.token ?? null;
}

// Start sharing, or return the link that already exists. Deliberately *not* a
// new token each call: the button that calls this is the same one the user
// presses to see their link, and re-issuing there would silently break a link
// they had already sent to someone.
export async function ensureShare(db: Db, userId: string): Promise<string> {
  const existing = await getShareToken(db, userId);
  if (existing) return existing;

  const token = newToken();
  const [row] = await db
    .insert(shares)
    .values({ token, userId, createdAt: Date.now() })
    .onConflictDoNothing({ target: shares.userId })
    .returning({ token: shares.token });
  // A concurrent request won the insert; its token is the live one.
  return row?.token ?? ((await getShareToken(db, userId)) as string);
}

// Replace the user's link with a new one. The old token stops working the
// moment this returns — that is how a link handed to the wrong person is taken
// back.
export async function rotateShare(db: Db, userId: string): Promise<string> {
  const token = newToken();
  await db.transaction(async (tx) => {
    await tx.delete(shares).where(eq(shares.userId, userId));
    await tx.insert(shares).values({ token, userId, createdAt: Date.now() });
  });
  return token;
}

// Who a share token belongs to, or null when it is unknown — which is what a
// revoked or replaced token has become. This is the only place a token is
// turned into an identity, so it is also the only thing a public request can
// use to decide whose data it may read.
export async function resolveShare(
  db: Db,
  token: string,
): Promise<{ userId: string; ownerName: string | null } | null> {
  const rows = await db
    .select({ userId: shares.userId, ownerName: users.name })
    .from(shares)
    .innerJoin(users, eq(shares.userId, users.id))
    .where(eq(shares.token, token))
    .limit(1);
  return rows[0] ?? null;
}

// Stop sharing entirely. Idempotent.
export async function revokeShare(db: Db, userId: string): Promise<void> {
  await db.delete(shares).where(eq(shares.userId, userId));
}
