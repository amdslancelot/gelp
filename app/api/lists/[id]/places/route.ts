import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadListPlaces } from "@/lib/queries";
import { parseNear } from "@/lib/geo";

export const dynamic = "force-dynamic";

// The places of one list, fetched when the user opens it. The page itself
// carries only the list names and counts, so this is how every list after the
// first one arrives.
//
// The list id comes from the URL, so it is only ever read against the
// *session's* user: `loadListPlaces` returns nothing for a list that user does
// not own, which is the same answer as for a list that does not exist.
// `near=lat,lng` narrows the answer to a box around the caller, so a phone can
// draw the map it is standing in before the whole account has arrived. It is an
// optimisation and nothing depends on it: a missing or malformed value simply
// returns the entire list, which is what the client asks for next anyway.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const query = new URL(req.url).searchParams;
  const near = parseNear(query.get("near"), query.get("radius")) ?? undefined;

  const { id } = await params;
  const places = await loadListPlaces(
    session.user.id,
    decodeURIComponent(id),
    near,
  );
  return NextResponse.json({ places });
}
