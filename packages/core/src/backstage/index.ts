// The `@tdk/core/backstage` subpath barrel — the scriptable Backstage client and its
// taxonomy. Kept OFF the main `@tdk/core` surface so the DSL's authoring API stays
// free of HTTP concerns; a consumer who wants to talk to a live Backstage opts in with
// `import { backstageClient } from "@tdk/core/backstage"`.
//
// The VS Code extension consumes the same module for its dry-run (the low-level
// `dryRun` + the taxonomy types), which is why the dry-run request composers and every
// result type are exported here too.
//
// DELIBERATELY NOT EXPORTED: the low-level `createTask` (and its `templateRefFor` /
// `taskUrl` / `TASKS_PATH` helpers). Creating a task has REAL side effects, and the
// consent gate lives in `backstageClient` — exporting the ungated function here would
// hand every consumer a route to /v2/tasks that never consults the gate. The ONLY
// exported way to create a task is `backstageClient({ allowTaskCreation: true })
// .createTask(...)`. The helpers stay module-internal (client.ts is not reachable
// through the package's exports map); index.test.ts pins this surface.

export type {
  BackstageClient,
  BackstageClientConfig,
  CompiledArtifact,
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
  DRY_RUN_PATH,
  dryRun,
  dryRunBody,
  dryRunHeaders,
  dryRunUrl,
  MISSING_BASE_URL_MESSAGE,
} from "./client.ts";
