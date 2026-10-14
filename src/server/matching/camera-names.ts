/**
 * Conservative resolution of a camera name from a NAS file name to a Protect camera:
 * exact match after Unicode NFC normalization and trimming; otherwise a case-insensitive
 * match, but only if it is unique. No fuzzy, prefix or substring matching – no guessing.
 */

export interface NamedCamera {
  id: string;
  name: string;
}

export function normalizeCameraName(name: string): string {
  return name.normalize("NFC").trim();
}

/** Camera ID for `cameraName`, or `undefined` if there is no unambiguous match. */
export function resolveCameraName(cameraName: string, cameras: readonly NamedCamera[]): string | undefined {
  const wanted = normalizeCameraName(cameraName);
  if (!wanted) return undefined;

  const exact = cameras.filter((camera) => normalizeCameraName(camera.name) === wanted);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) return undefined; // two cameras with the same name: ambiguous

  const lower = wanted.toLowerCase();
  const caseInsensitive = cameras.filter((camera) => normalizeCameraName(camera.name).toLowerCase() === lower);
  return caseInsensitive.length === 1 ? caseInsensitive[0].id : undefined;
}
