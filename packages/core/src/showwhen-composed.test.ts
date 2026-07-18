// Composed `showWhen` — the ADR-0025 Decision 1 authoring surface and the
// `dependencies`/`oneOf` tree the compiler synthesises from it.
//
// The predicates (`field.is`, `field.in`, `all`, `any`) and the synthesiser (in
// pages.ts) already exist; this file pins the COMPOSED front door that phase 2
// adds on top:
//   - the `.showWhen(...)` METHOD is value-equivalent to the `showWhen:` option
//     and the record form (byte-identical compiled parameters);
//   - `.in([...])` (array) equals `.in(...)` (variadic) equals the record array;
//   - `any(...)` on ONE field lowers to that field's `.in`;
//   - a cross-field `any(...)` OR is a loud compile error (the wire cannot key a
//     single dependency off two controllers);
//   - a controller on a DIFFERENT page is a loud compile error (each page is its
//     own object schema — no cross-page dependency);
//   - the synthesiser groups, nests, and else-fills exactly as hand-written
//     `dep.*` does (two fields sharing a discriminator; 2- and 3-level AND-chains
//     with branch-scoped `required`; two independent discriminators on one page).

import { describe, expect, test } from "bun:test";
import {
  all,
  any,
  compile,
  defineTemplate,
  execute,
  type PageObject,
  type ParamMap,
  p,
  page,
  step,
  type Template,
} from "./index.ts";

const nonprod = { env: "test", outDir: "dist/nonprod" } as const;

/** A one-page template wrapping `props`, so tests read as just their fields. */
function onePage(props: ParamMap): Template {
  return defineTemplate({
    id: "t",
    title: "T",
    type: "service",
    parameters: [page("P", props)],
    steps: () => [step("s", "debug:log")],
  });
}

/** The compiled `spec.parameters`, serialised for byte-equality assertions. */
function paramsJson(props: ParamMap): string {
  return JSON.stringify(compile(onePage(props), nonprod).object.spec.parameters);
}

/** The first page's compiled `dependencies` object. */
type Dep = { oneOf: Array<Record<string, unknown>> };
function depsOf(props: ParamMap): Record<string, Dep> {
  const [pg] = compile(onePage(props), nonprod).object.spec.parameters as PageObject[];
  return (pg!.dependencies ?? {}) as Record<string, Dep>;
}

/** The branch of `dep` whose controller `const` equals `value`. */
function branchOf(dep: Dep, controller: string, value: unknown): Record<string, unknown> {
  const branch = dep.oneOf.find((b) => {
    const props = b.properties as Record<string, { const?: unknown }>;
    return props[controller]?.const === value;
  });
  if (!branch) throw new Error(`no branch for ${controller}=${String(value)}`);
  return branch;
}

// ---------------------------------------------------------------------------
// Value-equivalence: the composed forms compile to the SAME bytes as the record
// form they stand in for. This is the load-bearing byte-stability guarantee.
// ---------------------------------------------------------------------------

describe("the .showWhen() method ≡ the showWhen: option ≡ the record form", () => {
  test("a single predicate is byte-identical across all three forms", () => {
    // method form
    const oM = p.enum(["standard", "wedding"], { title: "Order type", required: true });
    const method = paramsJson({ orderType: oM, tiers: p.number({ title: "Tiers" }).showWhen(oM.is("wedding")) });
    // option form
    const oO = p.enum(["standard", "wedding"], { title: "Order type", required: true });
    const option = paramsJson({ orderType: oO, tiers: p.number({ title: "Tiers", showWhen: oO.is("wedding") }) });
    // record form
    const oR = p.enum(["standard", "wedding"], { title: "Order type", required: true });
    const record = paramsJson({
      orderType: oR,
      tiers: p.number({ title: "Tiers", showWhen: { orderType: "wedding" } }),
    });

    expect(method).toBe(record);
    expect(option).toBe(record);
  });

  test("an all(...) AND-chain via the method is byte-identical to the record form", () => {
    const oM = p.enum(["standard", "wedding"], { title: "Order type", required: true });
    const tM = p.boolean({ title: "Topper?" }).showWhen(oM.is("wedding"));
    const method = paramsJson({
      orderType: oM,
      topper: tM,
      topperText: p.string({ title: "Topper text" }).showWhen(all(oM.is("wedding"), tM.is(true))),
    });
    const oR = p.enum(["standard", "wedding"], { title: "Order type", required: true });
    const tR = p.boolean({ title: "Topper?", showWhen: { orderType: "wedding" } });
    const record = paramsJson({
      orderType: oR,
      topper: tR,
      topperText: p.string({ title: "Topper text", showWhen: { orderType: "wedding", topper: true } }),
    });
    expect(method).toBe(record);
  });

  test(".showWhen() throws if a condition was already set via the option", () => {
    const orderType = p.enum(["standard", "wedding"]);
    expect(() => p.string({ showWhen: { orderType: "wedding" } }).showWhen(orderType.is("wedding"))).toThrow(
      /showWhen is already set/,
    );
  });
});

