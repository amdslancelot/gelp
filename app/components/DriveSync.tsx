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

export type DriveState = {
  connected: boolean;
  enabled: boolean;
  folderName: string | null;
  lastSyncedAt: number | null;
  lastError: string | null;
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

      {state.connected && !state.folderName && (
        <p className="mt-3 text-sm text-neutral-500">
          Connected, but not syncing yet — pick the folder to finish. Gelp gets
          access to that folder only, which is why this step cannot be skipped.
        </p>
      )}
    </div>
  );
}
