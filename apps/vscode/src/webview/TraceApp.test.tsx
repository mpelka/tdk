// LAYER 1 — TraceApp component tests (React Testing Library + happy-dom).
//
// The reworked debugger-style trace view retains TWO SLOTS switched by a header segmented
// control: LOCAL simulate and Backstage dry-run. These tests drive it through the extension
// → view protocol, asserting:
//   - the `ready` handshake on mount;
//   - the local trace: rail glyphs (ran ✓ / skipped ⤼ / error ✗ / not reached ○), the
//     notReached one-line body, auto-select of the first errored step, provenance rows, the
//     collapsible block affordance;
//   - the SLOT SWITCHER: a completed dry-run auto-switches to the dry-run tab; both slots
//     persist so the user can flip back; empty slots show friendly empty states;
//   - the GATING placeholder (no prior valid trace) and the banner-over-stale variant;
//   - the YAML-source Local-tab note;
//   - the dry-run rendering: endpoint header, normalized steps + per-step log, files, and
//     the failure states (validationFailed / authFailed / error).
//
// The switcher is a segmented control of plain buttons (Fluent's <TabList>/<Tab> crash
// under happy-dom), so it is clickable here; the provenance + normalized steps are built
// EXTENSION-side and arrive on the message, so the view is handed realistic payloads.

import "../test/dom.ts";

import { beforeEach, describe, expect, test } from "bun:test";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import type { ProvenanceNode } from "../lib/traceProvenance.ts";
import type {
  DryRunHistoryView,
  DryRunTraceMessage,
  ExtensionToTraceView,
  TraceStep,
  TraceViewToExtension,
} from "./protocol.ts";
import { TraceApp } from "./TraceApp.tsx";

/** Mount <TraceApp> with a captured `subscribe` handler and a recording `post`. */
function mount() {
  let handler: ((msg: ExtensionToTraceView) => void) | undefined;
  const posts: TraceViewToExtension[] = [];
  render(
    <FluentProvider theme={webLightTheme}>
      <TraceApp
        subscribe={(h) => {
          handler = h;
        }}
        post={(m) => posts.push(m)}
      />
    </FluentProvider>,
  );
  return {
    posts,
    send(msg: ExtensionToTraceView) {
      React.act(() => handler?.(msg));
    },
  };
}

const q = (testid: string) => document.querySelector(`[data-testid="${testid}"]`);

/** A templated-leaf provenance node (`expression → value`). */
function templatedLeaf(key: string, expression: string, value: unknown): ProvenanceNode {
  return { key, kind: "leaf", expression, value, templated: true };
}

/** A literal-leaf provenance node (value only, no arrow). */
function literalLeaf(key: string, value: unknown): ProvenanceNode {
  return { key, kind: "leaf", value };
}

/** An EXPRESSION-ONLY leaf: a source expression that never resolved (a skipped/never-ran step). */
function expressionOnlyLeaf(key: string, expression: string): ProvenanceNode {
  return { key, kind: "leaf", expression };
}

/** A minimal enriched step. */
function step(over: Partial<TraceStep> & Pick<TraceStep, "id" | "status">): TraceStep {
  return { input: {}, output: {}, provenance: [], context: { parameters: {} }, ...over };
}

/** An `ok` dry-run result (normalized steps + per-step log + one emitted file). */
function okDryRun(over: Partial<DryRunTraceMessage> = {}): DryRunTraceMessage {
  return {
    type: "dryRunResult",
    title: "Cake Order",
    kind: "ok",
    endpoint: { baseUrl: "http://localhost:7007", status: "200", durationMs: 42 },
    preamble: [{ message: "Starting up task with 2 steps" }],
    steps: [
      step({
        id: "build-ticket",
        status: "ran",
        output: undefined,
        provenance: [templatedLeaf("customerName", "${{ parameters.customerName }}", "Alice Baker")],
        log: [{ status: "completed", message: "Finished step build-ticket" }],
      }),
      step({
        id: "log-ticket",
        status: "ran",
        output: undefined,
        provenance: [literalLeaf("message", "Ticket: Order for Alice Baker")],
        log: [{ message: "info: Ticket: Order for Alice Baker" }],
      }),
    ],
    output: { customer: "Alice Baker" },
    files: [{ path: "ticket.txt", executable: false, content: "flour and sugar" }],
    ...over,
  };
}

