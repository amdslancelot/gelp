import type { DefaultSession } from "next-auth";

// Augment the session so `session.user.id` is available to server components.
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}