describe(".in([...]) (array) ≡ .in(...) (variadic) ≡ the record array", () => {
  test("all three OR spellings compile to identical bytes", () => {
    const sA = p.enum(["S", "M", "L"], { title: "Size" });
    const arrayForm = paramsJson({ size: sA, note: p.string({ title: "Note" }).showWhen(sA.in(["M", "L"])) });
    const sV = p.enum(["S", "M", "L"], { title: "Size" });
    const variadic = paramsJson({ size: sV, note: p.string({ title: "Note" }).showWhen(sV.in("M", "L")) });
    const sR = p.enum(["S", "M", "L"], { title: "Size" });
    const record = paramsJson({ size: sR, note: p.string({ title: "Note", showWhen: { size: ["M", "L"] } }) });
    expect(arrayForm).toBe(record);
    expect(variadic).toBe(record);
  });
});

describe("any(...) on ONE field lowers to that field's .in", () => {
  test("any(size.is('M'), size.is('L')) ≡ size.in(['M','L'])", () => {
    const sAny = p.enum(["S", "M", "L"], { title: "Size" });
    const viaAny = paramsJson({
      size: sAny,
      note: p.string({ title: "Note" }).showWhen(any(sAny.is("M"), sAny.is("L"))),
    });
    const sIn = p.enum(["S", "M", "L"], { title: "Size" });
    const viaIn = paramsJson({ size: sIn, note: p.string({ title: "Note" }).showWhen(sIn.in(["M", "L"])) });
    expect(viaAny).toBe(viaIn);
  });

  test("any(...) may sit inside all(...) as one AND-ed term", () => {
    // all(kind.is('cake'), any(size.is('M'), size.is('L'))) == { kind: 'cake', size: ['M','L'] }
    const kindA = p.enum(["cake", "bun"], { title: "Kind" });
    const sizeA = p.enum(["S", "M", "L"], { title: "Size" }).showWhen(kindA.is("cake"));
    const composed = paramsJson({
      kind: kindA,
      size: sizeA,
      note: p.string({ title: "Note" }).showWhen(all(kindA.is("cake"), any(sizeA.is("M"), sizeA.is("L")))),
    });
    const kindR = p.enum(["cake", "bun"], { title: "Kind" });
    const sizeR = p.enum(["S", "M", "L"], { title: "Size", showWhen: { kind: "cake" } });
    const record = paramsJson({
      kind: kindR,
      size: sizeR,
      note: p.string({ title: "Note", showWhen: { kind: "cake", size: ["M", "L"] } }),
    });
    expect(composed).toBe(record);
  });
});

// ---------------------------------------------------------------------------
// Synthesis: grouping, else-bookkeeping, nesting, independence.
// ---------------------------------------------------------------------------

describe("two fields sharing a discriminator group into one dependency", () => {
  test("one `color` dependency, a branch per value, else branches empty", () => {
    const color = p.enum(["red", "green", "blue"], { title: "Colour" });
    const deps = depsOf({
      color,
      redNote: p.string({ title: "Red note" }).showWhen(color.is("red")),
      blueNote: p.string({ title: "Blue note" }).showWhen(color.is("blue")),
    });
    // Grouped: exactly ONE controller, with a branch for every value in its set.
    expect(Object.keys(deps)).toEqual(["color"]);
    expect(deps.color!.oneOf).toHaveLength(3);
    // The matching branches reveal their field...
    expect(branchOf(deps.color!, "color", "red").properties).toHaveProperty("redNote");
    expect(branchOf(deps.color!, "color", "blue").properties).toHaveProperty("blueNote");
    // ...and the untouched value gets an else branch: match fragment only.
    expect(branchOf(deps.color!, "color", "green")).toEqual({ properties: { color: { const: "green" } } });
  });
});

