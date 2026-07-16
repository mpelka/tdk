// The Backstage client — the ONE place a compiled template becomes an HTTP request
// against a live Backstage and the response becomes a typed, classified result. It
// grew out of the VS Code extension's dry-run client (the taxonomy + auth scrubbing
// + timeout below are lifted verbatim so the extension's behaviour never changes),
// and adds two things the DSL wants on its own: a scriptable `backstageClient(...)`
// factory (env-var config + a CONSENT GATE) and a `createTask` that actually kicks
// off a real scaffolder run.
//
// Pure-ish: `fetch` is INJECTED (the caller passes the runtime's global), so every
// classification is unit-testable with a fake fetch, and one gated integration test
// drives it against a live Backstage.
//
// THE DRY-RUN CONTRACT (verified against the version-matched local Backstage source):
//   POST {baseUrl}/api/scaffolder/v2/dry-run
//     body: { template: <compiled entity JSON>, values, secrets?, directoryContents: [] }
//     headers: Content-Type: application/json, Authorization: Bearer <token> (optional)
//   → 200 { steps, log, output, directoryContents: [{ path, executable, base64Content }] }
//   → 400 { errors: [{ message, ... }] }  when `values` fail server-side param validation
//   → 401/403                              when the bearer token is present but rejected
//
// THE TASK CONTRACT (same source): POST {baseUrl}/api/scaffolder/v2/tasks with a
//   `templateRef` naming a CATALOG-REGISTERED template (`template:default/<name>`),
//   the `values`, and optional `secrets`; → 201 { id } with the new task id. Unlike
//   the dry-run, this template must already be in the catalog — the endpoint looks it
//   up by ref, it does not accept an inline entity.
//
// THE TAXONOMY. Neither request THROWS for an HTTP outcome — each returns a
// discriminated result the caller renders directly:
//   - `ok` / `created`   — the success arm.
//   - `validationFailed` — 400: the server-side `{ errors }` (free payload validation,
//                          even for custom fields).
//   - `authFailed`       — 401/403: the token is missing/expired/wrong.
//   - `unreachable`      — the request never completed (connection refused, DNS, timeout,
//                          fetch threw) OR a success body that could not be parsed as JSON.
//   - `serverError`      — any OTHER non-2xx (a 5xx, or a 4xx that isn't 400/401/403),
//                          carrying the status + the server's best-effort error message.

/** A compiled Backstage Template entity — the JSON we parsed out of the compiled YAML. */
export type TemplateEntity = Record<string, unknown>;

/**
 * A compiled artifact the client accepts — the `{ object, yaml }` shape BOTH
 * `compile()` (its `CompileResult`) and `fromYaml()`'s `template` arm return. Only
 * `object` (the entity) is read; `yaml` rides along so the same value flows straight
 * from either producer into the client with no unwrapping at the call site.
 *
 * `object` is the structural `object` type on purpose: compile's `TemplateEntity` is a
 * strict interface (no index signature) and would NOT assign to `Record<string, unknown>`,
 * so a `Record`-typed field would reject a genuine compiled artifact. `object` accepts
 * both producers; the client narrows it to a record internally.
 */
export interface CompiledArtifact {
  /** The Template entity as a plain object (the wire `template`). */
  object: object;
  /** The entity serialized to YAML — carried for interchange, not sent on the wire. */
  yaml?: string;
}

/** Narrow a `CompiledArtifact`'s structural-`object` entity to the wire record shape. */
function entityOf(artifact: CompiledArtifact): TemplateEntity {
  return artifact.object as TemplateEntity;
}

/** One `directoryContents` entry the dry-run emits: a path, its exec bit, base64 body. */
export interface DirectoryFile {
  path: string;
  executable?: boolean;
  base64Content: string;
}

/**
 * One log entry from the run. Backstage nests the useful fields under `body`
 * (`{ body: { stepId?, status?, message } }`) — we keep the raw shape and read
 * `body.stepId` / `body.message` when grouping the log by step.
 */
export interface DryRunLogEntry {
  body?: {
    stepId?: string;
    status?: string;
    message?: string;
  };
  // Some entries carry other top-level fields; keep them but never rely on them.
  [key: string]: unknown;
}

/** One executed step the dry-run reports back (id, name, action, the resolved input). */
export interface DryRunStep {
  id: string;
  name?: string;
  action?: string;
  input?: unknown;
}

