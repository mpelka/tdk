import { beforeEach, describe, expect, test } from "bun:test";
import { parse } from "yaml";

// PUBLIC API. Everything an author / consumer plugin needs for the resolver hook
// comes from the barrel — the end-to-end `person()` example below imports ONLY
// from here, proving the hook is usable without reaching into internals.
import {
  _resetEnvRegistry,
  _resetResolvers,
  compile,
  compileAll,
  compileResolved,
  defineResolver,
  isResolvable,
  Template,
} from "./index.ts";

// INTERNAL pass helpers (not re-exported from the barrel). Imported only to
// unit-test the mechanism directly; the e2e example never touches these.
import { lookupResolved, resolvedKey, resolveMarkers } from "./resolve.ts";

const nonprod = { env: "test", outDir: "dist/nonprod" } as const;
const prod = { env: "prod", outDir: "dist/prod" } as const;

beforeEach(() => {
  _resetResolvers();
  _resetEnvRegistry();
});

describe("defineResolver", () => {
  test("registers a resolver and returns a marker factory", () => {
    const person = defineResolver("person", (_ctx, name: string) => name);
    const marker = person("Ada Lovelace");
    expect(marker.__tdkResolvable).toBe(true);
    expect(marker.resolver).toBe("person");
    expect(marker.args).toEqual(["Ada Lovelace"]);
  });

  test("re-registering the SAME fn is tolerated (module reload)", () => {
    const fn = (_ctx: { env: string }, name: string) => name;
    expect(() => {
      defineResolver("person", fn);
      defineResolver("person", fn);
    }).not.toThrow();
  });

  test("registering a DIFFERENT fn under a taken name throws", () => {
    defineResolver("person", (_ctx, name: string) => name);
    expect(() => defineResolver("person", (_ctx, name: string) => `${name}!`)).toThrow(
      /already registered for "person"/,
    );
  });
});

describe("isResolvable", () => {
  test("true for a marker, false otherwise", () => {
    const person = defineResolver("person", (_ctx, name: string) => name);
    expect(isResolvable(person("Ada Lovelace"))).toBe(true);
    expect(isResolvable({})).toBe(false);
    expect(isResolvable(null)).toBe(false);
    expect(isResolvable("x")).toBe(false);
    expect(isResolvable({ __tdkResolvable: false })).toBe(false);
  });
});

describe("resolveMarkers", () => {
  test("resolves unique markers across nested roots (incl. arrays)", async () => {
    const person = defineResolver("person", (_ctx, name: string) => name.toUpperCase());
    const roots = [{ author: person("Ada"), tags: [person("Grace")] }, { lead: person("Ada") }];
    const resolved = await resolveMarkers(roots, { env: "test" });
    expect(resolved.get(resolvedKey(person("Ada"), "test"))).toBe("ADA");
    expect(resolved.get(resolvedKey(person("Grace"), "test"))).toBe("GRACE");
  });

  test("a repeated identical marker invokes the resolver fn only ONCE", async () => {
    let calls = 0;
    const person = defineResolver("person", (_ctx, name: string) => {
      calls++;
      return name;
    });
    const roots = [{ a: person("Ada"), b: person("Ada") }, [person("Ada")]];
    await resolveMarkers(roots, { env: "test" });
    expect(calls).toBe(1);
  });

  test("distinct args resolve separately", async () => {
    let calls = 0;
    const person = defineResolver("person", (_ctx, name: string) => {
      calls++;
      return name;
    });
    await resolveMarkers([{ a: person("Ada"), b: person("Grace") }], {
      env: "test",
    });
    expect(calls).toBe(2);
  });

  test("the resolver receives ctx.env (env-aware resolution)", async () => {
    const dir = defineResolver("dir", (ctx, name: string) => `${name}@${ctx.env}`);
    const roots = [{ who: dir("Ada") }];
    const onTest = await resolveMarkers(roots, { env: "test" });
    const onProd = await resolveMarkers(roots, { env: "prod" });
    expect(onTest.get(resolvedKey(dir("Ada"), "test"))).toBe("Ada@test");
    expect(onProd.get(resolvedKey(dir("Ada"), "prod"))).toBe("Ada@prod");
  });

  test("an async (Promise-returning) resolver works", async () => {
    const person = defineResolver("person", async (_ctx, name: string) => {
      await Promise.resolve();
      return `id-${name}`;
    });
    const resolved = await resolveMarkers([{ who: person("Ada") }], {
      env: "test",
    });
    expect(resolved.get(resolvedKey(person("Ada"), "test"))).toBe("id-Ada");
  });

  test("an unregistered resolver name throws an actionable error", async () => {
    // A hand-built marker whose resolver was never registered.
    const marker = { __tdkResolvable: true, resolver: "ghost", args: [] } as const;
    await expect(resolveMarkers([{ x: marker }], { env: "test" })).rejects.toThrow(
      /no resolver registered for "ghost"/,
    );
  });
});

