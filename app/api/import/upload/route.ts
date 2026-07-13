import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";
import { parseTakeoutZip } from "@/lib/takeout";
import { runImport } from "@/lib/import";
import { createPlacesClient } from "@/lib/places";

export const dynamic = "force-dynamic";

// Session-authenticated upload of a Takeout zip. The signed-in user owns the
// imported lists. A missing Places API key degrades gracefully to no
// enrichment rather than failing the import.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Expected a 'file' field containing a Takeout zip" },
      { status: 400 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  let parsed;
  try {
    parsed = parseTakeoutZip(buffer);
  } catch {
    return NextResponse.json(
      { error: "Could not read the uploaded zip" },
      { status: 400 },
    );
  }

  const db = getDb();
  const result = await runImport(
    db,
    session.user.id,
    parsed,
    createPlacesClient(),
    "upload",
  );

  return NextResponse.json(result);
}
