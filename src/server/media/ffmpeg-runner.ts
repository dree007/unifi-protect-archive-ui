import { spawn, type ChildProcess } from "node:child_process";

/**
 * Runs the external `ffmpeg` binary. Abstracted so that the thumbnail service can be tested
 * with a fake runner (no ffmpeg needed). Never through a shell: the binary and an argument
 * array go straight to `spawn`.
 */

export type FfmpegErrorKind =
  /** Binary missing or not executable (FFMPEG_PATH). */
  | "unavailable"
  /** Killed after the timeout. */
  | "timeout"
  /** Ran, but exited unsuccessfully (e.g. broken MP4). */
  | "failed";

export class FfmpegError extends Error {
  override name = "FfmpegError";
  constructor(
    readonly kind: FfmpegErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface FfmpegJob {
  args: readonly string[];
  /** Open descriptor passed to the child as fd 3 (the input, read as `/dev/fd/3`). */
  inputFd?: number;
  timeoutMs: number;
}

export interface FfmpegRunner {
  /** Resolves when ffmpeg exited with code 0; rejects with `FfmpegError` otherwise. */
  run(job: FfmpegJob): Promise<void>;
}

/** Input name of the descriptor passed as fd 3. `file:` so ffmpeg never guesses a protocol. */
export const FFMPEG_INPUT_FD = "file:/dev/fd/3";

export interface ThumbnailArgsOptions {
  timestampMs: number;
  input: string;
  output: string;
  maxWidth: number;
}

/** One JPEG frame at `timestampMs`, at most `maxWidth` wide, aspect ratio kept (even height). */
export function buildThumbnailArgs({ timestampMs, input, output, maxWidth }: ThumbnailArgsOptions): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    // Input seeking: fast, lands on the nearest frame at or before the position.
    "-ss",
    (timestampMs / 1000).toFixed(3),
    "-i",
    input,
    "-map",
    "0:v:0",
    "-an",
    "-sn",
    "-dn",
    "-frames:v",
    "1",
    "-vf",
    `scale='min(${maxWidth},iw)':-2`,
    "-q:v",
    "4",
    "-f",
    "image2",
    "-update",
    "1",
    "-y",
    `file:${output}`,
  ];
}

const STDERR_LIMIT = 2048;

const activeChildren = new Set<ChildProcess>();
let stopping = false;
let signalsInstalled = false;

function trackChild(child: ChildProcess) {
  activeChildren.add(child);
  child.once("close", () => activeChildren.delete(child));
  if (signalsInstalled) return;
  signalsInstalled = true;
  // Next closes its HTTP listener on these same signals. Cancel renders first so
  // an active thumbnail request cannot hold shutdown until its normal 20 s timeout.
  const stop = () => {
    stopping = true;
    for (const active of activeChildren) active.kill("SIGTERM");
    const force = setTimeout(() => {
      for (const active of activeChildren) active.kill("SIGKILL");
    }, 500);
    force.unref();
  };
  process.prependListener("SIGTERM", stop);
  process.prependListener("SIGINT", stop);
}

export function createFfmpegRunner(ffmpegPath: string): FfmpegRunner {
  return {
    run: ({ args, inputFd, timeoutMs }) =>
      new Promise<void>((resolve, reject) => {
        if (stopping) {
          reject(new FfmpegError("unavailable", "Media service is shutting down."));
          return;
        }
        let stderr = "";
        let settled = false;
        let timedOut = false;
        const finish = (error?: FfmpegError) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };

        const child = spawn(ffmpegPath, args, {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "ignore", "pipe", inputFd ?? "ignore"],
        });
        trackChild(child);
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);

        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          stderr = (stderr + chunk).slice(-STDERR_LIMIT);
        });
        child.on("error", (error: NodeJS.ErrnoException) => {
          finish(
            error.code === "ENOENT" || error.code === "EACCES"
              ? new FfmpegError("unavailable", `ffmpeg not available (${error.code}); set FFMPEG_PATH`, { cause: error })
              : new FfmpegError("failed", `ffmpeg could not be started: ${error.message}`, { cause: error }),
          );
        });
        child.on("close", (code, signal) => {
          if (timedOut) finish(new FfmpegError("timeout", `ffmpeg did not finish within ${timeoutMs} ms`));
          else if (code === 0) finish();
          else finish(new FfmpegError("failed", `ffmpeg exited with ${code ?? signal}: ${stderr.trim() || "no output"}`));
        });
      }),
  };
}

/** `ffmpeg -version` for checks (media:check, integration tests); `undefined` if not runnable. */
export function ffmpegVersion(ffmpegPath: string, timeoutMs = 10_000): Promise<string | undefined> {
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(ffmpegPath, ["-version"], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    trackChild(child);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? output.split("\n")[0]?.trim() : undefined);
    });
  });
}
