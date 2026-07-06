// Unit tests for the action-simulator registry (the `execute()` extension hook).
//
// Mirrors resolve.test.ts: duplicate-different registration throws, same-ref is
// tolerated, and lookups/reset behave. The cross-cutting behaviour (execute()
// actually USING a simulator) lives in extend.test.ts alongside the other hooks.

import { beforeEach, describe, expect, test } from "bun:test";

import { _resetActionSimulators, _resetResolvers, getActionSimulator, registerActionSimulator } from "./index.ts";

beforeEach(() => {
  _resetResolvers();
  _resetActionSimulators();
});

describe("registerActionSimulator", () => {
  test("registers a simulator that getActionSimulator returns", () => {
    const sim = () => ({ ok: true });
    registerActionSimulator("bakery:x", sim);
    expect(getActionSimulator("bakery:x")).toBe(sim);
  });

  test("getActionSimulator is undefined for an unregistered action", () => {
    expect(getActionSimulator("bakery:none")).toBeUndefined();
  });

  test("re-registering the SAME simulator is tolerated (module reload)", () => {
    const sim = () => 1;
    expect(() => {
      registerActionSimulator("bakery:x", sim);
      registerActionSimulator("bakery:x", sim);
    }).not.toThrow();
  });

  test("registering a DIFFERENT simulator under a taken action throws", () => {
    registerActionSimulator("bakery:x", () => 1);
    expect(() => registerActionSimulator("bakery:x", () => 2)).toThrow(
      /different simulator is already registered for "bakery:x"/,
    );
  });

  test("_resetActionSimulators clears the registry", () => {
    registerActionSimulator("bakery:x", () => 1);
    _resetActionSimulators();
    expect(getActionSimulator("bakery:x")).toBeUndefined();
  });
});
