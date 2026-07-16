// Backstage client tests — three layers in one file:
//
//   1. UNIT (a fake fetch): every classification of `dryRun`/`createTask`, plus the pure
//      request composers. A fake fetch drives each HTTP status + the network-throw path
//      deterministically, offline.
//   2. THE SCRIPTABLE CLIENT: config resolution (explicit wins, env fallback, the loud
//      missing-base-URL error) and the createTask CONSENT GATE (a synchronous throw
//      without the flag; a real POST with it, against a mocked fetch).
//   3. INTEGRATION (gated): real POSTs against a live, version-matched Backstage. Reads
//      `TDK_BACKSTAGE_URL` + `TDK_BACKSTAGE_TOKEN` and `skipIf`s (printing why) when unset.
//
// The dry-run unit layer moved here from the VS Code extension (`lib/dryRunClient.test.ts`)
// when the client became a core subpath export; the extension now consumes this module.

import { describe, expect, test } from "bun:test";
import {
  BACKSTAGE_TOKEN_ENV,
  BACKSTAGE_URL_ENV,
  backstageClient,
  CONSENT_GATE_MESSAGE,
  type CompiledArtifact,
  createTask,
  type DryRunRequest,
  dryRun,
  dryRunBody,
  dryRunHeaders,
  dryRunUrl,
  type FetchLike,
  type FetchResponseLike,
  MISSING_BASE_URL_MESSAGE,
  taskUrl,
  templateRefFor,
} from "./client.ts";

/** A canned response body for a fake fetch. */
function response(status: number, body: unknown, opts: { throwText?: boolean } = {}): FetchResponseLike {
  const text =
    opts.throwText === true
      ? () => Promise.reject(new Error("body read failed"))
      : () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body));
  return { status, ok: status >= 200 && status < 300, text };
}

/** A fake fetch that returns a fixed response and records the one call it received. */
function fakeFetch(res: FetchResponseLike): { fetch: FetchLike; calls: Parameters<FetchLike>[] } {
  const calls: Parameters<FetchLike>[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push([url, init]);
    return Promise.resolve(res);
  };
  return { fetch, calls };
}

/** A fake fetch that THROWS (a network-level failure). */
function throwingFetch(err: unknown): FetchLike {
  return () => Promise.reject(err);
}

/** A minimal valid dry-run request. */
function req(over: Partial<DryRunRequest> = {}): DryRunRequest {
  return {
    baseUrl: "http://localhost:7007",
    token: "tok",
    template: { apiVersion: "scaffolder.backstage.io/v1beta3", kind: "Template" },
    values: { flavor: "vanilla" },
    ...over,
  };
}

/** A minimal compiled artifact (the `{ object, yaml }` shape). */
function artifact(over: Record<string, unknown> = {}): CompiledArtifact {
  return {
    object: {
      apiVersion: "scaffolder.backstage.io/v1beta3",
      kind: "Template",
      metadata: { name: "cake-order", title: "Cake Order" },
      spec: { type: "service", parameters: [], steps: [] },
      ...over,
    },
    yaml: "apiVersion: scaffolder.backstage.io/v1beta3\nkind: Template\n",
  };
}

describe("dryRunUrl", () => {
  test("appends the dry-run path", () => {
    expect(dryRunUrl("http://localhost:7007")).toBe("http://localhost:7007/api/scaffolder/v2/dry-run");
  });
  test("tolerates a trailing slash on the base", () => {
    expect(dryRunUrl("http://localhost:7007/")).toBe("http://localhost:7007/api/scaffolder/v2/dry-run");
    expect(dryRunUrl("http://localhost:7007///")).toBe("http://localhost:7007/api/scaffolder/v2/dry-run");
  });
});

describe("dryRunBody", () => {
  test("composes the wire shape with an empty directoryContents and default secrets", () => {
    const body = JSON.parse(dryRunBody(req()));
    expect(body).toEqual({
      template: { apiVersion: "scaffolder.backstage.io/v1beta3", kind: "Template" },
      values: { flavor: "vanilla" },
      secrets: {},
      directoryContents: [],
    });
  });
  test("passes provided secrets through", () => {
    const body = JSON.parse(dryRunBody(req({ secrets: { token: "s" } })));
    expect(body.secrets).toEqual({ token: "s" });
  });
});

describe("dryRunHeaders", () => {
  test("always sets JSON content type", () => {
    expect(dryRunHeaders(undefined)["Content-Type"]).toBe("application/json");
  });
  test("adds a bearer token only when one is given", () => {
    expect(dryRunHeaders("abc").Authorization).toBe("Bearer abc");
    expect(dryRunHeaders(undefined).Authorization).toBeUndefined();
    expect(dryRunHeaders("").Authorization).toBeUndefined();
  });
});

