// Mobile debug mode
// -----------------
// Google OAuth cannot authenticate against a bare LAN IP: its authorized
// origins and redirect URIs require a public-TLD https host, so a phone pointed
// at the dev server (http://<mac-ip>:3000) can never complete the normal login
// flow. Mobile debug mode skips OAuth entirely — set MOBILE_DEBUG_LOGIN to a
// user's email and every request is treated as that user, letting a phone on the
// LAN browse real data over plain http while testing the responsive UI.
//
// It is honored ONLY in non-production builds. Next.js forces
// NODE_ENV=production for every production build and start, so this switch is
// inert in a deployment even if the variable is somehow present — it can never
// weaken real auth.
//
// This module reads no database and touches no Node-only APIs, so it is safe to
// import from the edge middleware as well as the Node.js runtime.
export const mobileDebugEmail =
  process.env.NODE_ENV === "production"
    ? undefined
    : process.env.MOBILE_DEBUG_LOGIN?.trim() || undefined;

export const mobileDebugEnabled = mobileDebugEmail !== undefined;
