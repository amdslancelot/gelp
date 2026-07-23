import type { DefaultSession } from "next-auth";

// Augment the session so `session.user.id` is available to server components.
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}

// Carry the app's own internal user id (a UUID we control — never Google's
// `sub`) on the JWT, so the session can expose it as `session.user.id`.
declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
  }
}
