import { redirect } from "next/navigation";
import { auth } from "@/auth";
import Header from "../components/Header";
import Uploader from "../components/Uploader";

export const dynamic = "force-dynamic";

// Upload page for manually importing a Takeout export.
export default async function ImportPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="mx-auto w-full max-w-2xl px-4 py-10">
        <h1 className="mb-1 text-xl font-semibold">Import saved lists</h1>
        <p className="mb-4 text-sm text-neutral-500">
          Upload the <code className="text-neutral-700">.zip</code> from Google
          Takeout. Places are enriched once and cached, so re-imports cost
          nothing.
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
        <p className="mt-6 rounded-lg bg-neutral-100 px-4 py-3 text-sm text-neutral-600">
          A nightly Drive sync also imports the newest Takeout zip
          automatically, so manual uploads are only needed when you want an
          update sooner.
        </p>
      </main>
    </div>
  );
}