describe("an all(...) AND-chain nests, with branch-scoped required", () => {
  test("2 levels: domain nests inside platform's Windows branch; required scoped", () => {
    const platform = p.enum(["Windows", "Mac"], { title: "Platform", required: true });
    const domain = p.enum(["Corp", "Other"], { title: "Domain" }).showWhen(platform.is("Windows"));
    const props: ParamMap = {
      platform,
      domain,
      otherName: p
        .string({ title: "Other domain name", required: true })
        .showWhen(all(platform.is("Windows"), domain.is("Other"))),
    };
    const [pg] = compile(onePage(props), nonprod).object.spec.parameters as PageObject[];
    // The REQUIRED base field stays at page level; the required CONDITIONAL field
    // does NOT — it is required only inside its branch.
    expect(pg!.required).toEqual(["platform"]);

    const deps = (pg!.dependencies ?? {}) as Record<string, Dep>;
    expect(Object.keys(deps)).toEqual(["platform"]);
    const win = branchOf(deps.platform!, "platform", "Windows");
    expect(win.properties).toHaveProperty("domain"); // domain revealed in Windows
    // domain nests INSIDE the Windows branch (not a page-level sibling).
    const nested = (win.dependencies as Record<string, Dep>).domain!;
    const other = branchOf(nested, "domain", "Other");
    expect(other.properties).toHaveProperty("otherName");
    expect(other.required).toEqual(["otherName"]); // required scoped to this branch
  });

  test("3 levels: a → b → c → d nests three dependencies deep", () => {
    const a = p.enum(["x", "y"], { title: "A", required: true });
    const b = p.enum(["p", "q"], { title: "B" }).showWhen(a.is("x"));
    const c = p.enum(["m", "n"], { title: "C" }).showWhen(all(a.is("x"), b.is("p")));
    const d = p.string({ title: "D" }).showWhen(all(a.is("x"), b.is("p"), c.is("m")));
    const deps = depsOf({ a, b, c, d });
    const aX = branchOf(deps.a!, "a", "x");
    const bDep = (aX.dependencies as Record<string, Dep>).b!;
    const bp = branchOf(bDep, "b", "p");
    const cDep = (bp.dependencies as Record<string, Dep>).c!;
    const cm = branchOf(cDep, "c", "m");
    expect(cm.properties).toHaveProperty("d");
  });
});

describe("two independent discriminators on one page compile side by side", () => {
  test("each controller gets its own root dependency", () => {
    const color = p.enum(["red", "blue"], { title: "Colour" });
    const size = p.enum(["S", "L"], { title: "Size" });
    const deps = depsOf({
      color,
      size,
      redNote: p.string({ title: "Red note" }).showWhen(color.is("red")),
      largeNote: p.string({ title: "Large note" }).showWhen(size.is("L")),
    });
    expect(Object.keys(deps).sort()).toEqual(["color", "size"]);
  });
});

// ---------------------------------------------------------------------------
// Loud rejections: cross-field OR and cross-page controller.
// ---------------------------------------------------------------------------

describe("a cross-field any(...) OR is rejected at compile", () => {
  test("the diagnostic names both fields and points at .in([...])", () => {
    const size = p.enum(["S", "L"], { title: "Size" });
    const topping = p.enum(["jam", "cream"], { title: "Topping" });
    const build = () =>
      compile(
        onePage({
          size,
          topping,
          // An OR across DIFFERENT fields — unexpressible as one dependency node.
          note: p.string({ title: "Note" }).showWhen(any(size.is("L"), topping.is("jam"))),
        }),
        nonprod,
      );
    // Exact diagnostic, pinned: names the fields, states the wire limit, and the fix.
    expect(build).toThrow(
      'showWhen any(...) mixes different fields "size", "topping" — an OR across different fields cannot be ' +
        "expressed as a JSON-Schema dependency (each dependency keys off ONE controller). For an OR on ONE " +
        "field use that field's .in([...]); a genuine cross-field OR needs separate conditional fields, one " +
        "per controller.",
    );
  });
});

describe("a controller on a DIFFERENT page is rejected at compile", () => {
  test("cross-page reveal has no wire form — loud, with the reason", () => {
    // `platform` is declared on page 1; `detail` on page 2 tries to key off it.
    const platform = p.enum(["Windows", "Mac"], { title: "Platform", required: true });
    const detail = p.string({ title: "Detail" }).showWhen(platform.is("Windows"));
    const tpl = defineTemplate({
      id: "cross-page",
      title: "Cross page",
      type: "service",
      parameters: [page("P1", { platform }), page("P2", { detail })],
      steps: () => [step("s", "debug:log")],
    });
    expect(() => compile(tpl, nonprod)).toThrow(
      'showWhen references controller "platform", which is not a property on this page. A dependency can ' +
        "only key off a field declared on the SAME page (each wizard page is its own object schema) — " +
        "declare the controller on this page, or move both fields onto one page.",
    );
  });
});

