// TYPE-LEVEL proof for the typed step-input layer (issue #15). Threading a
// marker's result type through `TypedInputValue<V>` means a marker that renders
// the WRONG type is a compile error in a typed slot, and `MarkerValue<M>`
// recovers the type a marker carries (what `derive` reads to build its context).
//
// This file is NOT a runtime test (no `.test` in the name, so `bun test` skips
// it); it is checked by `bun run typecheck` (tsc over `src`). Each
// `@ts-expect-error` asserts the line BELOW is a compile error — delete one and
// typecheck fails, which is the load-bearing proof that the constraint bites.
// The loose `InputValue` is proven still-permissive at the bottom.
//
// biome-ignore-all lint/correctness/noUnusedVariables: type-level assertions; values exist only to be checked.
// biome-ignore-all lint/suspicious/noExplicitAny: mirrors the marker variance under test (Ctx is `any`).

import type { Ref } from "./define.ts";
import type { NjContext, NunjucksExpr } from "./expr/nunjucks/index.ts";
import { env, jsonata, nj, p, raw } from "./index.ts";
import type { ParamRef } from "./params.ts";
import type { InputValue } from "./template.ts";
import type { MarkerValue, TypedInputValue } from "./typed-input.ts";

type Ctx = { parameters: { count: number; label: string; tags: string[] } };

// Result-typed markers, one per kind, at both a number and a string result.
const jNum = jsonata<Ctx, number>((c) => c.parameters.count);
const jStr = jsonata<Ctx, string>((c) => c.parameters.label);
const njNum = nj<Ctx, number>((c) => c.parameters.count);
const njStr = nj<Ctx, string>((c) => c.parameters.label);
const refNum = p.number().ref as Ref<number>;
const refStr = p.string().ref as Ref<string>;
const pickNum = env.pick<number>({ test: 1, prod: 2 });
const pickStr = env.pick<string>({ test: "t", prod: "p" });

// Untyped escape hatches — carry no result type.
const rawExpr = raw`verbatim ${refStr}`;

// ---------------------------------------------------------------------------
// TypedInputValue<V> — a marker's result must match the slot.
// ---------------------------------------------------------------------------

// --- Positive: a number-result marker is accepted in a number slot ----------
const okJNum: TypedInputValue<number> = jNum;
const okNjNum: TypedInputValue<number> = njNum;
const okRefNum: TypedInputValue<number> = refNum;
const okPickNum: TypedInputValue<number> = pickNum;
const okNumLit: TypedInputValue<number> = 42;

// --- Positive: a string-result marker is accepted in a string slot ----------
const okJStr: TypedInputValue<string> = jStr;
const okNjStr: TypedInputValue<string> = njStr;
const okRefStr: TypedInputValue<string> = refStr;
const okPickStr: TypedInputValue<string> = pickStr;
const okStrLit: TypedInputValue<string> = "hello";

// --- Positive: the untyped escape hatches go in any typed slot ---------------
const okRawInNum: TypedInputValue<number> = rawExpr;
const okRawInStr: TypedInputValue<string> = rawExpr;

// --- Negative: a NUMBER-result marker is rejected in a STRING slot -----------
// @ts-expect-error — jsonata result is number, slot wants string.
const badJInStr: TypedInputValue<string> = jNum;
// @ts-expect-error — nj result is number, slot wants string.
const badNjInStr: TypedInputValue<string> = njNum;
// @ts-expect-error — Ref<number> in a string slot.
const badRefInStr: TypedInputValue<string> = refNum;
// @ts-expect-error — env.pick<number> in a string slot.
const badPickInStr: TypedInputValue<string> = pickNum;
// @ts-expect-error — a number literal in a string slot.
const badNumLit: TypedInputValue<string> = 7;

// --- Negative: a STRING-result marker is rejected in a NUMBER slot -----------
// @ts-expect-error — jsonata result is string, slot wants number.
const badJInNum: TypedInputValue<number> = jStr;
// @ts-expect-error — Ref<string> in a number slot.
const badRefInNum: TypedInputValue<number> = refStr;

// --- Positive: a literal-union slot (a contract enum) admits its members -----
const okEnumMember: TypedInputValue<"a" | "b"> = "a";
// @ts-expect-error — "c" is not one of the slot's literals.
const badEnumMember: TypedInputValue<"a" | "b"> = "c";

// --- Structural recursion: arrays and nested objects thread element-wise -----
const okNumArr: TypedInputValue<number[]> = [jNum, refNum, 3];
// @ts-expect-error — a string marker among a number[] slot's elements.
const badNumArr: TypedInputValue<number[]> = [jStr];
const okObj: TypedInputValue<{ count: number; label: string }> = { count: jNum, label: jStr };
// @ts-expect-error — number marker where the object's `label` field wants string.
const badObj: TypedInputValue<{ count: number; label: string }> = { count: jNum, label: jNum };

