import { JWT } from "google-auth-library";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";

// True when the environment carries everything the Drive sync needs.
export function isDriveConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 &&
    process.env.DRIVE_FOLDER_ID,
  );
}

// Build an authorized JWT client from the base64-encoded service account JSON.
function buildJwtClient(): JWT {
  const base64 = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64;
  if (!base64) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 is not set");
  }
  const json = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
  return new JWT({
    email: json.client_email,
    key: json.private_key,
    scopes: [DRIVE_SCOPE],
  });
}

// Fetch a bearer access token from the service account.
async function getAccessToken(client: JWT): Promise<string> {
  const { token } = await client.getAccessToken();
  if (!token) throw new Error("Failed to obtain a Drive access token");
  return token;
}

// Google's own words for why a Drive call failed, which are the only useful
// part of it — "403" alone cannot distinguish an API nobody enabled from a file
// this app was never given. Falls back to the status when there is no message.
async function describeDriveError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  const message = body?.error?.message;
  return message ? `${res.status} — ${message}` : `HTTP ${res.status}`;
}

// One Takeout zip sitting in the folder.
export type DriveFile = { id: string; name: string; createdTime?: string };

// Every Takeout zip in the folder, newest first.
//
// The query is the definition of what this app considers its business in that
// folder: a zip, named like a Takeout export, not already trashed. Anything
// else the user keeps there is invisible to Gelp — which matters most for the
// cleanup below, since what this query cannot see, it cannot trash.
async function listTakeoutZips(
  accessToken: string,
  folderId: string,
): Promise<DriveFile[]> {
  const query = [
    `'${folderId}' in parents`,
    "name contains 'takeout'",
    "mimeType = 'application/zip'",
    "trashed = false",
  ].join(" and ");

  const listUrl = new URL(DRIVE_FILES_URL);
  listUrl.searchParams.set("q", query);
  listUrl.searchParams.set("orderBy", "createdTime desc");
  listUrl.searchParams.set("pageSize", "100");
  listUrl.searchParams.set("fields", "files(id,name,createdTime)");

  const res = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Drive list failed: ${await describeDriveError(res)}`);
  }
  const data = (await res.json()) as { files?: DriveFile[] };
  return data.files ?? [];
}

// Download the newest Takeout zip from a Drive folder.
//
// Returns the file's identity alongside its bytes, because a caller that
// afterwards tidies the folder has to know which one it just imported — the
// single file that must survive.
//
// Takes the token and folder as arguments rather than reading the environment,
// because there is no longer one of either: the nightly sync runs this once per
// user, with that user's own access token and the folder they picked.
export async function fetchTakeoutZipFrom(
  accessToken: string,
  folderId: string,
): Promise<{ buffer: Buffer; file: DriveFile }> {
  const files = await listTakeoutZips(accessToken, folderId);
  const file = files[0];
  if (!file) {
    throw new Error("No Takeout zip found in the Drive folder");
  }

  const downloadUrl = new URL(`${DRIVE_FILES_URL}/${file.id}`);
  downloadUrl.searchParams.set("alt", "media");
  const downloadRes = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!downloadRes.ok) {
    throw new Error(
      `Drive download failed: ${await describeDriveError(downloadRes)}`,
    );
  }

  return {
    buffer: Buffer.from(await downloadRes.arrayBuffer()),
    file,
  };
}

// Move every Takeout zip in the folder except `keepFileId` to Drive's trash,
// and answer how many were moved.
//
// Trash, never delete. Trashed files are recoverable for 30 days, which is the
// difference between an automated tidy-up and an automated way to lose the only
// copy of an export. This app deletes nothing of the user's permanently.
//
// Only ever called after an import has succeeded. The export in that folder is
// the input to this app, and destroying inputs before knowing the run worked is
// how a bad night becomes an unrecoverable one.
export async function trashOlderTakeouts(
  accessToken: string,
  folderId: string,
  keepFileId: string,
): Promise<number> {
  const files = await listTakeoutZips(accessToken, folderId);
  const doomed = files.filter((f) => f.id !== keepFileId);

  let trashed = 0;
  for (const file of doomed) {
    const res = await fetch(`${DRIVE_FILES_URL}/${file.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ trashed: true }),
    });
    // One file refusing to move is not a reason to abandon the rest, and not a
    // reason to fail an import that has already succeeded. The count reports
    // what actually happened.
    if (res.ok) trashed++;
  }
  return trashed;
}

// The original single-tenant path: one service account reading one folder from
// the environment.
//
// Kept only until the per-user sync has run in production for a while. It is
// the fallback for a deployment that has the old variables set and nobody
// connected yet — see TODO.md; both variables go away with it.
export async function fetchLatestTakeoutZip(): Promise<Buffer> {
  const folderId = process.env.DRIVE_FOLDER_ID;
  if (!folderId) {
    throw new Error("DRIVE_FOLDER_ID is not set");
  }
  const token = await getAccessToken(buildJwtClient());
  return (await fetchTakeoutZipFrom(token, folderId)).buffer;
}
