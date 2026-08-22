"use client";

import { useEffect, useRef, useState } from "react";

// Header control for the read-only share link: create it, copy it, replace it,
// or turn it off. The link itself is only ever built on the client, from the
// token the API returns plus the current origin, so the server never needs to
// know what host it is being served under.
export default function ShareButton() {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Guarded because this component is also rendered on the server, where there
  // is no `window` — `token` is null there, but the guard keeps that a fact
  // about the code rather than a coincidence of the initial state.
  const url =
    token && typeof window !== "undefined"
      ? `${window.location.origin}/s/${token}`
      : null;

  // Load the current state the first time the panel is opened, not on mount:
  // most page loads never touch this control.
  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/share");
        if (!res.ok) throw new Error("Could not load the share link");
        const data = (await res.json()) as { token: string | null };
        if (!cancelled) {
          setToken(data.token);
          setLoaded(true);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Something went wrong");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, loaded]);

  // Close on an outside click or Escape, the way a popover is expected to
  // behave.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function call(method: "POST" | "DELETE", rotate = false) {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch(`/api/share${rotate ? "?rotate=1" : ""}`, {
        method,
      });
      if (!res.ok) throw new Error("The request failed");
      const data = (await res.json()) as { token: string | null };
      setToken(data.token);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused (an insecure origin, or a denied
      // permission). The link stays selectable in the box either way.
      setError("Could not copy — select the link and copy it manually");
    }
  }

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
      >
        Share
      </button>

      {open && (
        <div className="absolute right-0 z-[3000] mt-2 w-80 rounded-lg border border-neutral-200 bg-white p-4 shadow-lg">
          <h3 className="text-sm font-semibold text-neutral-900">
            Share your map
          </h3>

          {!loaded && !error && (
            <p className="mt-2 text-xs text-neutral-500">Loading…</p>
          )}

          {loaded && !token && (
            <>
              <p className="mt-2 text-xs text-neutral-500">
                Anyone with the link can see your lists and their places — the
                notes on them too. Lists you have hidden stay hidden.
              </p>
              <button
                onClick={() => call("POST")}
                disabled={busy}
                className="mt-3 w-full rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy ? "Creating…" : "Create link"}
              </button>
            </>
          )}

          {loaded && token && url && (
            <>
              <div className="mt-2 flex gap-1.5">
                <input
                  readOnly
                  value={url}
                  onFocus={(e) => e.currentTarget.select()}
                  className="min-w-0 flex-1 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-xs text-neutral-700"
                />
                <button
                  onClick={copy}
                  className="shrink-0 rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="mt-2 text-xs text-neutral-500">
                Read-only, and not listed in search engines. It always shows
                your latest import.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => call("POST", true)}
                  disabled={busy}
                  className="flex-1 rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
                >
                  New link
                </button>
                <button
                  onClick={() => call("DELETE")}
                  disabled={busy}
                  className="flex-1 rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                >
                  Stop sharing
                </button>
              </div>
              <p className="mt-2 text-[11px] text-neutral-400">
                Both make the current link stop working.
              </p>
            </>
          )}

          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </div>
      )}
    </div>
  );
}
