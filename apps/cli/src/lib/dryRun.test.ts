// Unit tests for `tdk dry-run` — the batch sweep operation. No live Backstage: a FAKE
// client (injected via `DryRunSweepOptions.client`) drives every taxonomy arm and records
// the values each dry-run was handed, so the values-source priority, the synthesizer, the
// 429/5xx backoff, and the report shaping are all provable offline.
//
// The .ts path reuses the `greeting` fixture (a required `customer` string + one scenario);
// the .yaml path writes tiny bakery templates + colocated values into a temp dir.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BackstageClient,
  CompiledArtifact,
  CreateTaskResult,
  DryRunResult,
  RequestValues,
} from "@tdk/core/backstage";
import {
  colocatedValuesPath,
  type DryRunSweepOptions,
  expandPaths,
  formatDryRunReport,
  runDryRunSweep,
  serializeDryRunReport,
  synthesizeValues,
} from "./dryRun.ts";

const TS_TEMPLATE = join(import.meta.dir, "..", "__fixtures__", "greeting", "template.ts");

/** A fake client that records each dryRun's values and returns a scripted result. */
function fakeClient(
  result: DryRunResult | ((call: number) => DryRunResult) = {
    kind: "ok",
    body: { steps: [], log: [], output: {}, directoryContents: [] },
  },
): BackstageClient & { calls: { artifact: CompiledArtifact; values: RequestValues }[] } {
  const calls: { artifact: CompiledArtifact; values: RequestValues }[] = [];
  let n = 0;
  return {
    baseUrl: "http://fake:7007",
    allowTaskCreation: false,
    calls,
    dryRun(artifact, values) {
      calls.push({ artifact, values });
      const r = typeof result === "function" ? result(n) : result;
      n++;
      return Promise.resolve(r);
    },
    createTask(): Promise<CreateTaskResult> {
      throw new Error("createTask must never be called by dry-run");
    },
  };
}

/** Base sweep options with a fake client and no values source (each test adds one). */
function opts(over: Partial<DryRunSweepOptions> & { client: BackstageClient }): DryRunSweepOptions {
  return { env: "test", synthesizeValues: false, concurrency: 4, ...over };
}

// A temp workspace for the .yaml fixtures (cleaned at the end).
const dir = mkdtempSync(join(tmpdir(), "tdk-dryrun-"));
afterAll(() => {
  // Best-effort cleanup; the OS temp dir is reclaimed regardless.
});

/** Write a bakery YAML template into the temp dir and return its path. */
function writeYaml(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body, "utf8");
  return path;
}

const CAKE_YAML = `apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: cake-order
  title: Cake Order
spec:
  type: service
  parameters:
    - title: Order
      required: [flavor]
      properties:
        flavor:
          type: string
          title: Flavor
          enum: [vanilla, chocolate]
  steps:
    - id: log
      action: debug:log
      input:
        message: "Flavor: \${{ parameters.flavor }}"
`;

describe("expandPaths", () => {
  test("keeps a literal .ts/.yaml path and rejects a non-template literal", async () => {
    const files = await expandPaths([TS_TEMPLATE]);
    expect(files).toEqual([TS_TEMPLATE]);
    await expect(expandPaths(["README.md"])).rejects.toThrow(/Not a .ts or .yaml template/);
  });

  test("expands a glob, drops non-template matches, throws on a zero-match pattern", async () => {
    writeYaml("a.yaml", CAKE_YAML);
    writeYaml("b.yaml", CAKE_YAML);
    writeYaml("notes.txt", "not a template");
    const files = await expandPaths(["*.yaml"], dir);
    expect(files.map((f) => f.split("/").pop())).toEqual(["a.yaml", "b.yaml"]);
    await expect(expandPaths(["*.nope"], dir)).rejects.toThrow(/No .ts or .yaml templates matched/);
  });
});

