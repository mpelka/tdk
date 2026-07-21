import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileResolved, execute, validate } from "../index.ts";
import { corpus, corpusMapping } from "./__fixtures__/corpus.ts";
import { scenarios as goldenScenarios } from "./__fixtures__/golden/__fixtures__/scenarios.ts";
import goldenTemplate from "./__fixtures__/golden/template.ts";
import type { MigrationMapping, MigrationModel } from "./model.ts";
import { printTemplate } from "./print.ts";
import { formatModelErrors, validateModel } from "./validate.ts";

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, "__fixtures__", "golden");
const readGolden = (rel: string) => readFileSync(join(goldenDir, rel), "utf8");

describe("printTemplate — determinism + golden", () => {
  test("the same model prints byte-identical files", () => {
    const a = printTemplate(corpus, { mapping: corpusMapping });
    const b = printTemplate(corpus, { mapping: corpusMapping });
    expect(a.files).toEqual(b.files);
  });

  test("the emitted files match the committed golden fixture", () => {
    const out = printTemplate(corpus, { mapping: corpusMapping });
    expect(out.files["template.ts"]).toBe(readGolden("template.ts"));
    expect(out.files["__fixtures__/scenarios.ts"]).toBe(readGolden("__fixtures__/scenarios.ts"));
    expect(out.files["migration-report.json"]).toBe(readGolden("migration-report.json"));
  });

  test("the report counts translated vs flagged, and quotes every flagged construct", () => {
    const { report } = printTemplate(corpus, { mapping: corpusMapping });
    expect(report.counts).toEqual({ translated: 15, flagged: 3 });
    expect(report.flagged.map((f) => f.construct).sort()).toEqual(["effect", "expression", "lookup"]);
    for (const f of report.flagged) {
      expect(f.path).toMatch(/^(logic|lookups|effects)\[\d+\]$/);
      expect(typeof f.verbatim).toBe("string");
    }
  });
});

describe("printTemplate — the round-trip proof (gates 1 + 2)", () => {
  test("the golden template compiles and schema-validates (gate 1)", async () => {
    const { object } = await compileResolved(goldenTemplate, { env: "test", outDir: "" });
    const result = await validate(object);
    expect(result.valid).toBe(true);
  });

  test("the model's extraSpec rides through into the compiled spec block verbatim", async () => {
    const { object } = await compileResolved(goldenTemplate, { env: "test", outDir: "" });
    // The corpus' custom top-level spec metadata is merged into `spec` unchanged — the
    // migration keeps catalog wiring the DSL has no first-class field for.
    expect((object.spec as Record<string, unknown>).catalog_metadata).toEqual(
      corpus.template.extraSpec?.catalog_metadata,
    );
  });

  test("the generated scenario executes and produces the expected output (gate 2)", async () => {
    // The generated fixture is loosely typed (`satisfies ExecuteFixture`); execute
    // infers the template's strict param unions, so cast at the boundary.
    const run = await execute(goldenTemplate, goldenScenarios[0].fixture as never);
    const output = run.output as { workOrderId: string; sla: number };
    // The derives are computed for REAL; the effect output is mocked.
    expect(output.sla).toBe(4);
    expect(output.workOrderId).toBe("submit-request-id");
    // Every derive step ran (listMap included).
    const steps = run.steps as Record<string, { output?: { result?: unknown } }>;
    expect(steps["parts-list"].output?.result).toEqual(["OV-A1", "OV-B2"]);
  });
});