describe("lookupResolved", () => {
  test("returns the resolved value when present", () => {
    const person = defineResolver("person", (_ctx, name: string) => name);
    const marker = person("Ada");
    const resolved = new Map([[resolvedKey(marker, "test"), "a-id"]]);
    expect(lookupResolved(marker, "test", resolved)).toBe("a-id");
  });

  test("throws the sync-path error when there is no resolved cache", () => {
    const person = defineResolver("person", (_ctx, name: string) => name);
    expect(() => lookupResolved(person("Ada"), "test", undefined)).toThrow(/compileResolved\(\.\.\.\) or compileAll/);
  });
});

describe("compile integration", () => {
  test("sync compile on a template with a marker throws the helpful error", () => {
    const person = defineResolver("person", (_ctx, name: string) => name);
    class HasMarker extends Template {
      id = "has-marker";
      title = "Has Marker";
      type = "service";
      params = {};
      build() {
        return [{ id: "s", action: "debug:log", input: { author: person("Ada") } }];
      }
    }
    expect(() => compile(new HasMarker(), nonprod)).toThrow(/use compileResolved\(\.\.\.\) or compileAll/i);
  });
});

// End-to-end: a SYNTHETIC `person()` resolver backed by a static fictional table.
// This is exactly what a consumer plugin would ship — and it imports ONLY from
// the public barrel (`defineResolver` above), never from `./resolve.ts`.
describe("end-to-end person() resolver", () => {
  // A static fictional name → synthetic id table (the stand-in for an AD lookup).
  const DIRECTORY: Record<string, string> = {
    "Ada Lovelace": "a-lovelace-01",
    "Grace Hopper": "g-hopper-02",
  };
  const makePerson = () =>
    defineResolver("person", (_ctx, name: string) => {
      const id = DIRECTORY[name];
      if (!id) throw new Error(`person: unknown name "${name}"`);
      return id;
    });

  // Registered AFTER the top-level reset (outer beforeEach runs first), so the
  // marker factory is always backed by a live registration in every test.
  let person: ReturnType<typeof makePerson>;
  beforeEach(() => {
    person = makePerson();
  });

  class GreetTemplate extends Template {
    id = "greet-fixture";
    title = "Greet Fixture";
    type = "service";
    params = {};
    build() {
      return [
        {
          id: "log",
          action: "debug:log",
          if: true,
          input: { author: person("Ada Lovelace"), backup: person("Grace Hopper") },
        },
      ];
    }
    output = { lead: person("Ada Lovelace") };
  }

  test("compileResolved replaces the marker with the resolved id", async () => {
    const { object, yaml } = await compileResolved(new GreetTemplate(), nonprod);
    expect(object.spec.steps[0]!.input!.author).toBe("a-lovelace-01");
    expect(object.spec.steps[0]!.input!.backup).toBe("g-hopper-02");
    expect(object.spec.output!.lead).toBe("a-lovelace-01");
    // The marker never reaches the artifact; only the resolved id does.
    expect(yaml).toContain("a-lovelace-01");
    expect(parse(yaml).spec.steps[0].input.author).toBe("a-lovelace-01");
  });

  test("compileAll resolves markers per target transparently", async () => {
    const jobs = await compileAll([new GreetTemplate()], { nonprod, prod }, { write: false });
    for (const job of jobs) {
      expect(job.result.object.spec.steps[0]!.input!.author).toBe("a-lovelace-01");
    }
  });

  test("a marker in a step's `if` resolves like an input value", async () => {
    class IfMarker extends Template {
      id = "if-marker";
      title = "If Marker";
      type = "service";
      params = {};
      build() {
        // The resolved id lands verbatim in the compiled `if` (a truthy string).
        return [{ id: "log", action: "debug:log", if: person("Ada Lovelace"), input: {} }];
      }
    }
    const { object } = await compileResolved(new IfMarker(), nonprod);
    expect(object.spec.steps[0]!.if).toBe("a-lovelace-01");
  });
});