describe("TraceApp — handshake + empty state", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("posts `ready` on mount (the handshake)", () => {
    const app = mount();
    expect(app.posts).toContainEqual({ type: "ready" });
  });

  test("with nothing posted, shows the first-open empty state", () => {
    mount();
    expect(q("trace-empty")).toBeTruthy();
  });
});

describe("TraceApp — the local simulate slot", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("a trace renders one rail row per step with the right status glyph, incl. not reached ○", () => {
    const app = mount();
    app.send({
      type: "trace",
      ok: true,
      title: "Cake Wizard",
      steps: [
        step({ id: "log-order", status: "ran" }),
        step({ id: "guard", status: "skipped" }),
        step({ id: "provision", status: "error", error: "who required" }),
        step({ id: "after", status: "notReached" }),
      ],
      output: {},
    });

    expect(q("trace-rail-log-order")?.textContent).toContain("✓");
    expect(q("trace-rail-guard")?.textContent).toContain("⤼");
    expect(q("trace-rail-provision")?.textContent).toContain("✗");
    expect(q("trace-rail-after")?.textContent).toContain("○");
    expect(document.body.textContent).toContain("Cake Wizard");
  });

  test("a notReached step shows the one-line 'never ran' body, no input/output sections", async () => {
    const app = mount();
    app.send({
      type: "trace",
      ok: true,
      steps: [step({ id: "boom", status: "error", error: "kaboom" }), step({ id: "after", status: "notReached" })],
      output: {},
    });
    const user = userEvent.setup({ document });
    await user.click(q("trace-rail-after") as HTMLElement);
    expect(q("trace-not-reached")?.textContent).toContain("never ran");
    expect(q("trace-not-reached")?.textContent).toContain("halted at the first failed step");
    expect(q("trace-inputs")).toBeNull();
    expect(q("trace-output")).toBeNull();
  });

  test("auto-selects the first ERRORED step (not the first) on a new trace", () => {
    const app = mount();
    app.send({
      type: "trace",
      ok: true,
      steps: [
        step({ id: "first", status: "ran", output: { ok: 1 } }),
        step({ id: "boom", status: "error", error: "kaboom" }),
        step({ id: "third", status: "ran" }),
      ],
      output: {},
    });
    expect(q("trace-rail-boom")?.getAttribute("aria-selected")).toBe("true");
    expect(q("trace-step-error")?.textContent).toContain("kaboom");
  });

  test("clicking a rail row switches the detail to that step", async () => {
    const app = mount();
    app.send({
      type: "trace",
      ok: true,
      steps: [
        step({ id: "a", status: "ran", provenance: [literalLeaf("first", "A-value")] }),
        step({ id: "b", status: "ran", provenance: [literalLeaf("second", "B-value")] }),
      ],
      output: {},
    });
    expect(document.body.textContent).toContain("A-value");
    const user = userEvent.setup({ document });
    await user.click(q("trace-rail-b") as HTMLElement);
    expect(q("trace-rail-b")?.getAttribute("aria-selected")).toBe("true");
    expect(document.body.textContent).toContain("B-value");
  });

  test("provenance: a templated leaf shows `expression → value`, a literal shows only the value", () => {
    const app = mount();
    app.send({
      type: "trace",
      ok: true,
      steps: [
        step({
          id: "log-order",
          status: "ran",
          provenance: [
            templatedLeaf("message", "Order type: ${{ parameters.orderType }}", "Order type: standard"),
            literalLeaf("channel", "web"),
          ],
        }),
      ],
      output: {},
    });
    expect(q("prov-expr-message")?.textContent).toContain("${{ parameters.orderType }}");
    expect(q("prov-message")?.textContent).toContain("Order type: standard");
    expect(q("prov-expr-channel")).toBeNull();
    expect(q("prov-literal-channel")?.textContent).toContain("web");
  });

  test("provenance: an EXPRESSION-ONLY leaf (no resolved value) shows its expression, NEVER `undefined` (item #2)", () => {
    // The never-guess contract: a leaf with a source expression but no recovered value must
    // render the expression alone — the old code dropped the expression and printed
    // `key: undefined` (the maintainer's `summary : undefined` bug).
    const app = mount();
    app.send({
      type: "trace",
      ok: true,
      steps: [
        step({ id: "skipped", status: "skipped", provenance: [expressionOnlyLeaf("message", "${{ parameters.x }}")] }),
      ],
      output: {},
    });
    const row = q("prov-message");
    expect(row?.textContent).toContain("${{ parameters.x }}");
    expect(row?.textContent).not.toContain("undefined");
    // It renders through the expression slot, not the literal (value) slot.
    expect(q("prov-expr-message")).toBeTruthy();
    expect(q("prov-literal-message")).toBeNull();
  });

  test("a skipped step shows the ⤼ glyph AND a skipped note in the detail body (item #1)", () => {
    const app = mount();
    app.send({
      type: "trace",
      ok: true,
      steps: [
        step({ id: "gate", status: "skipped", provenance: [expressionOnlyLeaf("message", "${{ parameters.x }}")] }),
      ],
      output: {},
    });
    expect(q("trace-rail-gate")?.textContent).toContain("⤼");
    expect(q("trace-skipped")?.textContent).toContain("skipped");
    expect(q("trace-skipped")?.textContent).toContain("if:");
    // The Inputs section still renders (expression-only), unlike a notReached step.
    expect(q("trace-inputs")).toBeTruthy();
  });

  test("a multi-line string value collapses by default, then expands to a VERBATIM code block", async () => {
    const app = mount();
    const expression = ["{", '  "summary": customerName,', "}"].join("\n");
    app.send({
      type: "trace",
      ok: true,
      steps: [step({ id: "build-ticket", status: "ran", provenance: [literalLeaf("expression", expression)] })],
      output: {},
    });
    const row = q("prov-expression");
    expect(row?.tagName).toBe("DETAILS");
    expect(row?.textContent).toContain("(3 lines)");
    expect(q("prov-block-expression")).toBeNull();
    const user = userEvent.setup({ document });
    await user.click(row?.querySelector("summary") as HTMLElement);
    const block = q("prov-block-expression");
    expect(block?.textContent).toBe(expression);
    expect(block?.tagName).toBe("PRE");
  });

  test("a template-level failure (ok:false) renders a single error line, no rail", () => {
    const app = mount();
    app.send({ type: "trace", ok: false, title: "Cake Wizard", error: "compile failed: boom" });
    expect(q("trace-template-error")?.textContent).toContain("compile failed: boom");
    expect(q("trace-rail")).toBeNull();
  });
});

