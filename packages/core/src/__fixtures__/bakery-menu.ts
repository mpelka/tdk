// A synthetic "live bakery catalog" client for the load() fixtures.
//
// Stands in for an internal plugin client (a catalog / directory / provisioning API) that a template
// would call at compile time. It returns DIFFERENT menus per env so tests can
// prove that `load({ env })` bakes env-specific options into the YAML. In template
// tests the data is either injected (a fixture's `loaded`) or this is called for
// real — there is nothing TDK-specific to mock here.

// `env` is an open string (a project can run any env set), so these tables key
// off known env names and fall back to the test menu for anything else — the
// idiomatic shape for an adopter's own env-keyed data source.
const FLAVORS: Record<string, string[]> = {
  test: ["Vanilla", "Chocolate"],
  prod: ["Vanilla", "Chocolate", "Red Velvet", "Carrot"],
};

const SIZES: Record<string, string[]> = {
  test: ["Small"],
  prod: ["Small", "Medium", "Large"],
};

/** Tracks how many times each endpoint was hit — lets tests assert load caching. */
export const bakeryCalls = { flavors: 0, sizes: 0 };

/** Reset the call counters between tests. */
export function resetBakeryCalls(): void {
  bakeryCalls.flavors = 0;
  bakeryCalls.sizes = 0;
}

export const bakery = {
  async flavors(env: string): Promise<string[]> {
    bakeryCalls.flavors++;
    return FLAVORS[env] ?? FLAVORS.test;
  },
  async sizes(env: string): Promise<string[]> {
    bakeryCalls.sizes++;
    return SIZES[env] ?? SIZES.test;
  },
};
