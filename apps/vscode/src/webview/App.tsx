// The form-preview React app — a STEPPER over the compiled template's pages.
//
// One RJSF `Form` (Fluent theme, ajv8 validator) per page; a single `values`
// object persists across pages, so moving back and forth keeps what you typed.
// The controls mirror Backstage's wizard:
//   - Previous / Next — Next VALIDATES the current page first (via the Form's
//     `validateForm()` ref method), refusing to advance while it has errors.
//   - Reset — instantly clears every value back to the schema defaults. A headline
//     feature: one click, no confirm, no recompile.
//   - a final REVIEW step showing the aggregated values as pretty JSON.
//
// A MINIMAL header shows the template title, the current env, and the current
// scenario as plain text. The env/scenario are picked through NATIVE QuickPicks (no
// Fluent dropdowns in the form): clicking either text posts a message that opens the
// same QuickPick the palette commands open — a discoverable in-panel affordance.
//
// The live execute() TRACE is no longer here — it streams to the separate "TDK
// Trace" panel view as the values change.
//
// ERROR POLISH: `showErrorList={false}` (the top "Errors" box duplicates the
// field-level errors — Backstage hides it too), `transformErrors` humanizes ajv's
// phrasing, and the validator supports schema-authored `errorMessage` via ajv-errors.
//
// A compile error arrives as a dismissable banner; the last good form stays
// rendered underneath, so a transient error never blanks the preview. An unknown
// `ui:field` renders through `CustomFieldFallback` (registered as the default field)
// rather than crashing the form.

import {
  Button,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  makeStyles,
  shorthands,
  Text,
  Title3,
  tokens,
} from "@fluentui/react-components";
import type { IChangeEvent } from "@rjsf/core";
// NAMED imports, deliberately. Under browser bundling these packages resolve to
// their CJS build, whose DEFAULT export interops to the whole module namespace
// object — `<Form>` from a default import throws React error #130, and a
// default-imported validator is a namespace whose `.isValid` is not a function,
// which kills EVERY form interaction the moment RJSF validates (option selects
// never commit, Next throws instead of validating). `default as x` is still a
// default import — only genuinely NAMED bindings are safe here.
import { Form } from "@rjsf/fluentui-rc";
import type { FieldProps, RegistryFieldsType } from "@rjsf/utils";
import * as React from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { formValidity } from "../lib/formValidity.ts";
import { FALLBACK_FIELD_NAME, remapCustomFields } from "../lib/remapCustomFields.ts";
import { transformErrors } from "../lib/transformErrors.ts";
import { CustomFieldFallback } from "./CustomFieldFallback.tsx";
import { formTemplates } from "./formTemplates.tsx";
import { validator } from "./formValidator.ts";
import type { FormPage, ScenarioSummary, TemplateSource } from "./protocol.ts";

const useStyles = makeStyles({
  // Spacing tightened ~30-50% from the earlier airy defaults (12px → 8px gaps/pad).
  root: { display: "flex", flexDirection: "column", ...shorthands.gap("8px"), ...shorthands.padding("8px", "10px") },
  // The minimal single-line header: title on the left, env · scenario on the right.
  header: {
    display: "flex",
    alignItems: "baseline",
    ...shorthands.gap("10px"),
    ...shorthands.padding("0", "0", "4px", "0"),
    ...shorthands.borderBottom("1px", "solid", tokens.colorNeutralStroke2),
  },
  headerMeta: { display: "flex", alignItems: "baseline", ...shorthands.gap("8px"), marginLeft: "auto" },
  metaLabel: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  // A clickable meta value — looks like a subtle link, opens the native QuickPick.
  metaButton: {
    cursor: "pointer",
    color: tokens.colorBrandForeground1,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    ...shorthands.textDecoration("none"),
    backgroundColor: "transparent",
    ...shorthands.border("none"),
    ...shorthands.padding("0"),
  },
  actions: { display: "flex", ...shorthands.gap("6px"), marginLeft: "auto" },
  steps: {
    display: "flex",
    flexWrap: "wrap",
    ...shorthands.gap("4px"),
    ...shorthands.padding("2px", "0"),
  },
  step: {
    ...shorthands.padding("2px", "8px"),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  stepActive: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
    fontWeight: tokens.fontWeightSemibold,
  },
  nav: { display: "flex", ...shorthands.gap("6px"), ...shorthands.padding("4px", "0") },
  review: {
    ...shorthands.padding("8px"),
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: "pre",
    overflowX: "auto",
  },
  empty: { color: tokens.colorNeutralForeground3 },
  // The quiet one-line note shown for a YAML source, where the TDK-only affordances
  // (env, scenarios, save, local trace) are hidden — so their absence reads as
  // intentional, not a bug.
  yamlNote: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    ...shorthands.padding("0", "0", "2px", "0"),
  },
  reviewActions: {
    display: "flex",
    alignItems: "center",
    ...shorthands.gap("10px"),
    ...shorthands.padding("8px", "0", "0", "0"),
  },
});

