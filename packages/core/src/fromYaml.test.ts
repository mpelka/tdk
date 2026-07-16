// Unit tests for `fromYaml` — the pure gatekeeper that reads a plain-YAML Scaffolder
// template into the `{ object, yaml }` artifact shape `compile()` produces. Adversarial
// by design: the k8s manifest, the multi-doc file, the template missing its `kind`, CRLF
// line endings, syntax errors with and without a template-shaped root — every case where
// mis-detection would either hand back a bad artifact or crash a downstream parse.
//
// These moved here from the VS Code extension (`lib/yamlTemplate.test.ts`) when the
// detector became a core export; the assertions now check the artifact arm's `object`
// (the parsed entity) rather than the extension's old parameters/steps helper fields.

import { describe, expect, test } from "bun:test";
import { fromYaml } from "./fromYaml.ts";

/** A minimal, well-formed bakery Scaffolder template. */
const CAKE_ORDER_TEMPLATE = `apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: cake-order
  title: Cake Order
spec:
  type: service
  parameters:
    - title: Order Type
      properties:
        orderType:
          type: string
          title: Order type
          enum: [standard, wedding]
      required: [orderType]
  steps:
    - id: log-order
      action: debug:log
      input:
        message: "Order type: \${{ parameters.orderType }}"
`;

/** Narrow to the `template` arm or fail the test (keeps assertions type-safe). */
function expectTemplate(result: ReturnType<typeof fromYaml>) {
  expect(result.kind).toBe("template");
  if (result.kind !== "template") throw new Error("unreachable");
  return result;
}

describe("fromYaml — accepting real templates", () => {
  test("a well-formed Scaffolder template yields the { object, yaml } artifact", () => {
    const result = expectTemplate(fromYaml(CAKE_ORDER_TEMPLATE));
    // The artifact is interchangeable with compile()'s: `object` is the parsed entity,
    // `yaml` the source text.
    const meta = result.object.metadata as Record<string, unknown>;
    expect(meta.name).toBe("cake-order");
    expect(meta.title).toBe("Cake Order");
    const spec = result.object.spec as Record<string, unknown>;
    expect(Array.isArray(spec.parameters)).toBe(true);
    expect((spec.parameters as unknown[]).length).toBe(1);
    expect(Array.isArray(spec.steps)).toBe(true);
    expect(result.yaml).toBe(CAKE_ORDER_TEMPLATE);
  });

  test("CRLF line endings read the same as LF (the yaml parser normalizes them)", () => {
    const crlf = CAKE_ORDER_TEMPLATE.replace(/\n/g, "\r\n");
    const result = expectTemplate(fromYaml(crlf));
    const meta = result.object.metadata as Record<string, unknown>;
    expect(meta.title).toBe("Cake Order");
    expect(Array.isArray((result.object.spec as Record<string, unknown>).parameters)).toBe(true);
  });

  test("a template with no spec.parameters still reads (the form is just empty)", () => {
    const result = expectTemplate(
      fromYaml("apiVersion: scaffolder.backstage.io/v1beta3\nkind: Template\nmetadata:\n  name: bare-cake\n"),
    );
    expect((result.object.metadata as Record<string, unknown>).name).toBe("bare-cake");
  });

  test("any scaffolder.backstage.io/* version passes the prefix check", () => {
    expect(fromYaml("apiVersion: scaffolder.backstage.io/v2\nkind: Template\n").kind).toBe("template");
  });
});

describe("fromYaml — rejecting non-templates (each carries a reason)", () => {
  test("a k8s manifest (apiVersion v1, kind ConfigMap) is notTemplate", () => {
    const k8s = `apiVersion: v1
kind: ConfigMap
metadata:
  name: oven-settings
data:
  temperature: "180"
`;
    const result = fromYaml(k8s);
    expect(result.kind).toBe("notTemplate");
    if (result.kind !== "notTemplate") throw new Error("unreachable");
    expect(result.reason).toContain("Scaffolder template");
  });

  test("a scaffolder apiVersion MISSING its kind is notTemplate", () => {
    const missingKind = `apiVersion: scaffolder.backstage.io/v1beta3
metadata:
  name: cake-order
spec:
  parameters: []
`;
    expect(fromYaml(missingKind).kind).toBe("notTemplate");
  });

  test("a scaffolder apiVersion with the WRONG kind is notTemplate", () => {
    expect(fromYaml("apiVersion: scaffolder.backstage.io/v1beta3\nkind: Recipe\n").kind).toBe("notTemplate");
  });

  test("a MULTI-DOCUMENT file is notTemplate, even when one document IS a template", () => {
    // A downstream single-document parse() throws on multi-doc sources — reject them
    // cleanly instead of letting that throw happen.
    const multi = `---
apiVersion: v1
kind: ConfigMap
---
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
`;
    const result = fromYaml(multi);
    expect(result.kind).toBe("notTemplate");
    if (result.kind !== "notTemplate") throw new Error("unreachable");
    expect(result.reason).toContain("multiple");
  });

  test("empty / whitespace-only / comment-only text is notTemplate", () => {
    expect(fromYaml("").kind).toBe("notTemplate");
    expect(fromYaml("   \n\t\n").kind).toBe("notTemplate");
    expect(fromYaml("# just a comment\n").kind).toBe("notTemplate");
  });

  test("a non-map root (a list, a scalar) is notTemplate", () => {
    const list = fromYaml("- one\n- two\n");
    expect(list.kind).toBe("notTemplate");
    if (list.kind !== "notTemplate") throw new Error("unreachable");
    expect(list.reason).toContain("mapping");
    expect(fromYaml("just a string").kind).toBe("notTemplate");
  });

  test("apiVersion must be a STRING starting with the scaffolder prefix", () => {
    // A non-string apiVersion (or one merely CONTAINING the prefix) must not pass.
    expect(fromYaml("apiVersion: 42\nkind: Template\n").kind).toBe("notTemplate");
    expect(fromYaml("apiVersion: not-scaffolder.backstage.io/v1beta3\nkind: Template\n").kind).toBe("notTemplate");
  });

  test("a syntax error in a file that is NOT template-shaped is notTemplate (no hijack)", () => {
    const brokenK8s = "apiVersion: v1\nkind: ConfigMap\ndata:\n  bad: [unclosed\n";
    expect(fromYaml(brokenK8s).kind).toBe("notTemplate");
  });
});

describe("fromYaml — parse errors in a genuine template", () => {
  test("a template with a syntax error reports parseError with the 1-based line", () => {
    // The root still parses enough to show apiVersion/kind, so this IS a template —
    // report the error (with its line) instead of silently falling back.
    const broken = `apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
spec:
  parameters:
    - title: X
  bad: [unclosed
`;
    const result = fromYaml(broken);
    expect(result.kind).toBe("parseError");
    if (result.kind !== "parseError") throw new Error("unreachable");
    expect(result.message.length).toBeGreaterThan(0);
    // The parser locates the unterminated flow sequence at (or just past) its line —
    // assert it points into the broken region, not an exact column of the message.
    expect(result.line).toBeGreaterThanOrEqual(6);
    expect(result.line).toBeLessThanOrEqual(7);
  });
});
