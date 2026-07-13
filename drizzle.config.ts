import type { Config } from "drizzle-kit";

// The database path is resolved at runtime; drizzle-kit only needs it to
// generate migration SQL, so a default is fine here.
export default {
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? "./data/gelp.db",
  },
} satisfies Config;
