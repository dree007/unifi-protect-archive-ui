import { getI18n } from "@/i18n/server";
import { localizeMediaError } from "@/i18n/media-errors";
import type { NextRequest } from "next/server";

import { consoleMediaLogger } from "@/server/media/media-logger";
import { handleVideoRequest } from "@/server/media/video-response";
import { getDb } from "@/server/db/client";
import { getClipMedia } from "@/server/queries/clips";

/** Streams an archived clip (see src/server/media/video-response.ts). Read-only. */

async function serve(request: NextRequest, { params }: RouteContext<"/api/clips/[clipId]/video">) {
  const { clipId } = await params;
  const response = await handleVideoRequest(request, clipId, {
    findClip: (id) => getClipMedia(id, getDb()),
    archiveRoot: process.env.ARCHIVE_ROOT,
    logger: consoleMediaLogger,
  });
  return response.status >= 400 && request.method !== "HEAD"
    ? localizeMediaError(response, (await getI18n()).t) : response;
}

export const GET = serve;
export const HEAD = serve;
