import { describe, expect, it } from "vitest";

import { noteIdFromOembedUrl } from "@/lib/seo/oembed-url";

const SITE = "https://nostrmash.com";

describe("noteIdFromOembedUrl", () => {
  it("accepts this site and its subdomains", () => {
    expect(noteIdFromOembedUrl("https://nostrmash.com/notes/abc", SITE)).toBe("abc");
    expect(noteIdFromOembedUrl("https://www.nostrmash.com/notes/abc", SITE)).toBe("abc");
    expect(noteIdFromOembedUrl("https://preview.nostrmash.com/notes/abc/", SITE)).toBe("abc");
    expect(noteIdFromOembedUrl("http://localhost:3000/notes/abc", "http://localhost:3000")).toBe(
      "abc"
    );
    expect(noteIdFromOembedUrl("http://127.0.0.1:3000/notes/abc", SITE)).toBe("abc");
  });

  it("rejects a hostname that only shares a suffix", () => {
    expect(noteIdFromOembedUrl("https://evilnostrmash.com/notes/abc", SITE)).toBeNull();
    expect(noteIdFromOembedUrl("https://nostrmash.com.evil.example/notes/abc", SITE)).toBeNull();
    expect(noteIdFromOembedUrl("https://example.com/notes/abc", SITE)).toBeNull();
  });
});
