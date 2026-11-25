import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";

import { SECTION_ERROR_REQUEST_HEADER, markSectionError } from "@/lib/caching/section-error-signal";

/**
 * Record that this response rendered the failed-section panel.
 * `headers()` throws during static prerender; the page still renders.
 * Next's own control-flow errors are rethrown so a prerender can still bail out.
 */
export async function notePublicSectionError(): Promise<void> {
  try {
    const headerList = await headers();
    const requestId = headerList.get(SECTION_ERROR_REQUEST_HEADER);
    if (requestId) markSectionError(requestId);
  } catch (error) {
    unstable_rethrow(error);
  }
}
