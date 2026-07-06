// A tiny self-contained template fixture for the CLI tests. It uses `env.pick`
// so a `--env test` vs `--env prod` compile produces observably different YAML
// (the `cluster` input), and a `raw` interpolation of a param so `execute` has
// something to compute. Kept deliberately minimal — the CLI test only cares that
// the command surfaces the right YAML/JSON, not about DSL coverage (that lives in
// @tdk/core's own tests).

import { defineTemplate, env, p, raw, step } from "@tdk/core";

export default defineTemplate({
  id: "cake-order-fixture",
  title: "Cake Order Fixture",
  description: "Place a cake order (CLI test fixture)",
  type: "service",
  parameters: {
    customer: p.string({ title: "Customer", required: true }),
  },
  steps: (f) => [
    step("order", "debug:log", {
      name: "Place order",
      input: {
        cluster: env.pick({ test: "test-cluster", prod: "prod-cluster" }),
        message: raw`Order for ${f.customer}!`,
      },
    }),
  ],
});
