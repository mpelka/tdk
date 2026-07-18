// EXAMPLE 6 — "Storefront Flavour Picker": a REAL network load().
//
// ⚠️ DELIBERATELY V1 (authoring-v1) — kept on the `load()` template surface, for the
// same reason as env-loaded: the authoring-v2 `{ pages, effects, output }` config has
// no `load()` hook, and this template's `featuredFlavour` enum is built from the
// awaited `load()` data (`parameters: (data) => …`). Stays v1 until the v2 surface
// grows a loader (ADR-0025 phase 4, #19).
//
// This is the sibling of env-loaded (the Seasonal Menu Publisher). Where that one
// loads from an in-process stub, THIS one's `load(ctx)` does a real `fetch` against
// an HTTP endpoint and bakes the returned flavours into the form. It exists to prove
// two things end-to-end:
//
//   1. `load()` can drive a genuine HTTP call — `fetch(...)`, parse JSON, map it into
//      params — and the async compile path (compileResolved / compileAll) threads the
//      result into the baked enum, per env.
//   2. There are TWO ways to test such a template, and this kit shows BOTH:
//        · the fixture tier — scenarios inject `loaded: {…}` so `tdk test` never hits
//          the network (see __fixtures__/scenarios.ts + __snapshots__);
//        · the mock-server tier — a test spins a local `Bun.serve` catalog on an
//          ephemeral port, points the base URL at it, and runs the REAL load() path
//          (see template.test.ts, "real load() against a local mock").
//
// The base URL is INJECTABLE (an env var over a module default) so the mock-server
// test can redirect the fetch without touching the template. The default host is a
// synthetic bakery domain — never a real endpoint.

import { defineTemplate, env, type LoadContext, p, page, step } from "@tdk/core";

// --- The catalog endpoint (injectable base URL) ---------------------------------
//
// The default points at a synthetic bakery host that is never actually reached in
// tests: the fixture tier injects `loaded` (no fetch at all), and the mock-server
// tier overrides `BAKERY_MENU_API` to a local `Bun.serve` origin. An adopter would
// set `BAKERY_MENU_API` to their real catalog service per environment.
const DEFAULT_MENU_API = "https://menu.bakery.example";

/** The catalog base URL — env var wins, else the synthetic default. */
export function menuApiBaseUrl(): string {
  return process.env.BAKERY_MENU_API ?? DEFAULT_MENU_API;
}

/** The shape the catalog endpoint returns: `{ flavours: string[] }`. */
interface MenuResponse {
  flavours: string[];
}

/**
 * The real network loader. Fetches the env-specific flavour catalog over HTTP and
 * maps it into the loaded data. `env` selects the catalog path, so test and prod
 * legitimately bake different flavours.
 */
export const load = async ({ env }: LoadContext) => {
  const url = `${menuApiBaseUrl()}/api/${env}/flavours`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`menu catalog fetch failed for env "${env}": ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as MenuResponse;
  return { flavours: body.flavours };
};

export const StorefrontFlavourPicker = defineTemplate({
  id: "storefront-flavour-picker",
  title: "Storefront Flavour Picker",
  description: "Pick the featured flavour from the live storefront catalog.",
  type: "service",
  tags: ["bakery", "menu", "catalog"],
  owner: "team-bakery",
  load,
  // `data` is the awaited load() result: { flavours: string[] } — fetched over HTTP.
  // The env-specific catalog becomes the enum options, so each target bakes its own
  // flavour set.
  parameters: (data) => [
    page("Storefront", {
      featuredFlavour: p.enum(data.flavours, { title: "Featured flavour", required: true }),
      headline: p.string({ title: "Storefront headline", required: true }),
    }),
  ],
  steps: (f) => [
    step("publish", "bakery:publish-menu", {
      name: "Publish to the storefront",
      input: {
        featuredFlavour: f.featuredFlavour,
        headline: f.headline,
        // Per-env storefront shelf — env.pick, never a hardcoded prod value.
        shelf: env.pick({ test: "test-shelf", prod: "prod-shelf" }),
      },
    }),
  ],
  output: (f) => ({ featured: f.featuredFlavour }),
});
