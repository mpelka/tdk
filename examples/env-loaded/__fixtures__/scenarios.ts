// Scenario fixtures for the Seasonal Menu Publisher.
//
// This is a `load()` template — each fixture injects the loaded menu via `loaded`
// (the deterministic fixture-tier mock) so the run never touches the stub client.
// `tdk test` runs scenarios in the TEST env, so these bake the TEST menu; the
// prod-target behaviour (the pistachio-royale enum + prod-oven) is asserted
// directly in template.test.ts, which can pass a prod target to execute().
//
// `publish` is a custom action with no simulator, so its output is mocked.

import type { ExecuteFixture } from "@tdk/core";

type MenuParams = {
  featuredFlavour: string;
  headline: string;
} & Record<string, unknown>;

interface Scenario {
  name: string;
  branches?: string[];
  fixture: ExecuteFixture<MenuParams>;
}

// The test menu the fixtures inject (matches load()'s test-env result).
const testMenu = { flavours: ["vanilla", "chocolate"] };

export const scenarios: Scenario[] = [
  {
    name: "publish vanilla (test menu)",
    branches: ["vanilla"],
    fixture: {
      loaded: testMenu,
      parameters: { featuredFlavour: "vanilla", headline: "Fresh vanilla, all week" },
      steps: { publish: { output: { url: "https://storefront.example/menu" } } },
    },
  },
  {
    name: "publish chocolate (test menu)",
    branches: ["chocolate"],
    fixture: {
      loaded: testMenu,
      parameters: { featuredFlavour: "chocolate", headline: "Double chocolate season" },
      steps: { publish: { output: { url: "https://storefront.example/menu" } } },
    },
  },
  {
    name: "publish with a long headline",
    branches: ["headline"],
    fixture: {
      loaded: testMenu,
      parameters: {
        featuredFlavour: "vanilla",
        headline: "Our seasonal vanilla is back — pre-order now for the weekend rush",
      },
      steps: { publish: { output: { url: "https://storefront.example/menu" } } },
    },
  },
];
