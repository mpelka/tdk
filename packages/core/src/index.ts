// Public API barrel for TDK — the DSL surface authors import from.

export const version = "0.1.0";

export type { ActionSimContext, ActionSimulator } from "./actions.ts";
export {
  _resetActionSimulators,
  getActionSimulator,
  registerActionSimulator,
} from "./actions.ts";
export type {
  CompileJob,
  CompileResult,
  JsonSchemaObject,
  TemplateEntity,
} from "./compile.ts";
// Compile engine.
export { assertNoCrossEnvLeaks, compile, compileAll, compileResolved } from "./compile.ts";
export type {
  DefineTemplateConfig,
  DefineTemplateConfigWithLoad,
  FieldRefs,
  LoadFn,
  ParamValues,
  Ref,
  StepOptions,
  TypedTemplate,
} from "./define.ts";
// Functional template API ("Option C") — colocated params + inferred typed refs.
// `defineTemplate({...})` authors a template without a class; `step(...)` builds
// a step; the colocated `page(title, props)` form lives in ./pages.ts.
export { defineTemplate, step } from "./define.ts";
export type { EnvValues } from "./env.ts";
// Environments / env.pick.
export { _resetEnvRegistry, EnvPick, env, exclusiveValuesByEnv, isEnvPick } from "./env.ts";
export type {
  ExecuteDifferential,
  ExecuteFixture,
  ExecuteOptions,
  ExecuteResult,
  ExecuteStepResult,
  FixtureParams,
} from "./execute.ts";
// Scenario simulator. `execute(template, fixture)` renders the compiled
// template's interpolations + runs the pure (jsonata) steps to produce output;
// `executeAgainstGold` runs the same engine on a gold YAML for a differential.
export {
  assertExecuteAgainstGold,
  execute,
  executeAgainstGold,
} from "./execute.ts";
export type { RawRef, RefResolver } from "./expr/index.ts";
// Raw expressions. `raw` emits a verbatim Scaffolder string; `raw.jsonata`
// inlines verbatim JSONata (the M2 escape hatch).
export { isRawExpr, isRawRef, RawExpr, raw } from "./expr/index.ts";
export type {
  DifferentialCase,
  DifferentialResult,
} from "./expr/jsonata/differential.ts";
export {
  assertDifferential,
  assertDifferentialJsonata,
  differential,
  differentialJsonata,
} from "./expr/jsonata/differential.ts";
// Expressions (TS→JSONata transpiler, M2). `jsonata(...)` compiles a typed arrow
// to a validated JSONata expression usable anywhere `raw` is.
export {
  assert,
  isJsonataExpr,
  JsonataExpr,
  jsonata,
  substringAfter,
  substringBefore,
  TranspileError,
  validateJsonata,
} from "./expr/jsonata/index.ts";
export type {
  NjDifferentialCase,
  NjDifferentialResult,
} from "./expr/nunjucks/differential.ts";
export {
  assertDifferentialNj,
  differentialNj,
  njString,
  renderNj,
} from "./expr/nunjucks/differential.ts";
export type { NjContext } from "./expr/nunjucks/index.ts";
// Expressions (TS→Nunjucks transpiler). `nj(...)` compiles a typed arrow to a
// Backstage `${{ … }}` Nunjucks interpolation, usable anywhere `raw`/`jsonata` are.
export {
  isNunjucksExpr,
  NjTranspileError,
  NunjucksExpr,
  nj,
  njDefault,
} from "./expr/nunjucks/index.ts";
// Extension hooks — typed authoring sugar + custom-action simulators. A consumer
// plugin publishes its own field/step helpers with `defineField`/`defineAction`
// (compiling down to `p.customField` / a `Step`); `defineAction`'s `simulate`
// registers an action simulator so `execute()` learns how a custom action
// behaves. Core ships only the mechanism — it never imports a plugin.
export { defineAction, defineField } from "./extend.ts";
// Composition fragments — `fragment(title, props)` builds a shareable colocated
// PAGE authored once and dropped into many templates. Concrete org-specific
// fragments are built on top of it and live in the consumer's own shared code.
export { fragment } from "./fragment.ts";
export type { FromYamlResult } from "./fromYaml.ts";
// Reading a plain-YAML Scaffolder template into the same `{ object, yaml }` artifact
// `compile()` produces — so a hand-authored YAML template validates and dry-runs
// exactly like a compiled TDK one. The `@tdk/core/backstage` subpath carries the
// client that consumes either artifact.
export { fromYaml } from "./fromYaml.ts";
export type {
  Branch,
  BranchBody,
  ColocatedPage,
  PageInput,
  PageObject,
  PageOptions,
} from "./pages.ts";
// Multi-page parameter forms + conditional dependencies.
export { Dependency, dep, page } from "./pages.ts";
export type {
  ArrayParamOptions,
  BaseParamOptions,
  BooleanParamOptions,
  CustomFieldOptions,
  EnumParamOptions,
  JsonSchema,
  NumberParamOptions,
  ParamMap,
  ShowWhen,
  ShowWhenInput,
  ShowWhenValue,
  StringParamOptions,
} from "./params.ts";
// Parameters. `Param` is the base class (long exported as `ParamBase`, kept as
// a compat alias); `ParamRef` is a param's `${{ parameters.<name> }}` ref.
// `all(...)` AND-composes the ref-based `showWhen` conditions `.is`/`.in` build.
export { all, Param, ParamBase, ParamRef, p, requireParam, ShowWhenCondition } from "./params.ts";
export type {
  Resolvable,
  ResolveContext,
  ResolvedMap,
  ResolverFn,
} from "./resolve.ts";
// Value resolvers (extension hook). A consumer plugin registers an async
// resolver with `defineResolver(name, fn)` and gets back a marker factory;
// markers are replaced with concrete values during `compileResolved`/`compileAll`.
// Core ships only the mechanism — it never imports a concrete resolver.
export { _resetResolvers, defineResolver, isResolvable } from "./resolve.ts";
export type { Target, Targets, TdkConfig, TemplateInput, TemplateMeta } from "./targets.ts";
// Targets + config.
export { defineConfig } from "./targets.ts";
export type { BuiltForm, InputValue, Lifecycle, LoadContext, PrepareOptions, Step } from "./template.ts";
// Core authoring model.
export { Template } from "./template.ts";
export type { ValidationResult } from "./validate.ts";
// Validation.
export {
  assertValid,
  getValidator,
  structuralCheck,
  validate,
  validateParameters,
} from "./validate.ts";
