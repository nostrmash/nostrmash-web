type RateLimiter = {
  limit: (options: { key: string }) => Promise<{ success: boolean }>;
};

/**
 * Cloudflare rate limit for suggest and link unfurl.
 *
 * A Worker that booted without `SUGGEST_RATE_LIMITER` fails closed in
 * production. `next dev` and `next start` have no request context, so
 * `getCloudflareContext()` throws and those processes stay unlimited.
 */
export async function allowEdgeRateLimit(key: string): Promise<boolean> {
  let env: unknown;
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    env = getCloudflareContext().env;
  } catch {
    return true;
  }

  const limiter = (env as { SUGGEST_RATE_LIMITER?: RateLimiter }).SUGGEST_RATE_LIMITER;
  if (!limiter || typeof limiter.limit !== "function") {
    return process.env.NODE_ENV !== "production";
  }

  try {
    const result = await limiter.limit({ key });
    return result.success;
  } catch {
    return process.env.NODE_ENV !== "production";
  }
}
