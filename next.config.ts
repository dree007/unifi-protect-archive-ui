import type { NextConfig } from "next";

/**
 * Hostnames (no scheme/port, `*` wildcards allowed) that may use the dev server besides
 * localhost, e.g. `ALLOWED_DEV_ORIGINS=dev.example.com`. Without an entry, `next dev`
 * blocks its dev resources for that host and the page is never hydrated: thumbnails stay
 * invisible and search/filters do nothing. Only affects `next dev`, never `next build`/`start`.
 */
const allowedDevOrigins = (process.env.ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  allowedDevOrigins,
  // Self-contained server (.next/standalone/server.js with only the traced node_modules) for the
  // production image (Dockerfile, docs/selfhosting.md). `npm start` runs the same standalone server locally.
  output: "standalone",
  // Media already use the private ffmpeg/streaming endpoints. Disable the unused
  // optimizer so it cannot re-cache private JPEGs or require a writable Next image cache.
  images: { unoptimized: true },
  outputFileTracingExcludes: {
    // The tracer picks up our TypeScript sources (path.resolve(process.cwd(), …) in the media
    // config); the server only runs the compiled .next/server code.
    "/*": ["src/**/*"],
  },
};

export default nextConfig;
