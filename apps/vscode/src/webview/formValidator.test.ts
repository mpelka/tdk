// Tests for the form's shared validator (formValidator.ts) — the ajv-errors wiring
// that renders a schema-authored `errorMessage` (issue #59). Two layers:
//   1. VALIDATOR level: `validateFormData` on a schema carrying `errorMessage`
//      produces the authored message (name `errorMessage`, keyword-scoped path).
//   2. RENDER level: a real RJSF <Form> (the same fluentui-rc Form the App uses),
//      given a present-but-invalid value, surfaces that authored message in the DOM
//      when validated — proving the message flows all the way through RJSF.
//
// The render layer uses an ISOLATED <Form> with the value set directly (not typed),
// because the FluentUI-RC theme paints field-level error text under happy-dom only
// when the invalid value is already in formData at validate time — the App's
// type-then-Next path hits a documented happy-dom/theme gap (see App.bundle.test.ts).

import "../test/dom.ts";

import { describe, expect, test } from "bun:test";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { Form } from "@rjsf/fluentui-rc";
import { render } from "@testing-library/react";
import * as React from "react";
import { transformErrors } from "../lib/transformErrors.ts";
import { validator } from "./formValidator.ts";

const AUTHORED = "Please choose morning, noon, or evening.";
const patternSchema = {
  type: "object",
  required: ["slot"],
  properties: {
    slot: { type: "string", title: "Slot", pattern: "^(morning|noon|evening)$", errorMessage: AUTHORED },
  },
};

// The EXACT schema `@tdk/core` emits for a required field carrying a string
// `errorMessage` (issue #59) — verified against the emission in
// packages/core/src/pages.ts. A string covers BOTH the field's own keyword failure
// (`format: email`, on the property) AND its missing-value failure (lifted to the
// object schema's `errorMessage.required`). This is the shape the compiled
// examples/conditional-forms Baker Notes page produces for `contactEmail`; the
// preview must render the authored message either way.
const REQUIRED_AUTHORED = "Enter a valid contact email so the baker can reach you.";
const requiredEmittedSchema = {
  type: "object",
  required: ["contactEmail"],
  errorMessage: { required: { contactEmail: REQUIRED_AUTHORED } },
  properties: {
    contactEmail: { type: "string", title: "Contact email", format: "email", errorMessage: REQUIRED_AUTHORED },
  },
};

describe("formValidator — ajv-errors wiring (validator level)", () => {
  test("validateFormData surfaces a schema-authored errorMessage for an invalid value", () => {
    const result = validator.validateFormData({ slot: "nope" }, patternSchema);
    const authored = result.errors.find((e) => e.message === AUTHORED);
    expect(authored).toBeTruthy();
    // ajv-errors tags it with the `errorMessage` keyword, scoped to the field.
    expect(authored?.name).toBe("errorMessage");
    expect(authored?.schemaPath).toContain("errorMessage");
  });

  test("a plain schema (no errorMessage) still validates normally — required fires", () => {
    const plain = { type: "object", required: ["name"], properties: { name: { type: "string" } } };
    const result = validator.validateFormData({}, plain);
    expect(result.errors.some((e) => /required property/.test(e.message ?? ""))).toBe(true);
  });

  test("the validator's isValid is a real function (interop is safe, not a namespace)", () => {
    // The pre-fix interop bug bound the module namespace, whose `.isValid` is not a
    // function. This guards that the NAMED customizeValidator + our Ajv subclass keep
    // it callable.
    expect(typeof validator.isValid).toBe("function");
    expect(validator.isValid({ type: "string" }, "ok", { type: "string" })).toBe(true);
  });

  test("a core-emitted `errorMessage.required` surfaces the authored message for a MISSING field", () => {
    // The parent-level `errorMessage: { required: { … } }` half of core's emission:
    // a required field left empty renders the authored message, not "must have
    // required property 'contactEmail'".
    const result = validator.validateFormData({}, requiredEmittedSchema);
    const authored = result.errors.find((e) => e.message === REQUIRED_AUTHORED);
    expect(authored).toBeTruthy();
    expect(authored?.name).toBe("errorMessage");
    expect(authored?.schemaPath).toContain("errorMessage");
  });

  test("the same schema surfaces the field-level message for a PRESENT-but-invalid value", () => {
    // The property-level half: a malformed (present) value fails `format: email` and
    // renders the same authored string (the shorthand covers both failure modes).
    const result = validator.validateFormData({ contactEmail: "not-an-email" }, requiredEmittedSchema);
    expect(result.errors.some((e) => e.message === REQUIRED_AUTHORED)).toBe(true);
  });
});

describe("formValidator — ajv-errors rendering through RJSF (render level)", () => {
  test("a real RJSF Form surfaces the authored errorMessage when validated", async () => {
    document.body.innerHTML = "";
    const ref = React.createRef<{ validateForm(): boolean }>();
    render(
      React.createElement(
        FluentProvider,
        { theme: webLightTheme },
        React.createElement(
          Form as never,
          {
            // The RJSF ref handle type varies with the linker layout; we call
            // validateForm() structurally (see App.tsx). `any` is fine in test files.
            ref: ref as never,
            schema: patternSchema,
            validator,
            transformErrors,
            formData: { slot: "nope" },
            showErrorList: false,
            noHtml5Validate: true,
          },
          // A non-null child suppresses RJSF's built-in submit button (like App.tsx).
          React.createElement(React.Fragment),
        ),
      ),
    );
    // Let the mount settle, then validate — validateForm returns false and RJSF paints
    // the field's authored error into the DOM.
    await new Promise((r) => setTimeout(r, 100));
    let valid: boolean | undefined;
    React.act(() => {
      valid = ref.current?.validateForm();
    });
    await new Promise((r) => setTimeout(r, 200));

    expect(valid).toBe(false);
    expect(document.body.textContent ?? "").toContain(AUTHORED);
  });

  test("a real RJSF Form renders the authored message from a CORE-EMITTED errorMessage schema", async () => {
    // End-to-end proof for issue #59: the exact schema `@tdk/core` emits for the
    // adopted `contactEmail` field (property `errorMessage` + parent
    // `errorMessage.required`) renders the authored message in the real fluentui-rc
    // Form. A present-but-invalid value is used for the same happy-dom/theme reason
    // as the case above (field error text paints only when the value is in formData
    // at validate time); the missing-value path is covered at the validator level.
    document.body.innerHTML = "";
    const ref = React.createRef<{ validateForm(): boolean }>();
    render(
      React.createElement(
        FluentProvider,
        { theme: webLightTheme },
        React.createElement(
          Form as never,
          {
            ref: ref as never,
            schema: requiredEmittedSchema,
            validator,
            transformErrors,
            formData: { contactEmail: "not-an-email" },
            showErrorList: false,
            noHtml5Validate: true,
          },
          React.createElement(React.Fragment),
        ),
      ),
    );
    await new Promise((r) => setTimeout(r, 100));
    let valid: boolean | undefined;
    React.act(() => {
      valid = ref.current?.validateForm();
    });
    await new Promise((r) => setTimeout(r, 200));

    expect(valid).toBe(false);
    expect(document.body.textContent ?? "").toContain(REQUIRED_AUTHORED);
  });
});
