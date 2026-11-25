/**
 * A full 200 preview needs a known length. The route answers `Range` itself
 * (206). Next still drops Content-Length on the way out and attaches the
 * document `Vary`, which does not belong on a video, so a non-range 200 is
 * normalized here.
 */
export async function videoFrameCacheResponse(response: Response): Promise<Response> {
  if (response.status !== 200 || !response.body) return response;
  const body = await response.arrayBuffer();
  const headers = new Headers(response.headers);
  headers.set("content-length", String(body.byteLength));
  headers.set("accept-ranges", "bytes");
  headers.delete("content-encoding");
  headers.delete("vary");
  return new Response(body, { status: 200, headers });
}
