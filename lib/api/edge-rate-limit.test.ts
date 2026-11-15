import { afterEach, describe, expect, it, vi } from "vitest";

import { allowEdgeRateLimit } from "@/lib/api/edge-rate-limit";

const context = vi.hoisted(() => ({
  mode: "missing" as "missing" | "empty" | "deny" | "throw",
}));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    if (context.mode === "missing") throw new Error("no cloudflare context");
    if (context.mode === "empty") return { env: {} };
    if (context.mode === "throw") {
      return {
        env: {
          SUGGEST_RATE_LIMITER: {
            limit: async () => {
              throw new Error("binding down");
            },
          },
        },
      };
    }
    return {
      env: {
        SUGGEST_RATE_LIMITER: {
          limit: async () => ({ success: false }),
        },
      },
    };
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  context.mode = "missing";
});

describe("allowEdgeRateLimit", () => {
  it("stays open when the process has no Worker context", async () => {
    vi.stubEnv("NODE_ENV", "production");
    context.mode = "missing";
    await expect(allowEdgeRateLimit("203.0.113.5")).resolves.toBe(true);
  });

  it("fails closed in production when the binding is missing or errors", async () => {
    vi.stubEnv("NODE_ENV", "production");
    context.mode = "empty";
    await expect(allowEdgeRateLimit("203.0.113.5")).resolves.toBe(false);
    context.mode = "throw";
    await expect(allowEdgeRateLimit("203.0.113.5")).resolves.toBe(false);
  });

  it("honors a deny from the binding", async () => {
    context.mode = "deny";
    await expect(allowEdgeRateLimit("203.0.113.5")).resolves.toBe(false);
  });
});
