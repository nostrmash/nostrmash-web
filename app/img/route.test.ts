import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/img/route";

afterEach(() => {
  vi.unstubAllGlobals();
});

function request(query: string): Request {
  return new Request(`https://nostrmash.com/img?${query}`);
}

describe("display image route", () => {
  it("rejects a private host and a width the resizer blocks", async () => {
    expect((await GET(request("src=https%3A%2F%2F127.0.0.1%2Fa.jpg&w=96"))).status).toBe(400);
    expect(
      (await GET(request(`src=${encodeURIComponent("https://[::1]/a.jpg")}&w=96`))).status
    ).toBe(400);
    expect((await GET(request("src=https%3A%2F%2Fcdn.example%2Fa.jpg&w=640"))).status).toBe(400);
  });

  it("does not follow a redirect onto a private host", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("127.0.0.1") || url.includes("[::1]")) {
        return new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } });
      }
      return new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/secret" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET(request("src=https%3A%2F%2Fcdn.example%2Fa.jpg&w=96"));
    expect(response.status).toBe(400);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("127.0.0.1"))).toBe(false);
  });

  it("rejects a cross-site image fetch", async () => {
    const response = await GET(
      new Request("https://nostrmash.com/img?src=https%3A%2F%2Fcdn.example%2Fa.jpg&w=96", {
        headers: { "sec-fetch-site": "cross-site" },
      })
    );
    expect(response.status).toBe(403);
  });

  it("serves a resized image", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/webp" } })
      )
    );
    const response = await GET(request("src=https%3A%2F%2Fcdn.example%2Fa.jpg&w=96"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toContain("max-age=86400");
  });

  it("redirects to the original when the transform is not an image", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("Blocked", { status: 403, headers: { "content-type": "text/plain" } })
      )
    );
    const response = await GET(request("src=https%3A%2F%2Fcdn.example%2Fa.jpg&w=96"));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://cdn.example/a.jpg");
  });
});
