import { beforeEach, describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { OvenTemplate } from "./__fixtures__/templates.ts";
import type { JsonSchemaObject } from "./index.ts";
import {
  _resetEnvRegistry,
  assertNoCrossEnvLeaks,
  compile,
  compileAll,
  env,
  nj,
  p,
  page,
  raw,
  structuralCheck,
  Template,
  validate,
} from "./index.ts";

const nonprod = { env: "test", outDir: "dist/nonprod" } as const;
const prod = { env: "prod", outDir: "dist/prod" } as const;

// `_resetEnvRegistry` keeps the env.pick registry isolated between tests.
beforeEach(() => {
  _resetEnvRegistry();
});

describe("env-targeting", () => {
  test("nonprod resolves env.pick to the test value, not prod", () => {
    const { object } = compile(new OvenTemplate(), nonprod);
    const cluster = object.spec.steps[0]!.input!.cluster;
    expect(cluster).toBe("test-cluster");
    expect(JSON.stringify(object)).not.toContain("prod-cluster");
  });

  test("prod resolves env.pick to the prod value, not test", () => {
    const { object } = compile(new OvenTemplate(), prod, {
      checkEnvSafety: false,
    });
    const cluster = object.spec.steps[0]!.input!.cluster;
    expect(cluster).toBe("prod-cluster");
    expect(JSON.stringify(object)).not.toContain("test-cluster");
  });

  test("yaml round-trips and reflects the target env", () => {
    const { yaml } = compile(new OvenTemplate(), nonprod);
    const parsed = parse(yaml);
    expect(parsed.spec.steps[0].input.cluster).toBe("test-cluster");
  });
});

describe("env-safety", () => {
  test("passes for a clean nonprod artifact", () => {
    const { object } = compile(new OvenTemplate(), nonprod);
    expect(() => assertNoCrossEnvLeaks(object, "test")).not.toThrow();
  });

  test("throws when a prod-only value is forced into a test artifact", () => {
    // Register the prod-only value via a real env.pick, then build a template
    // that hardcodes that prod value as a literal in a test artifact.
    class Leaky extends Template {
      id = "leaky";
      title = "Leaky";
      type = "service";
      params = {};
      build() {
        // env.pick registers "leak-prod" as a prod-only value...
        const _registerPick = env.pick({
          test: "leak-test",
          prod: "leak-prod",
        });
        void _registerPick;
        return [
          {
            id: "s",
            action: "debug:log",
            // ...but here we HARDCODE the prod value (the bug we catch).
            input: { url: "leak-prod" },
          },
        ];
      }
    }
    expect(() => compile(new Leaky(), nonprod)).toThrow(/env-safety/);
  });

  test("compile on test env runs the safety check automatically", () => {
    class Leaky2 extends Template {
      id = "leaky2";
      title = "Leaky2";
      type = "service";
      params = {};
      build() {
        env.pick({ test: "ok", prod: "secret-prod-host" });
        return [
          {
            id: "s",
            action: "debug:log",
            input: { host: "secret-prod-host" },
          },
        ];
      }
    }
    expect(() => compile(new Leaky2(), nonprod)).toThrow(/secret-prod-host/);
  });

  test("a value shared across test+prod is NOT flagged as prod-only", () => {
    class Shared extends Template {
      id = "shared";
      title = "Shared";
      type = "service";
      params = {};
      build() {
        // "common" appears as both a test and prod value -> not prod-only.
        env.pick({ test: "common", prod: "common" });
        return [{ id: "s", action: "debug:log", input: { value: "common" } }];
      }
    }
    expect(() => compile(new Shared(), nonprod)).not.toThrow();
  });

  test("a prod-only value nested deep in arrays/objects is still caught", () => {
    class DeepLeak extends Template {
      id = "deep-leak";
      title = "DeepLeak";
      type = "service";
      params = {};
      build() {
        env.pick({ test: "t", prod: "deep-prod-secret" });
        return [
          {
            id: "s",
            action: "debug:log",
            // Buried inside an array, inside an object -> walkStrings must find it.
            input: { nested: { list: ["safe", "deep-prod-secret"] } },
          },
        ];
      }
    }
    expect(() => compile(new DeepLeak(), nonprod)).toThrow(/deep-prod-secret/);
  });
});

// The generalized env model: arbitrary env names (not just test/prod), a
// `default` fallback, and cross-env safety that treats "exclusive to another
// env" as the leak — regardless of which env we compiled for.
describe("generalized N-env model", () => {
  const dev = { env: "dev", outDir: "dist/dev" } as const;
  const staging = { env: "staging", outDir: "dist/staging" } as const;
  const prodE = { env: "prod", outDir: "dist/prod" } as const;

  class ThreeEnv extends Template {
    id = "three-env";
    title = "Three Env";
    type = "service";
    params = {};
    build() {
      return [
        {
          id: "s",
          action: "debug:log",
          input: {
            cluster: env.pick({ dev: "dev-cluster", staging: "stg-cluster", prod: "prod-cluster" }),
            region: env.pick({ prod: "eu-west", default: "eu-central" }),
          },
        },
      ];
    }
  }

  test("resolves env.pick per arbitrary env name", () => {
    expect(compile(new ThreeEnv(), dev).object.spec.steps[0]!.input!.cluster).toBe("dev-cluster");
    expect(compile(new ThreeEnv(), staging, { checkEnvSafety: false }).object.spec.steps[0]!.input!.cluster).toBe(
      "stg-cluster",
    );
    expect(compile(new ThreeEnv(), prodE, { checkEnvSafety: false }).object.spec.steps[0]!.input!.cluster).toBe(
      "prod-cluster",
    );
  });

  test("uses the default fallback for an env with no explicit entry", () => {
    // `region` has only prod + default: dev/staging get "eu-central".
    expect(compile(new ThreeEnv(), dev).object.spec.steps[0]!.input!.region).toBe("eu-central");
    expect(compile(new ThreeEnv(), prodE, { checkEnvSafety: false }).object.spec.steps[0]!.input!.region).toBe(
      "eu-west",
    );
  });

  test("throws (naming the miss) when compiling for an env the pick doesn't know", () => {
    class NoDefault extends Template {
      id = "no-default";
      title = "No Default";
      type = "service";
      params = {};
      build() {
        return [{ id: "s", action: "debug:log", input: { cluster: env.pick({ dev: "d", prod: "p" }) } }];
      }
    }
    expect(() => compile(new NoDefault(), staging, { checkEnvSafety: false })).toThrow(
      'env.pick has no value for env "staging" (knows: dev, prod) — add a "staging" entry or a "default".',
    );
  });

  test("env-safety: a staging-exclusive value hardcoded in a dev artifact throws", () => {
    class Leak extends Template {
      id = "cross-leak";
      title = "Cross Leak";
      type = "service";
      params = {};
      build() {
        // "stg-secret" is exclusive to staging across the registry...
        env.pick({ dev: "dev-ok", staging: "stg-secret", prod: "prod-ok" });
        // ...but here we hardcode it into a dev artifact (the leak we catch).
        return [{ id: "s", action: "debug:log", input: { host: "stg-secret" } }];
      }
    }
    expect(() => compile(new Leak(), dev)).toThrow(/exclusive to env "staging"/);
  });

  test("env-safety: a value shared by two envs does NOT throw for either", () => {
    class Shared extends Template {
      id = "cross-shared";
      title = "Cross Shared";
      type = "service";
      params = {};
      build() {
        // "eu-west" is used by BOTH staging and prod -> shared, never exclusive.
        env.pick({ dev: "eu-central", staging: "eu-west", prod: "eu-west" });
        return [{ id: "s", action: "debug:log", input: { region: "eu-west" } }];
      }
    }
    expect(() => compile(new Shared(), dev)).not.toThrow();
    expect(() => compile(new Shared(), staging)).not.toThrow();
    expect(() => compile(new Shared(), prodE)).not.toThrow();
  });

  test("env-safety: a default value never counts as a leak in any env", () => {
    class WithDefault extends Template {
      id = "with-default";
      title = "With Default";
      type = "service";
      params = {};
      build() {
        env.pick({ prod: "prod-only", default: "shared-default" });
        return [{ id: "s", action: "debug:log", input: { v: "shared-default" } }];
      }
    }
    expect(() => compile(new WithDefault(), dev)).not.toThrow();
    expect(() => compile(new WithDefault(), staging)).not.toThrow();
  });

  test("single-env project: one target, no picks, compiles clean", async () => {
    class SingleEnv extends Template {
      id = "single-env";
      title = "Single Env";
      type = "service";
      params = { name: p.string() };
      build() {
        return [{ id: "s", action: "debug:log", input: { greeting: "hi" } }];
      }
    }
    const jobs = await compileAll(
      [new SingleEnv()],
      { live: { env: "production", outDir: "dist/live" } },
      {
        write: false,
      },
    );
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.targetName).toBe("live");
    expect(jobs[0]!.outPath).toBe("dist/live/single-env/template.yaml");
  });

  test("compileAll accepts arbitrary target names (no special nonprod/prod keys)", async () => {
    const jobs = await compileAll(
      [new ThreeEnv()],
      {
        alpha: { env: "dev", outDir: "dist/alpha" },
        beta: { env: "staging", outDir: "dist/beta" },
        gamma: { env: "prod", outDir: "dist/gamma" },
      },
      { write: false },
    );
    expect(new Set(jobs.map((j) => j.targetName))).toEqual(new Set(["alpha", "beta", "gamma"]));
  });

  test("compileAll throws when given zero targets", async () => {
    await expect(compileAll([new ThreeEnv()], {}, { write: false })).rejects.toThrow(/at least one entry/);
  });
});

