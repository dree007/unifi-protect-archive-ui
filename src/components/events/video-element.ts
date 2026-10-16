/** Shared by the single player and the shared playback ("Gemeinsam abspielen"). */

/** Stops a video and lets the browser drop its buffers and connection. */
export function releaseVideo(video: HTMLVideoElement): void {
  video.pause();
  video.removeAttribute("src");
  video.load();
}

/**
 * Puts the source back after a release. In development React (StrictMode) attaches every ref,
 * runs its cleanup and attaches it again; the cleanup's release removes `src`, and React does
 * not set an unchanged prop again, so the video would stay without a source.
 */
export function restoreSource(video: HTMLVideoElement, url: string): void {
  if (video.getAttribute("src") !== url) video.src = url;
}

/**
 * Why a video failed. A media error does not say why: if the endpoint still answers HEAD with
 * 200, the file is there and the browser cannot decode it; otherwise it is unavailable.
 */
export function videoFailure(url: string): Promise<"unavailable" | "unsupported"> {
  return fetch(url, { method: "HEAD" })
    .then((response): "unavailable" | "unsupported" => (response.ok ? "unsupported" : "unavailable"))
    .catch(() => "unavailable" as const);
}

export const FAILURE_TEXT = {
  unavailable: {
    title: "errors.videoUnavailable",
    text: "errors.videoUnavailableBody",
  },
  unsupported: {
    title: "errors.videoUnsupported",
    text: "errors.videoUnsupportedBody",
  },
} as const;