describe("dryRun — classification (fake fetch)", () => {
  test("200 → ok, with steps/log/output/directoryContents normalized", async () => {
    const { fetch, calls } = fakeFetch(
      response(200, {
        steps: [{ id: "log", name: "Log", action: "debug:log", input: { message: "hi" } }],
        log: [{ body: { message: "Starting up task with 1 steps" } }],
        output: { links: [] },
        directoryContents: [{ path: "recipe.txt", executable: false, base64Content: "Zmxvdw==" }],
      }),
    );
    const result = await dryRun(req(), fetch);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.body.steps).toHaveLength(1);
    expect(result.body.steps[0]?.id).toBe("log");
    expect(result.body.directoryContents[0]?.path).toBe("recipe.txt");
    expect(result.body.output).toEqual({ links: [] });

    // The request went to the right URL with the right method/headers/body.
    const [url, init] = calls[0]!;
    expect(url).toBe("http://localhost:7007/api/scaffolder/v2/dry-run");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body).values).toEqual({ flavor: "vanilla" });
  });

  test("200 with missing arrays → ok with empty defaults (never crashes the renderer)", async () => {
    const { fetch } = fakeFetch(response(200, { output: 42 }));
    const result = await dryRun(req(), fetch);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.body.steps).toEqual([]);
    expect(result.body.log).toEqual([]);
    expect(result.body.directoryContents).toEqual([]);
    expect(result.body.output).toBe(42);
  });

  test("400 with { errors } → validationFailed carrying the errors", async () => {
    const { fetch } = fakeFetch(
      response(400, {
        errors: [
          {
            path: [],
            property: "instance",
            message: 'requires property "flavor"',
            name: "required",
            argument: "flavor",
          },
        ],
      }),
    );
    const result = await dryRun(req({ values: {} }), fetch);
    expect(result.kind).toBe("validationFailed");
    if (result.kind !== "validationFailed") throw new Error("expected validationFailed");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("flavor");
    expect(result.errors[0]?.name).toBe("required");
  });

  test("400 WITHOUT { errors } → serverError (a malformed 400 is not silently empty)", async () => {
    const { fetch } = fakeFetch(response(400, { error: { message: "something else" } }));
    const result = await dryRun(req(), fetch);
    expect(result.kind).toBe("serverError");
    if (result.kind !== "serverError") throw new Error("expected serverError");
    expect(result.status).toBe(400);
    expect(result.message).toContain("something else");
  });

  test("401 → authFailed pointing at refreshing the token", async () => {
    const { fetch } = fakeFetch(response(401, { error: { name: "AuthenticationError", message: "Illegal token" } }));
    const result = await dryRun(req(), fetch);
    expect(result.kind).toBe("authFailed");
    if (result.kind !== "authFailed") throw new Error("expected authFailed");
    expect(result.status).toBe(401);
    expect(result.message).toContain("401");
    expect(result.message).toContain("Illegal token");
    expect(result.message).toContain("TDK_BACKSTAGE_TOKEN");
  });

  test("403 → authFailed (forbidden)", async () => {
    const { fetch } = fakeFetch(response(403, {}));
    const result = await dryRun(req(), fetch);
    expect(result.kind).toBe("authFailed");
    if (result.kind !== "authFailed") throw new Error("expected authFailed");
    expect(result.status).toBe(403);
    expect(result.message).toContain("403");
  });

  test("500 → serverError with the server's error message (a bad template entity)", async () => {
    const { fetch } = fakeFetch(
      response(500, { error: { name: "TypeError", message: "/spec/output/text must be array" } }),
    );
    const result = await dryRun(req(), fetch);
    expect(result.kind).toBe("serverError");
    if (result.kind !== "serverError") throw new Error("expected serverError");
    expect(result.status).toBe(500);
    expect(result.message).toContain("must be array");
  });

  test("a thrown fetch (connection refused) → unreachable naming the base URL", async () => {
    const result = await dryRun(req(), throwingFetch(new Error("ECONNREFUSED")));
    expect(result.kind).toBe("unreachable");
    if (result.kind !== "unreachable") throw new Error("expected unreachable");
    expect(result.message).toContain("http://localhost:7007");
    expect(result.message).toContain("ECONNREFUSED");
  });

  test("a 200 with a non-JSON body → unreachable (a proxy/HTML error page, not a real dry-run)", async () => {
    const { fetch } = fakeFetch(response(200, "<html>bad gateway</html>"));
    const result = await dryRun(req(), fetch);
    expect(result.kind).toBe("unreachable");
    if (result.kind !== "unreachable") throw new Error("expected unreachable");
    expect(result.message).toContain("non-JSON");
  });

  test("a body-read failure degrades gracefully (does not throw)", async () => {
    const { fetch } = fakeFetch(response(500, {}, { throwText: true }));
    const result = await dryRun(req(), fetch);
    expect(result.kind).toBe("serverError");
    if (result.kind !== "serverError") throw new Error("expected serverError");
    expect(result.message).toBe("no response body");
  });

  test("no token → no Authorization header sent", async () => {
    const { fetch, calls } = fakeFetch(response(200, { steps: [], log: [], output: {}, directoryContents: [] }));
    await dryRun(req({ token: undefined }), fetch);
    expect(calls[0]![1].headers.Authorization).toBeUndefined();
  });

  test("an abort (the timeout path) classifies as unreachable, not a hang", async () => {
    const abort = new AbortController();
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      });
    setTimeout(() => abort.abort(), 5);
    const result = await dryRun(
      { baseUrl: "http://localhost:9", token: "t", template: {}, values: {} },
      hanging,
      abort.signal,
    );
    expect(result.kind).toBe("unreachable");
  });

  test("a bearer token embedded in an error message is scrubbed from every arm", async () => {
    const throwing: FetchLike = () => {
      throw new Error("proxy rejected request with header Authorization: Bearer super-secret-token");
    };
    const unreachable = await dryRun({ baseUrl: "http://x", token: "t", template: {}, values: {} }, throwing);
    expect(unreachable.kind).toBe("unreachable");
    expect(JSON.stringify(unreachable)).not.toContain("super-secret-token");
    expect((unreachable as { message: string }).message).toContain("Bearer ***");

    const echoing: FetchLike = () =>
      Promise.resolve({
        status: 500,
        ok: false,
        text: () => Promise.resolve(JSON.stringify({ error: { message: "saw Bearer super-secret-token" } })),
      });
    const server = await dryRun({ baseUrl: "http://x", token: "t", template: {}, values: {} }, echoing);
    expect(JSON.stringify(server)).not.toContain("super-secret-token");
  });
});

