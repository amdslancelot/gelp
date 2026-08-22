import Link from "next/link";
import { auth, signOut } from "@/auth";
import ShareButton from "./ShareButton";

// Top application bar: brand, the import link, and the signed-in user's
// identity with a sign-out control.
export default async function Header() {
  const session = await auth();
  const user = session?.user;

  return (
    <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-2.5">
      <div className="flex items-center gap-6">
        <Link
          href="/"
          className="text-xl font-bold tracking-tight text-emerald-800"
        >
          Gelp
        </Link>
        <Link
          href="/import"
          className="text-sm font-medium text-neutral-600 hover:text-neutral-900"
        >
          Import
        </Link>
        <Link
          href="/settings"
          className="text-sm font-medium text-neutral-600 hover:text-neutral-900"
        >
          Settings
        </Link>
      </div>
      {user && (
        <div className="flex items-center gap-3">
          <ShareButton />
          {user.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={user.image}
              alt=""
              className="h-7 w-7 rounded-full border border-neutral-200"
            />
          )}
          <span className="hidden text-sm text-neutral-600 sm:inline">
            {user.email}
          </span>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/login" });
            }}
          >
            <button
              type="submit"
              className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
            >
              Sign out
            </button>
          </form>
        </div>
      )}
    </header>
  );
}