describe("TraceApp — validity gating (the local slot)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("a traceGated with NO stale trace shows the quiet placeholder listing missing fields", () => {
    const app = mount();
    app.send({ type: "traceGated", title: "Cake Wizard", missing: ["Customer name", "Priority"] });
    expect(q("gated-placeholder")?.textContent).toContain("Form incomplete");
    expect(q("gated-placeholder")?.textContent).toContain("Customer name, Priority");
    expect(q("trace-rail")).toBeNull();
  });

  test("a traceGated WITH a stale trace keeps showing it under a slim banner", () => {
    const app = mount();
    app.send({
      type: "traceGated",
      title: "Cake Wizard",
      missing: ["Priority"],
      stale: { steps: [step({ id: "a", status: "ran", provenance: [literalLeaf("channel", "web")] })], output: {} },
    });
    expect(q("gated-banner")?.textContent).toContain("Form incomplete");
    expect(q("gated-banner")?.textContent).toContain("Showing the last valid simulate");
    expect(q("trace-rail-a")).toBeTruthy();
    expect(document.body.textContent).toContain("web");
  });

  test("REPLAY into a fresh view: a gated message is self-contained — the stale trace still renders", () => {
    // The focus-switch/view-recreate failure mode: the receiving view has NO prior local
    // state (fresh mount), yet the replayed gated message must still render the banner
    // OVER the last valid trace — not collapse to the bare placeholder.
    const app = mount();
    app.send({
      type: "traceGated",
      title: "Cake Wizard",
      missing: ["Priority"],
      stale: { steps: [step({ id: "mine-step", status: "ran" })], output: {} },
    });
    expect(q("gated-banner")).toBeTruthy();
    expect(q("trace-rail-mine-step")).toBeTruthy();
    expect(q("gated-placeholder")).toBeNull();
  });

  test("REPLAY across previews: a gated message never leaks ANOTHER preview's trace under its banner", () => {
    // The cross-preview failure mode: the view currently shows preview A's ok trace;
    // switching focus replays preview B's gated message. B's OWN stale trace must render
    // under the banner — never A's steps.
    const app = mount();
    // Preview A's trace is on display.
    app.send({
      type: "trace",
      ok: true,
      title: "Other Wizard",
      steps: [step({ id: "other-step", status: "ran" })],
      output: {},
    });
    expect(q("trace-rail-other-step")).toBeTruthy();
    // Focus switches to preview B — its retained gated state replays, self-contained.
    app.send({
      type: "traceGated",
      title: "Cake Wizard",
      missing: ["Priority"],
      stale: { steps: [step({ id: "mine-step", status: "ran" })], output: {} },
    });
    expect(q("gated-banner")).toBeTruthy();
    expect(q("trace-rail-mine-step")).toBeTruthy();
    expect(q("trace-rail-other-step")).toBeNull();
  });

  test("a replayed gated message WITHOUT a stale trace shows the placeholder even after another trace showed", () => {
    // The inverse cross-preview case: preview B never had a valid run, so its gated
    // message carries no stale payload — the view must show the bare placeholder, not
    // keep rendering preview A's trace under B's banner.
    const app = mount();
    app.send({
      type: "trace",
      ok: true,
      title: "Other Wizard",
      steps: [step({ id: "other-step", status: "ran" })],
      output: {},
    });
    app.send({ type: "traceGated", title: "Cake Wizard", missing: ["Priority"] });
    expect(q("gated-placeholder")).toBeTruthy();
    expect(q("gated-banner")).toBeNull();
    expect(q("trace-rail-other-step")).toBeNull();
  });

  test("validating again (a fresh trace) resumes the live trace, clearing the banner", () => {
    const app = mount();
    app.send({
      type: "traceGated",
      missing: ["Priority"],
      stale: { steps: [step({ id: "a", status: "ran" })], output: {} },
    });
    expect(q("gated-banner")).toBeTruthy();
    app.send({ type: "trace", ok: true, steps: [step({ id: "b", status: "ran" })], output: {} });
    expect(q("gated-banner")).toBeNull();
    expect(q("trace-rail-b")).toBeTruthy();
  });

  test("a YAML source shows the explanatory Local-tab note", () => {
    const app = mount();
    app.send({ type: "traceLocalUnavailable", title: "Cake Order (YAML)" });
    expect(q("local-yaml-note")?.textContent).toContain("template.ts sources");
  });
});

