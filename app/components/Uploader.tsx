"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface ImportResult {
  lists: number;
  places: number;
  cacheHits: number;
  apiCalls: number;
  listsRemoved: number;
  queued: number;
}

// Which of the two buttons was pressed. See `ImportMode` in lib/import.
type Mode = "queued" | "fast";

interface Progress {
  processed: number;
  total: number;
  listsDone: number;
  totalLists: number;
  currentList: string;
}

// Drag-and-drop / file-input uploader that posts a Takeout zip, renders a live
// progress bar from the server's streamed updates, and jumps to the list
// browser once the import finishes.
export default function Uploader() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [done, setDone] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Which mode the next file picked will be imported with. Held in a ref as
  // well as state because the file-input change handler fires after the click
  // that set it, and reads the value out of a closure.
  const modeRef = useRef<Mode>("queued");
  const [mode, setMode] = useState<Mode>("queued");

  const upload = useCallback(
    async (file: File) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      setResult(null);
      setProgress(null);
      setDone(false);
      try {
        const body = new FormData();
        body.append("file", file);
        body.append("mode", modeRef.current);
        const res = await fetch("/api/import/upload", {
          method: "POST",
          body,
        });

        // Errors before the import starts (bad zip, auth) come back as plain
        // JSON, not the stream.
        const contentType = res.headers.get("content-type") ?? "";
        if (!res.ok || !contentType.includes("x-ndjson")) {
          const data = await res.json().catch(() => ({}));
          setError(data.error ?? "Import failed");
          return;
        }

        if (!res.body) {
          setError("Import failed");
          return;
        }

        // Read the newline-delimited JSON stream, updating the bar per line.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let final: ImportResult | null = null;
        let failed: string | null = null;

        for (;;) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const msg = JSON.parse(line);
            if (msg.type === "progress") {
              setProgress(msg as Progress);
            } else if (msg.type === "done") {
              final = msg.result as ImportResult;
            } else if (msg.type === "error") {
              failed = msg.error ?? "Import failed";
            }
          }
        }

        if (failed) {
          setError(failed);
          return;
        }
        if (final) {
          setResult(final);
          setDone(true);
          // Refresh so the server-rendered list browser picks up the new data,
          // then jump to it.
          router.refresh();
          setTimeout(() => router.push("/"), 900);
        }
      } catch {
        setError("Upload failed");
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [router],
  );

  // Open the file picker, remembering which button opened it.
  const pick = (next: Mode) => {
    if (busy) return;
    modeRef.current = next;
    setMode(next);
    inputRef.current?.click();
  };

  const pct =
    progress && progress.total > 0
      ? Math.round((progress.processed / progress.total) * 100)
      : busy
        ? 0
        : null;

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (busy) return;
          const file = e.dataTransfer.files?.[0];
          if (file) upload(file);
        }}
        onClick={() => pick("queued")}
        className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 text-center transition ${
          busy
            ? "cursor-not-allowed border-neutral-200 bg-neutral-50"
            : "cursor-pointer border-neutral-300 bg-white hover:bg-neutral-50"
        } ${dragOver ? "border-rose-400 bg-rose-50" : ""}`}
      >
        <p className="text-sm font-medium text-neutral-700">
          {done ? "Import complete" : busy ? "Importing…" : "Drop your Takeout zip here"}
        </p>
        <p className="mt-1 text-xs text-neutral-400">
          {done
            ? "Taking you to your lists…"
            : busy
              ? `Keep this tab open until it finishes${
                  mode === "fast" ? "" : " — no lookups, so this is quick"
                }`
              : "or choose how to import it below"}
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload(file);
            // Reset, so picking the same file again with the other button
            // still fires a change event.
            e.target.value = "";
          }}
        />
      </div>

      {/* The two ways to import, and the trade they represent. Queued is first
          and is what a drop on the box above uses: it never guesses, so it can
          never pin a place in the wrong country — it just leaves those places
          unpinned until a resolve run reads their real positions. Fast answers
          immediately by searching for each title, which is a guess, and is
          billed. */}
      {!busy && !done && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <ModeButton
            title="Queued import"
            detail="Exact, free, slower. Places we don't already know are queued to be looked up properly — they appear once that runs."
            emphasis
            onClick={() => pick("queued")}
          />
          <ModeButton
            title="Fast import"
            detail="Everything on the map now, by searching each name. Some pins will be the wrong place, and it uses the Places API quota."
            onClick={() => pick("fast")}
          />
        </div>
      )}

      {pct !== null && (
        <div className="mt-4">
          <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-200">
            <div
              className="h-full rounded-full bg-rose-500 transition-all duration-300 ease-out"
              style={{ width: `${done ? 100 : pct}%` }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-neutral-500">
            <span className="truncate">
              {done
                ? "Done"
                : progress
                  ? `Importing “${progress.currentList}” · list ${
                      progress.listsDone + 1
                    }/${progress.totalLists}`
                  : "Reading your export…"}
            </span>
            <span className="ml-2 shrink-0 tabular-nums">
              {progress ? `${progress.processed}/${progress.total}` : ""}{" "}
              {done ? "100%" : `${pct}%`}
            </span>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}

      {result && (
        <>
          <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-5">
            <Stat label="Lists" value={result.lists} />
            <Stat label="Places" value={result.places} />
            <Stat label="Known" value={result.cacheHits} />
            <Stat label="Looked up" value={result.apiCalls} />
            {/* Lists the export no longer has, deleted to match it. */}
            <Stat label="Removed" value={result.listsRemoved} />
          </div>
          {result.queued > 0 && (
            <p className="mt-3 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
              {result.queued} place{result.queued === 1 ? "" : "s"} queued to be
              looked up properly. They&rsquo;ll have no pin until that runs — find
              them under <span className="font-medium">No coordinates</span>.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// One of the two import buttons: a title, and the trade it makes.
function ModeButton({
  title,
  detail,
  emphasis,
  onClick,
}: {
  title: string;
  detail: string;
  emphasis?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-xl border px-4 py-3 text-left transition ${
        emphasis
          ? "border-rose-300 bg-rose-50 hover:bg-rose-100"
          : "border-neutral-300 bg-white hover:bg-neutral-50"
      }`}
    >
      <div
        className={`text-sm font-semibold ${
          emphasis ? "text-rose-800" : "text-neutral-800"
        }`}
      >
        {title}
      </div>
      <div
        className={`mt-1 text-xs leading-relaxed ${
          emphasis ? "text-rose-700/80" : "text-neutral-500"
        }`}
      >
        {detail}
      </div>
    </button>
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
