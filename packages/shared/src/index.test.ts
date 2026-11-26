import { describe, it, expect } from "vitest";
import { PAINCAVE_SCHEMA_VERSION } from "./index.js";

describe("@paincave/shared bootstrap", () => {
  it("exports schema version 1", () => {
    expect(PAINCAVE_SCHEMA_VERSION).toBe(1);
  });
});
