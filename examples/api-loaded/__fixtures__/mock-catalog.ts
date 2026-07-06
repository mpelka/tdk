// A local, loopback-only catalog server — the mock the flavour endpoint stands in for.
//
// One helper, shared by two callers:
//   · template.test.ts spins it to exercise the REAL load() fetch (the mock-server
//     recipe this example exists for);
//   · scenarios.ts binds it at import time so `tdk test`'s preflight compile (which
//     calls the real load() once, before scenarios inject their `loaded`) stays on
//     loopback and never touches the internet.
//
// It binds port 0 (ephemeral), so parallel test files never collide. Swap this block
// for msw's setupServer if your components already standardise on msw — the contract
// (GET /api/:env/flavours → { flavours }) is identical.

/** The env-keyed catalogs the mock serves — the TEST catalog lacks pistachio-royale. */
export const CATALOGS: Record<string, string[]> = {
  test: ["vanilla", "chocolate"],
  prod: ["vanilla", "chocolate", "pistachio-royale"],
};

/** A running mock: its origin, the paths it was asked for, and a stop() to tear down. */
export interface MockCatalog {
  /** The `http://127.0.0.1:<port>` origin to point `BAKERY_MENU_API` at. */
  origin: string;
  /** Every request pathname the server saw, in order (asserts the fetch really ran). */
  requestedPaths: string[];
  /** Stop the server and free the port. */
  stop: () => void;
}

/**
 * Start the local catalog server: `GET /api/:env/flavours → { flavours }`, 404 for an
 * unknown env — the same contract a real catalog would honour.
 *
 * Pass `{ unref: true }` for a fire-and-forget server that does NOT hold the event loop
 * open — `scenarios.ts` uses it, so `tdk test` can exit without an explicit `stop()`.
 * A test with a lifecycle (beforeAll/afterAll) leaves `unref` off and calls `stop()`.
 */
export function startMockCatalog(opts: { unref?: boolean } = {}): MockCatalog {
  const requestedPaths: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      requestedPaths.push(pathname);
      const match = pathname.match(/^\/api\/([^/]+)\/flavours$/);
      const flavours = match ? CATALOGS[match[1]!] : undefined;
      if (!flavours) {
        return new Response("not found", { status: 404 });
      }
      return Response.json({ flavours });
    },
  });
  if (opts.unref) {
    server.unref();
  }
  return {
    origin: server.url.origin,
    requestedPaths,
    stop: () => server.stop(true),
  };
}
