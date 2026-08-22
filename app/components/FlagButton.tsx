"use client";

import { useState } from "react";

// Report a place as pinned in the wrong spot, or as one we failed to place at
// all.
//
// The click does not fix anything and deliberately does not pretend to: it puts
// the place on a queue to have its real coordinates read off its own Google
// Maps page, which happens out of band and can take a while. So the button
// settles into "Queued" rather than "Fixed", because that is what happened.
export default function FlagButton({
  mapsUrl,
  title,
  // Rendered inside a row that is itself a button, so clicks must not bubble up
  // and also select the place.
  className = "",
}: {
  mapsUrl: string | null;
  title: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "sending" | "queued" | "error">(
    "idle",
  );

  // Nothing to open means nothing to read a position off.
  if (!mapsUrl) return null;

  const send = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (state === "sending" || state === "queued") return;
    setState("sending");
    try {
      const res = await fetch("/api/flag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mapsUrl, title }),
      });
      setState(res.ok ? "queued" : "error");
    } catch {
      setState("error");
    }
  };

  const label = {
    idle: "Wrong spot?",
    sending: "Queueing…",
    queued: "Queued ✓",
    error: "Try again",
  }[state];

  return (
    <button
      onClick={send}
      disabled={state === "sending" || state === "queued"}
      title="Queue this place to have its real coordinates looked up"
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium transition ${
        state === "queued"
          ? "border-emerald-500 bg-emerald-50 text-emerald-900"
          : state === "error"
            ? "border-red-300 bg-red-50 text-red-700"
            : "border-neutral-300 bg-white text-neutral-500 hover:border-amber-400 hover:bg-amber-50 hover:text-amber-700"
      } ${className}`}
    >
      {label}
    </button>
  );
}
