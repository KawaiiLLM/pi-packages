import { describe, expect, it } from "vitest";
import { fakeSource, mockTui } from "./transcript-fixtures";

describe("mockTui", () => {
  it("defaults to a 40x80 terminal", () => {
    expect(mockTui().terminal).toEqual({ rows: 40, columns: 80 });
  });

  it("applies the supplied dimensions", () => {
    expect(mockTui(24, 200).terminal).toEqual({ rows: 24, columns: 200 });
  });

  it("exposes requestRender as a spy", () => {
    const tui = mockTui();
    tui.requestRender();
    expect(tui.requestRender).toHaveBeenCalledOnce();
  });
});

describe("fakeSource", () => {
  it("defaults to a single user message with no subscription activity", () => {
    const source = fakeSource();
    expect(source.getMessages()).toEqual([{ role: "user", content: "Hello world" }]);
    expect(source.streaming()).toBeUndefined();
    expect(source.getToolDefinition("read")).toBeUndefined();
  });

  it("applies overrides over the defaults", () => {
    const source = fakeSource({ streaming: () => ({ activeTools: new Map(), responseText: "hi" }) });
    expect(source.streaming()).toEqual({ activeTools: new Map(), responseText: "hi" });
    expect(source.getMessages()).toEqual([{ role: "user", content: "Hello world" }]);
  });
});
