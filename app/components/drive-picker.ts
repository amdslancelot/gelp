"use client";

// Opening Google's file picker and getting back the zip a user chose.
//
// Kept apart from the components that use it because two of them do: the import
// page picks a zip to import, and the settings panel only manages the
// connection. The picker itself is a lump of Google's runtime with three
// non-obvious requirements, and they belong in one place.

type PickerDoc = { id: string; name?: string };
type PickerData = { action: string; docs?: PickerDoc[] };

declare global {
  interface Window {
    gapi?: { load: (name: string, cb: () => void) => void };
    google?: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      picker: { [key: string]: any };
    };
  }
}

const PICKER_SCRIPT = "https://apis.google.com/js/api.js";

// Drive labels a zip inconsistently — a Takeout export lands as
// `application/x-zip` in practice, but the other three occur too depending on
// what wrote the file. Miss the right one and the picker says "No documents",
// which reads as "your export is missing".
const ZIP_MIME_TYPES = [
  "application/x-zip",
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream",
].join(",");

// Load Google's picker script once, on demand. A page visit that never picks
// anything should not fetch a third-party script.
function loadPicker(): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = () => window.gapi!.load("picker", () => resolve());
    if (window.gapi) return start();
    const script = document.createElement("script");
    script.src = PICKER_SCRIPT;
    script.onload = start;
    script.onerror = () => reject(new Error("Could not load Google Picker"));
    document.head.appendChild(script);
  });
}

// Read a JSON response, or fail with something that names what actually came
// back. An API answering with HTML means the request never reached the route —
// a session that expired into a login redirect, or a route the dev server has
// not compiled — and "Unexpected token '<'" describes none of that.
export async function readJson(
  res: Response,
): Promise<Record<string, unknown>> {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) {
    throw new Error(
      res.status === 401 || res.redirected
        ? "Your session expired — reload the page and sign in again."
        : `The server answered ${res.status} with a page instead of data. Reload and try again.`,
    );
  }
  return (await res.json()) as Record<string, unknown>;
}

// Show the picker and resolve with the chosen file, or null if the user closed
// it. Rejects only when the picker could not be shown at all.
export async function pickDriveZip(): Promise<PickerDoc | null> {
  const pickerKey = process.env.NEXT_PUBLIC_GOOGLE_PICKER_KEY;
  const projectNumber = process.env.NEXT_PUBLIC_GOOGLE_PROJECT_NUMBER;
  if (!pickerKey) {
    throw new Error("NEXT_PUBLIC_GOOGLE_PICKER_KEY is not set on this server");
  }
  if (!projectNumber) {
    throw new Error(
      "NEXT_PUBLIC_GOOGLE_PROJECT_NUMBER is not set on this server",
    );
  }

  const tokenRes = await fetch("/api/drive/picker-token");
  const tokenBody = await readJson(tokenRes);
  if (!tokenRes.ok) {
    throw new Error(
      (tokenBody.error as string) ?? "Could not start the picker",
    );
  }
  const accessToken = tokenBody.accessToken as string;

  await loadPicker();
  const picker = window.google!.picker;

  const zipView = new picker.DocsView(picker.ViewId.DOCS)
    .setMimeTypes(ZIP_MIME_TYPES)
    .setIncludeFolders(true)
    .setLabel("Takeout zips");
  // An unfiltered view behind it, because the cost of a wrong guess about mime
  // types is a user who cannot proceed at all. Picking a non-zip is harmless:
  // the server parses it and says it is not a Takeout export.
  const allView = new picker.DocsView(picker.ViewId.DOCS)
    .setIncludeFolders(true)
    .setLabel("All files");

  return new Promise((resolve) => {
    new picker.PickerBuilder()
      .addView(zipView)
      .addView(allView)
      .setOAuthToken(accessToken)
      .setDeveloperKey(pickerKey)
      // Required for `drive.file`, and the whole reason picking works at all:
      // this is what makes the picker *grant* the app access to the chosen file
      // rather than merely hand back its id. Without it every pick looks fine
      // and every subsequent read is a 404.
      .setAppId(projectNumber)
      .setTitle("Pick your Takeout .zip")
      .setCallback((data: PickerData) => {
        if (data.action === picker.Action.PICKED) {
          resolve(data.docs?.[0] ?? null);
        } else if (data.action === picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build()
      .setVisible(true);
  });
}
