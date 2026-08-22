import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { DecryptError } from "@/lib/crypto";
import {
  DriveGrantRevokedError,
  accessTokenFromStored,
} from "@/lib/drive-oauth";
import {
  fetchLatestTakeoutZip,
  fetchTakeoutZipFrom,
  isDriveConfigured,
} from "@/lib/drive";
import { parseTakeoutZip } from "@/lib/takeout";
import { runImport } from "@/lib/import";
import { createPlacesClient } from "@/lib/places";
import { allowedEmails } from "@/lib/allowlist";

export const dynamic = "force-dynamic";

// The unattended sync queues rather than guesses. Nobody is watching it to
// notice a place it put on the wrong continent, and a place with no pin yet is
// a smaller problem than a place with a confidently wrong one.
const UNATTENDED_MODE = "queued" as const;

type UserOutcome = {
  userId: string;
  email: string;
  ok: boolean;
  error?: string;
  result?: Awaited<ReturnType<typeof runImport>>;
};

// Nightly Drive import, authenticated with a bearer token so a cluster CronJob
// can drive it.
//
// It imports for every user who has connected their own Drive and picked a
// folder. Each user is isolated: a revoked grant, an unreadable token, a
// missing zip or a Drive outage stops that user and nobody else. The whole run
// aborting on one person's bad night is the failure mode worth avoiding here —
// it is the difference between one map going stale and everyone's doing so.
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.get("authorization");
  if (!secret || header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();

  const connected = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.driveSyncEnabled, true),
        isNotNull(users.driveRefreshTokenEnc),
        isNotNull(users.driveFolderId),
      ),
    );

  const outcomes: UserOutcome[] = [];

  for (const user of connected) {
    try {
      const accessToken = await accessTokenFromStored(
        user.driveRefreshTokenEnc!,
      );
      const buffer = await fetchTakeoutZipFrom(
        accessToken,
        user.driveFolderId!,
      );
      const result = await runImport(
        db,
        user.id,
        parseTakeoutZip(buffer),
        createPlacesClient(),
        "drive",
        UNATTENDED_MODE,
      );
      await db
        .update(users)
        .set({ driveLastSyncedAt: Date.now(), driveLastError: null })
        .where(eq(users.id, user.id));
      outcomes.push({ userId: user.id, email: user.email, ok: true, result });
    } catch (err) {
      // Two failures mean "stop asking": a grant Google has dropped, and a
      // token this app can no longer decrypt. Both need the user to reconnect,
      // and retrying nightly would only fail identically forever — so the sync
      // is switched off and the reason left where the settings page can show
      // it. Anything else (Drive down, a half-written zip) is transient and
      // stays enabled to try again tomorrow.
      const permanent =
        err instanceof DriveGrantRevokedError || err instanceof DecryptError;
      const message = permanent
        ? "Reconnect Google Drive — this app's access was revoked or can no longer be read."
        : err instanceof Error
          ? err.message
          : "Drive sync failed";

      await db
        .update(users)
        .set({
          driveLastError: message,
          ...(permanent ? { driveSyncEnabled: false } : {}),
        })
        .where(eq(users.id, user.id));
      outcomes.push({
        userId: user.id,
        email: user.email,
        ok: false,
        error: message,
      });
    }
  }

  // Fall back to the old single-tenant path only when it is configured and
  // nobody has connected their own Drive — so a deployment mid-migration keeps
  // syncing, and one that has moved on never runs both.
  if (outcomes.length === 0 && isDriveConfigured()) {
    const legacy = await legacyImport(db);
    return NextResponse.json(
      { users: [], legacy },
      { status: legacy.ok ? 200 : 502 },
    );
  }

  // 200 even when some users failed: the run itself did what it was asked, and
  // the CronJob's own success is not the place to report one user's revoked
  // token — the settings page is. A 500 here would only retry the users who
  // already succeeded.
  return NextResponse.json({ users: outcomes });
}

// The original path: one service account, one folder, imported for the first
// allowlisted email. Slated for removal with `GOOGLE_SERVICE_ACCOUNT_KEY_BASE64`
// and `DRIVE_FOLDER_ID` once the per-user sync has proven itself in production.
async function legacyImport(db: Awaited<ReturnType<typeof getDb>>) {
  try {
    const allow = allowedEmails();
    let userId: string;
    if (allow.length > 0) {
      const email = allow[0];
      const existing = (
        await db.select().from(users).where(eq(users.email, email)).limit(1)
      )[0];
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
      if (!first)
        return { ok: false, error: "No user available to own the import" };
      userId = first.id;
    }

    const buffer = await fetchLatestTakeoutZip();
    const result = await runImport(
      db,
      userId,
      parseTakeoutZip(buffer),
      createPlacesClient(),
      "drive",
      UNATTENDED_MODE,
    );
    return { ok: true, result };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Drive fetch failed",
    };
  }
}
