// Pins the `@tdk/core/backstage` barrel's VALUE surface — specifically that the
// ungated low-level `createTask` (and its `templateRefFor` / `taskUrl` / `TASKS_PATH`
// helpers) is NOT exported. The consent gate lives in `backstageClient`; a barrel
// re-export of the bare `createTask` would hand every consumer a route to /v2/tasks
// that never consults the gate. This test makes that erosion loud: a future refactor
// that re-adds the export fails here, not in a security review.
//
// The safe, side-effect-free low-level `dryRun` (consumed by the VS Code extension)
// stays exported on purpose.

import { describe, expect, test } from "bun:test";
import * as barrel from "./index.ts";

describe("the @tdk/core/backstage barrel surface", () => {
  test("exports the gated client and the safe low-level dryRun", () => {
    expect(typeof barrel.backstageClient).toBe("function");
    expect(typeof barrel.dryRun).toBe("function");
    // The composers + config constants the extension and tests rely on.
    expect(typeof barrel.dryRunUrl).toBe("function");
    expect(typeof barrel.dryRunBody).toBe("function");
    expect(typeof barrel.dryRunHeaders).toBe("function");
    expect(typeof barrel.CONSENT_GATE_MESSAGE).toBe("string");
    expect(typeof barrel.MISSING_BASE_URL_MESSAGE).toBe("string");
  });

  test("does NOT export the ungated createTask or its task-endpoint helpers", () => {
    const exported = barrel as Record<string, unknown>;
    // The only exported route to /v2/tasks must be backstageClient().createTask —
    // which throws without allowTaskCreation. None of these may leak past the gate.
    expect(exported.createTask).toBeUndefined();
    expect(exported.templateRefFor).toBeUndefined();
    expect(exported.taskUrl).toBeUndefined();
    expect(exported.TASKS_PATH).toBeUndefined();
  });

  test("the gate still holds through the barrel's client", () => {
    const client = barrel.backstageClient({ baseUrl: "http://localhost:7007" });
    expect(() => client.createTask({ object: { metadata: { name: "cake" } } }, { values: {} })).toThrow(
      barrel.CONSENT_GATE_MESSAGE,
    );
  });
});
