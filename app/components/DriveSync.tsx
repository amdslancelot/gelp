"use client";

import { useState } from "react";

// Minimal shape of the Google Picker globals this component touches. Typed here
// rather than pulled in as a dependency: the script is loaded at runtime from
// Google, and this is the whole surface used.
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

// The parts of an import dry run this panel shows. The upload page renders the
// full breakdown; here the question is narrower — is this export current enough
// to import — so it shows the size of the change and, above all, what would be
// deleted.
type SyncPreview = {
  fileName: string;
  fileId: string;
  places: number;
  lists: unknown[];
  removed: { name: string; places: number }[];
  emptyExport: boolean;
};

export type DriveState = {
  connected: boolean;
  lastSyncedAt: number | null;
  lastError: string | null;
};

// Read a JSON response, or fail with something that names what actually came
// back. An API answering with HTML means the request never reached the route —
// a session that expired into a login redirect, or a dev server that has not
// compiled the route yet — and "Unexpected token '<'" describes none of that.
async function readJson(res: Response): Promise<Record<string, unknown>> {
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

// Load Google's picker script once and resolve when the picker module is ready.
// Called on click rather than on mount: a settings page visit that never syncs
// should not fetch a third-party script.
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

// The settings control for importing straight from Drive.
//
// Deliberately a button rather than a schedule. The `drive.file` scope shows
// this app only the file its owner picks for it, which is what keeps it out of
// Google's verification process — and also what makes an unattended sync
// impossible: next month's export is a file nobody has picked yet. Since taking
// a Takeout export is itself something you do by hand, pressing sync afterwards
// is the next step of the same act.
export default function DriveSync({ initial }: { initial: DriveState }) {
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const pickerKey = process.env.NEXT_PUBLIC_GOOGLE_PICKER_KEY;

  // Open the Picker, and dry-run whatever comes back. Nothing is written: the
  // user sees what importing that export would do — including which stored
  // lists it would delete — and decides.
  async function pickAndPreview() {
    setError(null);
    setDone(null);
    setPreview(null);
    setBusy(true);
    try {
      if (!pickerKey) {
        throw new Error(
          "NEXT_PUBLIC_GOOGLE_PICKER_KEY is not set on this server",
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

      const view = new picker.DocsView(picker.ViewId.DOCS)
        .setMimeTypes("application/zip")
        .setIncludeFolders(true);

      new picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(accessToken)
        .setDeveloperKey(pickerKey)
        .setTitle("Pick your Takeout .zip")
        .setCallback(async (data: PickerData) => {
          if (data.action === picker.Action.CANCEL) {
            setBusy(false);
            return;
          }
          if (data.action !== picker.Action.PICKED) return;
          const doc = data.docs?.[0];
          if (!doc) return setBusy(false);

          setBusy(true);
          try {
            const res = await fetch("/api/drive/sync?dryRun=1", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ fileId: doc.id }),
            });
            const body = await readJson(res);
            if (!res.ok)
              throw new Error((body.error as string) ?? "Could not read it");
            setPreview({
              fileName: doc.name ?? "the picked file",
              fileId: doc.id,
              places: body.places as number,
              lists: body.lists as unknown[],
              removed: body.removed as { name: string; places: number }[],
              emptyExport: body.emptyExport as boolean,
            });
          } catch (err) {
            setError(
              err instanceof Error ? err.message : "Something went wrong",
            );
          } finally {
            setBusy(false);
          }
        })
        .build()
        .setVisible(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  // Import for real, now that the user has seen what it would do.
  async function importNow() {
    if (!preview) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/drive/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId: preview.fileId }),
      });
      const body = await readJson(res);
      if (!res.ok)
        throw new Error((body.error as string) ?? "The import failed");
      setPreview(null);
      setDone("Imported. Your lists are up to date.");
      setState((s) => ({ ...s, lastSyncedAt: Date.now(), lastError: null }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/drive/disconnect", { method: "DELETE" });
      if (!res.ok) throw new Error("Could not disconnect");
      setPreview(null);
      setState((s) => ({ ...s, connected: false, lastError: null }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-white px-4 py-4">
      <h2 className="text-sm font-medium text-neutral-900">
        Import from Drive
      </h2>
      <p className="mt-1 text-sm text-neutral-500">
        Have Takeout deliver your export to Drive, then import it from there —
        no downloading, no uploading. Gelp sees only the file you pick, nothing
        else in your Drive.
      </p>

      {/* Google offers no way to start a Takeout export from another app, so
          this is a link and a checklist rather than a button that does it.
          Saying exactly which boxes to tick is the whole value: the products
          are named inconsistently in Takeout's own list, and picking the wrong
          ones produces an export that imports to nothing. */}
      <ol className="mt-4 space-y-2 text-sm text-neutral-600">
        <li className="flex gap-2">
          <span className="text-neutral-400">1.</span>
          <span>
            <a
              href="https://takeout.google.com/settings/takeout"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-rose-600 underline underline-offset-2"
            >
              Open Google Takeout
            </a>{" "}
            and press <strong>Deselect all</strong>.
          </span>
        </li>
        <li className="flex gap-2">
          <span className="text-neutral-400">2.</span>
          <span>
            Tick <strong>Maps (your places)</strong>, <strong>My Maps</strong>,
            and <strong>Saved</strong> — the last one is your lists. Leave
            everything else off for a smaller export.
          </span>
        </li>
        <li className="flex gap-2">
          <span className="text-neutral-400">3.</span>
          <span>
            For delivery, choose <strong>Add to Drive</strong>, then create the
            export. Google takes a while — minutes to hours — and emails you
            when the zip has landed in your Drive.
          </span>
        </li>
        <li className="flex gap-2">
          <span className="text-neutral-400">4.</span>
          <span>
            Come back and press <strong>Sync from Drive</strong> below. Pick
            that zip, and Gelp will show you what importing it would change
            before writing anything.
          </span>
        </li>
      </ol>

      {state.lastError && (
        <p className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {state.lastError}
        </p>
      )}
      {error && (
        <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {done && (
        <p className="mt-3 rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
          {done}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {!state.connected ? (
          <a
            href="/api/drive/connect"
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700"
          >
            Connect Google Drive
          </a>
        ) : (
          <>
            <button
              onClick={pickAndPreview}
              disabled={busy}
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50"
            >
              {busy ? "Working…" : "Sync from Drive"}
            </button>
            <button
              onClick={disconnect}
              disabled={busy}
              className="rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
            >
              Disconnect
            </button>
          </>
        )}
      </div>

      {preview && (
        <div className="mt-3 rounded border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm">
          <p className="text-neutral-500">{preview.fileName}</p>
          {preview.emptyExport ? (
            <p className="mt-1 text-amber-800">
              That zip contains no lists at all — far more likely a broken
              download than an emptied account. Nothing would be imported and
              nothing deleted.
            </p>
          ) : (
            <>
              <p className="mt-1 text-neutral-700">
                <strong>{preview.places.toLocaleString()}</strong> places across{" "}
                <strong>{preview.lists.length}</strong> lists.
              </p>
              {preview.removed.length > 0 && (
                <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
                  <p className="font-medium">
                    {preview.removed.length} stored list
                    {preview.removed.length === 1 ? "" : "s"} would be deleted,
                    because this export does not contain{" "}
                    {preview.removed.length === 1 ? "it" : "them"}:
                  </p>
                  <ul className="mt-1 list-inside list-disc">
                    {preview.removed.map((r) => (
                      <li key={r.name}>
                        {r.name}{" "}
                        <span className="text-amber-700">
                          ({r.places} places)
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1">
                    If you saved those after this export was taken, take a fresh
                    Takeout instead of importing this one.
                  </p>
                </div>
              )}
              <div className="mt-3 flex gap-2">
                <button
                  onClick={importNow}
                  disabled={busy}
                  className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50"
                >
                  {busy ? "Importing…" : "Import this export"}
                </button>
                <button
                  onClick={() => setPreview(null)}
                  disabled={busy}
                  className="rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <dl className="mt-4 text-sm text-neutral-500">
        <div className="flex gap-2">
          <dt className="text-neutral-400">Last imported from Drive</dt>
          <dd className="text-neutral-700">
            {state.lastSyncedAt
              ? new Date(state.lastSyncedAt).toLocaleString()
              : "never"}
          </dd>
        </div>
      </dl>
    </div>
  );
}
