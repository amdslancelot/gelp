"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface ImportResult {
  lists: number;
  places: number;
  cacheHits: number;
  apiCalls: number;
}

// Drag-and-drop / file-input uploader that posts a Takeout zip and reports the
// import counts returned by the server.
export default function Uploader() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const upload = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      setResult(null);
      try {
        const body = new FormData();
        body.append("file", file);
        const res = await fetch("/api/import/upload", {
          method: "POST",
          body,
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Import failed");
        } else {
          setResult(data as ImportResult);
          router.refresh();
        }
      } catch {
        setError("Upload failed");
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) upload(file);
        }}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 text-center transition ${
          dragOver
            ? "border-rose-400 bg-rose-50"
            : "border-neutral-300 bg-white hover:bg-neutral-50"
        }`}
      >
        <p className="text-sm font-medium text-neutral-700">
          {busy ? "Importing…" : "Drop your Takeout zip here"}
        </p>
        <p className="mt-1 text-xs text-neutral-400">or click to choose a file</p>
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload(file);
          }}
        />
      </div>

      {error && (
        <p className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}

      {result && (
        <div className="mt-4 grid grid-cols-4 gap-3">
          <Stat label="Lists" value={result.lists} />
          <Stat label="Places" value={result.places} />
          <Stat label="Cache hits" value={result.cacheHits} />
          <Stat label="API calls" value={result.apiCalls} />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-center">
      <div className="text-lg font-semibold text-neutral-900">{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-neutral-400">
        {label}
      </div>
    </div>
  );
}
