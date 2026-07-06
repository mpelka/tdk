// LAYER 1 — App component tests (React Testing Library + happy-dom under bun test).
//
// Renders the real <App> with fake `subscribe`/`post` props and feeds it the EXACT
// payload the extension pushes in production: a real gold-standard example compiled
// through the `tdk` CLI and split by `toFormPages` (see compileExample.ts). No
// hand-mocked schema — the form under test is the form users see.
//
// These tests exercise the STEPPER's behaviour: rendering, required-field validation
// on Next, value commit + `valuesChanged` posts, Reset, the unknown-`ui:field`
// fallback, the error polish (no top ErrorList; humanized required message), and the
// MINIMAL header (env/scenario picks post the native-QuickPick request). They run
// under the RUNTIME module loader, where the pre-fix `default as validator` import
// happened to resolve fine — so this layer canNOT catch the CJS-interop bug. That bug
// lives in the BROWSER BUNDLE, and the bundle smoke test (App.bundle.test.ts) is the
// layer that catches it.
//
// HAPPY-DOM GAP (documented, not faked): Fluent v9's <Dropdown> renders its option
// list through a Floating-UI-positioned portal that needs real browser layout — but
// the form no longer uses a Dropdown for env/scenario (those are native QuickPicks
// now), and the enum FIELD's popup is still not drivable here, so the value-commit
// and forward-navigation paths are driven through TEXT fields. `user-event` (not bare
// fireEvent) drives Fluent's controlled inputs.

import "../test/dom.ts";

import { beforeEach, describe, expect, test } from "bun:test";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { exampleFormPages } from "../test/compileExample.ts";
import { App } from "./App.tsx";
import type { ExtensionToWebview, FormPage, WebviewToExtension } from "./protocol.ts";

/** Mount <App> with recording `post` and a captured `subscribe` handler. */
function mount() {
  let handler: ((msg: ExtensionToWebview) => void) | undefined;
  const posts: WebviewToExtension[] = [];
  render(
    <FluentProvider theme={webLightTheme}>
      <App
        subscribe={(h) => {
          handler = h;
        }}
        post={(m) => posts.push(m)}
      />
    </FluentProvider>,
  );
  return {
    /** Every message the app posted back to the extension. */
    posts,
    /** Push an extension → webview message (wrapped in act so React flushes). */
    send(msg: ExtensionToWebview) {
      React.act(() => handler?.(msg));
    },
    /** The last `valuesChanged` payload posted, if any. */
    lastValues() {
      const changed = posts.filter((p) => p.type === "valuesChanged");
      return changed.length ? (changed[changed.length - 1] as { values: unknown }).values : undefined;
    },
  };
}

/** A `template` message carrying `pages`, with sensible header defaults. */
function templateMsg(pages: FormPage[]): ExtensionToWebview {
  return { type: "template", templateId: "t", title: "Cake Wizard", env: "test", pages };
}

/** A button by its exact visible label. */
function button(label: string): HTMLButtonElement {
  const btn = [...document.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!btn) throw new Error(`no "${label}" button`);
  return btn as HTMLButtonElement;
}

/** The posts of a given type recorded on the mount. */
function postsOfType<T extends WebviewToExtension["type"]>(
  posts: WebviewToExtension[],
  type: T,
): Extract<WebviewToExtension, { type: T }>[] {
  return posts.filter((p) => p.type === type) as Extract<WebviewToExtension, { type: T }>[];
}

