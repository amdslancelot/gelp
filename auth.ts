import NextAuth from "next-auth";
import { eq } from "drizzle-orm";
import { authConfig } from "./auth.config";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";

// Full NextAuth configuration. This module touches the database and therefore
// runs only in the Node.js runtime (never the edge middleware).
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  session: { strategy: "jwt" },
  events: {
    // Upsert the user row on every sign-in so the app always has a matching
    // record. The token's `sub` is the Google account id, used as the row id.
    async signIn({ user }) {
      if (!user?.email) return;
      const db = getDb();
      const id = user.id ?? user.email;
      const existing = db
        .select()
        .from(users)
        .where(eq(users.email, user.email))
        .get();

      if (existing) {
        db.update(users)
          .set({ name: user.name ?? null, image: user.image ?? null })
          .where(eq(users.id, existing.id))
          .run();
      } else {
        db.insert(users)
          .values({
            id,
            email: user.email,
            name: user.name ?? null,
            image: user.image ?? null,
            createdAt: Date.now(),
          })
          .run();
      }
    },
  },
});
