import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce a self-contained server bundle so the container image stays small.
  output: "standalone",
  // Pin the file-tracing root to this project so the standalone bundle lands at
  // .next/standalone/server.js even when an ancestor directory looks like a
  // workspace root (which would otherwise nest the output under the full path).
  outputFileTracingRoot: path.join(__dirname),
  // better-sqlite3 is a native module and must not be bundled by the server compiler.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
