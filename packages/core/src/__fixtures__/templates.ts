// Template fixtures for TDK's own tests.
//
// Minimal, synthetic `Template` subclasses that stand in for example apps so the
// library test-suite has no dependency on `examples/`. Each fixture is built to
// reproduce the exact behaviours the compile/jsonata tests assert (env.pick values,
// lifecycle gating, param schemas, the embedded expression payload).

import { env, nj, p, raw, Template } from "../index.ts";
import { orderTicket } from "./expressions.ts";

/**
 * An oven-provisioning template fixture. Exercises required + pattern params,
 * `env.pick` (test/prod cluster), a `raw` expression interpolating param refs,
 * lifecycle gating (`uat` → restrictedToUsers), and an output.
 */
export class OvenTemplate extends Template {
  id = "oven-fixture";
  title = "Oven Fixture";
  description = "Provision an oven (fixture)";
  type = "service";
  tags = ["fixture"];

  lifecycle = {
    state: "uat" as const,
    restrictedToUsers: ["baker-alice", "uat-stakeholder"],
  };

  params = {
    bakeryCode: p.string({
      title: "Bakery code",
      pattern: "^[A-Z]{2,10}$",
      required: true,
    }),
    ovenName: p.string({ title: "Oven name", required: true }),
  };

  build() {
    return [
      {
        id: "provision",
        name: "Provision oven",
        action: "debug:log",
        input: {
          cluster: env.pick({ test: "test-cluster", prod: "prod-cluster" }),
          message: raw`Creating ${this.params.ovenName.ref} (${this.params.bakeryCode.ref})`,
        },
      },
    ];
  }

  output = {
    ovenUrl: raw`https://bakery.example/${this.params.bakeryCode.ref}/${this.params.ovenName.ref}`,
  };
}

/**
 * A template fixture that feeds a transpiled `jsonata(...)` payload (the shared
 * `orderTicket` showcase) through compile the CORRECT way: as the `expression:`
 * string of a `roadiehq:utils:jsonata` step (via `.jsonata`), with the JSONata
 * root supplied by an `nj`-built `data` map. (Dropping the `orderTicket` OBJECT
 * itself into a step input would render `${{ <jsonata> }}` — which compile now
 * rejects, since Backstage's `${{ }}` is Nunjucks; see the compile tests.)
 */
export class OrderTicketTemplate extends Template {
  id = "order-ticket-fixture";
  title = "Order Ticket Fixture";
  description = "File an order ticket (fixture)";
  type = "service";
  tags = ["fixture"];

  params = {
    cakeName: p.string({ title: "Cake name", required: true }),
    tags: p.array({ title: "Labels" }),
  };

  build() {
    return [
      {
        id: "build-ticket",
        name: "Build order ticket",
        action: "roadiehq:utils:jsonata",
        input: {
          // The JSONata root: each `data` field is an `nj` `${{ }}` template,
          // resolved before the expression runs.
          data: {
            parameters: nj((c) => c.parameters),
          },
          // `.jsonata` is a STRING — the roadie action evaluates it as JSONata.
          expression: orderTicket.jsonata,
        },
      },
    ];
  }
}
