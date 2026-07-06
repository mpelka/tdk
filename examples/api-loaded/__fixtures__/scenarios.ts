// Scenario fixtures for the Storefront Flavour Picker.
//
// This is a REAL-network `load()` template — its loader does an HTTP `fetch`. Two
// things keep `tdk test` hermetic (never the internet):
//
//   1. Each fixture injects the catalog via `loaded` (the fixture-tier mock). That
//      skips `load()` entirely, so the scenario RUN never fetches.
//   2. `tdk test` also preflight-compiles the template once before running scenarios,
//      and that preflight calls the real `load()` (it has no fixture to inject). So we
//      bind a local, loopback-only catalog server at import time and point the
//      template's injectable base URL at it. The preflight fetch hits 127.0.0.1, not
//      the internet. The server is a module-level fixture (alive for the run, like
//      msw's setupServer); the process frees it on exit.
//
// `tdk test` runs scenarios in the TEST env, so these bake the TEST catalog; the
// prod-target behaviour (the pistachio-royale enum + prod-shelf) is asserted directly
// in template.test.ts, which passes a prod target.
//
// `publish` is a custom action with no simulator, so its output is mocked.

import type { ExecuteFixture } from "@tdk/core";
import { CATALOGS, startMockCatalog } from "./mock-catalog.ts";

// Bind the loopback catalog and redirect the template's fetch to it, so `tdk test`'s
// preflight compile stays hermetic. `unref` so the server never holds the event loop
// open — the run exits cleanly without an explicit teardown.
const mock = startMockCatalog({ unref: true });
process.env.BAKERY_MENU_API = mock.origin;

type FlavourParams = {
  featuredFlavour: string;
  headline: string;
} & Record<string, unknown>;

interface Scenario {
  name: string;
  branches?: string[];
  fixture: ExecuteFixture<FlavourParams>;
}

// The test catalog the fixtures inject (matches the TEST endpoint's response).
const testCatalog = { flavours: CATALOGS.test };

export const scenarios: Scenario[] = [
  {
    name: "publish vanilla (test catalog)",
    branches: ["vanilla"],
    fixture: {
      loaded: testCatalog,
      parameters: { featuredFlavour: "vanilla", headline: "Fresh vanilla, all week" },
      steps: { publish: { output: { url: "https://storefront.example/menu" } } },
    },
  },
  {
    name: "publish chocolate (test catalog)",
    branches: ["chocolate"],
    fixture: {
      loaded: testCatalog,
      parameters: { featuredFlavour: "chocolate", headline: "Double chocolate season" },
      steps: { publish: { output: { url: "https://storefront.example/menu" } } },
    },
  },
  {
    name: "publish with a long headline",
    branches: ["headline"],
    fixture: {
      loaded: testCatalog,
      parameters: {
        featuredFlavour: "vanilla",
        headline: "Our seasonal vanilla is back — pre-order now for the weekend rush",
      },
      steps: { publish: { output: { url: "https://storefront.example/menu" } } },
    },
  },
];
