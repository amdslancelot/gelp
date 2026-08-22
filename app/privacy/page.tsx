import Link from "next/link";

export const metadata = { title: "Privacy — Gelp" };

// Public privacy policy.
//
// Reachable without signing in, and deliberately so: Google requires a publicly
// fetchable policy before an OAuth app can be published, and a policy behind a
// login is not a policy anyone can read before deciding to log in.
//
// It describes what this app actually does, which is little enough to state
// plainly. Keep it that way — if the app starts doing something not written
// here, this page is what has to change first.
export default function PrivacyPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-12">
      <Link href="/" className="text-xl font-bold tracking-tight text-emerald-600">
        Gelp
      </Link>
      <h1 className="mt-6 text-2xl font-semibold">Privacy</h1>
      <p className="mt-2 text-sm text-neutral-500">
        Gelp is a personal tool for browsing your own Google Maps saved lists.
      </p>

      <Section title="What is stored">
        <p>
          Your Google account&rsquo;s email, name, and profile picture, so the
          app can recognise you when you sign in; and the saved lists and places
          from the Google Takeout export you import — their titles, your notes,
          and their map links. Coordinates and categories for those places come
          from the Google Places API and are cached so the same place is never
          looked up twice.
        </p>
      </Section>

      <Section title="Google Drive access">
        <p>
          If you turn on the nightly sync, Gelp asks for the{" "}
          <code className="text-neutral-700">drive.file</code> scope, which
          grants access only to files you hand over yourself through
          Google&rsquo;s own file picker. Gelp cannot see anything else in your
          Drive. It reads the newest Takeout{" "}
          <code className="text-neutral-700">.zip</code> in the folder you
          picked, imports it, and keeps nothing else from it.
        </p>
        <p>
          The credential that lets the nightly job do this while you are away is
          encrypted before it is stored, and is deleted — and revoked at Google
          — the moment you press Disconnect on the settings page.
        </p>
      </Section>

      <Section title="Who can see it">
        <p>
          Nobody but you, unless you create a share link. A share link makes
          your lists, places, and notes readable by anyone holding the link,
          with no sign-in; revoking it on the share menu stops that immediately.
        </p>
        <p>
          Nothing is sold, and nothing is shared with any third party. The only
          services involved are Google&rsquo;s own — sign-in, the Places API,
          and Drive if you enable the sync.
        </p>
      </Section>

      <Section title="Deleting it">
        <p>
          Disconnect Drive on the settings page to stop the sync and revoke the
          credential. To have the account and everything imported under it
          removed entirely, email the address below.
        </p>
      </Section>

      <Section title="Contact">
        <p>lansoulot@gmail.com</p>
      </Section>
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium text-neutral-900">{title}</h2>
      <div className="mt-2 space-y-3 text-sm leading-relaxed text-neutral-600">
        {children}
      </div>
    </section>
  );
}