describe("App — the compiled-template stepper (layer 1)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("posts `ready` on mount (the handshake) — before any template arrives", () => {
    // The app subscribes and then posts `ready`. This is the fix for the blank-form
    // race: the extension buffers the initial state and (re)plays it on `ready`, so the
    // first `template` message can't be lost to the mount/subscribe ordering.
    const app = mount();
    expect(app.posts).toContainEqual({ type: "ready" });
    // And it's posted eagerly, with no template message needed to trigger it.
    expect(app.posts.filter((p) => p.type === "ready")).toHaveLength(1);
  });

  test("a template message renders page 1 with the stepper and the required enum field", () => {
    const app = mount();
    app.send(templateMsg(exampleFormPages("conditional-forms")));

    // The stepper rail lists every page title plus a final Review.
    const text = document.body.textContent ?? "";
    expect(text).toContain("Cake Wizard");
    for (const label of ["Order Type", "Packaging & Speed", "Baker Notes", "Review"]) {
      expect(text).toContain(label);
    }

    // Page 1's required `orderType` enum renders as a Fluent combobox (RJSF's
    // SelectWidget). It carries the schema label and is marked required.
    const orderType = document.getElementById("root_orderType");
    expect(orderType).toBeTruthy();
    expect(orderType?.getAttribute("role")).toBe("combobox");
    expect(text).toContain("Order type");
  });

  test("Next on an empty required page stays on page 1 and renders a HUMANIZED required error", async () => {
    const app = mount();
    app.send(templateMsg(exampleFormPages("conditional-forms")));

    const user = userEvent.setup({ document });
    await user.click(button("Next"));

    // The Form's validateForm() ran and surfaced the missing required property. With
    // `transformErrors`, the raw ajv text ("must have required property 'orderType'")
    // is rewritten to "OrderType is required" — assert the humanized form, and that
    // the raw ajv phrasing is NOT shown.
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/is required/i);
    expect(text).not.toMatch(/must have required property/i);
    expect(text).toContain("Order type"); // still on page 1
    // Page 2's field must NOT be showing.
    expect(document.getElementById("root_packaging")).toBeNull();
  });

  test("the top ErrorList summary box is hidden (showErrorList=false)", async () => {
    // RJSF's ErrorList renders inside a `.panel-danger` / list-group container with a
    // heading "Errors". With showErrorList=false it must be absent — the field-level
    // errors carry the message instead.
    const app = mount();
    app.send(templateMsg(exampleFormPages("conditional-forms")));
    const user = userEvent.setup({ document });
    await user.click(button("Next"));

    // No RJSF ErrorList container, and no standalone "Errors" heading from it.
    expect(document.querySelector(".panel-danger, .list-group")).toBeNull();
    const headings = [...document.querySelectorAll("h2, h3, h4")].map((h) => h.textContent);
    expect(headings).not.toContain("Errors");
  });

  test("typing into a field commits (input shows it) and posts valuesChanged with the value", async () => {
    // plugin-composed's `ovenModel` is a custom `ui:field` → rendered by the
    // fallback as a plain text Input, which user-event can drive (unlike the enum
    // dropdown). Committing it exercises the same onChange → validate → post chain.
    const app = mount();
    app.send(templateMsg(exampleFormPages("plugin-composed")));

    const input = [...document.querySelectorAll("input")].find((i) => i.type === "text");
    expect(input).toBeTruthy();

    const user = userEvent.setup({ document });
    await user.click(input as HTMLInputElement);
    await user.keyboard("deck-3000");

    expect((input as HTMLInputElement).value).toBe("deck-3000");
    expect(app.lastValues()).toMatchObject({ ovenModel: "deck-3000" });
  });

  test("Next advances to the next page, and values survive Next then Previous", async () => {
    // conditional-forms' first page is a required enum the Fluent popup can't be
    // opened under happy-dom, so drive the stepper through two REAL compiled pages
    // whose first page has text fields: Baker Notes (contactEmail is required text)
    // then Packaging & Speed. Same App, same real schemas — just a passable page 1.
    const cf = exampleFormPages("conditional-forms");
    const app = mount();
    app.send(templateMsg([cf[2] as FormPage, cf[1] as FormPage]));

    const user = userEvent.setup({ document });
    const email = [...document.querySelectorAll("input")].find((i) => i.id.includes("contactEmail"));
    await user.click(email as HTMLInputElement);
    await user.keyboard("baker@cake.test");
    expect(app.lastValues()).toMatchObject({ contactEmail: "baker@cake.test" });

    // Next: page 1's required text is satisfied, so it advances to Packaging.
    await user.click(button("Next"));
    expect(document.body.textContent).toContain("Packaging");
    expect(document.getElementById("root_packaging")).toBeTruthy();

    // Previous: back to page 1, and the typed value is still there.
    await user.click(button("Previous"));
    const emailAgain = [...document.querySelectorAll("input")].find((i) => i.id.includes("contactEmail"));
    expect((emailAgain as HTMLInputElement).value).toBe("baker@cake.test");
  });

  test("Reset returns to page 1 with empty values and posts valuesChanged: {}", async () => {
    const cf = exampleFormPages("conditional-forms");
    const app = mount();
    // Two-page flow so we can move OFF page 1 first and prove Reset returns to it.
    app.send(templateMsg([cf[2] as FormPage, cf[1] as FormPage]));

    const user = userEvent.setup({ document });
    const email = [...document.querySelectorAll("input")].find((i) => i.id.includes("contactEmail"));
    await user.click(email as HTMLInputElement);
    await user.keyboard("baker@cake.test");
    await user.click(button("Next")); // now on page 2

    await user.click(button("Reset"));

    // Back on page 1 (Baker Notes) with an empty, cleared form and an empty post.
    expect(document.getElementById("root_contactEmail")).toBeTruthy();
    const cleared = [...document.querySelectorAll("input")].find((i) => i.id.includes("contactEmail"));
    expect((cleared as HTMLInputElement).value).toBe("");
    expect(app.lastValues()).toEqual({});
  });

  test("an unknown ui:field renders the fallback with its hint text", () => {
    // plugin-composed references the custom `ui:field` CakePickerWithDefault, which
    // the webview does not ship — it must render the fallback (a labelled input)
    // with a hint naming the extension, not silently render by type or crash.
    const app = mount();
    app.send(templateMsg(exampleFormPages("plugin-composed")));

    const text = document.body.textContent ?? "";
    expect(text).toContain("custom field");
    expect(text).toContain("CakePickerWithDefault");
  });

  test("an array ITEM heading is a smaller caption, a real rung below the field's title", async () => {
    // payload-assembly's `items` is an array field. Adding an item renders the item's
    // title ("Line items-1") which USED to paint at the same visual level as the field
    // title ("Line items"). The custom TitleFieldTemplate now renders array-item titles
    // as a compact "Item N" caption — assert the two titles differ in element/class so
    // the hierarchy is real, not just cosmetic text.
    const app = mount();
    app.send(templateMsg(exampleFormPages("payload-assembly")));

    // The field-level title is present at its prominent level.
    const fieldTitle = document.getElementById("root_items__title");
    expect(fieldTitle).toBeTruthy();
    expect(fieldTitle?.getAttribute("data-array-item-title")).toBeNull();

    // Add one array item (the array "add" button carries the `array-item` class).
    const user = userEvent.setup({ document });
    const addBtn = [...document.querySelectorAll("button")].find((b) => b.className.includes("array-item"));
    expect(addBtn).toBeTruthy();
    await user.click(addBtn as HTMLButtonElement);

    // The item title now renders as a distinct, smaller caption — NOT the field-title
    // markup. It is flagged as an array-item title, reads "Item 1", and its class is a
    // Fluent Caption (a different element/class from the field title's heading block).
    const itemTitle = document.getElementById("root_items_0__title");
    expect(itemTitle).toBeTruthy();
    expect(itemTitle?.getAttribute("data-array-item-title")).toBe("true");
    expect(itemTitle?.textContent).toBe("Item 1");
    // The two titles are visibly different: the item caption carries the Fluent Caption
    // class, the field title does not — a real visual rung, not the same level.
    expect(itemTitle?.className).toContain("fui-Caption1");
    expect(fieldTitle?.className).not.toContain("fui-Caption1");
    expect(itemTitle?.className).not.toBe(fieldTitle?.className);
  });
});

