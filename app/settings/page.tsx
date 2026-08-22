import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import Header from "../components/Header";
import DriveSync from "../components/DriveSync";

export const dynamic = "force-dynamic";

// What the OAuth callback tells the user when it sends them back here. Only
// `connected` is good news; the rest are the ways the round trip can end
// without a grant, worded as what to do rather than what failed.
const CALLBACK_MESSAGES: Record<string, string> = {
  connected: "Google Drive connected. Pick the folder to start syncing.",
  cancelled: "Connection cancelled — nothing changed.",
  signed_out: "You were signed out while connecting. Try again.",
  bad_state: "That connection attempt expired. Try again.",
  no_code: "Google did not return an authorization. Try again.",
  exchange_failed: "Google refused the connection. Try again.",
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ drive?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const db = await getDb();
  const row = (
    await db
      .select({
        refreshTokenEnc: users.driveRefreshTokenEnc,
        enabled: users.driveSyncEnabled,
        folderName: users.driveFolderName,
        lastSyncedAt: users.driveLastSyncedAt,
        lastError: users.driveLastError,
        trashOldExports: users.driveTrashOldExports,
      })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1)
  )[0];

  // The token itself is selected only to answer "is there one" and is turned
  // into a boolean here. Nothing below this line can leak it to the client.
  const state = {
    connected: Boolean(row?.refreshTokenEnc),
    enabled: Boolean(row?.enabled),
    folderName: row?.folderName ?? null,
    lastSyncedAt: row?.lastSyncedAt ?? null,
    lastError: row?.lastError ?? null,
    trashOldExports: Boolean(row?.trashOldExports),
  };

  const notice = CALLBACK_MESSAGES[(await searchParams).drive ?? ""];

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="mx-auto w-full max-w-2xl px-4 py-10">
        <h1 className="mb-4 text-xl font-semibold">Settings</h1>
        {notice && (
          <p className="mb-4 rounded border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
            {notice}
          </p>
        )}
        <DriveSync initial={state} />
      </main>
    </div>
  );
}