describe("TraceApp — the slot switcher + dry-run slot", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("a completed dry-run auto-switches the panel to the dry-run slot", () => {
    const app = mount();
    app.send({ type: "trace", ok: true, steps: [step({ id: "a", status: "ran" })], output: {} });
    expect(q("tab-local")?.getAttribute("aria-selected")).toBe("true");
    app.send(okDryRun());
    expect(q("tab-dryRun")?.getAttribute("aria-selected")).toBe("true");
    expect(q("dryrun-view")).toBeTruthy();
  });

  test("both slots persist — flipping back to Local shows the retained local trace, and forward again the dry-run", async () => {
    const app = mount();
    app.send({ type: "trace", ok: true, steps: [step({ id: "local-step", status: "ran" })], output: {} });
    app.send(okDryRun());
    expect(q("tab-dryRun")?.getAttribute("aria-selected")).toBe("true");
    const user = userEvent.setup({ document });
    await user.click(q("tab-local") as HTMLElement);
    expect(q("tab-local")?.getAttribute("aria-selected")).toBe("true");
    expect(q("trace-rail-local-step")).toBeTruthy();
    await user.click(q("tab-dryRun") as HTMLElement);
    expect(q("dryrun-view")).toBeTruthy();
    expect(q("trace-rail-build-ticket")).toBeTruthy();
  });

  test("an empty dry-run slot shows the friendly empty state (tab still usable)", async () => {
    const app = mount();
    app.send({ type: "trace", ok: true, steps: [step({ id: "a", status: "ran" })], output: {} });
    const user = userEvent.setup({ document });
    await user.click(q("tab-dryRun") as HTMLElement);
    expect(q("dryrun-empty")?.textContent).toContain("No dry-run yet");
  });

  test("a dryRunPending auto-switches and shows the pending placeholder + endpoint", () => {
    const app = mount();
    app.send({ type: "dryRunPending", title: "Cake Order", baseUrl: "http://localhost:7007" });
    expect(q("tab-dryRun")?.getAttribute("aria-selected")).toBe("true");
    expect(q("dryrun-pending")?.textContent).toContain("Running dry-run in Backstage");
    expect(q("dryrun-endpoint")?.textContent).toContain("http://localhost:7007");
  });

  test("the switcher wires the ARIA tabs pattern: tabpanel linkage + roving focus + arrow keys", async () => {
    const app = mount();
    app.send({ type: "trace", ok: true, steps: [step({ id: "a", status: "ran" })], output: {} });
    // The panel region names its active tab, and each tab names the panel.
    const panel = q("trace-tabpanel");
    expect(panel?.getAttribute("role")).toBe("tabpanel");
    expect(panel?.getAttribute("aria-labelledby")).toBe("trace-tab-local");
    expect(q("tab-local")?.getAttribute("aria-controls")).toBe("trace-tabpanel");
    expect(q("tab-dryRun")?.getAttribute("aria-controls")).toBe("trace-tabpanel");
    // Roving focus: only the ACTIVE tab is tabbable.
    expect((q("tab-local") as HTMLButtonElement).tabIndex).toBe(0);
    expect((q("tab-dryRun") as HTMLButtonElement).tabIndex).toBe(-1);
    // An arrow key moves selection AND focus to the other tab.
    (q("tab-local") as HTMLButtonElement).focus();
    const user = userEvent.setup({ document });
    await user.keyboard("{ArrowRight}");
    expect(q("tab-dryRun")?.getAttribute("aria-selected")).toBe("true");
    expect(panel?.getAttribute("aria-labelledby")).toBe("trace-tab-dryRun");
    expect((q("tab-dryRun") as HTMLButtonElement).tabIndex).toBe(0);
    expect(document.activeElement).toBe(q("tab-dryRun"));
  });
});

