import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { fetchLatestTakeoutZip, isDriveConfigured } from "@/lib/drive";
import { parseTakeoutZip } from "@/lib/takeout";
import { runImport } from "@/lib/import";
import { createPlacesClient } from "@/lib/places";
import { allowedEmails } from "@/lib/allowlist";

export const dynamic = "force-dynamic";

// Nightly Drive import. Authenticated with a bearer token so it can be driven
// by a cluster CronJob. Pulls the newest Takeout zip from the Drive folder and
// imports it for the single configured user.
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.get("authorization");
  if (!secret || header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isDriveConfigured()) {
    return NextResponse.json(
      {
        error:
          "Drive sync is not configured: set GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 and DRIVE_FOLDER_ID",
      },
      { status: 503 },
    );
  }

  const db = await getDb();

  // Determine which user owns the import: the first allowlisted email if set
  // (upserting it), otherwise the first existing user.
  const allow = allowedEmails();
  let userId: string;
  if (allow.length > 0) {
    const email = allow[0];
    const existingRows = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    const existing = existingRows[0];
    if (existing) {
      userId = existing.id;
    } else {
      userId = randomUUID();
      await db
        .insert(users)
        .values({ id: userId, email, createdAt: Date.now() });
    }
  } else {
    const first = (await db.select().from(users).limit(1))[0];
    if (!first) {
      return NextResponse.json(
        { error: "No user available to own the import" },
        { status: 409 },
      );
    }
    userId = first.id;
  }

  let buffer: Buffer;
  try {
    buffer = await fetchLatestTakeoutZip();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Drive fetch failed" },
      { status: 502 },
    );
  }

  const parsed = parseTakeoutZip(buffer);
  const result = await runImport(
    db,
    userId,
    parsed,
    createPlacesClient(),
    "drive",
  );

  return NextResponse.json(result);
}