/** The 200 payload — the executed steps, the run log, the output, and the emitted files. */
export interface DryRunSuccessBody {
  steps: DryRunStep[];
  log: DryRunLogEntry[];
  output: unknown;
  directoryContents: DirectoryFile[];
}

/** One server-side validation error from a 400 (the shape Backstage's validator emits). */
export interface DryRunValidationError {
  /** A JSON-pointer-ish path to the offending value (`[]` for the root). */
  path?: (string | number)[];
  /** The offending property name (`"instance"` at the root). */
  property?: string;
  /** The human message, e.g. `requires property "flavor"`. */
  message: string;
  /** The validator keyword (`required`, `type`, `enum`, …). */
  name?: string;
  /** The keyword argument (the missing property name for `required`, etc.). */
  argument?: unknown;
}

/** The discriminated result of one dry-run attempt — the caller renders it directly. */
export type DryRunResult =
  | { kind: "ok"; body: DryRunSuccessBody }
  | { kind: "validationFailed"; errors: DryRunValidationError[] }
  | { kind: "authFailed"; status: number; message: string }
  | { kind: "serverError"; status: number; message: string }
  | { kind: "unreachable"; message: string };

/** The discriminated result of one createTask attempt — same taxonomy, a `created` arm. */
export type CreateTaskResult =
  | { kind: "created"; taskId: string; taskUrl: string }
  | { kind: "validationFailed"; errors: DryRunValidationError[] }
  | { kind: "authFailed"; status: number; message: string }
  | { kind: "serverError"; status: number; message: string }
  | { kind: "unreachable"; message: string };

/** The minimal `Response` surface the client reads — status + a `text()` body. */
export interface FetchResponseLike {
  status: number;
  ok: boolean;
  text(): Promise<string>;
}

/** The minimal `fetch` surface the client depends on — injectable, so tests fake it. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

/** Everything `dryRun` needs: where Backstage is, the token, and the payload. */
export interface DryRunRequest {
  /** The base URL, e.g. `http://localhost:7007` (a trailing slash is fine). */
  baseUrl: string;
  /** The bearer token, or undefined when none is set. */
  token?: string;
  /** The compiled template entity (parsed from the compiled YAML). */
  template: TemplateEntity;
  /** The form's current values (the parameters payload the server validates). */
  values: Record<string, unknown>;
  /** Optional secrets to pass through (redacted in the run log by the server). */
  secrets?: Record<string, string>;
}

/** The dry-run path appended to the base URL — the one endpoint the dry-run speaks to. */
export const DRY_RUN_PATH = "/api/scaffolder/v2/dry-run";

/** The tasks path appended to the base URL — where `createTask` POSTs a real run. */
export const TASKS_PATH = "/api/scaffolder/v2/tasks";

/** Join a base URL and a path, tolerating a trailing slash on the base. */
export function backstageUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/** Join the base URL and the dry-run path (kept for the extension's existing import). */
export function dryRunUrl(baseUrl: string): string {
  return backstageUrl(baseUrl, DRY_RUN_PATH);
}

/**
 * Compose the JSON request body from a `DryRunRequest`. `directoryContents` is always
 * `[]` — the dry-run starts from an empty workspace and reports what the template
 * WOULD emit. Kept pure + exported so a test can assert the exact wire shape.
 */
export function dryRunBody(req: DryRunRequest): string {
  return JSON.stringify({
    template: req.template,
    values: req.values,
    secrets: req.secrets ?? {},
    directoryContents: [],
  });
}

/** The request headers: JSON, plus a bearer token only when one is provided. */
export function dryRunHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Run one dry-run against a live Backstage and classify the outcome. Never throws for
 * an HTTP result — a thrown/failed fetch (connection refused, DNS, abort) becomes
 * `unreachable`, and every HTTP status maps to a taxonomy arm (see `DryRunResult`).
 *
 * `fetchImpl` is injected so the caller supplies the runtime's `fetch` and tests
 * supply a fake — the whole reason this module is pure. `signal`, when given, is
 * forwarded to `fetch` for cancellation/timeout.
 */
