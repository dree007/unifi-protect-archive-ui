import { createFfmpegRunner } from "../../src/server/media/ffmpeg-runner";

// Keep this test parent alive until the real child has been reaped after SIGTERM/SIGINT.
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
const run = createFfmpegRunner(process.env.FFMPEG_PATH ?? "ffmpeg").run({
  args: ["-hide_banner", "-nostdin", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=5", "-t", "120", "-f", "null", "-"],
  timeoutMs: 130_000,
});
console.log("rendering");
await run.catch((error) => console.log(error.kind));
console.log("child reaped");
process.exit(0);
