import { describe, expect, it } from "vitest";

import {
  assertResolvedPublicHost,
  assertSafePreviewUrl,
  mapFxTwitterPayload,
  parseLinkPreviewHtml,
} from "@/lib/notes/link-preview";

describe("link preview safety and parsing", () => {
  it("rejects private and non-https targets", () => {
    expect(() => assertSafePreviewUrl("http://example.com")).toThrow("https_required");
    expect(() => assertSafePreviewUrl("https://127.0.0.1/x")).toThrow("private_host");
    expect(() => assertSafePreviewUrl("https://localhost/x")).toThrow("private_host");
    expect(() => assertSafePreviewUrl("https://192.168.1.10/x")).toThrow("private_host");
    expect(assertSafePreviewUrl("https://example.com/path").hostname).toBe("example.com");
    expect(() => assertSafePreviewUrl("https://2130706433/")).toThrow("private_host");
    expect(() => assertSafePreviewUrl("https://0x7f000001/")).toThrow("private_host");
    expect(() => assertSafePreviewUrl("https://[::1]/")).toThrow("private_host");
    expect(() => assertSafePreviewUrl("https://[::]/")).toThrow("private_host");
    expect(() => assertSafePreviewUrl("https://[fd00::1]/")).toThrow("private_host");
    expect(() => assertSafePreviewUrl("https://[fe80::1]/")).toThrow("private_host");
    expect(() => assertSafePreviewUrl("https://[::ffff:127.0.0.1]/")).toThrow("private_host");
    expect(() => assertSafePreviewUrl("https://[::ffff:169.254.169.254]/")).toThrow("private_host");
    expect(() => assertSafePreviewUrl("https://localhost./")).toThrow("private_host");
    expect(() => assertSafePreviewUrl("https://app.local./")).toThrow("private_host");
    expect(() => assertSafePreviewUrl("https://user:pass@example.com/")).toThrow(
      "credentials_forbidden"
    );
  });

  it("rejects a DNS answer that points at a private address", async () => {
    await expect(
      assertResolvedPublicHost("cdn.example", async () => [{ address: "127.0.0.1" }])
    ).rejects.toThrow("private_host");
    await expect(
      assertResolvedPublicHost("cdn.example", async () => [{ address: "10.1.1.1" }])
    ).rejects.toThrow("private_host");
    await expect(
      assertResolvedPublicHost("cdn.example", async () => [{ address: "1.1.1.1" }])
    ).resolves.toBeUndefined();
    await expect(
      assertResolvedPublicHost("cdn.example", async () => {
        throw new Error("nxdomain");
      })
    ).resolves.toBeUndefined();
  });

  it("parses open graph metadata from html", () => {
    const html = `
      <html><head>
        <title>Fallback</title>
        <meta property="og:title" content="Hello &amp; World" />
        <meta property="og:description" content="A short summary" />
        <meta property="og:image" content="/img.png" />
        <meta property="og:site_name" content="Example" />
      </head></html>
    `;
    const preview = parseLinkPreviewHtml(html, new URL("https://www.example.com/page"));
    expect(preview).toEqual({
      url: "https://www.example.com/page",
      domain: "example.com",
      provider: "generic",
      title: "Hello & World",
      description: "A short summary",
      image_url: "https://www.example.com/img.png",
      site_name: "Example",
    });
  });

  it("drops open graph images that point at a private host", () => {
    const preview = parseLinkPreviewHtml(
      '<meta property="og:image" content="https://127.0.0.1/a.png" />',
      new URL("https://example.com/")
    );
    expect(preview.image_url).toBeUndefined();
  });

  it("maps fxtwitter status payloads into tweet previews", () => {
    const preview = mapFxTwitterPayload(
      {
        code: 200,
        tweet: {
          url: "https://x.com/jack/status/20",
          text: "just setting up my twttr",
          created_at: "Tue Mar 21 20:50:14 +0000 2006",
          author: {
            name: "jack",
            screen_name: "jack",
            avatar_url: "https://pbs.twimg.com/profile_images/a.jpg",
          },
          media: {
            photos: [{ url: "https://pbs.twimg.com/media/photo.jpg" }],
          },
        },
      },
      "https://x.com/jack/status/20"
    );

    expect(preview).toMatchObject({
      provider: "twitter",
      domain: "x.com",
      title: "jack (@jack)",
      description: "just setting up my twttr",
      image_url: "https://pbs.twimg.com/media/photo.jpg",
      tweet: {
        text: "just setting up my twttr",
        author_name: "jack",
        author_handle: "jack",
        avatar_url: "https://pbs.twimg.com/profile_images/a.jpg",
        media_url: "https://pbs.twimg.com/media/photo.jpg",
      },
    });
  });
});
