// Unit tests for the plain-YAML Scaffolder-template detector — the pure gatekeeper of
// the YAML form-preview path. Adversarial by design: the k8s manifest, the multi-doc
// file, the template missing its `kind`, CRLF line endings, syntax errors with and
// without a template-shaped root — every case where mis-detection would either hijack
// the `.ts` fallback or crash the downstream single-document `parse()`.

import { describe, expect, test } from "bun:test";
import { detectYamlTemplate } from "./yamlTemplate.ts";

/** A minimal, well-formed bakery Scaffolder template. */
const CAKE_ORDER_TEMPLATE = `apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: cake-order
  title: Cake Order
spec:
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

describe("detectYamlTemplate — accepting real templates", () => {
  test("a well-formed Scaffolder template is detected, with parameters/steps/title/name", () => {
    const result = detectYamlTemplate(CAKE_ORDER_TEMPLATE);
    expect(result.kind).toBe("template");
    if (result.kind !== "template") throw new Error("unreachable");
    expect(result.title).toBe("Cake Order");
    expect(result.name).toBe("cake-order");
    expect(Array.isArray(result.parameters)).toBe(true);
    expect((result.parameters as unknown[]).length).toBe(1);
    expect(Array.isArray(result.steps)).toBe(true);
  });

  test("CRLF line endings detect the same as LF (the yaml parser normalizes them)", () => {
    const crlf = CAKE_ORDER_TEMPLATE.replace(/\n/g, "\r\n");
    const result = detectYamlTemplate(crlf);
    expect(result.kind).toBe("template");
    if (result.kind !== "template") throw new Error("unreachable");
    expect(result.title).toBe("Cake Order");
    expect(Array.isArray(result.parameters)).toBe(true);
  });

  test("a template with no spec.parameters still detects (the form is just empty)", () => {
    const result = detectYamlTemplate(
      "apiVersion: scaffolder.backstage.io/v1beta3\nkind: Template\nmetadata:\n  name: bare-cake\n",
    );
    expect(result.kind).toBe("template");
    if (result.kind !== "template") throw new Error("unreachable");
    expect(result.parameters).toBeUndefined();
    expect(result.name).toBe("bare-cake");
  });

  test("any scaffolder.backstage.io/* version passes the prefix check", () => {
    const result = detectYamlTemplate("apiVersion: scaffolder.backstage.io/v2\nkind: Template\n");
    expect(result.kind).toBe("template");
  });
});

describe("detectYamlTemplate — rejecting non-templates (the fallback stays intact)", () => {
  test("a k8s manifest (apiVersion v1, kind ConfigMap) is notTemplate", () => {
    const k8s = `apiVersion: v1
kind: ConfigMap
metadata:
  name: oven-settings
data:
  temperature: "180"
`;
    expect(detectYamlTemplate(k8s)).toEqual({ kind: "notTemplate" });
  });

  test("a scaffolder apiVersion MISSING its kind is notTemplate", () => {
    const missingKind = `apiVersion: scaffolder.backstage.io/v1beta3
metadata:
  name: cake-order
spec:
  parameters: []
`;
    expect(detectYamlTemplate(missingKind)).toEqual({ kind: "notTemplate" });
  });

  test("a scaffolder apiVersion with the WRONG kind is notTemplate", () => {
    const wrongKind = "apiVersion: scaffolder.backstage.io/v1beta3\nkind: Recipe\n";
    expect(detectYamlTemplate(wrongKind)).toEqual({ kind: "notTemplate" });
  });

  test("a MULTI-DOCUMENT file is notTemplate, even when one document IS a template", () => {
    // The downstream single-document parse() throws on multi-doc sources — the
    // detector must reject them cleanly instead of letting that throw happen.
    const multi = `---
apiVersion: v1
kind: ConfigMap
---
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
`;
    expect(detectYamlTemplate(multi)).toEqual({ kind: "notTemplate" });
  });

  test("empty / whitespace-only / comment-only text is notTemplate", () => {
    expect(detectYamlTemplate("")).toEqual({ kind: "notTemplate" });
    expect(detectYamlTemplate("   \n\t\n")).toEqual({ kind: "notTemplate" });
    expect(detectYamlTemplate("# just a comment\n")).toEqual({ kind: "notTemplate" });
  });

  test("a non-map root (a list, a scalar) is notTemplate", () => {
    expect(detectYamlTemplate("- one\n- two\n")).toEqual({ kind: "notTemplate" });
    expect(detectYamlTemplate("just a string")).toEqual({ kind: "notTemplate" });
  });

  test("apiVersion must be a STRING starting with the scaffolder prefix", () => {
    // A non-string apiVersion (or one merely CONTAINING the prefix) must not pass.
    expect(detectYamlTemplate("apiVersion: 42\nkind: Template\n")).toEqual({ kind: "notTemplate" });
    expect(detectYamlTemplate("apiVersion: not-scaffolder.backstage.io/v1beta3\nkind: Template\n")).toEqual({
      kind: "notTemplate",
    });
  });

  test("a syntax error in a file that is NOT template-shaped is notTemplate (no hijack)", () => {
    const brokenK8s = "apiVersion: v1\nkind: ConfigMap\ndata:\n  bad: [unclosed\n";
    expect(detectYamlTemplate(brokenK8s).kind).toBe("notTemplate");
  });
});

describe("detectYamlTemplate — parse errors in a genuine template", () => {
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
    const result = detectYamlTemplate(broken);
    expect(result.kind).toBe("parseError");
    if (result.kind !== "parseError") throw new Error("unreachable");
    expect(result.message.length).toBeGreaterThan(0);
    // The parser locates the unterminated flow sequence at (or just past) its line —
    // assert it points into the broken region, not an exact column of the message.
    expect(result.line).toBeGreaterThanOrEqual(6);
    expect(result.line).toBeLessThanOrEqual(7);
  });
});
