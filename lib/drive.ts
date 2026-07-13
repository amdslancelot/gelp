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

// Download the newest Takeout zip from the configured Drive folder and return
// its bytes. Lists candidate files, ordered newest first, and downloads the
// first match.
export async function fetchLatestTakeoutZip(): Promise<Buffer> {
  const folderId = process.env.DRIVE_FOLDER_ID;
  if (!folderId) {
    throw new Error("DRIVE_FOLDER_ID is not set");
  }

  const client = buildJwtClient();
  const token = await getAccessToken(client);
  const authHeader = { Authorization: `Bearer ${token}` };

  const query = [
    `'${folderId}' in parents`,
    "name contains 'takeout'",
    "mimeType = 'application/zip'",
    "trashed = false",
  ].join(" and ");

  const listUrl = new URL(DRIVE_FILES_URL);
  listUrl.searchParams.set("q", query);
  listUrl.searchParams.set("orderBy", "createdTime desc");
  listUrl.searchParams.set("pageSize", "1");
  listUrl.searchParams.set("fields", "files(id,name,createdTime)");

  const listRes = await fetch(listUrl, { headers: authHeader });
  if (!listRes.ok) {
    throw new Error(`Drive list failed: ${listRes.status}`);
  }
  const listData = (await listRes.json()) as {
    files?: Array<{ id: string; name: string }>;
  };
  const file = listData.files?.[0];
  if (!file) {
    throw new Error("No Takeout zip found in the Drive folder");
  }

  const downloadUrl = new URL(`${DRIVE_FILES_URL}/${file.id}`);
  downloadUrl.searchParams.set("alt", "media");
  const downloadRes = await fetch(downloadUrl, { headers: authHeader });
  if (!downloadRes.ok) {
    throw new Error(`Drive download failed: ${downloadRes.status}`);
  }

  const arrayBuffer = await downloadRes.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
