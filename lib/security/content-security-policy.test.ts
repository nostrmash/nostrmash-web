import { describe, expect, it } from "vitest";

import { buildContentSecurityPolicy } from "@/lib/security/content-security-policy";

const nonce = "abc";

describe("buildContentSecurityPolicy", () => {
  it("keeps production script and connect sources tight", () => {
    const policy = buildContentSecurityPolicy({ nonce, isEmbed: false, isDev: false });
    expect(policy).toContain(`'nonce-${nonce}'`);
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).not.toContain("localhost");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("upgrade-insecure-requests");
  });

  it("allows the dev server and embed framing only where asked", () => {
    const dev = buildContentSecurityPolicy({ nonce, isEmbed: false, isDev: true });
    expect(dev).toContain("unsafe-eval");
    expect(dev).toContain("http://localhost:*");
    expect(dev).toContain("http://127.0.0.1:*");

    const embed = buildContentSecurityPolicy({ nonce, isEmbed: true, isDev: false });
    expect(embed).toContain("frame-ancestors *");
    expect(embed).not.toContain("frame-ancestors 'none'");
  });
});
