import { describe, it, expect } from "vitest";
import { APP_NAME } from "./main.js";

describe("@paincave/web bootstrap", () => {
  it("exports PainCave app name", () => {
    expect(APP_NAME).toBe("PainCave");
  });
});