describe("TraceApp — the dry-run rendering (normalized, subsumes the old DryRunView)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("renders the endpoint header line: baseUrl · status · duration", () => {
    const app = mount();
    app.send(okDryRun());
    const endpoint = q("dryrun-endpoint");
    expect(endpoint?.textContent).toContain("http://localhost:7007");
    expect(endpoint?.textContent).toContain("200");
    expect(endpoint?.textContent).toContain("42ms");
    expect(endpoint?.textContent).toContain("Backstage dry-run");
  });

  test("renders the normalized step rail with provenance, and the per-step log", () => {
    const app = mount();
    app.send(okDryRun());
    expect(q("trace-rail-build-ticket")).toBeTruthy();
    expect(q("trace-rail-log-ticket")).toBeTruthy();
    expect(q("prov-expr-customerName")?.textContent).toContain("${{ parameters.customerName }}");
    expect(q("dryrun-log-build-ticket")?.textContent).toContain("Finished step build-ticket");
  });

  test("the preamble + run output + emitted files render", () => {
    const app = mount();
    app.send(okDryRun());
    expect(q("dryrun-preamble")?.textContent).toContain("Starting up task with 2 steps");
    expect(document.body.textContent).toContain("Alice Baker");
    expect(q("dryrun-file-ticket.txt")).toBeTruthy();
  });

  test("an emitted file is clickable and posts openDryRunFile with the path + content", async () => {
    const app = mount();
    app.send(okDryRun());
    const link = q("dryrun-file-ticket.txt")?.querySelector("button") as HTMLButtonElement;
    const user = userEvent.setup({ document });
    await user.click(link);
    const opens = app.posts.filter((p) => p.type === "openDryRunFile");
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({ path: "ticket.txt", content: "flour and sugar" });
  });

  test("a failed dry-run step auto-selects and shows ✗ + its error", () => {
    const app = mount();
    app.send(
      okDryRun({
        steps: [
          step({ id: "ok-step", status: "ran", output: undefined }),
          step({ id: "boom", status: "error", error: "who required", output: undefined }),
        ],
      }),
    );
    expect(q("trace-rail-boom")?.getAttribute("aria-selected")).toBe("true");
    expect(q("trace-rail-boom")?.textContent).toContain("✗");
    expect(q("trace-step-error")?.textContent).toContain("who required");
  });

  test("a validationFailed result renders each error readably (where — message)", () => {
    const app = mount();
    app.send({
      type: "dryRunResult",
      title: "Cake Order",
      kind: "validationFailed",
      endpoint: { baseUrl: "http://localhost:7007", status: "400", durationMs: 8 },
      errors: [{ where: "customerName", message: 'requires property "customerName"' }],
    });
    expect(q("dryrun-validation")).toBeTruthy();
    expect(q("dryrun-error-customerName")?.textContent).toContain("customerName");
    expect(q("dryrun-endpoint")?.textContent).toContain("400");
    expect(q("trace-rail")).toBeNull();
  });

  test("an authFailed result renders the message pointing at the set-token command", () => {
    const app = mount();
    app.send({
      type: "dryRunResult",
      title: "Cake Order",
      kind: "authFailed",
      endpoint: { baseUrl: "http://localhost:7007", status: "401", durationMs: 3 },
      message: "Backstage rejected the token (401 Unauthorized). Set or refresh it with TDK: Set Backstage Token.",
    });
    expect(q("dryrun-auth-error")?.textContent).toContain("401");
    expect(q("dryrun-auth-error")?.textContent).toContain("Set Backstage Token");
  });

  test("an error result (unreachable) renders the single message line + the taxonomy label", () => {
    const app = mount();
    app.send({
      type: "dryRunResult",
      title: "Cake Order",
      kind: "error",
      endpoint: { baseUrl: "http://localhost:7007", status: "unreachable", durationMs: 100 },
      message: "Could not reach Backstage at http://localhost:7007.",
    });
    expect(q("dryrun-error")?.textContent).toContain("Could not reach Backstage");
    expect(q("dryrun-endpoint")?.textContent).toContain("unreachable");
  });
});

