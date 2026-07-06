// The Backstage dry-run client (issue #3, phase 3) — the ONE place a compiled
// template becomes a `POST /api/scaffolder/v2/dry-run` request and the response
// becomes a typed, classified result. Pure-ish: `fetch` is INJECTED (the caller
// passes VS Code's / Node's global), so every classification is unit-testable with a
// fake fetch, and one gated integration test drives it against a live Backstage.
//
// THE CONTRACT (verified against the version-matched local Backstage source):
//   POST {baseUrl}/api/scaffolder/v2/dry-run
//     body: { template: <compiled entity JSON>, values, secrets?, directoryContents: [] }
//     headers: Content-Type: application/json, Authorization: Bearer <token> (optional)
//   → 200 { steps, log, output, directoryContents: [{ path, executable, base64Content }] }
//   → 400 { errors: [{ message, ... }] }  when `values` fail server-side param validation
//   → 401/403                              when the bearer token is present but rejected
//
// THE TAXONOMY. `dryRun()` never throws for an HTTP outcome — it returns a discriminated
// `DryRunResult` the submit flow renders directly:
//   - `ok`               — 200: the executed steps, the run log, the output, the files.
//   - `validationFailed` — 400: the server-side `{ errors }` (free payload validation,
//                          even for custom fields), rendered readably in the trace panel.
//   - `authFailed`       — 401/403: the token is missing/expired/wrong; points the user
//                          at `TDK: Set Backstage Token`.
//   - `unreachable`      — the request never completed (connection refused, DNS, timeout,
//                          fetch threw) OR a 2xx body that could not be parsed as JSON.
//                          Points the user at the `tdk.backstage.baseUrl` setting.
//   - `serverError`      — any OTHER non-2xx (a 5xx, or a 4xx that isn't 400/401/403),
//                          carrying the status + the server's best-effort error message
//                          (Backstage wraps a bad `template` entity as a 500 TypeError).

/** A compiled Backstage Template entity — the JSON we parsed out of the compiled YAML. */
export type TemplateEntity = Record<string, unknown>;

/** One `directoryContents` entry the dry-run emits: a path, its exec bit, base64 body. */
export interface DirectoryFile {
  path: string;
  executable?: boolean;
  base64Content: string;
}

/**
 * One log entry from the run. Backstage nests the useful fields under `body`
 * (`{ body: { stepId?, status?, message } }`) — we keep the raw shape and read
 * `body.stepId` / `body.message` when grouping the log by step (see logGrouping.ts).
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

/** The discriminated result of one dry-run attempt — the submit flow renders it directly. */
export type DryRunResult =
  | { kind: "ok"; body: DryRunSuccessBody }
  | { kind: "validationFailed"; errors: DryRunValidationError[] }
  | { kind: "authFailed"; status: number; message: string }
  | { kind: "serverError"; status: number; message: string }
  | { kind: "unreachable"; message: string };

/** The minimal `Response` surface `dryRun` reads — status + a `text()` body. */
export interface FetchResponseLike {
  status: number;
  ok: boolean;
  text(): Promise<string>;
}

/** The minimal `fetch` surface `dryRun` depends on — injectable, so tests fake it. */
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
  /** The `tdk.backstage.baseUrl` setting, e.g. `http://localhost:7007` (a trailing slash is fine). */
  baseUrl: string;
  /** The bearer token from SecretStorage, or undefined when none is set. */
  token?: string;
  /** The compiled template entity (parsed from the compiled YAML). */
  template: TemplateEntity;
  /** The form's current values (the parameters payload the server validates). */
  values: Record<string, unknown>;
  /** Optional secrets to pass through (redacted in the run log by the server). */
  secrets?: Record<string, string>;
}

/** The dry-run path appended to the base URL — the one endpoint this client speaks to. */
export const DRY_RUN_PATH = "/api/scaffolder/v2/dry-run";

/** Join the base URL and the dry-run path, tolerating a trailing slash on the base. */
export function dryRunUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${DRY_RUN_PATH}`;
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
 * `fetchImpl` is injected so the caller supplies the runtime's `fetch` (VS Code's
 * global in production) and tests supply a fake — the whole reason this module is
 * pure. `signal`, when given, is forwarded to `fetch` for cancellation/timeout.
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
  return `Could not reach Backstage at ${baseUrl}. Check that it is running and that tdk.backstage.baseUrl is correct. (${detail})`;
}

/** The `authFailed` message — names the fix (the set-token command). */
function authMessage(status: number, rawBody: string): string {
  const server = scrubAuth(extractErrorMessage(parseJson(rawBody)) ?? "") || undefined;
  const base =
    status === 401
      ? "Backstage rejected the token (401 Unauthorized)."
      : "Backstage forbade the request (403 Forbidden).";
  const hint = "Set or refresh it with the TDK: Set Backstage Token command.";
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