// --- The minimal header: env + scenario are NATIVE QuickPicks -----------------
//
// The form no longer has Fluent env/scenario dropdowns. The header shows the current
// env + scenario as plain text; clicking either posts a pick request the extension
// turns into a native QuickPick. These tests assert the header renders the values and
// the clicks post the right messages — and that no second combobox (a dropdown) is
// rendered for them.

describe("App — the minimal header + native pickers (layer 1)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("the header shows the current env and clicking it posts pickEnv", async () => {
    const app = mount();
    app.send(templateMsg(exampleFormPages("conditional-forms")));

    const envButton = document.querySelector('[data-testid="pick-env"]') as HTMLButtonElement;
    expect(envButton).toBeTruthy();
    expect(envButton.textContent).toBe("test");

    const user = userEvent.setup({ document });
    await user.click(envButton);
    expect(postsOfType(app.posts, "pickEnv")).toHaveLength(1);
  });

  test("clicking the scenario text posts pickScenario once scenarios exist", async () => {
    const app = mount();
    app.send(templateMsg(exampleFormPages("conditional-forms")));

    // With no scenarios the scenario button is disabled (shows "—").
    const before = document.querySelector('[data-testid="pick-scenario"]') as HTMLButtonElement;
    expect(before.disabled).toBe(true);
    expect(before.textContent).toBe("—");

    app.send({
      type: "scenarios",
      scenarios: [{ name: "standard order", hasStepMocks: true, parameters: { orderType: "standard" } }],
    });

    const after = document.querySelector('[data-testid="pick-scenario"]') as HTMLButtonElement;
    expect(after.disabled).toBe(false);
    expect(after.textContent).toBe("none");

    const user = userEvent.setup({ document });
    await user.click(after);
    expect(postsOfType(app.posts, "pickScenario")).toHaveLength(1);
  });

  test("the form renders NO env/scenario Fluent dropdown (only the enum field's combobox)", () => {
    const app = mount();
    app.send(templateMsg(exampleFormPages("conditional-forms")));
    app.send({
      type: "scenarios",
      scenarios: [{ name: "standard order", hasStepMocks: true, parameters: { orderType: "standard" } }],
    });

    // The only combobox on the page is the schema's `orderType` enum — NOT an
    // env or scenario dropdown (those were removed in favour of native QuickPicks).
    const comboboxes = [...document.querySelectorAll('[role="combobox"]')];
    expect(comboboxes).toHaveLength(1);
    expect(comboboxes[0]?.id).toBe("root_orderType");
    // And the old dropdown labels are gone.
    const labels = [...document.querySelectorAll("label")].map((l) => l.textContent);
    expect(labels).not.toContain("Environment");
    expect(labels).not.toContain("Scenario");
  });

  test("a scenarioPrefill fills the form, reflects the name in the header, and posts valuesChanged", () => {
    // Drive through a text-field page (Baker Notes → contactEmail) so we can READ the
    // prefilled value out of a rendered input (the enum dropdown isn't inspectable).
    const cf = exampleFormPages("conditional-forms");
    const app = mount();
    app.send(templateMsg([cf[2] as FormPage]));
    app.send({
      type: "scenarios",
      scenarios: [{ name: "a saved order", hasStepMocks: false, parameters: {} }],
    });
    app.send({
      type: "scenarioPrefill",
      name: "a saved order",
      values: { contactEmail: "prefilled@bakery.example" },
    });

    // The contactEmail input now shows the prefilled value.
    const email = [...document.querySelectorAll("input")].find((i) => i.id.includes("contactEmail"));
    expect((email as HTMLInputElement).value).toBe("prefilled@bakery.example");
    // The header reflects the selected scenario name.
    const scenarioButton = document.querySelector('[data-testid="pick-scenario"]') as HTMLButtonElement;
    expect(scenarioButton.textContent).toBe("a saved order");
    // …and the merged values were posted so the extension can run the trace.
    const changed = postsOfType(app.posts, "valuesChanged");
    expect(changed.at(-1)?.values).toMatchObject({ contactEmail: "prefilled@bakery.example" });
  });

  test("the Save as scenario button posts saveScenario with the current values", async () => {
    const cf = exampleFormPages("conditional-forms");
    const app = mount();
    app.send(templateMsg([cf[2] as FormPage]));

    // Type a value so the current values are non-empty.
    const user = userEvent.setup({ document });
    const email = [...document.querySelectorAll("input")].find((i) => i.id.includes("contactEmail"));
    await user.click(email as HTMLInputElement);
    await user.keyboard("save@bakery.example");

    await user.click(button("Save as scenario"));

    const saves = postsOfType(app.posts, "saveScenario");
    expect(saves).toHaveLength(1);
    expect(saves[0]?.values).toMatchObject({ contactEmail: "save@bakery.example" });
  });

  test("the Review step's 'Dry-run in Backstage' button posts dryRunSubmit with the current values", async () => {
    // Drive to the Review step (a single text-field page, then Review) with a value typed,
    // then click the dry-run button — it posts the current values for the extension to
    // compile + POST to Backstage.
    const cf = exampleFormPages("conditional-forms");
    const app = mount();
    app.send(templateMsg([cf[2] as FormPage]));

    const user = userEvent.setup({ document });
    const email = [...document.querySelectorAll("input")].find((i) => i.id.includes("contactEmail"));
    await user.click(email as HTMLInputElement);
    await user.keyboard("baker@cake.test");

    // Next on the single page → the Review step, where the dry-run button lives.
    await user.click(button("Review"));
    const dryRunBtn = document.querySelector('[data-testid="dry-run-submit"]') as HTMLButtonElement;
    expect(dryRunBtn).toBeTruthy();
    await user.click(dryRunBtn);

    const submits = postsOfType(app.posts, "dryRunSubmit");
    expect(submits).toHaveLength(1);
    expect(submits[0]?.values).toMatchObject({ contactEmail: "baker@cake.test" });
  });
});

