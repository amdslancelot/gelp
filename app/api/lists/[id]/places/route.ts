import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadListPlaces } from "@/lib/queries";

export const dynamic = "force-dynamic";

// The places of one list, fetched when the user opens it. The page itself
// carries only the list names and counts, so this is how every list after the
// first one arrives.
//
// The list id comes from the URL, so it is only ever read against the
// *session's* user: `loadListPlaces` returns nothing for a list that user does
// not own, which is the same answer as for a list that does not exist.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const places = await loadListPlaces(session.user.id, decodeURIComponent(id));
  return NextResponse.json({ places });
}