export async function dryRun(req: DryRunRequest, fetchImpl: FetchLike, signal?: AbortSignal): Promise<DryRunResult> {
  let res: FetchResponseLike;
  try {
    res = await fetchImpl(dryRunUrl(req.baseUrl), {
      method: "POST",
      headers: dryRunHeaders(req.token),
      body: dryRunBody(req),
      signal,
    });
  } catch (err) {
    // A network-level failure: connection refused, DNS, abort, TLS — the request never
    // got an HTTP response. This is the "is Backstage running / is the URL right" case,
    // so the message points at the base URL.
    return { kind: "unreachable", message: unreachableMessage(req.baseUrl, err) };
  }

  const rawBody = await safeText(res);

  if (res.status === 401 || res.status === 403) {
    return { kind: "authFailed", status: res.status, message: authMessage(res.status, rawBody) };
  }

  if (res.status === 400) {
    const parsed = parseJson(rawBody);
    const errors = isRecord(parsed) ? (parsed.errors as DryRunValidationError[] | undefined) : undefined;
    if (Array.isArray(errors)) return { kind: "validationFailed", errors };
    // A 400 whose body isn't the expected `{ errors }` — surface it as a server error
    // with whatever message we can extract, rather than a silent empty list.
    return { kind: "serverError", status: 400, message: serverMessage(parsed, rawBody) };
  }

  if (res.ok) {
    const parsed = parseJson(rawBody);
    if (!isRecord(parsed)) {
      return { kind: "unreachable", message: `Backstage returned a non-JSON dry-run response (status ${res.status}).` };
    }
    return { kind: "ok", body: normalizeSuccess(parsed) };
  }

  // Any other non-2xx: a 5xx (Backstage wraps a malformed template entity as a 500
  // TypeError), or a 4xx that isn't 400/401/403.
  const parsed = parseJson(rawBody);
  return { kind: "serverError", status: res.status, message: serverMessage(parsed, rawBody) };
}

/** Read `res.text()` but never throw — a body-read failure degrades to an empty string. */
async function safeText(res: FetchResponseLike): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** Parse JSON, returning `undefined` (never throwing) on malformed text. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A plain-object type guard (not an array, not null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerce a parsed 200 body into the `DryRunSuccessBody` shape, defaulting each field so
 * a slightly-shaped-differently backend never crashes the renderer (missing arrays
 * become `[]`, missing output becomes `undefined`).
 */
function normalizeSuccess(parsed: Record<string, unknown>): DryRunSuccessBody {
  return {
    steps: Array.isArray(parsed.steps) ? (parsed.steps as DryRunStep[]) : [],
    log: Array.isArray(parsed.log) ? (parsed.log as DryRunLogEntry[]) : [],
    output: parsed.output,
    directoryContents: Array.isArray(parsed.directoryContents) ? (parsed.directoryContents as DirectoryFile[]) : [],
  };
}

/**
 * Defense-in-depth: no REAL runtime error message embeds the Authorization header
 * (verified against Node/Bun fetch failures), but a proxy or a misbehaving server
 * could echo the request back — scrub any bearer token from anything we surface.
 */
function scrubAuth(message: string): string {
  return message.replace(/Bearer\s+\S+/gi, "Bearer ***");
}

/** The `unreachable` message — names the base URL so the user checks the setting / server. */
function unreachableMessage(baseUrl: string, err: unknown): string {
  const detail = scrubAuth(err instanceof Error ? err.message : String(err));
  return `Could not reach Backstage at ${baseUrl}. Check that it is running and that the base URL is correct. (${detail})`;
}

/** The `authFailed` message — names the fix (set/refresh the token). */
function authMessage(status: number, rawBody: string): string {
  const server = scrubAuth(extractErrorMessage(parseJson(rawBody)) ?? "") || undefined;
  const base =
    status === 401
      ? "Backstage rejected the token (401 Unauthorized)."
      : "Backstage forbade the request (403 Forbidden).";
  const hint = "Set or refresh the Backstage token (TDK_BACKSTAGE_TOKEN, or the VS Code Set Backstage Token command).";
  return server ? `${base} ${server} ${hint}` : `${base} ${hint}`;
}

/** A best-effort server-error message for the `serverError` arm. */
function serverMessage(parsed: unknown, rawBody: string): string {
  return scrubAuth(extractErrorMessage(parsed) || (rawBody.trim() ? rawBody.trim().slice(0, 500) : "no response body"));
}

/**
 * Pull a human message out of Backstage's error envelopes. It wraps failures as
 * `{ error: { message } }` (a 500) and sometimes as a bare `{ message }`; return the
 * first one found, or `undefined` when neither is present.
 */
function extractErrorMessage(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) return undefined;
  const error = parsed.error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  if (typeof parsed.message === "string") return parsed.message;
  return undefined;
}

