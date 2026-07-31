import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";
import { enqueuePlaces } from "@/lib/import";

export const dynamic = "force-dynamic";

// Report a place as pinned in the wrong spot.
//
// This does not attempt a fix. It puts the place on `place_queue`, where a
// resolve run will later read its real coordinates off its own Google Maps
// page. The queue is the durable part; the run is deliberate and out of band,
// because reading those pages is slow and not something to do automatically on
// a user's click.
//
// Nothing here trusts the caller beyond the URL of the place: a flag records
// only that somebody wants this place looked at, and the coordinates it
// eventually produces come from Google, never from the request.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { mapsUrl?: unknown; title?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const mapsUrl = typeof body.mapsUrl === "string" ? body.mapsUrl.trim() : "";
  if (mapsUrl === "") {
    // A place saved without a Maps URL — a bare title in an old export — has
    // nothing to open, so there is no page to read its position off.
    return NextResponse.json(
      { error: "This place has no Maps link, so it cannot be looked up" },
      { status: 400 },
    );
  }

  const db = await getDb();
  const added = await enqueuePlaces(
    db,
    [
      {
        mapsUrl,
        title: typeof body.title === "string" ? body.title : "",
        note: typeof body.note === "string" ? body.note : undefined,
      },
    ],
    "flagged",
    session.user.id,
  );

  // `added` is 0 when the place was already waiting, which is not an error —
  // the user's report and the queue agree about what needs doing.
  return NextResponse.json({ queued: true, added });
}