describe("lifecycle", () => {
  test("state 'uat' emits restrictedToUsers under spec", () => {
    const { object } = compile(new OvenTemplate(), nonprod);
    expect(object.spec.restrictedToUsers).toEqual(["baker-alice", "uat-stakeholder"]);
  });

  test("state 'ga' omits restrictedToUsers", () => {
    class GaTemplate extends Template {
      id = "ga-tpl";
      title = "GA Template";
      type = "service";
      lifecycle = {
        state: "ga" as const,
        restrictedToUsers: ["should-be-ignored"],
      };
      params = {};
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const { object } = compile(new GaTemplate(), nonprod);
    expect(object.spec.restrictedToUsers).toBeUndefined();
  });

  // A non-ga lifecycle FAILS CLOSED: compiling without a user list used to
  // silently emit an UNRESTRICTED template — now it throws.
  test("a non-ga state with an EMPTY restrictedToUsers throws", () => {
    class EmptyRestriction extends Template {
      id = "empty-restriction";
      title = "Empty";
      type = "service";
      lifecycle = { state: "beta" as const, restrictedToUsers: [] };
      params = {};
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    expect(() => compile(new EmptyRestriction(), nonprod)).toThrow(
      /state "beta" requires a non-empty restrictedToUsers/,
    );
  });

  test("a non-ga state with no restrictedToUsers list throws", () => {
    class NoList extends Template {
      id = "no-list";
      title = "No List";
      type = "service";
      lifecycle = { state: "alpha" as const };
      params = {};
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    expect(() => compile(new NoList(), nonprod)).toThrow(/state "alpha" requires a non-empty restrictedToUsers/);
  });
});

describe("extraSpec collisions with modeled spec fields", () => {
  function withExtraSpec(extraSpec: Record<string, unknown>, lifecycle?: Template["lifecycle"]) {
    return class extends Template {
      id = "extra";
      title = "Extra";
      type = "service";
      owner = "team-bakery";
      lifecycle = lifecycle;
      extraSpec = extraSpec;
      params = {};
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    };
  }

  test.each([
    "type",
    "owner",
    "parameters",
    "steps",
    "output",
  ])("extraSpec.%s throws, naming the modeled field", (key) => {
    const T = withExtraSpec({ [key]: "clobber" });
    expect(() => compile(new T(), nonprod)).toThrow(new RegExp(`extraSpec key "${key}" collides`));
  });

  test("extraSpec.restrictedToUsers throws when a lifecycle gate produced one", () => {
    const T = withExtraSpec(
      { restrictedToUsers: ["someone-else"] },
      { state: "beta", restrictedToUsers: ["baker-alice"] },
    );
    expect(() => compile(new T(), nonprod)).toThrow(/extraSpec key "restrictedToUsers" collides/);
  });

  test("extraSpec.restrictedToUsers passes through when there is NO lifecycle gate", () => {
    const T = withExtraSpec({ restrictedToUsers: ["baker-alice"] });
    const { object } = compile(new T(), nonprod);
    expect(object.spec.restrictedToUsers).toEqual(["baker-alice"]);
  });

  test("non-modeled extraSpec keys still merge verbatim", () => {
    const T = withExtraSpec({ catalog_metadata: { category: "Catering" } });
    const { object } = compile(new T(), nonprod);
    expect(object.spec.catalog_metadata).toEqual({ category: "Catering" });
  });
});

describe("marker leak detection (unresolved TDK markers in the artifact)", () => {
  test("an env.pick inside extraSpec throws, naming the JSON path", () => {
    class T extends Template {
      id = "leak-extra";
      title = "Leak Extra";
      type = "service";
      extraSpec = { hook: env.pick({ test: "t", prod: "p" }) };
      params = {};
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    expect(() => compile(new T(), nonprod)).toThrow(/env\.pick\(\.\.\.\) marker at \$\.spec\.hook/);
  });

  test("an env.pick inside a param's ui:options throws, naming the JSON path", () => {
    class T extends Template {
      id = "leak-ui";
      title = "Leak UI";
      type = "service";
      params = {
        flavor: p.string({ uiOptions: { help: env.pick({ test: "t", prod: "p" }) } }),
      };
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    expect(() => compile(new T(), nonprod)).toThrow(
      /marker at \$\.spec\.parameters\.properties\.flavor\.ui:options\.help/,
    );
  });

  test("a Param nested inside ui:options throws (it would clone into garbage)", () => {
    class T extends Template {
      id = "leak-nested-param";
      title = "Leak Nested Param";
      type = "service";
      params = {
        // structuredClone strips the prototype and Param carries no __tdk*
        // key, so without the toSchema guard this emitted silent garbage.
        flavor: p.string({ uiOptions: { oops: p.string({ title: "stray" }) as unknown as string } }),
      };
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    expect(() => compile(new T(), nonprod)).toThrow(/holds a Param at \$\.ui:options\.oops/);
  });

  test("a Param used directly as a step input value throws, pointing at .ref", () => {
    class T extends Template {
      id = "leak-step-param";
      title = "Leak Step Param";
      type = "service";
      flavor = p.string();
      params = { flavor: this.flavor };
      build() {
        // Forgot `.ref` — resolveValue's Object.entries would degrade the
        // instance into a plain object before the marker walk could see it.
        return [{ id: "s", action: "debug:log", input: { oops: this.flavor as unknown as string } }];
      }
    }
    expect(() => compile(new T(), nonprod)).toThrow(/Param "flavor" was used directly as a value.*\.ref/);
  });

  test("a param ref used as a schema default throws (refs are not resolved in schemas)", () => {
    class T extends Template {
      id = "leak-default";
      title = "Leak Default";
      type = "service";
      other = p.string();
      params = {
        other: this.other,
        // Deliberately forcing the type hole the runtime walk must catch.
        flavor: p.string({ default: this.other.ref as any }),
      };
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    expect(() => compile(new T(), nonprod)).toThrow(/at \$\.spec\.parameters\.properties\.flavor\.default/);
  });

  test("markers in step input/if/output still RESOLVE (no false positives)", () => {
    class T extends Template {
      id = "no-false-positive";
      title = "No False Positive";
      type = "service";
      params = { name: p.string() };
      output = { where: env.pick({ test: "t-out", prod: "p-out" }) };
      build() {
        return [
          {
            id: "s",
            action: "debug:log",
            if: this.params.name.ref,
            input: { cluster: env.pick({ test: "t-in", prod: "p-in" }) },
          },
        ];
      }
    }
    const { object } = compile(new T(), nonprod, { checkEnvSafety: false });
    expect(object.spec.steps[0]!.if).toBe("${{ parameters.name }}");
    expect(object.spec.steps[0]!.input!.cluster).toBe("t-in");
    expect(object.spec.output!.where).toBe("t-out");
  });
});

describe("uniqueness validation", () => {
  test("duplicate step ids throw", () => {
    class T extends Template {
      id = "dup-steps";
      title = "Dup Steps";
      type = "service";
      params = {};
      build() {
        return [
          { id: "order", action: "debug:log" },
          { id: "order", action: "debug:log" },
        ];
      }
    }
    expect(() => compile(new T(), nonprod)).toThrow(/duplicate step id "order"/);
  });

  test("duplicate parameter names across pages throw, naming both pages", () => {
    class T extends Template {
      id = "dup-params";
      title = "Dup Params";
      type = "service";
      pages = [
        page({ title: "Cake", properties: { flavor: p.string() } }),
        page({ title: "Extras", properties: { flavor: p.string() } }),
      ];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    expect(() => compile(new T(), nonprod)).toThrow(
      /duplicate parameter name "flavor" — declared on page "Cake" and again on page "Extras"/,
    );
  });
});

describe("non-Param property values", () => {
  test("a raw schema object in flat params throws, pointing at p.*", () => {
    class T extends Template {
      id = "raw-prop";
      title = "Raw Prop";
      type = "service";
      // Deliberately bypassing the ParamMap type to pin the runtime guard.
      params = { flavor: { type: "string" } as any };
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    expect(() => compile(new T(), nonprod)).toThrow(/property "flavor" is not a Param — wrap it in a p\.\* helper/);
  });
});

describe("metadata + owner passthrough", () => {
  test("description, tags and owner are emitted when present", () => {
    class Full extends Template {
      id = "full";
      title = "Full";
      description = "a description";
      type = "service";
      tags = ["a", "b"];
      owner = "team-x";
      params = {};
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const { object } = compile(new Full(), nonprod);
    expect(object.metadata.description).toBe("a description");
    expect(object.metadata.tags).toEqual(["a", "b"]);
    expect(object.spec.owner).toBe("team-x");
  });

  test("absent optional metadata is omitted entirely", () => {
    class Bare extends Template {
      id = "bare";
      title = "Bare";
      type = "service";
      params = {};
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const { object } = compile(new Bare(), nonprod);
    expect(object.metadata.description).toBeUndefined();
    expect(object.metadata.tags).toBeUndefined();
    expect(object.spec.owner).toBeUndefined();
  });
});

describe("step + value resolution", () => {
  test("raw param refs and a literal `if` pass through", () => {
    class WithIf extends Template {
      id = "with-if";
      title = "With If";
      type = "service";
      params = { name: p.string() };
      build() {
        return [
          {
            id: "s",
            name: "Step",
            action: "debug:log",
            input: { who: raw`hi ${this.params.name.ref}` },
            if: "true",
          },
        ];
      }
    }
    const { object } = compile(new WithIf(), nonprod);
    expect(object.spec.steps[0]!.input!.who).toBe("hi ${{ parameters.name }}");
    expect(object.spec.steps[0]!.if).toBe("true");
  });

  test("nested arrays + objects in a step input resolve recursively", () => {
    class Nested extends Template {
      id = "nested";
      title = "Nested";
      type = "service";
      params = { name: p.string() };
      build() {
        return [
          {
            id: "s",
            action: "debug:log",
            input: {
              cfg: {
                list: [env.pick({ test: "t", prod: "p" }), "lit"],
                ref: raw`${this.params.name.ref}`,
                num: 7,
              },
            },
          },
        ];
      }
    }
    const { object } = compile(new Nested(), nonprod);
    const cfg = object.spec.steps[0]!.input!.cfg as Record<string, unknown>;
    expect(cfg.list).toEqual(["t", "lit"]);
    expect(cfg.ref).toBe("${{ parameters.name }}");
    expect(cfg.num).toBe(7);
  });

  test("a raw boolean `if` is preserved", () => {
    class BoolIf extends Template {
      id = "bool-if";
      title = "Bool If";
      type = "service";
      params = {};
      build() {
        return [{ id: "s", action: "debug:log", if: false }];
      }
    }
    const { object } = compile(new BoolIf(), nonprod);
    expect(object.spec.steps[0]!.if).toBe(false);
  });
});

// Issue #9: `resolveValue` used to return an `env.pick`'s branch verbatim, so a
// branch OBJECT containing markers (raw/nj()/jsonata()/param refs) aborted
// compilation with an unrendered-marker error. The fix routes the picked branch
// back through `resolveValue` itself.
describe("env.pick branch resolution (issue #9)", () => {
  class PerEnvOrder extends Template {
    id = "per-env-order";
    title = "Per-env order";
    type = "service";
    params = { customerName: p.string({ required: true }) };
    build() {
      return [
        {
          id: "place-order",
          action: "debug:log",
          input: {
            // The exact reproduction from the issue: per-env payloads where
            // prod's fulfilment service takes an extra field.
            order: env.pick({
              test: {
                customer: this.params.customerName.ref,
                notes: nj((c) => `Rush: ${c.parameters.rush}`),
              },
              prod: {
                customer: this.params.customerName.ref,
                notes: nj((c) => `Rush: ${c.parameters.rush}`),
                costCentre: "CC-1",
              },
            }),
          },
        },
      ];
    }
  }

  test("a branch OBJECT containing nj() and a param ref renders its markers, per env", () => {
    const testOrder = compile(new PerEnvOrder(), nonprod).object.spec.steps[0]!.input!.order;
    expect(testOrder).toEqual({
      customer: "${{ parameters.customerName }}",
      notes: '${{ ("Rush: " ~ (parameters.rush)) }}',
    });

    const prodOrder = compile(new PerEnvOrder(), prod).object.spec.steps[0]!.input!.order;
    expect(prodOrder).toEqual({
      customer: "${{ parameters.customerName }}",
      notes: '${{ ("Rush: " ~ (parameters.rush)) }}',
      costCentre: "CC-1",
    });
  });

  test("a scalar branch still resolves unchanged (no regression)", () => {
    expect(compile(new OvenTemplate(), nonprod).object.spec.steps[0]!.input!.cluster).toBe("test-cluster");
  });

  test("an env.pick NESTED inside a branch resolves recursively, against the same target env", () => {
    // Deliberate semantics (documented alongside the fix in compile.ts): a
    // picked branch flows back through `resolveValue` like any other value, so
    // a branch that is itself another `env.pick` resolves too — recursively,
    // against the SAME target env the outer pick was resolved for. This lets a
    // branch be composed from a smaller/shared sub-pick instead of forcing an
    // author to flatten it by hand. (The alternative — rejecting a nested pick
    // outright — would special-case env.pick relative to every other value
    // resolveValue recurses into; recursing keeps the rule uniform: "a picked
    // branch resolves exactly like any other authored value".)
    class NestedPick extends Template {
      id = "nested-pick";
      title = "Nested Pick";
      type = "service";
      params = {};
      build() {
        return [
          {
            id: "s",
            action: "debug:log",
            input: {
              region: env.pick({
                test: env.pick({ test: "t-inner", prod: "p-inner" }),
                prod: "p-outer",
              }),
            },
          },
        ];
      }
    }
    expect(compile(new NestedPick(), nonprod).object.spec.steps[0]!.input!.region).toBe("t-inner");
    expect(compile(new NestedPick(), prod).object.spec.steps[0]!.input!.region).toBe("p-outer");
  });
});

describe("params", () => {
  test("required + pattern produce the right schema fragment + required list", () => {
    const { object } = compile(new OvenTemplate(), nonprod);
    const params = object.spec.parameters as JsonSchemaObject;
    expect(params.properties.bakeryCode).toEqual({
      type: "string",
      title: "Bakery code",
      pattern: "^[A-Z]{2,10}$",
    });
    expect(params.required).toContain("bakeryCode");
    expect(params.required).toContain("ovenName");
  });

  test("param.ref renders ${{ parameters.<name> }} using the map key", () => {
    const { object } = compile(new OvenTemplate(), nonprod);
    expect(object.spec.steps[0]!.input!.message).toBe(
      "Creating ${{ parameters.ovenName }} (${{ parameters.bakeryCode }})",
    );
  });

  test("p.enum / p.number / p.boolean / p.array emit correct schemas", () => {
    class Many extends Template {
      id = "many";
      title = "Many";
      type = "service";
      params = {
        color: p.enum({ enum: ["red", "green"] as const, required: true }),
        count: p.number({ minimum: 1, maximum: 10 }),
        flag: p.boolean({ default: false }),
        list: p.array({ items: { type: "string" }, minItems: 1 }),
      };
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const { object } = compile(new Many(), nonprod);
    const params = object.spec.parameters as JsonSchemaObject;
    const props = params.properties;
    expect(props.color).toEqual({ type: "string", enum: ["red", "green"] });
    expect(props.count).toEqual({ type: "number", minimum: 1, maximum: 10 });
    expect(props.flag).toEqual({ type: "boolean", default: false });
    expect(props.list).toEqual({
      type: "array",
      items: { type: "string" },
      minItems: 1,
    });
    expect(params.required).toEqual(["color"]);
  });

  test("p.array defaults its items to string and supports description/uiField", () => {
    class Defaulted extends Template {
      id = "defaulted";
      title = "Defaulted";
      type = "service";
      params = {
        list: p.array(),
        picker: p.string({ description: "pick one", uiField: "OvenUrlPicker" }),
      };
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const { object } = compile(new Defaulted(), nonprod);
    const props = (object.spec.parameters as JsonSchemaObject).properties;
    expect(props.list).toEqual({ type: "array", items: { type: "string" } });
    expect(props.picker).toEqual({
      type: "string",
      description: "pick one",
      "ui:field": "OvenUrlPicker",
    });
  });

  test("params with no required entries omit the required array", () => {
    class Optional extends Template {
      id = "opt";
      title = "Opt";
      type = "service";
      params = { note: p.string() };
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const { object } = compile(new Optional(), nonprod);
    expect((object.spec.parameters as JsonSchemaObject).required).toBeUndefined();
  });

  test("an unbound param ref throws a helpful error", () => {
    expect(() => p.string().ref.toString()).toThrow(/used before its name was assigned/);
  });
});

describe("schema validation", () => {
  test("compiled nonprod artifact passes the real Backstage schema", async () => {
    const { object } = compile(new OvenTemplate(), nonprod);
    const { valid, errors } = await validate(object);
    if (!valid) console.error(errors);
    expect(valid).toBe(true);
  });

  test("compiled prod artifact passes the real Backstage schema", async () => {
    const { object } = compile(new OvenTemplate(), prod, {
      checkEnvSafety: false,
    });
    const { valid } = await validate(object);
    expect(valid).toBe(true);
  });

  test("validate() rejects a malformed entity", async () => {
    const bad = { apiVersion: "wrong", kind: "Template" };
    const { valid } = await validate(bad);
    expect(valid).toBe(false);
  });

  test("structuralCheck (schema-lite) agrees on a good artifact", () => {
    const { object } = compile(new OvenTemplate(), nonprod);
    expect(structuralCheck(object).valid).toBe(true);
  });

  test("structuralCheck flags an empty steps array", () => {
    const { valid, errors } = structuralCheck({
      apiVersion: "scaffolder.backstage.io/v1beta3",
      kind: "Template",
      metadata: { name: "x" },
      spec: { type: "service", steps: [] },
    });
    expect(valid).toBe(false);
    expect(errors.some((e) => e.instancePath === "/spec/steps")).toBe(true);
  });
});

describe("compileAll", () => {
  test("returns one job per template × target without writing when write:false", async () => {
    const jobs = await compileAll([new OvenTemplate(), new OrderOutTemplate()], { nonprod, prod }, { write: false });
    expect(jobs.length).toBe(4);
    const ids = new Set(jobs.map((j) => j.templateId));
    expect(ids).toEqual(new Set(["oven-fixture", "order-out"]));
    // Output path is <outDir>/<id>/template.yaml.
    const ovenNonprod = jobs.find((j) => j.templateId === "oven-fixture" && j.targetName === "nonprod")!;
    expect(ovenNonprod.outPath).toBe("dist/nonprod/oven-fixture/template.yaml");
    expect(ovenNonprod.result.yaml).toContain("apiVersion:");
  });

  test("write:true writes the YAML to <outDir>/<id>/template.yaml", async () => {
    const { join } = await import("node:path");
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const base = await mkdtemp(join(tmpdir(), "tdk-compileall-"));
    try {
      const target = { env: "test", outDir: base } as const;
      const jobs = await compileAll([new OvenTemplate()], { only: target });
      const written = await readFile(jobs[0]!.outPath, "utf8");
      expect(written).toContain("name: oven-fixture");
      expect(jobs[0]!.outPath).toBe(join(base, "oven-fixture", "template.yaml"));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("out(tpl) overrides outDir for a flat/custom layout", async () => {
    const jobs = await compileAll(
      [new OvenTemplate()],
      { flat: { env: "test", out: (t) => `dist/flat/templates/${t.id}.yaml` } },
      { write: false },
    );
    expect(jobs[0]!.outPath).toBe("dist/flat/templates/oven-fixture.yaml");
  });

  test("throws when a target sets neither outDir nor out", async () => {
    await expect(compileAll([new OvenTemplate()], { bad: { env: "test" } }, { write: false })).rejects.toThrow(
      /either "outDir" or "out"/,
    );
  });
});

// A second template whose env.pick-free output keeps compileAll prod-safe.
class OrderOutTemplate extends Template {
  id = "order-out";
  title = "Order Out";
  type = "service";
  params = { name: p.string() };
  build() {
    return [{ id: "s", action: "debug:log" }];
  }
}
