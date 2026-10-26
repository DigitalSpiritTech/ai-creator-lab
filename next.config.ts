/**
 * Configures the Next.js application.
 *
 * Inputs: none. Output: Next.js configuration. Expected errors: none.
 * @packageDocumentation
 */
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Allow the 12 MiB image plus multipart overhead to reach the bounded upload parser.
  experimental: { proxyClientMaxBodySize: "13mb" },
  outputFileTracingExcludes: {
    "/*": ["./.data/**/*", "./tests/**/*", "./docs/**/*"],
  },
};

export default nextConfig;
