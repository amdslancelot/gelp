import NextAuth from "next-auth";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { authConfig } from "./auth.config";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { mobileDebugEmail } from "@/lib/mobile-debug";

// Full NextAuth configuration. This module touches the database and therefore
// runs only in the Node.js runtime (never the edge middleware).
const nextAuth = NextAuth({
  ...authConfig,
  session: { strategy: "jwt" },
  callbacks: {
    ...authConfig.callbacks,
    // Resolve the app's own internal user id at sign-in and carry it on the JWT
    // as `uid` (the session reads this). Identity is an internal UUID we control.
    // A returning login is recognized by the immutable Google `sub`; the first
    // time an account that already exists by email signs in (e.g. data migrated
    // in), it is adopted and its `google_sub` stamped. A genuinely new account
    // gets a fresh randomUUID. Google's `sub` is only ever a lookup key here,
    // never the identity.
    async jwt({ token, user, profile }) {
      if (user?.email) {
        const db = await getDb();
        const googleSub = profile?.sub ?? user.id ?? null;
        const name = user.name ?? null;
        const image = user.image ?? null;

        const bySub = googleSub
          ? (
              await db
                .select()
                .from(users)
                .where(eq(users.googleSub, googleSub))
                .limit(1)
            )[0]
          : undefined;
        const row =
          bySub ??
          (
            await db
              .select()
              .from(users)
              .where(eq(users.email, user.email))
              .limit(1)
          )[0];

        if (row) {
          // Adopt the row: stamp google_sub if not set yet, keep profile fresh.
          await db
            .update(users)
            .set({ googleSub: row.googleSub ?? googleSub, name, image })
            .where(eq(users.id, row.id));
          token.uid = row.id;
        } else {
          const id = randomUUID();
          await db.insert(users).values({
            id,
            email: user.email,
            googleSub,
            name,
            image,
            createdAt: Date.now(),
          });
          token.uid = id;
        }
      }
      return token;
    },
  },
});

export const { handlers, signIn, signOut } = nextAuth;

// Mobile debug mode (see lib/mobile-debug.ts): when enabled, resolve the
// configured user's id from the database and hand back a synthetic session,
// bypassing Google OAuth so a phone on the LAN can browse over plain http. The
// switch is inert in production, so `auth` is the real NextAuth handler there.
async function mobileDebugAuth() {
  const db = await getDb();
  const row = (
    await db
      .select()
      .from(users)
      .where(eq(users.email, mobileDebugEmail!))
      .limit(1)
  )[0];
  if (!row) {
    throw new Error(
      `MOBILE_DEBUG_LOGIN="${mobileDebugEmail}" but no user with that email exists.`,
    );
  }
  return { user: { id: row.id, email: row.email }, expires: "" };
}

export const auth: typeof nextAuth.auth = mobileDebugEmail
  ? (mobileDebugAuth as unknown as typeof nextAuth.auth)
  : nextAuth.auth;

if (mobileDebugEmail) {
  console.warn(
    `⚠️  Mobile debug mode ON — Google login bypassed, every request is "${mobileDebugEmail}". Never enable in production.`,
  );
}
