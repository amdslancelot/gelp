import type { Config } from "drizzle-kit";

// The connection string is resolved at runtime; drizzle-kit only needs it for
// commands that touch a live database (push/introspect). `generate` diffs the
// schema against the committed snapshots and needs no server, so a default is
// fine here.
export default {
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://gelp_rw:gelp@localhost:5432/gelp",
  },
} satisfies Config;
