import { describe, it, expect } from "vitest";
import { APP_NAME } from "./App.js";

describe("@paincave/web bootstrap", () => {
  it("exports PainCave app name", () => {
    expect(APP_NAME).toBe("PainCave");
  });
});
