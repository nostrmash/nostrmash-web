import { describe, expect, it } from "vitest";

import { notePublicSectionError } from "./note-section-error";
import { takeSectionError } from "./section-error-signal";

describe("notePublicSectionError", () => {
  it("does nothing when the render has no request", async () => {
    await notePublicSectionError();
    expect(takeSectionError("missing")).toBe(false);
  });
});
