import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";
import { parseTakeoutZip } from "@/lib/takeout";
import { analyzeImport } from "@/lib/import";

export const dynamic = "force-dynamic";

// A dry run of an upload: what importing this zip would do, before anything is
// written. Same auth and same parse as the upload route — it is the same file,
// asked about rather than acted on.
//
// The zip is uploaded again when the user confirms, rather than being held here
// against a token. Keeping the parsed export server-side would mean state that
// has to be stored, expired, and found again by whichever replica serves the
// second request, to save re-sending a few megabytes the browser already has.
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

  const db = await getDb();
  const analysis = await analyzeImport(db, session.user.id, parsed);

  return NextResponse.json(analysis);
}