describe("templateRefFor / taskUrl", () => {
  test("derives template:<namespace>/<name>, defaulting the namespace", () => {
    expect(templateRefFor({ metadata: { name: "cake-order" } })).toBe("template:default/cake-order");
    expect(templateRefFor({ metadata: { name: "cake-order", namespace: "bakery" } })).toBe(
      "template:bakery/cake-order",
    );
  });
  test("throws a clear error when there is no metadata.name", () => {
    expect(() => templateRefFor({})).toThrow(/metadata.name/);
    expect(() => templateRefFor({ metadata: {} })).toThrow(/metadata.name/);
  });
  test("builds a frontend task URL, tolerating a trailing slash", () => {
    expect(taskUrl("http://localhost:7007", "abc123")).toBe("http://localhost:7007/create/tasks/abc123");
    expect(taskUrl("http://localhost:7007/", "abc123")).toBe("http://localhost:7007/create/tasks/abc123");
  });
});

describe("backstageClient — config resolution", () => {
  test("explicit config wins over the environment", () => {
    const client = backstageClient({
      baseUrl: "http://explicit:7007",
      token: "explicit-tok",
      env: { [BACKSTAGE_URL_ENV]: "http://env:7007", [BACKSTAGE_TOKEN_ENV]: "env-tok" },
    });
    expect(client.baseUrl).toBe("http://explicit:7007");
  });

  test("falls back to the environment when config omits baseUrl/token", () => {
    const client = backstageClient({
      env: { [BACKSTAGE_URL_ENV]: "http://env:7007", [BACKSTAGE_TOKEN_ENV]: "env-tok" },
    });
    expect(client.baseUrl).toBe("http://env:7007");
  });

  test("a dryRun with no resolvable base URL throws the loud two-source error", async () => {
    const client = backstageClient({ env: {} });
    expect(client.baseUrl).toBeUndefined();
    await expect(client.dryRun(artifact(), { values: {} })).rejects.toThrow(MISSING_BASE_URL_MESSAGE);
    // The message names BOTH sources so the fix is obvious.
    await expect(client.dryRun(artifact(), { values: {} })).rejects.toThrow(/baseUrl/);
    await expect(client.dryRun(artifact(), { values: {} })).rejects.toThrow(new RegExp(BACKSTAGE_URL_ENV));
  });

  test("dryRun sends the artifact's object as the wire template and the token as bearer", async () => {
    const { fetch, calls } = fakeFetch(response(200, { steps: [], log: [], output: {}, directoryContents: [] }));
    const client = backstageClient({ baseUrl: "http://localhost:7007", token: "env-tok", fetch });
    const result = await client.dryRun(artifact(), { values: { flavor: "vanilla" } });
    expect(result.kind).toBe("ok");
    const [url, init] = calls[0]!;
    expect(url).toBe("http://localhost:7007/api/scaffolder/v2/dry-run");
    expect(init.headers.Authorization).toBe("Bearer env-tok");
    const body = JSON.parse(init.body);
    expect(body.template.metadata.name).toBe("cake-order");
    expect(body.values).toEqual({ flavor: "vanilla" });
  });
});