describe("printTemplate — the ADR-0026 worked example", () => {
  // Lifted from ADR-0026 (its `"model": "tdk.migration/v1"` discriminator normalized
  // to `modelVersion: "1"`, this repo's canonical version field).
  const adrModel: MigrationModel = {
    modelVersion: "1",
    template: {
      id: "request-oven-maintenance",
      title: "Request oven maintenance",
      description: "Raise a maintenance work order for a bakery oven.",
      tags: ["bakery", "oven", "maintenance"],
      owner: "team-bakery",
    },
    questions: [
      {
        name: "bakeryCode",
        type: "choice",
        title: "Bakery site",
        options: { BK1: "Riverside", BK2: "Old Town", BK3: "Harbourfront" },
        required: true,
        exampleValue: "BK1",
        page: "Site",
      },
      { name: "ovenId", type: "string", title: "Oven asset ID", required: true, exampleValue: "OV-4471", page: "Site" },
      {
        name: "faultType",
        type: "choice",
        title: "Fault type",
        options: { heating: "Heating", door: "Door", controls: "Controls", other: "Other" },
        required: true,
        exampleValue: "other",
        page: "Fault",
      },
      {
        name: "faultDetail",
        type: "string",
        title: "Describe the fault",
        required: false,
        exampleValue: "Door seal warped, heat escaping",
        page: "Fault",
        visibleWhen: { field: "faultType", is: "other" },
      },
    ],
    logic: [
      {
        name: "job-summary",
        op: "template",
        template: "Oven {oven} at {site}",
        bindings: { oven: { op: "fieldRef", field: "ovenId" }, site: { op: "fieldRef", field: "bakeryCode" } },
      },
    ],
    lookups: [
      {
        name: "assignee",
        kind: "roster",
        source: "roster://maintenance-team?site={bakeryCode}",
        params: { site: { op: "fieldRef", field: "bakeryCode" } },
        at: "oven-maintenance.export.json#/fields/assignee",
      },
    ],
    effects: [
      {
        name: "submit-request",
        kind: "workOrder",
        actionRef: "legacy:oven-booking:create-work-order",
        inputs: {
          title: { ref: "job-summary" },
          site: { ref: "bakeryCode" },
          oven: { ref: "ovenId" },
          fault: { ref: "faultType" },
          detail: { ref: "faultDetail" },
          assignee: { ref: "assignee" },
        },
      },
    ],
    outputs: { workOrderId: { effectRef: "submit-request", path: ["body", "id"] } },
  };
  const adrMapping: MigrationMapping = {
    actions: { "legacy:oven-booking:create-work-order": { import: { name: "createWorkOrder", from: "./pack.ts" } } },
    lookups: { roster: { import: { name: "maintenanceRoster", from: "./pack.ts" } } },
  };

  test("the ADR model validates", () => {
    expect(validateModel(adrModel).valid).toBe(true);
  });

  test("the ADR model prints, and the output has the shapes the ADR illustrates", () => {
    const ts = printTemplate(adrModel, { mapping: adrMapping }).files["template.ts"];
    // Fields as module-scope consts with p.choice + .showWhen.
    expect(ts).toContain('export const bakeryCode = p.choice({ BK1: "Riverside"');
    expect(ts).toContain('.showWhen(faultType.is("other"))');
    // The logic node became a derive.
    expect(ts).toContain('export const jobSummary = derive("job-summary"');
    // The lookup is flagged, wired to the org marker.
    expect(ts).toContain("const assignee = maintenanceRoster({ site: bakeryCode });");
    expect(ts).toContain("TODO(migration)");
    // The effect went through the mapped helper.
    expect(ts).toContain('createWorkOrder("submit-request"');
    // The conditional field is defaulted at the effect input.
    expect(ts).toContain('detail: faultDetail.ref.orElse("")');
    // Pages-as-TOC + handle-based output.
    expect(ts).toContain('page("Site", { bakeryCode, ovenId })');
    expect(ts).toContain("workOrderId: submitRequest.output.body.id");
  });

  test("the ADR report counts 6 translated, 1 flagged (the lookup)", () => {
    const { report } = printTemplate(adrModel, { mapping: adrMapping });
    expect(report.counts).toEqual({ translated: 6, flagged: 1 });
    expect(report.flagged[0].construct).toBe("lookup");
  });

  // DIVERGENCE (documented, pending ADR amendment): ADR-0026 sketches one generated
  // scenario per visibleWhen branch. The printer emits a SINGLE happy-path scenario
  // with a `branches` list instead — see the rationale in print.ts renderScenariosFile.
  test("the ADR model generates the single baseline scenario (documented divergence)", () => {
    const scenarios = printTemplate(adrModel, { mapping: adrMapping }).files["__fixtures__/scenarios.ts"];
    expect(scenarios).toContain('name: "example — happy path"');
    expect(scenarios).toContain('branches: ["other"]');
  });
});