// Register the fallback under a known name; `remapCustomFields` rewrites every
// unknown `ui:field` in the uiSchema to point here (RJSF would otherwise ignore an
// unknown field name and render by type, hiding that a custom field was in play).
const FIELDS: RegistryFieldsType = {
  [FALLBACK_FIELD_NAME]: (props: FieldProps) => <CustomFieldFallback {...props} />,
};

export interface AppProps {
  /** The extension pushes fresh compiles / errors here; the app subscribes on mount. */
  subscribe: (handler: (msg: import("./protocol.ts").ExtensionToWebview) => void) => void;
  /** Post a message back to the extension (values changed, env/scenario pick requested). */
  post: (msg: import("./protocol.ts").WebviewToExtension) => void;
}

/** The stepper app. Owns the pages, the shared values object, and the step index. */
export function App({ subscribe, post }: AppProps): React.ReactElement {
  const styles = useStyles();
  const [title, setTitle] = useState("TDK form preview");
  const [env, setEnv] = useState("test");
  // Where the previewed template came from. `yaml` hides the TDK-only affordances
  // (env, scenarios, save, local trace); `tdk` shows them all. Defaults to `tdk`.
  const [source, setSource] = useState<TemplateSource>("tdk");
  const [pages, setPages] = useState<FormPage[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  // The discovered scenarios (for the header hint) and the selected scenario name.
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [selectedScenario, setSelectedScenario] = useState<string>("");
  // Whether Backstage dry-run is CONFIGURED (item #5): the base URL is set. Gates the
  // Review step's Dry-run button (disabled + hint until true). Default true so the button
  // is enabled until the extension says otherwise (older hosts never send the capability).
  const [dryRunConfigured, setDryRunConfigured] = useState(true);

  // The current page's Form, for programmatic validation on Next. Typed as the
  // STRUCTURAL slice we call rather than the RJSF `Form` class: the themed
  // wrapper forwards its ref to the core Form instance, but the class TYPE's
  // identity varies with the package-linker layout (a nested duplicate of
  // @rjsf/core makes the nominal class incompatible across environments — it
  // typechecked locally and failed on CI). Depending only on the method keeps
  // the type layout-independent.
  const formRef = useRef<{ validateForm(): boolean } | null>(null);

  // A ref to the latest `postValues` (defined below) so the ONCE-run subscribe effect can
  // call the current one — a scenario prefill posts values WITH validity too, and the
  // effect must not re-subscribe just to close over a fresh callback.
  const postValuesRef = useRef<(next: Record<string, unknown>) => void>(() => {});

  // Subscribe once to the extension's messages, then post `ready` — the handshake.
  // Ordering is the whole point: the listener is attached by the time `ready` reaches
  // the extension, so the extension's (re)play of the panel's buffered initial state
  // (template + scenarios + any prefill) cannot race the mount. Before this handshake,
  // the extension's eager first `template` was posted before this effect ran and was
  // dropped outright — the blank-form-until-first-env-pick bug.
  React.useEffect(() => {
    subscribe((msg) => {
      if (msg.type === "template") {
        setTitle(msg.title);
        setEnv(msg.env);
        setSource(msg.source ?? "tdk");
        setPages(msg.pages);
        // Clamp the step if the new template has fewer pages.
        setStep((s) => Math.min(s, msg.pages.length));
        setError(undefined);
      } else if (msg.type === "compileError") {
        setError(msg.message);
      } else if (msg.type === "scenarios") {
        setScenarios(msg.scenarios);
      } else if (msg.type === "scenarioPrefill") {
        // Merge the scenario's parameter values over the current ones and return to
        // page 1. Reflect the selection in the header + post the merged values (WITH
        // validity, so the extension gates the simulate) so the trace runs for them. A
        // scenario's values are typically complete, so this usually resumes a live trace.
        setSelectedScenario(msg.name);
        setValues((prev) => {
          const merged = { ...prev, ...msg.values };
          postValuesRef.current(merged);
          return merged;
        });
        setStep(0);
      } else if (msg.type === "dryRunCapability") {
        // Enable/disable the Review step's Dry-run button live (item #5) — the extension
        // posts this initially and whenever `tdk.backstage.baseUrl` changes.
        setDryRunConfigured(msg.configured);
      }
    });
    post({ type: "ready" });
  }, [subscribe, post]);

  const isReview = pages.length > 0 && step >= pages.length;

  // The accumulated values, kept in a ref so `onChange` can MERGE this page's data
  // into it (each page's Form only knows ITS OWN fields, so replacing outright would
  // wipe the other pages' values) without depending on the render-time `values`.
  const valuesRef = useRef(values);
  valuesRef.current = values;
  // The current pages + source, in refs so the ONE `postValues` callback can compute
  // validity against the latest schemas without being re-created on every change.
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const sourceRef = useRef(source);
  sourceRef.current = source;

  // The SINGLE place values leave for the extension — with the validity the extension
  // GATES the local simulate on. The webview already has the page schemas + ajv, so it
  // owns the check (per-page required lists, missing fields by title): the cleanest seam.
  // A YAML source has no local simulate, so it omits validity (the extension never runs
  // execute() for it anyway).
  const postValues = useCallback(
    (next: Record<string, unknown>) => {
      if (sourceRef.current === "yaml") {
        post({ type: "valuesChanged", values: next });
        return;
      }
      const { valid, missing } = formValidity(pagesRef.current, next);
      post({ type: "valuesChanged", values: next, valid, missing });
    },
    [post],
  );
  postValuesRef.current = postValues;

  const onChange = useCallback(
    (e: IChangeEvent) => {
      const pageData = (e.formData ?? {}) as Record<string, unknown>;
      const next = { ...valuesRef.current, ...pageData };
      setValues(next);
      postValues(next);
    },
    [postValues],
  );

  const goNext = useCallback(() => {
    // Next validates the current page first (like Backstage) — refuse to advance
    // while it has errors. `validateForm()` also surfaces the errors in the UI.
    if (!isReview && formRef.current && !formRef.current.validateForm()) return;
    setStep((s) => Math.min(s + 1, pages.length));
  }, [isReview, pages.length]);

  const goPrev = useCallback(() => setStep((s) => Math.max(0, s - 1)), []);

  const reset = useCallback(() => {
    // Clear back to defaults instantly: empty the shared values and re-render the
    // first page. RJSF re-applies each schema's defaults from an empty formData.
    setValues({});
    setStep(0);
    setError(undefined);
    postValues({});
  }, [postValues]);

  // Clicking the env / scenario header text opens the SAME native QuickPick the
  // palette commands open (the extension owns the lists + current values).
  const pickEnv = useCallback(() => post({ type: "pickEnv" }), [post]);
  const pickScenario = useCallback(() => post({ type: "pickScenario" }), [post]);

  // Save the current values as a new scenario — the extension prompts for a name and
  // inserts an entry into __fixtures__/scenarios.ts.
  const save = useCallback(() => {
    post({ type: "saveScenario", values: valuesRef.current });
  }, [post]);

  // Dry-run the current values against a real Backstage — the extension compiles the
  // current env's template, POSTs it, and renders the outcome in the TDK Trace view.
  const dryRun = useCallback(() => {
    post({ type: "dryRunSubmit", values: valuesRef.current });
  }, [post]);

  const currentPage = pages[step];
  // Route any unknown `ui:field` on this page to our fallback field before RJSF
  // sees it (RJSF ignores an unregistered field name and renders by type).
  const currentUiSchema = useMemo(() => (currentPage ? remapCustomFields(currentPage.uiSchema) : {}), [currentPage]);

  // A plain-YAML source: the env is fixed (the buffer IS the artifact), and scenarios,
  // save-as-scenario, and the local execute trace are TDK-only. Hide those affordances
  // and show a quiet note so their absence is legible, not mysterious.
  const isYaml = source === "yaml";

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Title3>{title}</Title3>
        {/* The env · scenario meta is a TDK-compile concept — only shown for a `.ts` source. */}
        {!isYaml && (
          <div className={styles.headerMeta}>
            <Text className={styles.metaLabel}>env</Text>
            <button type="button" className={styles.metaButton} onClick={pickEnv} data-testid="pick-env">
              {env}
            </button>
            <Text className={styles.metaLabel}>·</Text>
            <Text className={styles.metaLabel}>scenario</Text>
            <button
              type="button"
              className={styles.metaButton}
              onClick={pickScenario}
              disabled={scenarios.length === 0}
              data-testid="pick-scenario"
            >
              {selectedScenario || (scenarios.length ? "none" : "—")}
            </button>
          </div>
        )}
      </div>

      {isYaml && (
        <Text className={styles.yamlNote} data-testid="yaml-note">
          TDK features — scenarios, local trace, and env — available for template.ts sources.
        </Text>
      )}

      <div className={styles.actions}>
        {/* Save-as-scenario writes to __fixtures__/scenarios.ts — a TDK concept, hidden for YAML. */}
        {!isYaml && (
          <Button appearance="secondary" size="small" onClick={save} disabled={pages.length === 0}>
            Save as scenario
          </Button>
        )}
        <Button appearance="secondary" size="small" onClick={reset}>
          Reset
        </Button>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
          <MessageBarActions
            containerAction={
              <Button appearance="transparent" aria-label="Dismiss" onClick={() => setError(undefined)}>
                Dismiss
              </Button>
            }
          />
        </MessageBar>
      )}

      {pages.length === 0 ? (
        <Text className={styles.empty}>
          {error ? "Waiting for a successful compile…" : "This template has no parameters."}
        </Text>
      ) : (
        <>
          <Stepper pages={pages} step={step} styles={styles} />

          {isReview ? (
            <Review values={values} styles={styles} onDryRun={dryRun} dryRunConfigured={dryRunConfigured} />
          ) : (
            currentPage && (
              <Form
                key={step}
                // biome-ignore lint/suspicious/noExplicitAny: the expected ref names the RJSF Form class, whose type identity varies with the linker layout — formRef depends on the structural handle only (see its declaration)
                ref={formRef as any}
                schema={currentPage.schema}
                uiSchema={currentUiSchema}
                formData={values}
                validator={validator}
                fields={FIELDS}
                // Override the title template so an ARRAY ITEM's heading ("Line
                // items-1") renders a rung below its field's heading ("Line items"),
                // instead of at the same visual level (see formTemplates).
                templates={formTemplates}
                onChange={onChange}
                // The top "Errors" summary box duplicates the field-level errors —
                // Backstage hides it too. Field errors still render inline.
                showErrorList={false}
                // Humanize ajv's phrasing ("must have required property 'X'" → "X is
                // required"); a schema-authored errorMessage passes through verbatim.
                transformErrors={transformErrors}
                // The stepper owns navigation; hide RJSF's own submit button.
                omitExtraData={false}
                noHtml5Validate
              >
                {/* biome-ignore lint/complexity/noUselessFragments: deliberate — non-null children suppress RJSF's built-in submit button (the stepper's own Next/Review replaces it) */}
                <></>
              </Form>
            )
          )}

          <div className={styles.nav}>
            <Button appearance="secondary" onClick={goPrev} disabled={step === 0}>
              Previous
            </Button>
            <Button appearance="primary" onClick={goNext} disabled={isReview}>
              {step === pages.length - 1 ? "Review" : "Next"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** The step rail: page titles + a final "Review", the active one highlighted. */
function Stepper({
  pages,
  step,
  styles,
}: {
  pages: FormPage[];
  step: number;
  styles: ReturnType<typeof useStyles>;
}): React.ReactElement {
  const labels = [...pages.map((p, i) => p.title ?? `Page ${i + 1}`), "Review"];
  return (
    <div className={styles.steps}>
      {labels.map((label, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the rail is static per template — pages never reorder within a render, and titles may repeat
        <span key={i} className={`${styles.step} ${i === step ? styles.stepActive : ""}`}>
          {i + 1}. {label}
        </span>
      ))}
    </div>
  );
}

/**
 * The final review: the aggregated form values as pretty JSON, plus a "Dry-run in
 * Backstage" action. The dry-run compiles the current env's template and POSTs it to a
 * real Backstage (base URL via the tdk.backstage.baseUrl setting, token via the TDK: Set
 * Backstage Token command), rendering the executed steps + log + output + emitted files —
 * or the server-side validation errors — in the TDK Trace view.
 *
 * GATED ON CONFIGURATION (item #5). When `dryRunConfigured` is false (no
 * `tdk.backstage.baseUrl` set), the button is DISABLED with a visible hint naming the
 * commands to fix it — a click that only prompts is a dead end. A missing TOKEN does NOT
 * disable the button (some backends accept anonymous; the authFailed taxonomy guides a
 * rejected token), but the hint mentions both commands. The extension re-posts the
 * capability on config change, so setting the base URL live re-enables the button.
 */
function Review({
  values,
  styles,
  onDryRun,
  dryRunConfigured,
}: {
  values: Record<string, unknown>;
  styles: ReturnType<typeof useStyles>;
  onDryRun: () => void;
  dryRunConfigured: boolean;
}): React.ReactElement {
  return (
    <div>
      <Text weight="semibold">Review — the values this form would submit:</Text>
      <div className={styles.review}>{JSON.stringify(values, null, 2)}</div>
      <div className={styles.reviewActions}>
        <Button
          appearance="primary"
          size="small"
          onClick={onDryRun}
          disabled={!dryRunConfigured}
          data-testid="dry-run-submit"
        >
          Dry-run in Backstage
        </Button>
        {dryRunConfigured ? (
          <Text className={styles.empty}>
            Compiles the current env and posts to Backstage; results appear in TDK Trace.
          </Text>
        ) : (
          <Text className={styles.empty} data-testid="dry-run-hint">
            Dry-run needs a Backstage base URL — run 'TDK: Set Backstage Base URL' (and set a token with 'TDK: Set
            Backstage Token').
          </Text>
        )}
      </div>
    </div>
  );
}