describe("backstageClient — the createTask consent gate", () => {
  test("createTask THROWS SYNCHRONOUSLY without allowTaskCreation (never a swallowed rejection)", () => {
    const { fetch } = fakeFetch(response(201, { id: "should-never-be-called" }));
    const client = backstageClient({ baseUrl: "http://localhost:7007", token: "t", fetch });
    // A synchronous throw — not a rejected promise. `expect(fn).toThrow` proves it is
    // thrown before any Promise (and thus any network call) is created.
    let called = false;
    const guarded = () => {
      called = true;
      return client.createTask(artifact(), { values: {} });
    };
    expect(guarded).toThrow(CONSENT_GATE_MESSAGE);
    expect(called).toBe(true);
  });

  test("the consent message explains WHY (real side effects) and HOW (the flag)", () => {
    const client = backstageClient({ baseUrl: "http://localhost:7007" });
    expect(() => client.createTask(artifact(), { values: {} })).toThrow(/real/i);
    expect(() => client.createTask(artifact(), { values: {} })).toThrow(/allowTaskCreation/);
  });

  test("with the flag, createTask POSTs to /v2/tasks and returns the created task id + URL", async () => {
    const { fetch, calls } = fakeFetch(response(201, { id: "task-abc-123" }));
    const client = backstageClient({ baseUrl: "http://localhost:7007", token: "t", allowTaskCreation: true, fetch });
    const result = await client.createTask(artifact(), { values: { flavor: "vanilla" } });
    expect(result.kind).toBe("created");
    if (result.kind !== "created") throw new Error("expected created");
    expect(result.taskId).toBe("task-abc-123");
    expect(result.taskUrl).toBe("http://localhost:7007/create/tasks/task-abc-123");

    const [url, init] = calls[0]!;
    expect(url).toBe("http://localhost:7007/api/scaffolder/v2/tasks");
    const body = JSON.parse(init.body);
    expect(body.templateRef).toBe("template:default/cake-order");
    expect(body.values).toEqual({ flavor: "vanilla" });
  });
});

describe("createTask — classification (fake fetch)", () => {
  const taskReq = () => ({ baseUrl: "http://localhost:7007", token: "t", artifact: artifact(), values: {} });

  test("201 with an id → created", async () => {
    const { fetch } = fakeFetch(response(201, { id: "t1" }));
    const result = await createTask(taskReq(), fetch);
    expect(result.kind).toBe("created");
  });

  test("a 2xx without an id → unreachable (accepted but nothing to link to)", async () => {
    const { fetch } = fakeFetch(response(201, {}));
    const result = await createTask(taskReq(), fetch);
    expect(result.kind).toBe("unreachable");
    if (result.kind !== "unreachable") throw new Error("expected unreachable");
    expect(result.message).toContain("no task id");
  });

  test("400 { errors } → validationFailed", async () => {
    const { fetch } = fakeFetch(response(400, { errors: [{ message: 'requires property "flavor"' }] }));
    const result = await createTask(taskReq(), fetch);
    expect(result.kind).toBe("validationFailed");
  });

  test("401 → authFailed; 404 → serverError; thrown → unreachable", async () => {
    expect((await createTask(taskReq(), fakeFetch(response(401, {})).fetch)).kind).toBe("authFailed");
    expect(
      (await createTask(taskReq(), fakeFetch(response(404, { error: { message: "no such template" } })).fetch)).kind,
    ).toBe("serverError");
    expect((await createTask(taskReq(), throwingFetch(new Error("ECONNREFUSED")))).kind).toBe("unreachable");
  });
});