describe("printTemplate — no mapping (usable on day one)", () => {
  const model: MigrationModel = {
    modelVersion: "1",
    template: { id: "t", title: "T" },
    questions: [{ name: "site", type: "string", page: "P", exampleValue: "BK1" }],
    lookups: [
      {
        name: "roster",
        kind: "roster",
        source: "roster://x?site={site}",
        params: { site: { op: "fieldRef", field: "site" } },
      },
    ],
    effects: [
      {
        name: "submit",
        kind: "k",
        actionRef: "legacy:oven-booking:submit",
        inputs: { site: { ref: "site" }, who: { ref: "roster" } },
      },
    ],
  };

  test("an unmapped effect prints a direct effect(...) with a TODO and a flag", () => {
    const out = printTemplate(model); // NO mapping
    const ts = out.files["template.ts"];
    expect(ts).toContain('effect("submit", "legacy:oven-booking:submit"');
    expect(ts).toContain("TODO(migration): unmapped legacy action legacy:oven-booking:submit");
    expect(out.report.flagged.some((f) => f.construct === "effect")).toBe(true);
  });

  test("an unmapped lookup prints a flagged raw placeholder", () => {
    const out = printTemplate(model);
    const ts = out.files["template.ts"];
    expect(ts).toContain("const roster = raw`TODO(migration) unresolved lookup: roster`;");
    expect(out.report.flagged.some((f) => f.construct === "lookup")).toBe(true);
  });

  test("a model with no outputs gets a sensible default output referencing the last effect", () => {
    const out = printTemplate(model);
    const ts = out.files["template.ts"];
    expect(ts).toContain("submit.output");
    expect(out.report.notes.some((n) => /default output/.test(n))).toBe(true);
  });
});

describe("printTemplate — a customField reaches p.customField", () => {
  // A scratch dir INSIDE the package so the emitted template can resolve @tdk/core when
  // imported back (Bun walks up to the workspace node_modules) — same as the extraSpec
  // round-trip in injection.test.ts.
  let pkgTmp: string;
  beforeAll(async () => {
    pkgTmp = await mkdtemp(join(here, "..", ".tmp-customfield-"));
  });
  afterAll(async () => {
    await rm(pkgTmp, { recursive: true, force: true });
  });

  // A Backstage field extension the DSL has no first-class builder for: uiField +
  // customType (object) + uiOptions, revealed by a controller (showWhen), with an object
  // exampleValue. It reaches core's p.customField.
  const model: MigrationModel = {
    modelVersion: "1",
    template: { id: "cake-order", title: "Cake order", type: "service" },
    questions: [
      {
        name: "orderType",
        type: "choice",
        title: "Order type",
        options: { wedding: "Wedding", birthday: "Birthday" },
        required: true,
        exampleValue: "wedding",
        page: "Order",
      },
      {
        name: "cakeChoice",
        type: "customField",
        title: "Cake",
        uiField: "CakePickerWithDefault",
        customType: "object",
        uiOptions: { path: "bakery-catalog/entities", valueSelector: "metadata.name" },
        exampleValue: { id: "c1", name: "Sponge" },
        page: "Order",
        visibleWhen: { field: "orderType", is: "wedding" },
      },
    ],
  };

  test("the model validates", () => {
    const r = validateModel(model);
    if (!r.valid) throw new Error(formatModelErrors(r.errors));
    expect(r.valid).toBe(true);
  });

  test("prints p.customField with uiField, type, uiOptions, and a showWhen chain", () => {
    const ts = printTemplate(model).files["template.ts"];
    // An EXPLICIT p.customField call (not a p.customField-by-coincidence fallthrough).
    expect(ts).toContain("export const cakeChoice = p.customField({");
    expect(ts).toContain('uiField: "CakePickerWithDefault"');
    expect(ts).toContain('type: "object"');
    expect(ts).toContain('uiOptions: { path: "bakery-catalog/entities", valueSelector: "metadata.name" }');
    expect(ts).toContain('.showWhen(orderType.is("wedding"))');
  });

  test("the object exampleValue rides into the generated scenarios", () => {
    const scenarios = printTemplate(model).files["__fixtures__/scenarios.ts"];
    expect(scenarios).toContain('cakeChoice: { id: "c1", name: "Sponge" }');
  });

  test("the printed template compiles + validates, and the YAML carries ui:field (gate 1 smoke)", async () => {
    const ts = printTemplate(model).files["template.ts"];
    const file = join(pkgTmp, "cake-order.ts");
    await writeFile(file, ts, "utf8");
    const mod = (await import(`${file}?t=${Date.now()}`)) as { default: never };
    const { object, yaml } = await compileResolved(mod.default, { env: "test", outDir: "" });
    const result = await validate(object);
    expect(result.valid).toBe(true);
    // The custom field extension name reaches the compiled Scaffolder YAML verbatim.
    expect(yaml).toContain("ui:field: CakePickerWithDefault");
  });
});
