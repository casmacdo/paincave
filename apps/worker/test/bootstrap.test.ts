import { describe, it, expect } from "vitest";
import worker from "../src/index.js";

describe("@paincave/worker bootstrap", () => {
  it("responds to /api/health", async () => {
    const res = worker.fetch(new Request("https://paincave.test/api/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "paincave-worker" });
  });
});
