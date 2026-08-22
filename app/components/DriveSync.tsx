"use client";

import { useState } from "react";

// Minimal shape of the Google Picker globals this component touches. Typed here
// rather than pulled in as a dependency: the script is loaded at runtime from
// Google, and this is the whole surface used.
type PickerDoc = { id: string; name?: string };
type PickerData = { action: string; docs?: PickerDoc[] };
declare global {
  interface Window {
    gapi?: {
      load: (name: string, cb: () => void) => void;
    };
    google?: {
      picker: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        [key: string]: any;
      };
    };
  }
}

const PICKER_SCRIPT = "https://apis.google.com/js/api.js";

// The parts of an import dry run this panel shows. The upload page renders the
// full breakdown; here the question is narrower — is the export in that folder
// current enough to import — so it shows the size of the change and, above all,
// what would be deleted.
type SyncPreview = {
  places: number;
  lists: { name: string; status: "new" | "replace" }[];
  removed: { name: string; places: number }[];
  emptyExport: boolean;
};

export type DriveState = {
  connected: boolean;
  enabled: boolean;
  folderName: string | null;
  lastSyncedAt: number | null;
  lastError: string | null;
  trashOldExports: boolean;
};

// Load Google's picker script once and resolve when the picker module is ready.
// Called on click rather than on mount: a settings page visit that never picks
// a folder should not fetch a third-party script.
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

// The settings control for the nightly Drive sync.
//
// Three states, in order: not connected, connected but no folder yet, and
// syncing. They are steps rather than options — under `drive.file` a grant
// reaches nothing until the user picks a folder, so "connected" on its own is
// deliberately not a working state and the UI says so.
export default function DriveSync({ initial }: { initial: DriveState }) {
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // The only setting here that writes to the user's Drive, so it saves on the
  // click that changed it — no separate Save button to leave it ambiguous
  // whether the app has been given permission to move their files.
  async function setTrashOldExports(next: boolean) {
    setError(null);
    setState((s) => ({ ...s, trashOldExports: next }));
    try {
      const res = await fetch("/api/drive/prefs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trashOldExports: next }),
      });
      if (!res.ok) throw new Error("Could not save that setting");
    } catch (err) {
      // Put the switch back rather than leaving the page claiming a state the
      // server does not have.
      setState((s) => ({ ...s, trashOldExports: !next }));
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  // Ask what importing the newest zip in the folder would do, without writing.
  // Deliberately not one click all the way through: a Takeout export is a
  // complete snapshot, so importing a stale one deletes every list saved since
  // it was taken, and only the user knows whether the export is current.
  async function checkForUpdate() {
    setError(null);
    setDone(null);
    setPreview(null);
    setBusy(true);
    try {
      const res = await fetch("/api/drive/sync?dryRun=1", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not read the folder");
      setPreview({
        places: body.places,
        lists: body.lists,
        removed: body.removed,
        emptyExport: body.emptyExport,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  // Import for real, now that the user has seen what it would do.
  async function importNow() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/drive/sync", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "The import failed");
      setPreview(null);
      setDone("Imported. Your lists are up to date.");
      setState((s) => ({ ...s, lastSyncedAt: Date.now(), lastError: null }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const pickerKey = process.env.NEXT_PUBLIC_GOOGLE_PICKER_KEY;

  async function pickFolder() {
    setError(null);
    setBusy(true);
    try {
      if (!pickerKey) {
        throw new Error(
          "NEXT_PUBLIC_GOOGLE_PICKER_KEY is not set on this server",
        );
      }

      const tokenRes = await fetch("/api/drive/picker-token");
      if (!tokenRes.ok) {
        const body = (await tokenRes.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? "Could not start the picker");
      }
      const { accessToken } = (await tokenRes.json()) as {
        accessToken: string;
      };

      await loadPicker();
      const picker = window.google!.picker;

      const view = new picker.DocsView(picker.ViewId.FOLDERS)
        .setSelectFolderEnabled(true)
        .setIncludeFolders(true)
        .setMimeTypes("application/vnd.google-apps.folder");

      new picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(accessToken)
        .setDeveloperKey(pickerKey)
        .setTitle("Pick the folder your Takeout exports go to")
        .setCallback(async (data: PickerData) => {
          if (data.action !== picker.Action.PICKED) return;
          const doc = data.docs?.[0];
          if (!doc) return;
          const res = await fetch("/api/drive/folder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folderId: doc.id, folderName: doc.name }),
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as {
              error?: string;
            };
            setError(body.error ?? "Could not save the folder");
            return;
          }
          setState((s) => ({
            ...s,
            enabled: true,
            folderName: doc.name ?? "Selected folder",
            lastError: null,
          }));
        })
        .build()
        .setVisible(true);
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
      setState((s) => ({
        ...s,
        connected: false,
        enabled: false,
        folderName: null,
        lastError: null,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-white px-4 py-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium text-neutral-900">
            Nightly Drive sync
          </h2>
          <p className="mt-1 text-sm text-neutral-500">
            Point Gelp at the Drive folder your Google Takeout exports land in,
            and it imports the newest one every night. Gelp only ever sees the
            folder you pick here — nothing else in your Drive.
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
            state.enabled
              ? "bg-green-50 text-green-700"
              : "bg-neutral-100 text-neutral-500"
          }`}
        >
          {state.enabled ? "On" : "Off"}
        </span>
      </div>

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
              onClick={pickFolder}
              disabled={busy}
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50"
            >
              {state.folderName ? "Change folder" : "Pick the Takeout folder"}
            </button>
            {state.folderName && (
              <button
                onClick={checkForUpdate}
                disabled={busy}
                className="rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
              >
                {busy ? "Checking…" : "Sync now"}
              </button>
            )}
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

      {done && (
        <p className="mt-3 rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
          {done}
        </p>
      )}

      {preview && (
        <div className="mt-3 rounded border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm">
          {preview.emptyExport ? (
            <p className="text-amber-800">
              That zip contains no lists at all — far more likely a broken
              download than an emptied account. Nothing would be imported and
              nothing deleted.
            </p>
          ) : (
            <>
              <p className="text-neutral-700">
                The newest export in that folder has{" "}
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

      <dl className="mt-4 space-y-1 text-sm text-neutral-500">
        {state.folderName && (
          <div className="flex gap-2">
            <dt className="text-neutral-400">Folder</dt>
            <dd className="text-neutral-700">{state.folderName}</dd>
          </div>
        )}
        <div className="flex gap-2">
          <dt className="text-neutral-400">Last synced</dt>
          <dd className="text-neutral-700">
            {state.lastSyncedAt
              ? new Date(state.lastSyncedAt).toLocaleString()
              : "never"}
          </dd>
        </div>
      </dl>

      {state.folderName && (
        <label className="mt-4 flex gap-2 text-sm text-neutral-600">
          <input
            type="checkbox"
            checked={state.trashOldExports}
            onChange={(e) => setTrashOldExports(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Keep only the newest export — after a successful import, move the
            older Takeout zips in that folder to Drive&rsquo;s trash. They stay
            recoverable there for 30 days, and nothing else in the folder is
            touched.
          </span>
        </label>
      )}

      {state.connected && !state.folderName && (
        <p className="mt-3 text-sm text-neutral-500">
          Connected, but not syncing yet — pick the folder to finish. Gelp gets
          access to that folder only, which is why this step cannot be skipped.
        </p>
      )}
    </div>
  );
}
