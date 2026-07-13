// Parse the ALLOWED_EMAILS env var into a normalized list of emails. An empty
// or unset value means "allow any Google account".
export function allowedEmails(): string[] {
  return (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== "");
}

// Whether the given email is permitted to sign in.
export function isEmailAllowed(email: string | null | undefined): boolean {
  const allow = allowedEmails();
  if (allow.length === 0) return true;
  return email ? allow.includes(email.toLowerCase()) : false;
}