describe("any(...) in step().when: compiles to a Nunjucks `or` (issue #24)", () => {
  // The DELIBERATE asymmetry with showWhen: a step condition compiles to Nunjucks
  // (which has `or`), so a cross-field OR IS expressible here — unlike the schema
  // layer, which still rejects it (a JSON-Schema dependency keys off one field).
  test("when: any(a, b) across different fields → `(a) or (b)`", () => {
    const size = p.enum(["S", "L"], { title: "Size" });
    const topping = p.enum(["jam", "cream"], { title: "Topping" });
    size.setName("size");
    topping.setName("topping");
    const s = step("notify", "debug:log", { when: any(size.is("L"), topping.is("jam")) });
    expect(s.if).toBe('${{ (parameters.size == "L") or (parameters.topping == "jam") }}');
  });

  test("when: all(x, any(y, z)) nests → `(x) and ((y) or (z))`", () => {
    const size = p.enum(["S", "L"], { title: "Size" });
    const kind = p.enum(["cake", "bun"], { title: "Kind" });
    size.setName("size");
    kind.setName("kind");
    const s = step("notify", "debug:log", { when: all(kind.is("cake"), any(size.is("S"), size.is("L"))) });
    expect(s.if).toBe('${{ (parameters.kind == "cake") and ((parameters.size == "S") or (parameters.size == "L")) }}');
  });

  test("the schema layer STILL rejects a cross-field any(...) — the asymmetry stands", () => {
    // showWhen keeps rejecting a cross-field OR (see the "cross-field any(...)"
    // suite above): the form cannot express it, only the step condition can.
    const size = p.enum(["S", "L"], { title: "Size" });
    const topping = p.enum(["jam", "cream"], { title: "Topping" });
    const tpl = defineTemplate({
      id: "asym",
      title: "Asym",
      type: "service",
      parameters: [page("P", { size, topping, note: p.string().showWhen(any(size.is("L"), topping.is("jam"))) })],
      steps: () => [step("noop", "debug:log", { input: { x: "y" } })],
    });
    expect(() => compile(tpl, { env: "test", outDir: "" })).toThrow(/mixes different fields/);
  });
});

// ---------------------------------------------------------------------------
// execute(): a composed-condition field resolves on the ACTIVE side of the
// branch and is absent on the inactive side; branch-scoped `required` gates the
// opt-in fixture validation exactly where the branch is active.
// ---------------------------------------------------------------------------

describe("execute() — a composed-condition field on both sides of the branch", () => {
  // winNote is revealed only when platform=Windows AND domain=Other (an all(...)
  // AND-chain), and is required within that branch. A step and the output read it.
  const platform = p.enum(["Windows", "Mac"], { title: "Platform", required: true });
  const domain = p.enum(["Corp", "Other"], { title: "Domain" }).showWhen(platform.is("Windows"));
  const winNote = p
    .string({ title: "Windows/Other note", required: true })
    .showWhen(all(platform.is("Windows"), domain.is("Other")));
  const tpl = defineTemplate({
    id: "composed-run",
    title: "Composed run",
    type: "service",
    parameters: [page("Setup", { platform, domain, winNote })],
    steps: (f) => [step("log", "debug:log", { input: { note: f.winNote } })],
    output: (f) => ({ note: f.winNote, platform: f.platform }),
  });

  test("active branch: the field resolves into the step input and output", async () => {
    const run = await execute(tpl, {
      parameters: { platform: "Windows", domain: "Other", winNote: "keep me" },
      steps: { log: { output: {} } },
    });
    expect((run.steps.log!.input as { note: string }).note).toBe("keep me");
    expect(run.output).toEqual({ note: "keep me", platform: "Windows" });
  });

  test("inactive branch: no leak — the hidden field renders empty, not stale", async () => {
    const run = await execute(tpl, {
      parameters: { platform: "Mac" },
      steps: { log: { output: {} } },
    });
    // The field is not on the Mac branch, so nothing was submitted for it: the ref
    // resolves to absent (undefined), never to another run's value.
    expect((run.steps.log!.input as { note?: string }).note).toBeUndefined();
    expect(run.output).toMatchObject({ platform: "Mac" });
    expect((run.output as { note?: string }).note).toBeUndefined();
  });

  test("opt-in validation enforces branch-scoped required only when the branch is active", async () => {
    // Branch active (Windows + Other) but the branch-required winNote is missing:
    // validation fails against the synthesised oneOf branch.
    await expect(
      execute(
        tpl,
        { parameters: { platform: "Windows", domain: "Other" }, steps: { log: { output: {} } } },
        { validateParams: true },
      ),
    ).rejects.toThrow(/failed validation/);
    // Branch inactive (Mac): winNote is not required, so the same-shaped fixture
    // (no winNote) validates cleanly.
    const ok = await execute(
      tpl,
      { parameters: { platform: "Mac" }, steps: { log: { output: {} } } },
      { validateParams: true },
    );
    expect(ok.output).toMatchObject({ platform: "Mac" });
  });
});
