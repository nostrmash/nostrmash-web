import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { allowEdgeRateLimit } from "@/lib/api/edge-rate-limit";
import { clientIpFromRequest } from "@/lib/api/search-suggest-params";
import { assertSafePreviewUrl, fetchLinkPreview } from "@/lib/notes/link-preview";
import { isNoteMediaUrl } from "@/lib/notes/media";
import { isCrossSiteRequest } from "@/lib/security/request";

function errorResponse(code: string, status: number, cacheSeconds: number) {
  return NextResponse.json(
    { error: code },
    {
      status,
      headers: {
        "Cache-Control": `public, max-age=0, s-maxage=${cacheSeconds}`,
      },
    }
  );
}

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("url") ?? "";
  let sanitized: string;
  try {
    sanitized = assertSafePreviewUrl(raw).toString();
  } catch (error) {
    const code = error instanceof Error ? error.message : "invalid_url";
    return errorResponse(code, 400, 300);
  }

  if (isNoteMediaUrl(sanitized)) {
    return errorResponse("media_url", 400, 300);
  }
  if (isCrossSiteRequest(request)) {
    return errorResponse("cross_site", 403, 60);
  }

  const clientIp = clientIpFromRequest(request.headers);
  const allowed = await allowEdgeRateLimit(`link-preview:${clientIp}`);
  if (!allowed) {
    return errorResponse("rate_limited", 429, 30);
  }

  try {
    const preview = await fetchLinkPreview(sanitized);
    return NextResponse.json(preview, {
      headers: {
        "Cache-Control": "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800",
      },
    });
  } catch {
    // Domain-only fallback so the UI can still render a quiet card.
    try {
      const url = assertSafePreviewUrl(sanitized);
      return NextResponse.json(
        {
          url: url.toString(),
          domain: url.hostname.toLowerCase().replace(/^www\./, ""),
          provider: "generic",
        },
        {
          headers: {
            "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
          },
        }
      );
    } catch {
      return errorResponse("fetch_failed", 502, 60);
    }
  }
}