// --- The Dry-run button gated on configuration (item #5) ---------------------
//
// The Review step's "Dry-run in Backstage" button is DISABLED with a visible hint until the
// extension posts `dryRunCapability { configured: true }` (the `tdk.backstage.baseUrl`
// setting is present). A later capability message LIVE re-enables it — no reload.

describe("App — the Dry-run button gated on configuration (layer 1)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  /** Drive to the Review step of a single-page template (filling its required field), returning the app handle. */
  async function toReview() {
    const cf = exampleFormPages("conditional-forms");
    const app = mount();
    app.send(templateMsg([cf[2] as FormPage]));
    const user = userEvent.setup({ document });
    // Fill the page's required contact field so Next/Review advances (mirrors the submit test).
    const email = [...document.querySelectorAll("input")].find((i) => i.id.includes("contactEmail"));
    await user.click(email as HTMLInputElement);
    await user.keyboard("baker@cake.test");
    await user.click(button("Review"));
    return app;
  }

  test("with capability `configured: false`, the button is DISABLED and the hint shows both commands", async () => {
    const app = await toReview();
    app.send({ type: "dryRunCapability", configured: false });
    const btn = document.querySelector('[data-testid="dry-run-submit"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    const hint = document.querySelector('[data-testid="dry-run-hint"]');
    expect(hint?.textContent).toContain("Backstage base URL");
    expect(hint?.textContent).toContain("Set Backstage Base URL");
    expect(hint?.textContent).toContain("Set Backstage Token");
  });

  test("a clicked-through disabled button never posts a dryRunSubmit", async () => {
    const app = await toReview();
    app.send({ type: "dryRunCapability", configured: false });
    const btn = document.querySelector('[data-testid="dry-run-submit"]') as HTMLButtonElement;
    const user = userEvent.setup({ document });
    await user.click(btn);
    expect(postsOfType(app.posts, "dryRunSubmit")).toHaveLength(0);
  });

  test("a later `configured: true` capability LIVE re-enables the button — no reload (item #5)", async () => {
    const app = await toReview();
    app.send({ type: "dryRunCapability", configured: false });
    expect((document.querySelector('[data-testid="dry-run-submit"]') as HTMLButtonElement).disabled).toBe(true);
    // The user sets the base URL; the extension re-posts the capability.
    app.send({ type: "dryRunCapability", configured: true });
    const btn = document.querySelector('[data-testid="dry-run-submit"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(document.querySelector('[data-testid="dry-run-hint"]')).toBeNull();
    // …and it now posts a dryRunSubmit when clicked.
    const user = userEvent.setup({ document });
    await user.click(btn);
    expect(postsOfType(app.posts, "dryRunSubmit")).toHaveLength(1);
  });

  test("with NO capability message (older host), the button stays enabled (back-compat)", async () => {
    await toReview();
    const btn = document.querySelector('[data-testid="dry-run-submit"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(document.querySelector('[data-testid="dry-run-hint"]')).toBeNull();
  });
});

// --- Plain-YAML sources: the TDK-only affordances hide, the form still works ---
//
// A `template` message with `source: "yaml"` previews a plain YAML Scaffolder template:
// the artifact is fixed (no env), and scenarios / save-as-scenario / the local trace are
// TDK-only. The app hides those controls and shows a one-line note so the difference is
// legible; the FORM itself (pages, validation, values, dry-run) behaves identically.

describe("App — a plain-YAML source hides the TDK-only controls (layer 1)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  /** A `template` message flagged as coming from a plain YAML source. */
  function yamlTemplateMsg(pages: FormPage[]): ExtensionToWebview {
    return { type: "template", templateId: "t.yaml", title: "Cake Order", env: "test", source: "yaml", pages };
  }

  test("a source:yaml template hides env/scenario/save and shows the one-line note", () => {
    const app = mount();
    app.send(yamlTemplateMsg(exampleFormPages("conditional-forms")));

    // The env + scenario header affordances are gone (they open TDK-only pickers)…
    expect(document.querySelector('[data-testid="pick-env"]')).toBeNull();
    expect(document.querySelector('[data-testid="pick-scenario"]')).toBeNull();
    // …as is Save as scenario (it writes __fixtures__/scenarios.ts). Reset stays.
    const labels = [...document.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).not.toContain("Save as scenario");
    expect(labels).toContain("Reset");
    // The quiet note names WHY: these are template.ts features.
    const note = document.querySelector('[data-testid="yaml-note"]');
    expect(note).toBeTruthy();
    expect(note?.textContent).toContain("template.ts");
  });

  test("the form still renders its pages and VALIDATES for a yaml source", async () => {
    const app = mount();
    app.send(yamlTemplateMsg(exampleFormPages("conditional-forms")));

    // Page 1 renders as usual (the stepper + the required enum field).
    expect(document.getElementById("root_orderType")).toBeTruthy();
    expect(document.body.textContent).toContain("Cake Order");

    // Next on the empty required page refuses to advance and shows the humanized error
    // — validation is source-independent.
    const user = userEvent.setup({ document });
    await user.click(button("Next"));
    expect(document.body.textContent).toMatch(/is required/i);
    expect(document.getElementById("root_packaging")).toBeNull();
  });

  test("the Review step keeps the dry-run button for a yaml source (dry-run works fully)", async () => {
    const cf = exampleFormPages("conditional-forms");
    const app = mount();
    app.send(yamlTemplateMsg([cf[2] as FormPage]));

    const user = userEvent.setup({ document });
    const email = [...document.querySelectorAll("input")].find((i) => i.id.includes("contactEmail"));
    await user.click(email as HTMLInputElement);
    await user.keyboard("baker@cake.test");
    await user.click(button("Review"));

    const dryRunBtn = document.querySelector('[data-testid="dry-run-submit"]') as HTMLButtonElement;
    expect(dryRunBtn).toBeTruthy();
    await user.click(dryRunBtn);
    expect(postsOfType(app.posts, "dryRunSubmit").at(-1)?.values).toMatchObject({ contactEmail: "baker@cake.test" });
  });

  test("a template message WITHOUT a source (older extension) keeps the TDK controls", () => {
    // Back-compat: `source` is optional — absent means `tdk`, so nothing hides.
    const app = mount();
    app.send(templateMsg(exampleFormPages("conditional-forms")));

    expect(document.querySelector('[data-testid="pick-env"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="pick-scenario"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="yaml-note"]')).toBeNull();
    const labels = [...document.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toContain("Save as scenario");
  });

  test("switching back from a yaml source to a tdk one restores the controls", () => {
    // The panel is per-file so this doesn't happen in production, but the state
    // transition must be clean: `source` follows the latest template message.
    const app = mount();
    app.send(yamlTemplateMsg(exampleFormPages("conditional-forms")));
    expect(document.querySelector('[data-testid="pick-env"]')).toBeNull();

    app.send(templateMsg(exampleFormPages("conditional-forms")));
    expect(document.querySelector('[data-testid="pick-env"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="yaml-note"]')).toBeNull();
  });
});