// ---------------------------------------------------------------------------
// The ParamRef back door stays CLOSED. `.ref`'s public return type is the bare
// `ParamRef` base; `Ref`'s phantom is REQUIRED so that base satisfies NO
// `Ref<V>` instantiation. These pins keep the hole shut against refactors —
// if the phantom ever goes optional again, every line below breaks.
// ---------------------------------------------------------------------------

// (a) A value statically typed as the bare `ParamRef` is rejected in EVERY
// typed slot (with an optional phantom it entered them all).
const bareRef = p.string().ref;
// @ts-expect-error — a bare ParamRef carries no result type; a number slot rejects it.
const badBareInNum: TypedInputValue<number> = bareRef;
// @ts-expect-error — ...and a string slot rejects it too (no any-slot pass).
const badBareInStr: TypedInputValue<string> = bareRef;
// @ts-expect-error — ...and a literal-union slot.
const badBareInEnum: TypedInputValue<"a" | "b"> = bareRef;

// (b) Erasure-by-widening is closed: upcasting a Ref<number> to its ParamRef
// base must not let it re-enter a mismatched slot.
const widenedToBase: ParamRef = refNum;
// @ts-expect-error — the widened base is rejected; a single upcast cannot re-erase.
const badWidened: TypedInputValue<string> = widenedToBase;

// The loose path still admits the bare ref (compatibility unchanged).
const looseAcceptsBareRef: InputValue = bareRef;

// ---------------------------------------------------------------------------
// MarkerValue<M> — recover the type a marker carries (derive's input inference).
// ---------------------------------------------------------------------------

/** True only when A and B are mutually assignable (exact, invariant match). */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Each marker kind extracts to the type it renders — EXACTLY (a plain Ref<T>
// yields T, never `T | undefined`; that is what keeps a non-conditional derive
// input non-optional, per ADR-0025).
const exactRefNum: Exact<MarkerValue<Ref<number>>, number> = true;
const exactRefEnum: Exact<MarkerValue<Ref<"low" | "high">>, "low" | "high"> = true;
const exactJNum: Exact<MarkerValue<JsonataNumber>, number> = true;
const exactNjStr: Exact<MarkerValue<NunjucksString>, string> = true;
const exactPickStr: Exact<MarkerValue<PickString>, string> = true;
type JsonataNumber = typeof jNum;
type NunjucksString = typeof njStr;
type PickString = typeof pickStr;

// A bare ParamRef (untyped ref) extracts to `unknown` — the honest
// author-must-narrow signal, never a silently-guessed type.
const bareRefExtractsUnknown: Exact<MarkerValue<ParamRef>, unknown> = true;

// The derive use: an `inputs` object maps to its lambda context, field by field.
type DeriveInputs = { count: Ref<number>; label: Ref<string>; sev: Ref<"low" | "high"> };
type DeriveCtx = { [K in keyof DeriveInputs]: MarkerValue<DeriveInputs[K]> };
const exactDeriveCtx: Exact<DeriveCtx, { count: number; label: string; sev: "low" | "high" }> = true;

// ---------------------------------------------------------------------------
// The loose `InputValue` path is UNCHANGED — it still admits every marker,
// result type regardless (this is the compatibility guarantee).
// ---------------------------------------------------------------------------
const looseAcceptsJNum: InputValue = jNum;
const looseAcceptsJStr: InputValue = jStr;
const looseAcceptsRef: InputValue = refNum;
const looseAcceptsPick: InputValue = pickNum;
const looseAcceptsRaw: InputValue = rawExpr;
const looseAcceptsLiteral: InputValue = 42;
const looseAcceptsNested: InputValue = { a: [jNum, "x", refStr], b: { c: pickStr } };

// ---------------------------------------------------------------------------
// .orElse(default) (ADR-0025 §5, issue #16) — the result composes with
// TypedInputValue<T>. `NunjucksExpr` is one of `TypedMarker`'s four kinds
// (see the union above), so `.orElse`'s returned marker slots into a
// TypedInputValue<T> position exactly like jsonata()/nj()/env.pick do.
// ---------------------------------------------------------------------------

// A conditional field types as `Ref<T | undefined>` (the shape a showWhen-aware
// `f` carries); `.orElse` resolves the absence — the returned marker is the
// EXACT `NunjucksExpr<NjContext, T>` instantiation, non-undefined.
const refOptStr = p.string().ref as Ref<string | undefined>;
const orElseResult = refOptStr.orElse("fallback");
const exactOrElse: Exact<typeof orElseResult, NunjucksExpr<NjContext, string>> = true;

// The .orElse() result slots into a TypedInputValue<string> position, exactly
// like any other TypedMarker.
const okOrElseInStr: TypedInputValue<string> = orElseResult;
// @ts-expect-error — the resolved marker is string-typed; a number slot rejects it.
const badOrElseInNum: TypedInputValue<number> = orElseResult;

// On a plain Ref<T> (no `undefined` in T) `.orElse` is allowed but pointless:
// `Exclude<T, undefined>` is just `T` again, so the call still type-checks and
// still composes with TypedInputValue<T>.
const plainOrElse = refStr.orElse("fallback");
const okPlainOrElseInStr: TypedInputValue<string> = plainOrElse;