describe("TraceApp — the dry-run RUN HISTORY indicator + navigation (item #4)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  /** A dry-run message carrying a history view at `index` of `total`. */
  function withHistory(index: number, total: number, label: DryRunHistoryView["label"] = "ok"): DryRunTraceMessage {
    return okDryRun({ history: { index, total, timestamp: Date.UTC(2026, 6, 5, 22, 13, 56), label } });
  }

  test("renders `Run N of M · <time>` when the message carries a history view", () => {
    const app = mount();
    app.send(withHistory(3, 4));
    const label = q("dryrun-run-label");
    expect(label?.textContent).toContain("Run 4 of 4");
    // The time is a wall-clock HH:MM:SS (local — assert the minutes:seconds are shown).
    expect(label?.textContent).toMatch(/\d\d:13:56/);
  });

  test("a message with NO history view shows no indicator (direct/test callers)", () => {
    const app = mount();
    app.send(okDryRun());
    expect(q("dryrun-run-indicator")).toBeNull();
  });

  test("‹ is disabled at the oldest run, › is disabled at the newest", () => {
    const app = mount();
    // Newest of 4 selected → › disabled, ‹ enabled.
    app.send(withHistory(3, 4));
    expect((q("dryrun-run-next") as HTMLButtonElement).disabled).toBe(true);
    expect((q("dryrun-run-prev") as HTMLButtonElement).disabled).toBe(false);
    // Oldest selected → ‹ disabled, › enabled.
    app.send(withHistory(0, 4));
    expect((q("dryrun-run-prev") as HTMLButtonElement).disabled).toBe(true);
    expect((q("dryrun-run-next") as HTMLButtonElement).disabled).toBe(false);
  });

  test("clicking ‹ / › posts a dryRunNavigate to the extension (the extension owns the replay)", async () => {
    const app = mount();
    app.send(withHistory(2, 4));
    const user = userEvent.setup({ document });
    await user.click(q("dryrun-run-prev") as HTMLElement);
    await user.click(q("dryrun-run-next") as HTMLElement);
    const navs = app.posts.filter((p) => p.type === "dryRunNavigate");
    expect(navs).toEqual([
      { type: "dryRunNavigate", direction: "prev" },
      { type: "dryRunNavigate", direction: "next" },
    ]);
  });

  test("a FAILED run in history is labeled by its taxonomy in the indicator", () => {
    const app = mount();
    app.send({
      type: "dryRunResult",
      title: "Cake Order",
      kind: "validationFailed",
      endpoint: { baseUrl: "http://localhost:7007", status: "400", durationMs: 5 },
      errors: [{ where: "flavor", message: 'requires property "flavor"' }],
      history: { index: 1, total: 2, timestamp: Date.UTC(2026, 6, 5, 22, 13, 56), label: "validationFailed" },
    });
    expect(q("dryrun-run-label")?.textContent).toContain("Run 2 of 2");
    expect(q("dryrun-run-label")?.textContent).toContain("validation failed");
  });

  test("navigating replays a run into the SAME dry-run slot; it survives a tab flip to Local and back", async () => {
    // The extension replays the navigated run by posting a fresh dryRunResult (item #4): the
    // view shows it, and — since both slots persist — flipping to Local and back keeps it.
    const app = mount();
    app.send({ type: "trace", ok: true, steps: [step({ id: "local-step", status: "ran" })], output: {} });
    app.send(withHistory(1, 2)); // newest of 2
    // The extension's replay of the OLDER run (index 0) lands as a new dryRunResult.
    app.send(withHistory(0, 2));
    expect(q("dryrun-run-label")?.textContent).toContain("Run 1 of 2");
    const user = userEvent.setup({ document });
    await user.click(q("tab-local") as HTMLElement);
    expect(q("trace-rail-local-step")).toBeTruthy();
    await user.click(q("tab-dryRun") as HTMLElement);
    // The navigated run is still the one shown (retention across the tab flip).
    expect(q("dryrun-run-label")?.textContent).toContain("Run 1 of 2");
  });

  test("a dryRunHistoryUpdate refreshes the count WITHOUT switching tabs or replacing the shown run", async () => {
    // The lost-run fix's display half: a STALE run's append grows the total under the shown
    // run. The extension posts a lightweight dryRunHistoryUpdate — the indicator refreshes,
    // but the run on display stays put and the user is never yanked off the Local tab.
    const app = mount();
    app.send({ type: "trace", ok: true, steps: [step({ id: "local-step", status: "ran" })], output: {} });
    app.send(withHistory(0, 2)); // shown: Run 1 of 2 (auto-switched to the dry-run tab)
    const user = userEvent.setup({ document });
    await user.click(q("tab-local") as HTMLElement); // the user flips to Local
    app.send({
      type: "dryRunHistoryUpdate",
      history: { index: 0, total: 3, timestamp: Date.UTC(2026, 6, 5, 22, 13, 56), label: "ok" },
    });
    // STILL on Local — the refresh never yanks the tab (a full dryRunResult would).
    expect(q("tab-local")?.getAttribute("aria-selected")).toBe("true");
    await user.click(q("tab-dryRun") as HTMLElement);
    // The SAME run is shown, with the truthful count.
    expect(q("dryrun-run-label")?.textContent).toContain("Run 1 of 3");
    expect(q("trace-rail-build-ticket")).toBeTruthy();
  });

  test("a dryRunHistoryUpdate with no shown result (empty/pending slot) is ignored", () => {
    const app = mount();
    app.send({ type: "dryRunPending", title: "Cake Order", baseUrl: "http://localhost:7007" });
    app.send({
      type: "dryRunHistoryUpdate",
      history: { index: 0, total: 1, timestamp: Date.UTC(2026, 6, 5, 22, 13, 56), label: "ok" },
    });
    // The pending placeholder stays — there is no indicator to refresh.
    expect(q("dryrun-pending")).toBeTruthy();
    expect(q("dryrun-run-indicator")).toBeNull();
  });
});

describe("TraceApp — clearing", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("a traceClear returns both slots to the empty state", () => {
    const app = mount();
    app.send({ type: "trace", ok: true, steps: [step({ id: "a", status: "ran" })], output: {} });
    app.send(okDryRun());
    expect(q("dryrun-view")).toBeTruthy();
    app.send({ type: "traceClear" });
    expect(q("trace-empty")).toBeTruthy();
    expect(q("trace-rail")).toBeNull();
    expect(q("dryrun-view")).toBeNull();
  });
});