describe("synthesizeValues", () => {
  test("uses a property default, then the first enum member, then a type placeholder", () => {
    const params = [
      {
        required: ["a", "b", "c", "n", "flag"],
        properties: {
          a: { type: "string", default: "from-default" },
          b: { type: "string", enum: ["first", "second"] },
          c: { type: "string" },
          n: { type: "integer" },
          flag: { type: "boolean" },
        },
      },
    ];
    expect(synthesizeValues(params)).toEqual({ a: "from-default", b: "first", c: "example", n: 1, flag: false });
  });

  test("only synthesizes REQUIRED fields (optional properties are left out)", () => {
    const params = [{ required: ["needed"], properties: { needed: { type: "string" }, optional: { type: "string" } } }];
    expect(synthesizeValues(params)).toEqual({ needed: "example" });
  });

  test("merges required across pages, first page wins a shared name", () => {
    const params = [
      { required: ["shared"], properties: { shared: { type: "string", default: "page1" } } },
      {
        required: ["shared", "extra"],
        properties: { shared: { type: "string", default: "page2" }, extra: { type: "boolean" } },
      },
    ];
    expect(synthesizeValues(params)).toEqual({ shared: "page1", extra: false });
  });

  test("BAILS on a required object with no default (won't invent a deep structure)", () => {
    const params = [{ required: ["cfg"], properties: { cfg: { type: "object" } } }];
    expect(() => synthesizeValues(params)).toThrow(/Cannot synthesize values for required field\(s\): cfg/);
  });

  test("BAILS on a required typeless field", () => {
    const params = [{ required: ["mystery"], properties: { mystery: { title: "Mystery" } } }];
    expect(() => synthesizeValues(params)).toThrow(/mystery/);
  });

  test("a single-schema (non-array) parameters object works too", () => {
    expect(synthesizeValues({ required: ["x"], properties: { x: { type: "string" } } })).toEqual({ x: "example" });
  });
});

describe("values-source priority — .ts templates", () => {
  test("defaults to the first scenario's fixture", async () => {
    const client = fakeClient();
    const report = await runDryRunSweep([TS_TEMPLATE], opts({ client }));
    expect(report.ok).toBe(true);
    expect(client.calls[0]!.values.values).toEqual({ customer: "Alice" });
    expect(report.templates[0]!.valuesSource).toBe("scenario");
    expect(report.templates[0]!.synthesized).toBe(false);
  });

  test("--scenario selects a named scenario; an unknown name is a valuesError", async () => {
    const client = fakeClient();
    const ok = await runDryRunSweep([TS_TEMPLATE], opts({ client, scenario: "orders for alice" }));
    expect(ok.templates[0]!.valuesSource).toBe("scenario");

    const bad = await runDryRunSweep([TS_TEMPLATE], opts({ client, scenario: "does-not-exist" }));
    expect(bad.ok).toBe(false);
    expect(bad.templates[0]!.kind).toBe("valuesError");
    expect(bad.templates[0]!.message).toContain("No scenario named");
  });

  test("--values wins over the scenario fixture", async () => {
    const client = fakeClient();
    const valuesFile = join(dir, "override.values.json");
    writeFileSync(valuesFile, JSON.stringify({ customer: "Bob" }), "utf8");
    const report = await runDryRunSweep([TS_TEMPLATE], opts({ client, valuesFile }));
    expect(client.calls[0]!.values.values).toEqual({ customer: "Bob" });
    expect(report.templates[0]!.valuesSource).toBe("values-file");
  });
});

describe("values-source priority — .yaml templates", () => {
  test("reads a colocated <basename>.values.json", async () => {
    const path = writeYaml("colo.yaml", CAKE_YAML);
    writeFileSync(colocatedValuesPath(path), JSON.stringify({ flavor: "chocolate" }), "utf8");
    const client = fakeClient();
    const report = await runDryRunSweep([path], opts({ client }));
    expect(report.ok).toBe(true);
    expect(client.calls[0]!.values.values).toEqual({ flavor: "chocolate" });
    expect(report.templates[0]!.valuesSource).toBe("colocated");
  });

  test("--values wins over a colocated file", async () => {
    const path = writeYaml("colo2.yaml", CAKE_YAML);
    writeFileSync(colocatedValuesPath(path), JSON.stringify({ flavor: "chocolate" }), "utf8");
    const valuesFile = join(dir, "explicit.json");
    writeFileSync(valuesFile, JSON.stringify({ flavor: "vanilla" }), "utf8");
    const client = fakeClient();
    const report = await runDryRunSweep([path], opts({ client, valuesFile }));
    expect(client.calls[0]!.values.values).toEqual({ flavor: "vanilla" });
    expect(report.templates[0]!.valuesSource).toBe("values-file");
  });

  test("--synthesize-values derives from the schema and flags the run", async () => {
    const path = writeYaml("synth.yaml", CAKE_YAML);
    const client = fakeClient();
    const report = await runDryRunSweep([path], opts({ client, synthesizeValues: true }));
    // `flavor` is required with an enum → first member.
    expect(client.calls[0]!.values.values).toEqual({ flavor: "vanilla" });
    expect(report.templates[0]!.valuesSource).toBe("synthesized");
    expect(report.templates[0]!.synthesized).toBe(true);
  });

  test("no values source is a valuesError naming the ways to supply them", async () => {
    const path = writeYaml("bare.yaml", CAKE_YAML);
    const client = fakeClient();
    const report = await runDryRunSweep([path], opts({ client }));
    expect(report.ok).toBe(false);
    expect(report.templates[0]!.kind).toBe("valuesError");
    expect(report.templates[0]!.message).toContain(".values.json");
    expect(client.calls).toHaveLength(0); // never contacted Backstage
  });
});

