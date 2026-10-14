// Next.js does not include these assets in standalone output automatically (output.md).
// Keep local production starts and browser tests equivalent to the Docker distribution.
import { cp, mkdir } from "node:fs/promises";

// public is optional in Next.js. Git does not preserve an empty directory, so a fresh
// checkout may lack it. Ensure it exists for both the asset copy and Docker's COPY stage.
await mkdir("public", { recursive: true });
await cp("public", ".next/standalone/public", { recursive: true });
await cp(".next/static", ".next/standalone/.next/static", { recursive: true });
