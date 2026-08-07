import { describe, it, expect, vi } from "vitest";
import { logStage } from "../src/log.js";

describe("log", () => {
  it("emits a JSON line", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logStage({ run_id: "r1", stage: "extraction", status: "ok", latency_ms: 123 });
    expect(spy).toHaveBeenCalledOnce();
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.run_id).toBe("r1");
    expect(entry.stage).toBe("extraction");
    expect(entry.latency_ms).toBe(123);
    spy.mockRestore();
  });

  it("includes optional model and gate fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logStage({
      run_id: "r2",
      stage: "qualification",
      status: "clarify",
      latency_ms: 0,
      model_id: "m1",
      tokens_in: 10,
      tokens_out: 5,
      gate_fired: "clarify",
    });
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.model_id).toBe("m1");
    expect(entry.tokens_in).toBe(10);
    expect(entry.gate_fired).toBe("clarify");
    spy.mockRestore();
  });
});