describe("pre-flight failures never contact Backstage", () => {
  test("a notTemplate .yaml reports notTemplate with no dry-run", async () => {
    const path = writeYaml("k8s.yaml", "apiVersion: v1\nkind: ConfigMap\n");
    const client = fakeClient();
    const report = await runDryRunSweep([path], opts({ client, synthesizeValues: true }));
    expect(report.templates[0]!.kind).toBe("notTemplate");
    expect(client.calls).toHaveLength(0);
  });
});

describe("report shaping + taxonomy", () => {
  test("a validationFailed run is non-ok and carries a readable message", async () => {
    const client = fakeClient({ kind: "validationFailed", errors: [{ message: 'requires property "flavor"' }] });
    const path = writeYaml("val.yaml", CAKE_YAML);
    writeFileSync(colocatedValuesPath(path), JSON.stringify({}), "utf8");
    const report = await runDryRunSweep([path], opts({ client }));
    expect(report.ok).toBe(false);
    expect(report.templates[0]!.kind).toBe("validationFailed");
    expect(report.templates[0]!.message).toContain("flavor");
  });

  test("the whole sweep is ok only when EVERY template is ok", async () => {
    const okPath = writeYaml("ok1.yaml", CAKE_YAML);
    const badPath = writeYaml("bad1.yaml", CAKE_YAML);
    writeFileSync(colocatedValuesPath(okPath), JSON.stringify({ flavor: "vanilla" }), "utf8");
    writeFileSync(colocatedValuesPath(badPath), JSON.stringify({ flavor: "vanilla" }), "utf8");
    let call = 0;
    const client = fakeClient(() =>
      call++ === 0
        ? { kind: "ok", body: { steps: [], log: [], output: {}, directoryContents: [] } }
        : { kind: "authFailed", status: 401, message: "bad token" },
    );
    const report = await runDryRunSweep([okPath, badPath], opts({ client, concurrency: 1 }));
    expect(report.ok).toBe(false);
    expect(report.templates.filter((t) => t.ok)).toHaveLength(1);
  });

  test("--json serializes the report; the human format marks synthesized runs", async () => {
    const path = writeYaml("json.yaml", CAKE_YAML);
    const client = fakeClient();
    const report = await runDryRunSweep([path], opts({ client, synthesizeValues: true }));
    const json = JSON.parse(serializeDryRunReport(report));
    expect(json.ok).toBe(true);
    expect(json.templates[0].synthesized).toBe(true);
    expect(json.templates[0].valuesSource).toBe("synthesized");
    const human = formatDryRunReport(report, dir);
    expect(human).toContain("SYNTHESIZED");
    expect(human).toContain("1/1 template(s) dry-ran ok.");
  });
});

describe("429/5xx polite backoff", () => {
  // An instant sleep (recording each requested delay) so the backoff tests do not wait
  // out the real 250/500/1000ms delays — the DELAY SEQUENCE is asserted instead.
  function instantSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
    const delays: number[] = [];
    return {
      delays,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    };
  }

  test("retries a 503 then succeeds", async () => {
    const path = writeYaml("retry.yaml", CAKE_YAML);
    writeFileSync(colocatedValuesPath(path), JSON.stringify({ flavor: "vanilla" }), "utf8");
    let call = 0;
    const client = fakeClient(() =>
      call++ < 2
        ? { kind: "serverError", status: 503, message: "overloaded" }
        : { kind: "ok", body: { steps: [], log: [], output: {}, directoryContents: [] } },
    );
    const { sleep, delays } = instantSleep();
    const report = await runDryRunSweep([path], opts({ client, sleep }));
    expect(report.ok).toBe(true);
    expect(client.calls.length).toBeGreaterThanOrEqual(3); // two 503s + the ok
    expect(delays).toEqual([250, 500]); // one backoff per retried 503
  });

  test("gives up after the retry budget on a persistent 5xx", async () => {
    const path = writeYaml("retry2.yaml", CAKE_YAML);
    writeFileSync(colocatedValuesPath(path), JSON.stringify({ flavor: "vanilla" }), "utf8");
    const client = fakeClient({ kind: "serverError", status: 500, message: "always down" });
    const { sleep, delays } = instantSleep();
    const report = await runDryRunSweep([path], opts({ client, sleep }));
    expect(report.ok).toBe(false);
    expect(report.templates[0]!.kind).toBe("serverError");
    expect(report.templates[0]!.status).toBe(500);
    expect(delays).toEqual([250, 500, 1000]); // the full budget, then give up
  });
});
