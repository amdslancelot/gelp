import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { loadQueueSummary } from "@/lib/queries";
import Header from "../components/Header";
import Uploader from "../components/Uploader";

export const dynamic = "force-dynamic";

// Roughly how long something has been waiting, in the largest unit that still
// reads as a number.
function ago(ms: number): string {
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// Upload page for manually importing a Takeout export.
export default async function ImportPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const queue = await loadQueueSummary();

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="mx-auto w-full max-w-2xl px-4 py-10">
        <h1 className="mb-1 text-xl font-semibold">Import saved lists</h1>
        <p className="mb-4 text-sm text-neutral-500">
          Upload the <code className="text-neutral-700">.zip</code> from Google
          Takeout. It is read and summarised first — how much is already known,
          what would be looked up, what would be deleted — and imported only
          once you confirm. Places are enriched once and cached, so re-imports
          cost nothing.
        </p>
        <div className="mb-6 rounded-lg border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-600">
          <p className="font-medium text-neutral-800">
            In Google Takeout, include these products:
          </p>
          <ul className="mt-2 space-y-1">
            <li className="flex gap-2">
              <span className="text-neutral-400">✓</span>
              <span>
                <span className="font-medium text-neutral-800">
                  Maps (your places)
                </span>{" "}
                — your saved and starred places
              </span>
            </li>
            <li className="flex gap-2">
              <span className="text-neutral-400">✓</span>
              <span>
                <span className="font-medium text-neutral-800">My Maps</span> —
                any custom maps you created
              </span>
            </li>
            <li className="flex gap-2">
              <span className="text-neutral-400">✓</span>
              <span>
                <span className="font-medium text-neutral-800">Saved</span> —
                your lists (Favorites, Want to go, and more)
              </span>
            </li>
          </ul>
          <p className="mt-3 text-xs text-neutral-400">
            Leave everything else unchecked for a smaller, faster export.
          </p>
        </div>
        <Uploader />

        {/* What is waiting to be resolved. Shown here because this is where a
            queued import sends its work, and because a queue nobody drains
            should be visible rather than silent — the resolve run is a
            deliberate, manual step, not something that happens on its own. */}
        {queue.pending > 0 && (
          <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-sm font-medium text-amber-900">
              {queue.pending} place{queue.pending === 1 ? "" : "s"} waiting to be
              looked up
            </p>
            <p className="mt-1 text-xs leading-relaxed text-amber-800/80">
              {queue.fromImport > 0 && (
                <>
                  {queue.fromImport} from imports
                  {queue.flagged > 0 ? ", " : ". "}
                </>
              )}
              {queue.flagged > 0 && (
                <>
                  {queue.flagged} reported as wrongly pinned.{" "}
                </>
              )}
              They have no pin until a resolve run reads their real coordinates,
              which is a manual step.
              {queue.oldestAt !== null && (
                <> Oldest queued {ago(queue.oldestAt)}.</>
              )}
            </p>
          </div>
        )}

        {/* Work the queue has stopped retrying. Shown separately from the
            waiting count, and shown even when nothing is waiting: a row that
            gave up is not dumped by any later run, so without this it is
            invisible — which is the one thing a queue must never be. */}
        {queue.failed > 0 && (
          <div className="mt-4 rounded-lg border border-stone-300 bg-stone-50 px-4 py-3">
            <p className="text-sm font-medium text-stone-800">
              {queue.failed} place{queue.failed === 1 ? "" : "s"} gave up after
              repeated attempts
            </p>
            <p className="mt-1 text-xs leading-relaxed text-stone-600">
              Their map pages could not be read — a consent wall, a slow load, a
              browser that died — which says nothing about the places
              themselves. Nothing will retry them on its own. Reopen them with{" "}
              <code className="rounded bg-stone-200 px-1 py-0.5 text-[11px]">
                npx tsx scripts/dump-queue.ts --retry-failed
              </code>
              .
            </p>
          </div>
        )}

        <p className="mt-6 rounded-lg bg-neutral-100 px-4 py-3 text-sm text-neutral-600">
          A nightly Drive sync also imports the newest Takeout zip
          automatically, so manual uploads are only needed when you want an
          update sooner.
        </p>
      </main>
    </div>
  );
}
