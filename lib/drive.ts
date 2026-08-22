const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";

// Reading the one Takeout zip the user just handed over in the Google Picker.
//
// There is no folder-watching here, and there cannot be: the `drive.file` scope
// is per-file by design — an app sees what the user explicitly picks and
// nothing else, which is exactly why it needs no Google security review. A zip
// Takeout generates next month is a file nobody has picked yet, so no query
// could ever find it. Hence a sync somebody presses, rather than one that runs
// at 03:30 with nobody there to pick anything.

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

// Download one Drive file by id, with the user's own access token.
//
// The id comes from the Picker, which is the only thing that can produce one
// this app is allowed to read — so an id from anywhere else simply answers 404.
export async function fetchDriveFile(
  accessToken: string,
  fileId: string,
): Promise<Buffer> {
  const url = new URL(`${DRIVE_FILES_URL}/${fileId}`);
  url.searchParams.set("alt", "media");
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Drive download failed: ${await describeDriveError(res)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
