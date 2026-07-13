import { NextResponse } from "next/server";

// Liveness/readiness probe. No auth, no database — always cheap and green.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ ok: true });
}