// --- The scriptable client ---------------------------------------------------------
//
// `backstageClient(config?)` resolves its base URL + token from EXPLICIT config first,
// then the environment (`TDK_BACKSTAGE_URL` / `TDK_BACKSTAGE_TOKEN` — the convention the
// live tests already use). It exposes `dryRun` (safe: no side effects) and `createTask`
// (real side effects), the latter behind a CONSENT GATE so a real run never happens by
// accident.

/** The env-var names the client falls back to when config omits `baseUrl` / `token`. */
export const BACKSTAGE_URL_ENV = "TDK_BACKSTAGE_URL";
export const BACKSTAGE_TOKEN_ENV = "TDK_BACKSTAGE_TOKEN";

/** How the client is configured — everything optional; the env fills the gaps. */
export interface BackstageClientConfig {
  /** The Backstage base URL. Explicit wins; else `TDK_BACKSTAGE_URL`. */
  baseUrl?: string;
  /** The bearer token. Explicit wins; else `TDK_BACKSTAGE_TOKEN`. */
  token?: string;
  /**
   * The CONSENT GATE for `createTask`. Default `false`: `createTask` THROWS
   * synchronously until this is `true`, because a task is a REAL run with real side
   * effects (unlike the always-safe `dryRun`).
   */
  allowTaskCreation?: boolean;
  /** Per-request timeout in ms. When set, a request that outlives it aborts → `unreachable`. */
  timeoutMs?: number;
  /** The `fetch` to use (defaults to the global). Injectable so tests fake the network. */
  fetch?: FetchLike;
  /** The env source for the fallbacks (defaults to `process.env`). Injectable for tests. */
  env?: Record<string, string | undefined>;
}

/** The values payload for a request (the form values, plus optional secrets). */
export interface RequestValues {
  values: Record<string, unknown>;
  secrets?: Record<string, string>;
}

/** The scriptable client surface: an always-safe `dryRun` and a gated `createTask`. */
export interface BackstageClient {
  /** The resolved base URL this client targets (after config + env). */
  readonly baseUrl: string | undefined;
  /** Whether `createTask` is permitted (the consent gate's state). */
  readonly allowTaskCreation: boolean;
  /** Dry-run an artifact — no side effects, always safe. */
  dryRun(artifact: CompiledArtifact, values: RequestValues): Promise<DryRunResult>;
  /**
   * Create a REAL scaffolder task for an artifact. THROWS SYNCHRONOUSLY when the client
   * was built without `allowTaskCreation: true`. The template must be registered in the
   * Backstage catalog (the task endpoint resolves it by `templateRef`, not inline).
   */
  createTask(artifact: CompiledArtifact, values: RequestValues): Promise<CreateTaskResult>;
}

/**
 * The message the consent gate throws — it explains WHY the gate exists (a task is a
 * real run) and HOW to consent (the config flag). Exported so the CLI/tests can match it.
 */
export const CONSENT_GATE_MESSAGE =
  "backstageClient.createTask() is disabled: creating a task runs the template FOR REAL in " +
  "Backstage — real side effects, not a dry run. To allow it, construct the client with " +
  "backstageClient({ allowTaskCreation: true }).";

/** The message a request throws when neither config nor env supplied a base URL. */
export const MISSING_BASE_URL_MESSAGE =
  "No Backstage base URL configured. Pass baseUrl to backstageClient({ baseUrl }) " +
  `or set the ${BACKSTAGE_URL_ENV} environment variable.`;

/** Read `process.env` without assuming a Node global exists (core stays runtime-neutral). */
function processEnv(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}

/**
 * Build a scriptable Backstage client. Resolves `baseUrl` / `token` from config then the
 * environment at construction time; a request made with no resolvable base URL throws a
 * loud error naming BOTH sources. `createTask` is gated (see `CONSENT_GATE_MESSAGE`).
 */
