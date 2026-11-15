/** Browser-set hint. Missing on server and curl callers, which stay allowed. */
export function isCrossSiteRequest(request: {
  headers: { get(name: string): string | null };
}): boolean {
  return request.headers.get("sec-fetch-site") === "cross-site";
}
