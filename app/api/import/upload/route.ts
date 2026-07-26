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

  const db = await getDb();
  const userId = session.user.id;

  // Stream the import as newline-delimited JSON: a "progress" line per place so
  // the client can drive a progress bar, then a terminal "done" (with the
  // counts) or "error" line. The whole run happens inside the stream so a large
  // Takeout with many Places API calls reports incrementally instead of
  // blocking on one long request.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        const result = await runImport(
          db,
          userId,
          parsed,
          createPlacesClient(),
          "upload",
          (p) => send({ type: "progress", ...p }),
        );
        send({ type: "done", result });
      } catch {
        send({ type: "error", error: "Import failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
