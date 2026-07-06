// dryRunClient tests — two layers in one file:
//
//   1. UNIT (a fake fetch): every classification of `dryRun`, plus the pure request
//      composers (`dryRunUrl`/`dryRunBody`/`dryRunHeaders`). A fake fetch lets us drive
//      each HTTP status + the network-throw path deterministically, offline.
//
//   2. INTEGRATION (gated): one real POST against a live, version-matched Backstage.
//      It reads `TDK_BACKSTAGE_URL` + `TDK_BACKSTAGE_TOKEN` from the env and `skipIf`s
//      (printing why) when they're unset — CI has no Backstage, so it never runs there;
//      you run it locally against the live backend and paste the output in the PR.

import { describe, expect, test } from "bun:test";
import {
  type DryRunRequest,
  dryRun,
  dryRunBody,
  dryRunHeaders,
  dryRunUrl,
  type FetchLike,
  type FetchResponseLike,
} from "./dryRunClient.ts";

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

/** A minimal valid request. */
function req(over: Partial<DryRunRequest> = {}): DryRunRequest {
  return {
    baseUrl: "http://localhost:7007",
    token: "tok",
    template: { apiVersion: "scaffolder.backstage.io/v1beta3", kind: "Template" },
    values: { flavor: "vanilla" },
    ...over,
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

  test("401 → authFailed pointing at the set-token command", async () => {
    const { fetch } = fakeFetch(response(401, { error: { name: "AuthenticationError", message: "Illegal token" } }));
    const result = await dryRun(req(), fetch);
    expect(result.kind).toBe("authFailed");
    if (result.kind !== "authFailed") throw new Error("expected authFailed");
    expect(result.status).toBe(401);
    expect(result.message).toContain("401");
    expect(result.message).toContain("Illegal token");
    expect(result.message).toContain("Set Backstage Token");
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
    expect(result.message).toContain("tdk.backstage.baseUrl");
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
});

// --- INTEGRATION (gated on a live Backstage) --------------------------------------
//
// Reads TDK_BACKSTAGE_URL + TDK_BACKSTAGE_TOKEN; skips (with a printed reason) when
// unset. Export the vars from the token file and run locally against the live backend:
//   TDK_BACKSTAGE_URL=http://localhost:7007 \
//   TDK_BACKSTAGE_TOKEN=$(cat …/backstage-token.txt) \
//   bun test apps/vscode/src/lib/dryRunClient.test.ts

const LIVE_URL = process.env.TDK_BACKSTAGE_URL;
const LIVE_TOKEN = process.env.TDK_BACKSTAGE_TOKEN;
const liveConfigured = Boolean(LIVE_URL && LIVE_TOKEN);
if (!liveConfigured) {
  console.log(
    "[dryRunClient] SKIPPING the live integration test — set TDK_BACKSTAGE_URL and TDK_BACKSTAGE_TOKEN to run it against a live Backstage.",
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

describe("dryRun — live Backstage integration (gated)", () => {
  test.skipIf(!liveConfigured)("a valid payload dry-runs and reports the executed step", async () => {
    const result = await dryRun(
      { baseUrl: LIVE_URL!, token: LIVE_TOKEN, template: LIVE_TEMPLATE, values: { flavor: "vanilla" } },
      fetch as unknown as FetchLike,
    );
    console.log(`[dryRunClient] live valid dry-run → ${result.kind}`);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.body.steps.some((s) => s.id === "log")).toBe(true);
    expect(result.body.log.length).toBeGreaterThan(0);
    console.log(`[dryRunClient] steps: ${result.body.steps.map((s) => s.id).join(", ")}`);
    console.log(`[dryRunClient] log lines: ${result.body.log.length}, files: ${result.body.directoryContents.length}`);
  });

  test.skipIf(!liveConfigured)("a missing required value fails server-side validation (400)", async () => {
    const result = await dryRun(
      { baseUrl: LIVE_URL!, token: LIVE_TOKEN, template: LIVE_TEMPLATE, values: {} },
      fetch as unknown as FetchLike,
    );
    console.log(`[dryRunClient] live missing-required dry-run → ${result.kind}`);
    expect(result.kind).toBe("validationFailed");
    if (result.kind !== "validationFailed") return;
    expect(result.errors.length).toBeGreaterThan(0);
    console.log(`[dryRunClient] validation errors: ${result.errors.map((e) => e.message).join(" | ")}`);
  });

  test.skipIf(!liveConfigured)("a bad token is rejected (authFailed)", async () => {
    const result = await dryRun(
      { baseUrl: LIVE_URL!, token: "totally-invalid-token", template: LIVE_TEMPLATE, values: { flavor: "vanilla" } },
      fetch as unknown as FetchLike,
    );
    console.log(`[dryRunClient] live bad-token dry-run → ${result.kind}`);
    expect(result.kind).toBe("authFailed");
  });
});

describe("verifier regressions on #69", () => {
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
        text: () => Promise.resolve(JSON.stringify({ error: { message: "saw Bearer super-secret-token" } })),
      } as Awaited<ReturnType<FetchLike>>);
    const server = await dryRun({ baseUrl: "http://x", token: "t", template: {}, values: {} }, echoing);
    expect(JSON.stringify(server)).not.toContain("super-secret-token");
  });
});
