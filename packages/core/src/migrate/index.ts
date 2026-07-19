// The `@tdk/core/migrate` subpath barrel — the migration MODEL, its VALIDATOR, and
// the PRINTER (ADR-0026).
//
// Kept OFF the main `@tdk/core` surface (like `@tdk/core/backstage`): the DSL's
// authoring API stays free of migration concerns. A migration tool opts in with
// `import { validateModel, printTemplate } from "@tdk/core/migrate"`. The committed
// JSON Schema `model.schema.json` is the public contract producers validate against;
// `modelSchema()` returns it.

export type {
  ActionMap,
  ConditionalCase,
  Effect,
  ExpressionEscape,
  ImportSpec,
  JsonValue,
  LogicExpr,
  LogicNode,
  Lookup,
  LookupMap,
  MigrationMapping,
  MigrationModel,
  NamedLogic,
  Question,
  QuestionType,
  ScalarValue,
  TemplateMeta,
  ValueRef,
  VisibleWhen,
} from "./model.ts";
export { MODEL_VERSION } from "./model.ts";
export { buildNameMap, CORE_IMPORTS, type NameMap, type NodeKind, toConstName } from "./naming.ts";
export type { FlaggedConstruct, MigrationReport, PrintOptions, PrintResult } from "./print.ts";
export { printTemplate } from "./print.ts";
export { modelSchema } from "./schema.ts";
export type { ModelError, ValidateModelResult } from "./validate.ts";
export { formatModelErrors, validateModel } from "./validate.ts";