// --- INTEGRATION (gated on a live Backstage) --------------------------------------
//
// Reads TDK_BACKSTAGE_URL + TDK_BACKSTAGE_TOKEN; skips (with a printed reason) when
// unset. Export the vars and run locally against the live backend:
//   TDK_BACKSTAGE_URL=http://localhost:7007 TDK_BACKSTAGE_TOKEN=<token> \
//   bun test packages/core/src/backstage/client.test.ts

const LIVE_URL = process.env.TDK_BACKSTAGE_URL;
const LIVE_TOKEN = process.env.TDK_BACKSTAGE_TOKEN;
const liveConfigured = Boolean(LIVE_URL && LIVE_TOKEN);
if (!liveConfigured) {
  console.log(
    "[backstage client] SKIPPING the live integration test — set TDK_BACKSTAGE_URL and TDK_BACKSTAGE_TOKEN to run it against a live Backstage.",
  );
}

/** A minimal valid bakery template entity for the live dry-run. */
const LIVE_TEMPLATE = {
  apiVersion: "scaffolder.backstage.io/v1beta3",
  kind: "Template",
  metadata: { name: "cake-order", title: "Cake Order" },
  spec: {
    type: "service",
    owner: "bakery",
    parameters: [{ properties: { flavor: { type: "string", title: "Flavor" } }, required: ["flavor"] }],
    steps: [{ id: "log", name: "Log", action: "debug:log", input: { message: "Flavor: ${{ parameters.flavor }}" } }],
    output: { links: [] },
  },
};

describe("backstage client — live integration (gated)", () => {
  test.skipIf(!liveConfigured)("dryRun of a compiled artifact reports the executed step", async () => {
    const client = backstageClient({ baseUrl: LIVE_URL, token: LIVE_TOKEN });
    const result = await client.dryRun({ object: LIVE_TEMPLATE }, { values: { flavor: "vanilla" } });
    console.log(`[backstage client] live dryRun (client) → ${result.kind}`);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.body.steps.some((s) => s.id === "log")).toBe(true);
    console.log(
      `[backstage client] steps: ${result.body.steps.map((s) => s.id).join(", ")}, log lines: ${result.body.log.length}`,
    );
  });

  test.skipIf(!liveConfigured)("dryRun of a missing required value fails server-side validation (400)", async () => {
    const client = backstageClient({ baseUrl: LIVE_URL, token: LIVE_TOKEN });
    const result = await client.dryRun({ object: LIVE_TEMPLATE }, { values: {} });
    console.log(`[backstage client] live missing-required dryRun → ${result.kind}`);
    expect(result.kind).toBe("validationFailed");
  });

  test.skipIf(!liveConfigured)("dryRun with a bad token is rejected (authFailed)", async () => {
    const client = backstageClient({ baseUrl: LIVE_URL, token: "totally-invalid-token" });
    const result = await client.dryRun({ object: LIVE_TEMPLATE }, { values: { flavor: "vanilla" } });
    console.log(`[backstage client] live bad-token dryRun → ${result.kind}`);
    expect(result.kind).toBe("authFailed");
  });

  // createTask has REAL side effects (it kicks off a scaffolder run), so it is DOUBLE-
  // gated: the live vars AND an explicit opt-in `TDK_BACKSTAGE_ALLOW_CREATE_TASK=1`, and it
  // needs a harmless debug:log-only template ALREADY REGISTERED in the catalog (named by
  // `TDK_BACKSTAGE_TASK_TEMPLATE`, default `tdk-cake-order`). `createTask` derives its
  // `templateRef` from the artifact's `metadata.name`, so the artifact's name must match.
  const allowCreate = liveConfigured && process.env.TDK_BACKSTAGE_ALLOW_CREATE_TASK === "1";
  const TASK_TEMPLATE_NAME = process.env.TDK_BACKSTAGE_TASK_TEMPLATE ?? "tdk-cake-order";
  test.skipIf(!allowCreate)("createTask (consent granted) returns a task id + a link-able URL", async () => {
    const client = backstageClient({ baseUrl: LIVE_URL, token: LIVE_TOKEN, allowTaskCreation: true });
    const artifact = { object: { ...LIVE_TEMPLATE, metadata: { name: TASK_TEMPLATE_NAME } } };
    const result = await client.createTask(artifact, { values: { flavor: "vanilla" } });
    console.log(`[backstage client] live createTask → ${result.kind}`);
    if (result.kind === "created") {
      console.log(`[backstage client] task id: ${result.taskId}, url: ${result.taskUrl}`);
    } else {
      console.log(`[backstage client] createTask non-created: ${JSON.stringify(result)}`);
    }
    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;
    expect(result.taskId.length).toBeGreaterThan(0);
    expect(result.taskUrl).toContain("/create/tasks/");
  });
});
