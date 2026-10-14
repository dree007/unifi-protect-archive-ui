import { getI18n } from "@/i18n/server";
import { localizeMediaError } from "@/i18n/media-errors";
import type { NextRequest } from "next/server";

import { getDb } from "@/server/db/client";
import { getThumbnailService } from "@/server/media/media-config";
import { consoleMediaLogger } from "@/server/media/media-logger";
import { handleThumbnailRequest } from "@/server/media/thumbnail-response";
import { getClipMedia } from "@/server/queries/clips";

/** Preview JPEG of an archived clip (see src/server/media/thumbnail-response.ts). */
export async function GET(request: NextRequest, { params }: RouteContext<"/api/clips/[clipId]/thumbnail">) {
  const { clipId } = await params;
  const response = await handleThumbnailRequest(request, clipId, {
    findClip: (id) => getClipMedia(id, getDb()),
    // Configuration errors (e.g. an invalid THUMBNAIL_MAX_CONCURRENCY) are logged and answered with 503.
    getThumbnail: (clip) => getThumbnailService().get(clip),
    logger: consoleMediaLogger,
  });
  return response.status >= 400 ? localizeMediaError(response, (await getI18n()).t) : response;
}
