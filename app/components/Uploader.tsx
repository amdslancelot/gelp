"use client";

import { useCallback, useRef, useState } from "react";
import { pickDriveZip, readJson } from "./drive-picker";
import { useRouter } from "next/navigation";
import type { DeadPlace, ImportAnalysis, ListAnalysis } from "@/lib/import";

interface ImportResult {
  lists: number;
  places: number;
  cacheHits: number;
  apiCalls: number;
  listsRemoved: number;
  queued: number;
  gone: number;
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

// Drag-and-drop / file-input uploader.
//
// A file is analysed before it is imported: the zip goes to /api/import/analyze,
// which writes nothing and asks Google nothing, and the answer — how much of
// this export is already known, how much would be queued, and which lists would
// be deleted — is what the user confirms. The mode is chosen at that point
// rather than before picking the file, because the choice only means something
// once you can see how many places it applies to.
//
// The file itself is held here and uploaded a second time on confirm, so no
// parsed export has to be kept server-side between the two requests.
// Where the export being imported came from. Both sources run the same two
// steps against the same analysis and the same progress stream — only the first
// request of each step differs, so everything below this type is shared.
type Source =
  | { kind: "upload"; file: File }
  | { kind: "drive"; fileId: string; name: string };

export default function Uploader({
  driveConnected,
}: {
  driveConnected: boolean;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [done, setDone] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Which mode the confirmed import is running with, for the wording of the
  // progress line.
  const [mode, setMode] = useState<Mode>("queued");

  const reset = () => {
    setSource(null);
    setAnalysis(null);
    setError(null);
    setResult(null);
    setProgress(null);
    setDone(false);
  };

  // Step one: ask what this export would do. Nothing is written by this.
  const analyze = useCallback(async (picked: Source) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setAnalyzing(true);
    setError(null);
    setAnalysis(null);
    setResult(null);
    setProgress(null);
    setDone(false);
    setSource(picked);
    try {
      const res =
        picked.kind === "upload"
          ? await fetch("/api/import/analyze", {
              method: "POST",
              body: (() => {
                const body = new FormData();
                body.append("file", picked.file);
                return body;
              })(),
            })
          : await fetch("/api/drive/sync?dryRun=1", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ fileId: picked.fileId }),
            });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not read that export");
        setSource(null);
        return;
      }
      setAnalysis(data as ImportAnalysis);
    } catch {
      setError("Could not read that export");
      setSource(null);
    } finally {
      busyRef.current = false;
      setAnalyzing(false);
    }
  }, []);

  // Open Google's picker and analyse whatever comes back. The import itself is
  // identical to an upload from here on — the zip simply never touches a disk.
  const pickFromDrive = useCallback(async () => {
    if (busyRef.current) return;
    setError(null);
    try {
      const doc = await pickDriveZip();
      if (!doc) return;
      await analyze({
        kind: "drive",
        fileId: doc.id,
        name: doc.name ?? "your export",
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not open the picker",
      );
    }
  }, [analyze]);

  // Step two: do it. The same file, sent again, now that the user has seen
  // what it would do.
  const upload = useCallback(
    async (picked: Source, chosen: Mode) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setMode(chosen);
      setError(null);
      setResult(null);
      setProgress(null);
      setDone(false);
      try {
        const res =
          picked.kind === "upload"
            ? await fetch("/api/import/upload", {
                method: "POST",
                body: (() => {
                  const body = new FormData();
                  body.append("file", picked.file);
                  body.append("mode", chosen);
                  return body;
                })(),
              })
            : await fetch(`/api/drive/sync?mode=${chosen}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ fileId: picked.fileId }),
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

  const working = busy || analyzing;

  const pct =
    progress && progress.total > 0
      ? Math.round((progress.processed / progress.total) * 100)
      : busy
        ? 0
        : null;

  // The drop zone stands down once a file has been analysed: the decision on
  // screen is then which import to run, and a big "drop a file here" target
  // above it invites replacing the thing being decided about.
  const showDropZone = !analysis || busy || done;

  return (
    <div>
      {showDropZone && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              if (!working) setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (working) return;
              const picked = e.dataTransfer.files?.[0];
              if (picked) analyze({ kind: "upload", file: picked });
            }}
            onClick={() => {
              if (!working) inputRef.current?.click();
            }}
            className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 text-center transition ${
              working
                ? "cursor-not-allowed border-neutral-200 bg-neutral-50"
                : "cursor-pointer border-neutral-300 bg-white hover:bg-neutral-50"
            } ${dragOver ? "border-emerald-400 bg-emerald-50" : ""}`}
          >
            <p className="text-sm font-medium text-neutral-700">
              {done
                ? "Import complete"
                : busy
                  ? "Importing…"
                  : analyzing
                    ? "Reading your export…"
                    : "Drop your Takeout zip here"}
            </p>
            <p className="mt-1 text-xs text-neutral-400">
              {done
                ? "Taking you to your lists…"
                : busy
                  ? `Keep this tab open until it finishes${
                      mode === "fast" ? "" : " — no lookups, so this is quick"
                    }`
                  : analyzing
                    ? "Working out what importing it would do — nothing is saved yet"
                    : "Nothing is imported until you've seen what it would do"}
            </p>
          </div>

          {/* The Drive route sits beside the drop zone, not on another page and
            not under it: they are two shelves the same export can come off,
            and everything after the file is chosen — the dry run, the mode
            buttons, the progress bar — is the same code. */}
          <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-neutral-300 bg-white px-6 py-12 text-center">
            {driveConnected ? (
              <>
                <button
                  onClick={pickFromDrive}
                  disabled={working}
                  className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50"
                >
                  Import from Google Drive
                </button>
                <p className="mt-2 text-xs text-neutral-400">
                  If Takeout delivered your export there, pick it without
                  downloading it first
                </p>
              </>
            ) : (
              <>
                <a
                  href="/settings"
                  className="rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
                >
                  Connect Google Drive
                </a>
                <p className="mt-2 text-xs text-neutral-400">
                  To import an export Takeout delivered to Drive, without
                  downloading it
                </p>
              </>
            )}
          </div>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        disabled={working}
        onChange={(e) => {
          const picked = e.target.files?.[0];
          if (picked) analyze({ kind: "upload", file: picked });
          // Reset, so picking the same file again still fires a change event.
          e.target.value = "";
        }}
      />

      {analysis && !busy && !done && (
        <AnalysisPanel
          analysis={analysis}
          fileName={
            source?.kind === "upload"
              ? source.file.name
              : (source?.name ?? "your export")
          }
          onImport={(chosen) => {
            if (source) upload(source, chosen);
          }}
          onCancel={() => {
            reset();
            inputRef.current?.click();
          }}
        />
      )}

      {pct !== null && (
        <div className="mt-4">
          <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-200">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all duration-300 ease-out"
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
              looked up properly. They&rsquo;ll have no pin until that runs —
              find them under{" "}
              <span className="font-medium">No coordinates</span>.
            </p>
          )}
          {result.gone > 0 && (
            <p className="mt-3 rounded-lg bg-stone-100 px-4 py-3 text-sm text-stone-600">
              {result.gone} place{result.gone === 1 ? "" : "s"} could not be
              queued: Google no longer has the saved link, so there is no map
              page to read. Find {result.gone === 1 ? "it" : "them"} under{" "}
              <span className="font-medium">No coordinates</span> — a fast
              import will still try to look {result.gone === 1 ? "it" : "them"}{" "}
              up by name.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// What the export would do, and the two ways to go ahead with it.
function AnalysisPanel({
  analysis,
  fileName,
  onImport,
  onCancel,
}: {
  analysis: ImportAnalysis;
  fileName: string;
  onImport: (mode: Mode) => void;
  onCancel: () => void;
}) {
  const t = analysis.totals;
  // Places that would be on the map the moment the import finishes, whichever
  // mode is chosen — the guessed ones included, since a guess still pins.
  const located =
    t.exact + t.fromUrl + t.cached + t.cachedGuess + t.unverifiable;
  // Positions that are simply right. A cached row mirrored from `place_coords`
  // or from a URL that stated its own position belongs here rather than with
  // the guesses: where it is stored says nothing about how it was found.
  const confirmed = t.exact + t.fromUrl + t.cached;
  // Positions a text search picked, whether or not they can still be corrected.
  const guessed = t.cachedGuess + t.unverifiable;
  // Everything the import keeps. The five states below sum to it exactly, and
  // it is the export minus what is dropped — so the two sections account for
  // every place between them.
  const active =
    confirmed + guessed + t.cachedMissing + t.unknown + t.alreadyQueued;

  if (analysis.emptyExport) {
    return (
      <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-4">
        <p className="text-sm font-semibold text-amber-900">
          No lists in this export
        </p>
        <p className="mt-1 text-xs leading-relaxed text-amber-800">
          {fileName} parsed to zero lists, which is far more likely to be a
          broken or half-downloaded zip than an account with nothing saved.
          Nothing would be imported and — importantly — nothing would be
          deleted. Try downloading the Takeout export again.
        </p>
        <button
          onClick={onCancel}
          className="mt-3 rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
        >
          Choose a different file
        </button>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-xl border border-neutral-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-neutral-800">
          What this import would do
        </h2>
        <span className="truncate text-xs text-neutral-400">{fileName}</span>
      </div>
      {/* Three sections that account for every place in the export: where it
          came from, what survives the import, and what falls out of it.
          Active + Dropped = Source, always — the buckets are disjoint. */}
      <Section title="Source">
        <p className="text-xs text-neutral-500">
          {analysis.places.toLocaleString()} place
          {analysis.places === 1 ? "" : "s"} across {analysis.lists.length} list
          {analysis.lists.length === 1 ? "" : "s"}. Nothing has been saved yet.
        </p>
      </Section>

      {/* The five states a place can survive in, summed. Confirmed and Guessed
          are the two that have a position today; the other three are on the map
          in the sense that they are still yours, and will get one. */}
      <Section title="Active" tone="green">
        <div className="flex flex-wrap items-stretch gap-2">
          <Term
            label="Confirmed"
            value={confirmed}
            hint="Positions read off each place's own map page, or stated outright by the export. Correct, and free."
          />
          <Plus />
          <Term
            label="Guessed"
            value={guessed}
            hint={
              t.unverifiable > 0
                ? `Cached, but picked by searching the name — some will be the wrong business. ${t.unverifiable.toLocaleString()} of them can never be checked, because Google has dropped the saved link.`
                : "Cached, but picked by searching the name — some will be the wrong business. A resolve run can still correct them."
            }
          />
          <Plus />
          <Term
            label="Not found"
            value={t.cachedMissing}
            hint="Looked for by a previous import and not found. Cached as a miss, so it is not searched — or billed — again."
          />
          <Plus />
          <Term
            label="New"
            value={t.unknown}
            hint="Nobody has resolved these yet. This is the only group either import mode spends anything on."
            emphasis={t.unknown > 0}
          />
          <Plus />
          <Term
            label="Already queued"
            value={t.alreadyQueued}
            hint="Already has a row on the resolve queue, so re-importing adds nothing."
          />
          <Plus sign="=" />
          <Term label="Active" value={active} total />
        </div>
        <p className="mt-2 text-[11px] text-neutral-400">
          {located.toLocaleString()} of them would have a pin straight away —
          Confirmed and Guessed. The rest are kept and will get one.
        </p>
      </Section>

      <Section
        title="Dropped"
        tone={t.gone + t.notPlace > 0 ? "red" : "neutral"}
      >
        {/* Only tinted when something is actually dropped: a red panel saying
            "nothing" reads as a warning about the nothing. */}
        <ul
          className={`space-y-1 text-xs ${
            t.gone + t.notPlace > 0
              ? "rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800"
              : "text-neutral-500"
          }`}
        >
          {t.gone > 0 && (
            <li>
              <span className="font-medium text-red-900">
                {t.gone.toLocaleString()}
              </span>{" "}
              {t.gone === 1 ? "has" : "have"} a dead Google link — no pin.
            </li>
          )}
          {t.notPlace > 0 && (
            <li>
              <span className="font-medium text-red-900">
                {t.notPlace.toLocaleString()}
              </span>{" "}
              {t.notPlace === 1 ? "is" : "are"} not map places.
            </li>
          )}
          {t.gone === 0 && t.notPlace === 0 && (
            <li>Nothing — every place in this export is on the map.</li>
          )}
        </ul>
      </Section>

      <p className="mt-3 text-[11px] text-neutral-400">
        An estimate of right now: the nightly sync could resolve or queue some
        of these before you confirm.
      </p>

      {/* A heavier border than the Dropped panel above, deliberately: both are
          red, but only this one destroys something. */}
      {analysis.removed.length > 0 && (
        <div className="mt-4 rounded-lg border-2 border-red-400 bg-red-50 px-4 py-3">
          <p className="text-sm font-semibold text-red-800">
            {analysis.removed.length} list
            {analysis.removed.length === 1 ? "" : "s"} would be deleted
          </p>
          <p className="mt-1 text-xs leading-relaxed text-red-700">
            A Takeout export is a complete snapshot, so a list missing from it
            was deleted in Google Maps and is deleted here too — along with{" "}
            {analysis.removed
              .reduce((n, l) => n + l.places, 0)
              .toLocaleString()}{" "}
            place
            {analysis.removed.reduce((n, l) => n + l.places, 0) === 1
              ? ""
              : "s"}{" "}
            and their notes.
          </p>
          <ul className="mt-2 space-y-1">
            {analysis.removed.map((l) => (
              <li
                key={l.name}
                className="flex items-baseline justify-between gap-3 text-xs text-red-800"
              >
                <span className="truncate">{l.name}</span>
                <span className="shrink-0 tabular-nums text-red-600">
                  {l.places.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {analysis.deadTotal > 0 && (
        <DeadIdPanel
          dead={analysis.dead}
          total={analysis.deadTotal}
          guessed={analysis.deadGuessed}
        />
      )}

      <ListBreakdown lists={analysis.lists} />

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <ModeButton
          title="Queued import"
          detail={
            analysis.wouldQueue > 0
              ? `Exact, free, slower. ${analysis.wouldQueue.toLocaleString()} place${
                  analysis.wouldQueue === 1 ? "" : "s"
                } would go on the queue to be read off their own map pages — no pin until that runs.`
              : "Exact, free. Nothing new to queue: every place here is already known or already waiting."
          }
          emphasis
          onClick={() => onImport("queued")}
        />
        <ModeButton
          title="Fast import"
          detail={
            analysis.wouldCallApi > 0
              ? `Everything on the map now, by searching each name. At least ${analysis.wouldCallApi.toLocaleString()} Places API call${
                  analysis.wouldCallApi === 1 ? "" : "s"
                }, and some pins will be the wrong place.`
              : "Nothing left to search — this would do exactly what the queued import does, at no cost."
          }
          onClick={() => onImport("fast")}
        />
      </div>

      <button
        onClick={onCancel}
        className="mt-3 text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-700"
      >
        Choose a different file
      </button>
    </div>
  );
}

// One labelled band of the summary. The heading is what makes the arithmetic
// legible: without it the numbers are a pile, with it they are Source split
// into Active and Dropped.
function Section({
  title,
  tone = "neutral",
  children,
}: {
  title: string;
  tone?: "neutral" | "green" | "red";
  children: React.ReactNode;
}) {
  const heading = {
    neutral: "text-neutral-400",
    green: "text-emerald-600",
    red: "text-red-500",
  }[tone];
  return (
    <div className="mt-4 first:mt-3">
      <h3 className={`text-sm font-semibold tracking-wide ${heading}`}>
        {title}
      </h3>
      <div className="mt-2">{children}</div>
    </div>
  );
}

// One term of the Active sum: a count and what it counts.
function Term({
  label,
  value,
  hint,
  emphasis,
  total,
}: {
  label: string;
  value: number;
  hint?: string;
  emphasis?: boolean;
  total?: boolean;
}) {
  return (
    <div
      title={hint}
      className={`min-w-[5.5rem] flex-1 rounded-lg border px-2.5 py-2 text-center ${
        total
          ? "border-emerald-600 bg-emerald-600"
          : emphasis
            ? "border-amber-300 bg-amber-50"
            : "border-emerald-200 bg-white"
      }`}
    >
      <div
        className={`text-base font-semibold tabular-nums ${
          total
            ? "text-white"
            : emphasis
              ? "text-amber-900"
              : "text-neutral-900"
        }`}
      >
        {value.toLocaleString()}
      </div>
      <div
        className={`text-[10px] uppercase tracking-wide ${
          total
            ? "text-emerald-50"
            : emphasis
              ? "text-amber-700"
              : "text-emerald-700"
        }`}
      >
        {label}
      </div>
    </div>
  );
}

// The operator between two terms. Purely typographic, so it is hidden from
// screen readers rather than read out as part of the label.
function Plus({ sign = "+" }: { sign?: string }) {
  return (
    <div
      aria-hidden
      className="flex shrink-0 items-center text-sm font-medium text-emerald-300"
    >
      {sign}
    </div>
  );
}

// The places whose saved Google link no longer resolves — named, not just
// counted.
//
// This is the one outcome the app cannot work its way out of. A resolve run
// cannot read a page that no longer exists, and flagging one does nothing at
// all: `enqueuePlaces` filters tombstoned ids out for every caller, so the
// report is accepted and then dropped. The only fix is outside the app — open
// the place in Google Maps and save it again, which mints a new id — and that
// is not something a count can tell you to do about a place you cannot name.
function DeadIdPanel({
  dead,
  total,
  guessed,
}: {
  dead: DeadPlace[];
  total: number;
  guessed: number;
}) {
  return (
    <details
      className="mt-4 rounded-lg border border-stone-300 bg-stone-50"
      open
    >
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-stone-700 hover:bg-stone-100">
        {total.toLocaleString()} place{total === 1 ? "" : "s"} whose Google link
        is dead
        {guessed > 0 && (
          <span className="font-normal text-stone-500">
            {" "}
            · {guessed.toLocaleString()} pinned by a guess
          </span>
        )}
      </summary>
      <div className="border-t border-stone-200 px-3 py-2">
        <p className="text-xs leading-relaxed text-stone-600">
          Google no longer has an entry under {total === 1 ? "this" : "these"}{" "}
          saved link{total === 1 ? "" : "s"}, so nothing in the app can ever
          resolve {total === 1 ? "it" : "them"} — a resolve run has no page to
          open, and flagging {total === 1 ? "it" : "them"} does nothing. The fix
          is to find the place in Google Maps and save it again, then re-export.
          {guessed > 0 && (
            <>
              {" "}
              The {guessed.toLocaleString()} marked{" "}
              <span className="font-medium text-stone-700">guessed</span> do
              have a pin, chosen by searching the name — it may be the wrong
              business, and it will stay that way.
            </>
          )}
        </p>
        <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">
          {dead.map((d) => (
            <li
              key={d.mapsUrl}
              className="flex items-baseline justify-between gap-3 text-xs"
            >
              <a
                href={d.mapsUrl}
                target="_blank"
                rel="noreferrer"
                className="truncate text-stone-700 underline underline-offset-2 hover:text-stone-900"
                title={d.lists.join(", ")}
              >
                {d.title || "(untitled)"}
              </a>
              <span className="shrink-0 text-[11px] text-stone-400">
                {d.lists.length > 1 && `${d.lists.length} lists · `}
                {d.guessed ? (
                  <span className="text-amber-700">guessed</span>
                ) : (
                  "no pin"
                )}
              </span>
            </li>
          ))}
        </ul>
        {total > dead.length && (
          <p className="mt-2 text-[11px] text-stone-400">
            Showing {dead.length.toLocaleString()} of {total.toLocaleString()}.
          </p>
        )}
      </div>
    </details>
  );
}

// Every list in the export, row by row. Folded away by default once there are
// enough of them that the rows would bury the decision above.
function ListBreakdown({ lists }: { lists: ListAnalysis[] }) {
  return (
    <details
      className="mt-4 rounded-lg border border-neutral-200"
      open={lists.length <= 8}
    >
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-neutral-600 hover:bg-neutral-50">
        Per-list breakdown ({lists.length})
      </summary>
      <div className="max-h-80 overflow-y-auto border-t border-neutral-200">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-neutral-50 text-[11px] uppercase tracking-wide text-neutral-400">
            <tr>
              <th className="px-3 py-2 text-left font-medium">List</th>
              <th className="px-2 py-2 text-right font-medium">Places</th>
              <th className="px-2 py-2 text-right font-medium">Known</th>
              <th className="px-2 py-2 text-right font-medium">New</th>
              <th className="px-3 py-2 text-right font-medium">Change</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {lists.map((l) => {
              const b = l.buckets;
              const known =
                b.exact + b.fromUrl + b.cached + b.cachedGuess + b.unverifiable;
              return (
                <tr key={l.name} className="text-neutral-600">
                  <td className="max-w-[14rem] truncate px-3 py-1.5 text-neutral-800">
                    {l.name}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {l.places.toLocaleString()}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {known.toLocaleString()}
                  </td>
                  <td
                    className={`px-2 py-1.5 text-right tabular-nums ${
                      b.unknown > 0 ? "font-medium text-amber-700" : ""
                    }`}
                  >
                    {b.unknown.toLocaleString()}
                  </td>
                  {/* "New list", not "New" — the column beside it counts new
                      *places*, and two different News in one table read as one
                      thing. */}
                  <td className="px-3 py-1.5 text-right">
                    {l.status === "new" ? (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">
                        New list
                      </span>
                    ) : (
                      <span className="text-[11px] text-neutral-400">
                        replaces {l.existing.toLocaleString()}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// One of the two import buttons: a title, and the trade it represents, now
// carrying the count it applies to.
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
          ? "border-emerald-300 bg-emerald-50 hover:bg-emerald-100"
          : "border-neutral-300 bg-white hover:bg-neutral-50"
      }`}
    >
      <div
        className={`text-sm font-semibold ${
          emphasis ? "text-emerald-800" : "text-neutral-800"
        }`}
      >
        {title}
      </div>
      <div
        className={`mt-1 text-xs leading-relaxed ${
          emphasis ? "text-emerald-700/80" : "text-neutral-500"
        }`}
      >
        {detail}
      </div>
    </button>
  );
}

function Stat({
  label,
  value,
  hint,
  emphasis,
}: {
  label: string;
  value: number;
  hint?: string;
  emphasis?: boolean;
}) {
  return (
    <div
      title={hint}
      className={`rounded-lg border px-3 py-2 text-center ${
        emphasis
          ? "border-amber-300 bg-amber-50"
          : "border-neutral-200 bg-white"
      }`}
    >
      <div
        className={`text-lg font-semibold ${
          emphasis ? "text-amber-900" : "text-neutral-900"
        }`}
      >
        {value.toLocaleString()}
      </div>
      <div
        className={`text-[11px] uppercase tracking-wide ${
          emphasis ? "text-amber-700" : "text-neutral-400"
        }`}
      >
        {label}
      </div>
    </div>
  );
}
