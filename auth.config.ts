import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import { isEmailAllowed } from "@/lib/allowlist";

// Edge-safe auth configuration. It must not import the database, since the
// middleware that consumes it runs on the edge runtime.
export const authConfig: NextAuthConfig = {
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  ],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    // Enforce the email allowlist. The user upsert happens in the full config.
    signIn({ profile, user }) {
      const email = profile?.email ?? user?.email;
      return isEmailAllowed(email);
    },
    // Carry a stable user id into the session for DB queries.
    session({ session, token }) {
      if (token.sub) {
        session.user.id = token.sub;
      }
      return session;
    },
  },
};
