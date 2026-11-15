import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { JsonLd, serializeJsonLd } from "@/components/seo/json-ld";

describe("JSON-LD", () => {
  it("keeps a closing script tag inside the JSON string", () => {
    const payload = { articleBody: "</script><script>alert(1)</script>" };
    const html = serializeJsonLd(payload);
    expect(html).not.toContain("</script>");
    expect(html).toContain("\\u003c");
    expect(JSON.parse(html)).toEqual(payload);
  });

  it("renders the escaped payload into the script tag", () => {
    const { container } = render(
      <JsonLd data={{ name: "Ada </script><script>alert(1)</script>" }} />
    );
    const script = container.querySelector("script");
    expect(script?.innerHTML ?? "").not.toContain("</script><script>");
    expect(script?.getAttribute("type")).toBe("application/ld+json");
  });
});
