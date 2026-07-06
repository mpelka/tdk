import { describe, expect, test } from "bun:test";
import { cliNotFoundMessage, resolveTdkBin } from "./resolveCli.ts";

const existing = (...paths: string[]) => {
  const set = new Set(paths);
  return (p: string) => set.has(p);
};

describe("resolveTdkBin", () => {
  test("the workspace's node_modules/.bin/tdk wins when present", () => {
    const r = resolveTdkBin({
      workspaceRoot: "/ws",
      pathDirs: ["/usr/local/bin"],
      home: "/home/u",
      exists: existing("/ws/node_modules/.bin/tdk", "/usr/local/bin/tdk", "/home/u/.bun/bin/tdk"),
    });
    expect(r).toEqual({ bin: "/ws/node_modules/.bin/tdk", source: "workspace" });
  });

  test("an explicit tdk.cliPath setting beats the workspace bin", () => {
    const r = resolveTdkBin({
      workspaceRoot: "/ws",
      cliPathSetting: "/opt/tdk/cli",
      pathDirs: [],
      exists: existing("/opt/tdk/cli", "/ws/node_modules/.bin/tdk"),
    });
    expect(r).toEqual({ bin: "/opt/tdk/cli", source: "setting" });
  });

  test("a set-but-missing cliPath falls through to the workspace bin", () => {
    const r = resolveTdkBin({
      workspaceRoot: "/ws",
      cliPathSetting: "/gone/tdk",
      pathDirs: [],
      exists: existing("/ws/node_modules/.bin/tdk"),
    });
    expect(r).toEqual({ bin: "/ws/node_modules/.bin/tdk", source: "workspace" });
  });

  test("PATH is searched in order when the workspace has no bin", () => {
    const r = resolveTdkBin({
      workspaceRoot: "/ws",
      pathDirs: ["/first", "", "/second"],
      exists: existing("/second/tdk"),
    });
    expect(r).toEqual({ bin: "/second/tdk", source: "path" });
  });

  test("~/.bun/bin/tdk is the last rung (GUI-launched hosts miss that PATH entry)", () => {
    const r = resolveTdkBin({
      workspaceRoot: "/ws",
      pathDirs: ["/usr/bin"],
      home: "/home/u",
      exists: existing("/home/u/.bun/bin/tdk"),
    });
    expect(r).toEqual({ bin: "/home/u/.bun/bin/tdk", source: "bun-global" });
  });

  test("nothing anywhere resolves to undefined", () => {
    const r = resolveTdkBin({ workspaceRoot: "/ws", pathDirs: ["/usr/bin"], home: "/home/u", exists: () => false });
    expect(r).toBeUndefined();
  });
});

describe("cliNotFoundMessage", () => {
  test("names every searched location and the three fixes", () => {
    const msg = cliNotFoundMessage("/ws");
    expect(msg).toContain("/ws/node_modules/.bin/tdk");
    expect(msg).toContain("tdk.cliPath");
    expect(msg).toContain("bun link");
    expect(msg).toContain("bun install");
  });
});