export function backstageClient(config: BackstageClientConfig = {}): BackstageClient {
  const env = config.env ?? processEnv();
  const baseUrl = config.baseUrl ?? env[BACKSTAGE_URL_ENV];
  const token = config.token ?? env[BACKSTAGE_TOKEN_ENV];
  const allowTaskCreation = config.allowTaskCreation === true;
  const timeoutMs = config.timeoutMs;
  const fetchImpl = config.fetch ?? (globalThis.fetch as unknown as FetchLike);

  /** Require a resolved base URL, throwing the loud two-source error when absent. */
  function requireBaseUrl(): string {
    if (!baseUrl) throw new Error(MISSING_BASE_URL_MESSAGE);
    return baseUrl;
  }

  /** Run `fn` with a timeout-bound AbortSignal when `timeoutMs` is set; else no signal. */
  async function withTimeout<T>(fn: (signal?: AbortSignal) => Promise<T>): Promise<T> {
    if (timeoutMs === undefined) return fn();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      return await fn(abort.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    baseUrl,
    allowTaskCreation,

    // `dryRun` is a normal Promise-returning method: a missing base URL REJECTS (the
    // async body throws), the natural shape for `await client.dryRun(...)`.
    async dryRun(artifact, { values, secrets }) {
      const url = requireBaseUrl();
      return withTimeout((signal) =>
        dryRun({ baseUrl: url, token, template: entityOf(artifact), values, secrets }, fetchImpl, signal),
      );
    },

    // `createTask` is deliberately NOT async so the consent gate THROWS SYNCHRONOUSLY —
    // a caller who forgot the flag fails loudly at the call site, before any Promise (and
    // thus any network call) exists, never as a swallowed rejection.
    createTask(artifact, requestValues) {
      if (!allowTaskCreation) throw new Error(CONSENT_GATE_MESSAGE);
      const url = requireBaseUrl();
      return withTimeout((signal) =>
        createTask({ baseUrl: url, token, artifact, ...requestValues }, fetchImpl, signal),
      );
    },
  };
}

/** Everything `createTask` needs: where Backstage is, the token, the artifact + payload. */
export interface CreateTaskRequest {
  baseUrl: string;
  token?: string;
  artifact: CompiledArtifact;
  values: Record<string, unknown>;
  secrets?: Record<string, string>;
}

/**
 * Derive the catalog `templateRef` for an artifact: `template:default/<metadata.name>`.
 * The task endpoint resolves the template BY THIS REF from the catalog, so the name must
 * match a registered template. Throws when the entity carries no `metadata.name`.
 */
export function templateRefFor(entity: TemplateEntity): string {
  const metadata = isRecord(entity.metadata) ? entity.metadata : undefined;
  const namespace = typeof metadata?.namespace === "string" ? metadata.namespace : "default";
  const name = typeof metadata?.name === "string" ? metadata.name : undefined;
  if (!name) {
    throw new Error("Cannot create a task: the template entity has no metadata.name to build a templateRef from.");
  }
  return `template:${namespace}/${name}`;
}

/** The frontend URL a created task lives at — a link the caller can open/print. */
export function taskUrl(baseUrl: string, taskId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/create/tasks/${taskId}`;
}

/**
 * POST a real scaffolder task and classify the outcome — the same taxonomy as `dryRun`,
 * with a `created` success arm carrying the new task id + a link-able URL. Never throws
 * for an HTTP result (the consent gate is enforced by `backstageClient` before this runs).
 */
export async function createTask(
  req: CreateTaskRequest,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<CreateTaskResult> {
  const templateRef = templateRefFor(entityOf(req.artifact));
  const body = JSON.stringify({
    templateRef,
    values: req.values,
    secrets: req.secrets ?? {},
  });

  let res: FetchResponseLike;
  try {
    res = await fetchImpl(backstageUrl(req.baseUrl, TASKS_PATH), {
      method: "POST",
      headers: dryRunHeaders(req.token),
      body,
      signal,
    });
  } catch (err) {
    return { kind: "unreachable", message: unreachableMessage(req.baseUrl, err) };
  }

  const rawBody = await safeText(res);

  if (res.status === 401 || res.status === 403) {
    return { kind: "authFailed", status: res.status, message: authMessage(res.status, rawBody) };
  }

  if (res.status === 400) {
    const parsed = parseJson(rawBody);
    const errors = isRecord(parsed) ? (parsed.errors as DryRunValidationError[] | undefined) : undefined;
    if (Array.isArray(errors)) return { kind: "validationFailed", errors };
    return { kind: "serverError", status: 400, message: serverMessage(parsed, rawBody) };
  }

  if (res.ok) {
    const parsed = parseJson(rawBody);
    const taskId = isRecord(parsed) && typeof parsed.id === "string" ? parsed.id : undefined;
    if (!taskId) {
      return {
        kind: "unreachable",
        message: `Backstage accepted the task (status ${res.status}) but returned no task id.`,
      };
    }
    return { kind: "created", taskId, taskUrl: taskUrl(req.baseUrl, taskId) };
  }

  const parsed = parseJson(rawBody);
  return { kind: "serverError", status: res.status, message: serverMessage(parsed, rawBody) };
}
