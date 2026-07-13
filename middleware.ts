import NextAuth from "next-auth";
import { authConfig } from "./auth.config";

// Build an edge-safe auth instance purely for route protection. The full
// database-backed config is used only in the Node.js runtime.
const { auth } = NextAuth(authConfig);

// Paths that are always reachable without a session.
const PUBLIC_PREFIXES = [
  "/login",
  "/api/health",
  "/api/cron/import",
  "/api/auth",
];

export default auth((req) => {
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
