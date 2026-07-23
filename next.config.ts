import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce a self-contained server bundle so the container image stays small.
  output: "standalone",
  // Pin the file-tracing root to this project so the standalone bundle lands at
  // .next/standalone/server.js even when an ancestor directory looks like a
  // workspace root (which would otherwise nest the output under the full path).
  outputFileTracingRoot: path.join(__dirname),
  // pg carries a dynamic optional `pg-native` require that the server compiler
  // should not try to bundle; keep it external so standalone tracing includes it
  // from node_modules instead.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
