// The `@tdk/core/backstage` subpath barrel — the scriptable Backstage client and its
// taxonomy. Kept OFF the main `@tdk/core` surface so the DSL's authoring API stays
// free of HTTP concerns; a consumer who wants to talk to a live Backstage opts in with
// `import { backstageClient } from "@tdk/core/backstage"`.
//
// The VS Code extension consumes the same module for its dry-run (the low-level
// `dryRun` + the taxonomy types), which is why the request composers and every result
// type are exported here too.

export type {
  BackstageClient,
  BackstageClientConfig,
  CompiledArtifact,
  CreateTaskRequest,
  CreateTaskResult,
  DirectoryFile,
  DryRunLogEntry,
  DryRunRequest,
  DryRunResult,
  DryRunStep,
  DryRunSuccessBody,
  DryRunValidationError,
  FetchLike,
  FetchResponseLike,
  RequestValues,
  TemplateEntity,
} from "./client.ts";
export {
  BACKSTAGE_TOKEN_ENV,
  BACKSTAGE_URL_ENV,
  backstageClient,
  backstageUrl,
  CONSENT_GATE_MESSAGE,
  createTask,
  DRY_RUN_PATH,
  dryRun,
  dryRunBody,
  dryRunHeaders,
  dryRunUrl,
  MISSING_BASE_URL_MESSAGE,
  TASKS_PATH,
  taskUrl,
  templateRefFor,
} from "./client.ts";
