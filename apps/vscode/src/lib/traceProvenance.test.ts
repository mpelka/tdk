// Unit tests for the pure provenance pairing (traceProvenance.ts). The module pairs
// a step's compiled `${{ … }}` source input with its resolved trace input into a
// tree of leaf/branch nodes the trace view renders.

import { describe, expect, test } from "bun:test";
import { type ProvenanceNode, pairStepInputs, pairValue } from "./traceProvenance.ts";

describe("pairValue — a single source/value pair", () => {
  test("a templated scalar becomes a templated leaf carrying expression + value", () => {
    const node = pairValue("message", "Order type: ${{ parameters.orderType }}", "Order type: standard");
    expect(node).toEqual({
      key: "message",
      kind: "leaf",
      expression: "Order type: ${{ parameters.orderType }}",
      value: "Order type: standard",
      templated: true,
    });
  });

  test("a plain literal string is a leaf with NO templated flag (identical both sides)", () => {
    // A resolver-baked literal: compile emitted `baker-pastry-01` and it resolved to
    // the same — no `${{ }}`, so no arrow.
    const node = pairValue("headBaker", "baker-pastry-01", "baker-pastry-01");
    expect(node.kind).toBe("leaf");
    expect(node.templated).toBeUndefined();
    expect(node.expression).toBe("baker-pastry-01");
    expect(node.value).toBe("baker-pastry-01");
  });

  test("a template marker whose value equals the source verbatim is NOT templated (no arrow)", () => {
    // Source has a marker but nothing changed after render — treat as a literal.
    const node = pairValue("raw", "${{ x }}", "${{ x }}");
    expect(node.templated).toBeUndefined();
  });

  test("a non-string source (number literal) is a leaf with the value, no expression", () => {
    const node = pairValue("capacity", 12, 12);
    expect(node).toEqual({ key: "capacity", kind: "leaf", value: 12 });
  });

  test("nested objects pair recursively, marking each leaf literal vs templated", () => {
    const source = {
      customerName: "${{ parameters.customerName }}",
      channel: "web",
    };
    const value = { customerName: "Ada", channel: "web" };
    const node = pairValue("data", source, value);

    expect(node.kind).toBe("object");
    const children = node.children ?? [];
    const byKey = (k: string): ProvenanceNode => children.find((c) => c.key === k) as ProvenanceNode;
    expect(byKey("customerName").templated).toBe(true);
    expect(byKey("customerName").value).toBe("Ada");
    expect(byKey("channel").templated).toBeUndefined();
    expect(byKey("channel").value).toBe("web");
  });

  test("arrays pair by index, spanning the longer side", () => {
    const source = ["${{ items[0] }}", "${{ items[1] }}"];
    const value = ["cake", "candles", "extra"]; // resolved side longer
    const node = pairValue("items", source, value);

    expect(node.kind).toBe("array");
    expect(node.children).toHaveLength(3);
    expect(node.children?.[0]).toMatchObject({ key: "0", templated: true, value: "cake" });
    expect(node.children?.[1]).toMatchObject({ key: "1", templated: true, value: "candles" });
    // The trailing value-only index still renders (no source expression).
    expect(node.children?.[2]).toMatchObject({ key: "2", value: "extra" });
    expect(node.children?.[2]?.expression).toBeUndefined();
  });

  test("deeply nested object+array mixes pair leaf-by-leaf", () => {
    const source = { lineItems: [{ sku: "${{ items[0].sku }}", qty: 2 }] };
    const value = { lineItems: [{ sku: "CAKE-1", qty: 2 }] };
    const node = pairValue("input", source, value);

    const lineItems = node.children?.find((c) => c.key === "lineItems");
    expect(lineItems?.kind).toBe("array");
    const first = lineItems?.children?.[0];
    expect(first?.kind).toBe("object");
    const sku = first?.children?.find((c) => c.key === "sku");
    const qty = first?.children?.find((c) => c.key === "qty");
    expect(sku).toMatchObject({ templated: true, value: "CAKE-1" });
    expect(qty).toMatchObject({ value: 2 });
    expect(qty?.templated).toBeUndefined();
  });
});

describe("pairStepInputs — a whole step's inputs, keyed", () => {
  test("pairs each input key, source order first then resolved-only keys", () => {
    const source = { message: "Order: ${{ parameters.orderType }}", flag: true };
    const resolved = { message: "Order: standard", flag: true, extra: "value-only" };
    const rows = pairStepInputs(source, resolved);

    expect(rows.map((r) => r.key)).toEqual(["message", "flag", "extra"]);
    expect(rows[0]).toMatchObject({ templated: true, value: "Order: standard" });
    expect(rows[1]).toMatchObject({ value: true });
    // A resolved-only key (no source) shows the value with no expression.
    expect(rows[2]).toMatchObject({ key: "extra", value: "value-only" });
    expect(rows[2]?.expression).toBeUndefined();
  });

  test("a missing compiled input (step the YAML never named) still shows resolved values as literals", () => {
    const rows = pairStepInputs(undefined, { ovenId: "oven-7" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "ovenId", kind: "leaf", value: "oven-7" });
    expect(rows[0]?.expression).toBeUndefined();
    expect(rows[0]?.templated).toBeUndefined();
  });

  test("a missing resolved input (step errored before resolving) still shows the source expressions", () => {
    const rows = pairStepInputs({ message: "${{ parameters.x }}" }, undefined);
    expect(rows).toHaveLength(1);
    // The source expression is present; there is no resolved value → not templated.
    expect(rows[0]).toMatchObject({ key: "message", expression: "${{ parameters.x }}" });
    expect(rows[0]?.value).toBeUndefined();
    expect(rows[0]?.templated).toBeUndefined();
  });

  test("both sides empty → no rows", () => {
    expect(pairStepInputs(undefined, undefined)).toEqual([]);
    expect(pairStepInputs({}, {})).toEqual([]);
  });
});

describe("pairValue — verifier regressions (templated source vs structured value)", () => {
  // A `${{ }}` source resolving to an object/array must KEEP its expression as a
  // leaf — the old value-driven branching recursed on the value and dropped it.
  test("a templated source resolving to an array keeps the expression", () => {
    const node = pairValue("labels", "${{ parameters.tags }}", ["infra", "jira"]);
    expect(node.kind).toBe("leaf");
    expect(node.expression).toBe("${{ parameters.tags }}");
    expect(node.value).toEqual(["infra", "jira"]);
    expect(node.templated).toBe(true);
  });

  test("a templated source resolving to an object keeps the expression", () => {
    const node = pairValue("data", "${{ parameters.data }}", { a: 1, b: 2 });
    expect(node.kind).toBe("leaf");
    expect(node.expression).toBe("${{ parameters.data }}");
    expect(node.value).toEqual({ a: 1, b: 2 });
    expect(node.templated).toBe(true);
  });

  // The symmetric gap: a source OBJECT paired with a resolved SCALAR must show the
  // scalar (the truth of what the step received), not span the source's shape.
  test("a source object with a resolved scalar yields the scalar leaf", () => {
    const node = pairValue("data", { name: "${{ parameters.name }}" }, "flattened");
    expect(node.kind).toBe("leaf");
    expect(node.value).toBe("flattened");
  });

  test("a source object with NO resolved value still spans its authored keys", () => {
    const node = pairValue("data", { name: "${{ parameters.name }}" }, undefined);
    expect(node.kind).toBe("object");
    expect(node.children?.map((c) => c.key)).toEqual(["name"]);
  });
});
