import NextAuth from "next-auth";
import { authConfig } from "./auth.config";
import { mobileDebugEnabled } from "@/lib/mobile-debug";

// Build an edge-safe auth instance purely for route protection. The full
// database-backed config is used only in the Node.js runtime.
const { auth } = NextAuth(authConfig);

// Paths that are always reachable without a session. `/s` is the read-only
// shared-map view: the token in the path is its own authority, and requiring a
// session there would defeat the point of a link you can hand to anyone.
const PUBLIC_PREFIXES = [
  "/login",
  "/api/health",
  "/api/cron/import",
  "/api/auth",
  "/s",
];

export default auth((req) => {
  // Mobile debug mode (see lib/mobile-debug.ts): let every request through so a
  // phone can reach the app over a bare LAN IP without the Google login
  // round-trip. Inert in production.
  if (mobileDebugEnabled) return;

  const { pathname } = req.nextUrl;

  const isPublic = PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
  if (isPublic) return;

  if (!req.auth) {
    const url = new URL("/login", req.nextUrl.origin);
    return Response.redirect(url);
  }
});

// Run on everything except Next internals and static assets.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
