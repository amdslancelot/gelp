import { NextResponse } from "next/server";
import { loadSharedListPlaces } from "@/lib/queries";
import { parseNear } from "@/lib/geo";

export const dynamic = "force-dynamic";

// The same per-list fetch as `/api/lists/[id]/places`, for someone reading a
// shared map. It exists separately because the authority is different: there is
// no session here, and the token in the path is the whole permission.
//
// A bad token and a list belonging to someone else are both 404: distinguishing
// them would tell a stranger whether a token was ever real.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const query = new URL(req.url).searchParams;
  const listId = query.get("list");
  if (!listId) {
    return NextResponse.json({ error: "Missing list" }, { status: 400 });
  }

  // Same optional "near me" window as the session route; see it for why.
  const near = parseNear(query.get("near"), query.get("radius")) ?? undefined;

  const places = await loadSharedListPlaces(token, listId, near);
  if (places === null) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ places });
}
