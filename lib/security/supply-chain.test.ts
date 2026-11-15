import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function compareSemver(left: string, right: string): number {
  const a = left.split(".").map((part) => Number(part));
  const b = right.split(".").map((part) => Number(part));
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

describe("supply chain floors", () => {
  it("resolves Vite to a release that includes the 8.1.6 fixes", () => {
    const lock = readFileSync("pnpm-lock.yaml", "utf8");
    const versions = [...lock.matchAll(/^ {2}vite@(\d+\.\d+\.\d+):$/gm)].map((match) => match[1]!);
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      expect(compareSemver(version, "8.1.6")).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps Workers fetch from dialing private addresses", () => {
    const wrangler = readFileSync("wrangler.jsonc", "utf8");
    expect(wrangler).toContain("global_fetch_strictly_public");
  });
});
