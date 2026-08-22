"use client";

import { useState } from "react";

export type DriveState = {
  connected: boolean;
  lastSyncedAt: number | null;
  lastError: string | null;
};

// Settings' Drive panel: the connection, and nothing else.
//
// Importing lives on the import page, beside the upload it is a variant of —
// choosing a zip from Drive and choosing one from a disk differ only in where
// the bytes come from, and splitting them across two pages meant two
// implementations of the same dry run. What is left here is the part that is
// genuinely a setting: whether this app holds a Drive grant at all.
export default function DriveSync({ initial }: { initial: DriveState }) {
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function disconnect() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/drive/disconnect", { method: "DELETE" });
      if (!res.ok) throw new Error("Could not disconnect");
      setState((s) => ({ ...s, connected: false, lastError: null }));
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
          <h2 className="text-sm font-medium text-neutral-900">Google Drive</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Connect Drive to import a Takeout export straight from it, without
            downloading the zip first. Gelp sees only the file you pick each
            time — nothing else in your Drive.
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
            state.connected
              ? "bg-emerald-50 text-emerald-700"
              : "bg-neutral-100 text-neutral-500"
          }`}
        >
          {state.connected ? "Connected" : "Not connected"}
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
            <a
              href="/import"
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700"
            >
              Go to import
            </a>
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

      <p className="mt-4 text-sm text-neutral-500">
        Last imported from Drive:{" "}
        <span className="text-neutral-700">
          {state.lastSyncedAt
            ? new Date(state.lastSyncedAt).toLocaleString()
            : "never"}
        </span>
      </p>
    </div>
  );
}
