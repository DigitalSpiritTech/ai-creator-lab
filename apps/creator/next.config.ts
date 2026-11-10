/**
 * Configures the Next.js application (the project directory is `apps/creator`; every script runs
 * it from the repository root, which stays the working directory for the data folder, the
 * workflows, and `.env.local`).
 *
 * Inputs: none. Output: Next.js configuration. Expected errors: none.
 * @packageDocumentation
 */
import { join } from "node:path";
import type { NextConfig } from "next";

/** The monorepo root, two folders up from this file. */
const repoRoot = join(__dirname, "..", "..");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The workspace packages ship TypeScript source (no build step); Next.js compiles them with the app.
  transpilePackages: ["@creator-lab/core", "@creator-lab/recipes", "@creator-lab/executors", "@creator-lab/ui", "@creator-lab/content-ugc-ad", "@creator-lab/content-social-post"],
  // The bundled ffmpeg and ffprobe resolve their binaries beside their own package files, so they
  // load with Node's require at run time instead of being bundled.
  serverExternalPackages: ["ffmpeg-static", "@derhuerst/ffprobe-static"],
  // Trace server files from the monorepo root so the packages' sources are included.
  outputFileTracingRoot: repoRoot,
  // Allow the 12 MiB image plus multipart overhead to reach the bounded upload parser.
  experimental: { proxyClientMaxBodySize: "13mb" },
  outputFileTracingExcludes: {
    // Patterns resolve from this folder; the data folder, tests, and docs sit at the repository root.
    "/*": ["../../.data/**/*", "../../tests/**/*", "../../docs/**/*"],
  },
};

export default nextConfig;
