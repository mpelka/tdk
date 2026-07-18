// TYPE-LEVEL proof for `derive` (ADR-0025 Decision 2, phase 3a). The handle is a
// result-typed marker; its lambda context is INFERRED from the inputs (a plain
// ref is `T`, a conditional field is `T | undefined`); property access yields
// typed sub-refs; and a handle satisfies `TypedInputValue<R>` exactly.
//
// This file is NOT a runtime test (no `.test` in the name, so `bun test` skips
// it); it is checked by `bun run typecheck` (tsc over `src`). Each
// `@ts-expect-error` asserts the line BELOW is a compile error — delete one and
// typecheck fails, the load-bearing proof that the constraint bites.
//
// biome-ignore-all lint/correctness/noUnusedVariables: type-level assertions; values exist only to be checked.
// biome-ignore-all lint/suspicious/noExplicitAny: mirrors marker variance under test.

import type { FieldRefs, Ref } from "./define.ts";
import type { DeriveContext, DeriveHandle, DeriveMarker } from "./derive.ts";
import { derive } from "./derive.ts";
import { page } from "./pages.ts";
import { p } from "./params.ts";
import type { MarkerValue, TypedInputValue } from "./typed-input.ts";

/** True only when A and B are mutually assignable (exact, invariant match). */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const refNum = p.number().ref as Ref<number>;
const refStr = p.string().ref as Ref<string>;
const refOptStr = p.string().ref as Ref<string | undefined>; // a conditional field's ref shape

// ---------------------------------------------------------------------------
// Inferred lambda context — a ref maps to its value type, exactly.
// ---------------------------------------------------------------------------

// A plain ref types as `T` (no spurious `undefined`): the lambda uses it as a number.
const numHandle = derive("num", { c: refNum }, (i) => i.c + 1);
// @ts-expect-error — i.c is `number`, so a string method is a type error.
const badNumCtx = derive("bad-num", { c: refNum }, (i) => i.c.toUpperCase());

// A conditional field's ref types as `T | undefined` — the lambda must handle absence.
const condHandle = derive("cond", { d: refOptStr }, (i) => i.d ?? "fallback");
// @ts-expect-error — i.d is `string | undefined`; calling a string method unguarded is an error.
const badCondCtx = derive("bad-cond", { d: refOptStr }, (i) => i.d.toUpperCase());

// The context type, spelled out via the alias.
type Ctx = DeriveContext<{ c: Ref<number>; label: Ref<string>; d: Ref<string | undefined> }>;
const exactCtx: Exact<Ctx, { c: number; label: string; d: string | undefined }> = true;

// A param CONST input (the ADR surface) infers from the param's value type.
const sev = p.choice(["low", "normal", "urgent"]);
type ParamCtx = DeriveContext<{ severity: typeof sev }>;
const exactParamCtx: Exact<ParamCtx, { severity: "low" | "normal" | "urgent" }> = true;

// A param made conditional via `.showWhen(...)` infers as `T | undefined`.
const area = p.choice(["heating", "other"]);
const detail = p.string().showWhen(area.is("other"));
type CondParamCtx = DeriveContext<{ detail: typeof detail }>;
const exactCondParamCtx: Exact<CondParamCtx, { detail: string | undefined }> = true;

// The field-ref map `f` encodes the same conditionality: a `.showWhen(...)` field
// becomes `Ref<T | undefined>`, a plain field `Ref<T>`. This is what threads the
// `T | undefined` into a derive that reads `f.<field>` (the second deliverable).
const condPage = page("P", { detail, plain: p.string() });
type PageRefs = FieldRefs<[typeof condPage]>;
const exactPageRefs: Exact<PageRefs, { detail: Ref<string | undefined>; plain: Ref<string> }> = true;

// ---------------------------------------------------------------------------
// The handle — a result-typed marker.
// ---------------------------------------------------------------------------

// `MarkerValue` recovers the lambda's return type, exactly.
const exactMarkerValue: Exact<MarkerValue<typeof numHandle>, number> = true;

// The handle satisfies `TypedInputValue<R>` (it is a first-class TypedMarker kind).
const okHandleInSlot: TypedInputValue<number> = numHandle;
// @ts-expect-error — a number-result handle is rejected in a string slot.
const badHandleInSlot: TypedInputValue<string> = numHandle;

// ---------------------------------------------------------------------------
// Property sub-refs — an object-typed handle exposes a typed handle per property.
// ---------------------------------------------------------------------------

const objHandle = derive("obj", { c: refNum }, (i) => ({ summary: `n=${i.c}`, count: i.c }));
// `.summary` is a `DeriveHandle<string>`; `.count` a `DeriveHandle<number>`.
const exactSummaryValue: Exact<MarkerValue<typeof objHandle.summary>, string> = true;
const exactCountValue: Exact<MarkerValue<typeof objHandle.count>, number> = true;

// A sub-ref is itself a usable typed input, and a `DeriveHandle` of its field type.
const okSubRefInSlot: TypedInputValue<string> = objHandle.summary;
const subRefIsHandle: DeriveHandle<string> = objHandle.summary;
// @ts-expect-error — the `count` sub-ref is a number; a string slot rejects it.
const badSubRefInSlot: TypedInputValue<string> = objHandle.count;

// A handle feeds another derive's inputs, typed end-to-end.
const chained = derive("chained", { s: objHandle.summary, n: objHandle.count }, (i) => `${i.s}:${i.n + 1}`);
const exactChained: Exact<MarkerValue<typeof chained>, string> = true;

// A DeriveMarker<V> extracts to V (the marker-only view, no sub-refs).
const exactDeriveMarker: Exact<MarkerValue<DeriveMarker<boolean>>, boolean> = true;
