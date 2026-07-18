// EXAMPLE 4 — "Seasonal Menu Publisher": the env-loaded (compile-time data + env
// safety) stress test.
//
// ⚠️ DELIBERATELY V1 (authoring-v1) — kept on the `load()` template surface. The
// authoring-v2 config (`{ pages, effects, output }`) has no `load()` hook: v2 fields
// are module-scope consts, but this template's `featuredFlavour` enum is built from
// the awaited `load()` data (`parameters: (data) => …`), which only the v1 config
// shape expresses. So env-loaded (and its sibling api-loaded) stay v1 until the v2
// surface grows a loader (ADR-0025 phase 4, #31). It still uses the v2 SUGAR it can.
//
// This template proves TDK's per-env compile is env-SAFE by construction:
//   - `load({ env })` fetches the seasonal menu at COMPILE time (a stub client
//     below). It is env-aware — TEST bakes a two-flavour menu, PROD bakes a
//     three-flavour menu including the prod-only "pistachio-royale". That value
//     therefore appears ONLY in the prod artifact (invariant a).
//   - `env.pick({ test, prod })` selects the oven cluster per target (test-oven /
//     prod-oven) — never a hardcoded prod value.
//   - `lifecycle: { state: "beta", restrictedToUsers: ["baker-042"] }` restricts the
//     template while it is pre-GA — `restrictedToUsers` is emitted in both artifacts
//     (invariant b).
//   - one `extraSpec` key (`bakery_catalogue_metadata`) passes through VERBATIM
//     (invariant c).
//
// TWO golds: gold-standard.nonprod.yaml and gold-standard.prod.yaml. The tests
// compile BOTH targets (compileResolved / compileAll) and diff each against its gold.

import { defineTemplate, env, type LoadContext, p, page, step } from "@tdk/core";

// --- A synthetic "seasonal menu" client (the stub the spec asks to live here) ---
// Stands in for an internal catalog API called at compile time. It returns a
// DIFFERENT menu per env so the baked enum options differ between the two golds.
// `env` is an open string, so the menu keys off known env names and falls back
// to the test menu for anything else — the idiomatic shape for an adopter's own
// env-keyed data source.
const SEASONAL_MENU: Record<string, string[]> = {
  test: ["vanilla", "chocolate"],
  // "pistachio-royale" is PROD-ONLY — it must never surface in the test artifact.
  prod: ["vanilla", "chocolate", "pistachio-royale"],
};

/** The stub menu client — one method, env-aware, no TDK-specific mocking needed. */
export const menuClient = {
  async flavours(env: string): Promise<string[]> {
    return SEASONAL_MENU[env] ?? SEASONAL_MENU.test;
  },
};

export const load = async ({ env }: LoadContext) => ({
  flavours: await menuClient.flavours(env),
});

export const SeasonalMenuPublisher = defineTemplate({
  id: "seasonal-menu-publisher",
  title: "Seasonal Menu Publisher",
  description: "Publish the seasonal cake menu to the storefront.",
  type: "service",
  tags: ["bakery", "menu", "seasonal"],
  owner: "team-bakery",
  // Pre-GA: restricted to the pilot baker while in beta.
  lifecycle: { state: "beta", restrictedToUsers: ["baker-042"] },
  // A custom top-level spec key TDK does not model — passed through verbatim.
  extraSpec: {
    bakery_catalogue_metadata: { category_L1: "Signature Bakes", refresh_cadence: "weekly" },
  },
  load,
  // `data` is the awaited load() result: { flavours: string[] }. The env-specific
  // menu becomes the enum options — so each target bakes its own flavour set.
  parameters: (data) => [
    page("Menu", {
      featuredFlavour: p.enum(data.flavours, { title: "Featured flavour", required: true }),
      headline: p.string({ title: "Storefront headline", required: true }),
    }),
  ],
  steps: (f) => [
    step("publish", "bakery:publish-menu", {
      name: "Publish the menu",
      input: {
        featuredFlavour: f.featuredFlavour,
        headline: f.headline,
        // Per-env oven cluster — env.pick, never a hardcoded prod value.
        cluster: env.pick({ test: "test-oven", prod: "prod-oven" }),
      },
    }),
  ],
  output: (f) => ({ featured: f.featuredFlavour }),
});
