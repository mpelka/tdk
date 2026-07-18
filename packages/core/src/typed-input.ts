// Typed step-input values — the enabler for authoring-v2's typed refs and
// `derive` (ADR-0025, phase 1; issue #15).
//
// The loose `InputValue` (template.ts) admits every marker `any`-parameterized,
// so a marker's RESULT type is erased at a step-input position: a `jsonata(...)`
// rendering a number is accepted where a string belongs. The markers already
// carry the type — `JsonataExpr<Ctx, R>` / `NunjucksExpr<Ctx, R>` hold the
// result `R`, `Ref<T>` / `EnvPick<T>` hold the value `T` — it is only the
// input-value union that throws it away.
//
// This module threads that type through, in both directions:
//
//   - `TypedInputValue<V>` — the CONSTRAINT sibling of `InputValue`: the set of
//     values that render to a `V`. A `jsonata(...)` whose result is a number is
//     rejected in a `TypedInputValue<string>` position and accepted in a
//     `TypedInputValue<number>` one; `Ref<T>` / `EnvPick<T>` behave the same.
//     This is what a contract-typed step input constrains against, one field at
//     a time — the per-env contract mapping composes it as
//     `{ [K in keyof Schema]: TypedInputValue<Schema[K]> }` (issue #7).
//
//   - `MarkerValue<M>` — the EXTRACTION dual: given a marker, recover the value
//     type it carries. This is what `derive(name, inputs, fn)` reads to infer
//     its lambda's context from the `inputs` object — `{ severity }` (a
//     `Ref<"low" | "normal" | "urgent">`) yields `{ severity: "low" | "normal"
//     | "urgent" }`, with no hand-written `Ctx` type and no `data:` map.
//
// This is a purely ADDITIVE, TYPE-ONLY surface: nothing here runs, and the loose
// `InputValue` keeps admitting everything it does today at every position that
// uses it. Phase 2/3 wire these types into `derive` and the contract-checked
// step input; phase 1 only makes them expressible.

import type { Ref } from "./define.ts";
import type { DeriveMarker } from "./derive.ts";
import type { EnvPick } from "./env.ts";
import type { RawExpr } from "./expr/index.ts";
import type { JsonataExpr } from "./expr/jsonata/index.ts";
import type { NunjucksExpr } from "./expr/nunjucks/index.ts";
import type { Resolvable } from "./resolve.ts";

/**
 * The markers that carry a statically-known result type `V`. Each is
 * parameterized so a mismatched result is rejected structurally:
 *   - `JsonataExpr` / `NunjucksExpr` — `R` lives only in `fn: (ctx) => R`, and
 *     return types are covariant, so `JsonataExpr<any, number>` is NOT
 *     assignable to `JsonataExpr<any, string>`.
 *   - `Ref<T>` — the REQUIRED phantom `__tdkRefType: T` differs by `T`, so
 *     `Ref<number>` is not a `Ref<string>` (and the bare `ParamRef` base, which
 *     lacks the phantom, is no `Ref` at all — see `UntypedInputMarker`).
 *   - `EnvPick<T>` — `values: Record<string, T>` differs by `T`.
 *   - `DeriveMarker<V>` — a `derive(...)` handle; its REQUIRED `__tdkResultType`
 *     phantom differs by `V`, so a handle rendering the wrong type is rejected.
 *
 * The `Ctx` of the two expression markers stays `any` on purpose (as the loose
 * `InputValue` does): `fn` is contravariant in `Ctx`, so a concrete
 * `JsonataExpr<SomeCtx, V>` is not assignable to `JsonataExpr<unknown, V>` —
 * `any` accepts every concrete instantiation while leaving `V` load-bearing.
 */
export type TypedMarker<V> =
  // biome-ignore lint/suspicious/noExplicitAny: variance — Ctx must stay `any` to accept any concrete JsonataExpr<Ctx,V> (Ctx is contravariant in fn); V is the constrained result.
  | JsonataExpr<any, V>
  // biome-ignore lint/suspicious/noExplicitAny: variance — Ctx must stay `any` to accept any concrete NunjucksExpr<Ctx,V> (Ctx is contravariant in fn); V is the constrained result.
  | NunjucksExpr<any, V>
  | Ref<V>
  | EnvPick<V>
  | DeriveMarker<V>;

/**
 * The escape-hatch markers that carry NO static result type, and so are accepted
 * in ANY typed slot — exactly as they are in the loose `InputValue`:
 *   - `RawExpr` (`raw\`…\``) — a verbatim Scaffolder string the author owns.
 *   - `Resolvable` (`person("…")`) — resolved to a concrete value at compile.
 *
 * The bare `RawRef` interface is deliberately NOT here: every typed marker
 * implements it, so admitting it would re-erase the result types this module
 * exists to preserve. The one structural back door was NOT `RawRef` but the
 * concrete `ParamRef` class — the public `.ref` getter's return type: while
 * `Ref`'s phantom was optional, a bare `ParamRef` satisfied `Ref<V>` for EVERY
 * `V` (a missing optional property matches every instantiation), erasing the
 * result type this union is built to keep. `Ref.__tdkRefType` is REQUIRED
 * (define.ts) precisely to close that: the bare base matches no instantiation
 * and is rejected in every typed slot. `RawRef`-the-interface is separately
 * blocked: `ParamRef` carries a private member, which makes `Ref` nominal, so
 * no structural object can pose as a `Ref<V>` either.
 */
export type UntypedInputMarker = RawExpr | Resolvable;

/**
 * The TYPED sibling of `InputValue`: the values that render to a `V`. A literal
 * of type `V`, a result-typed marker (`TypedMarker<V>`), an untyped escape-hatch
 * marker, or — structurally — an array / object of the same, so it composes over
 * a JSON-Schema-shaped `V`.
 *
 * The scalar guarantee is independent of the recursion: when `V` is a scalar the
 * array and object branches resolve to `never`, so a wrong-typed marker can only
 * be judged against the `V` / `TypedMarker<V>` members — which is where it is
 * (correctly) rejected. When `V` is an array or object, the recursion adds the
 * nested-marker shapes on top.
 *
 * ```ts
 * const a: TypedInputValue<number> = jsonata<Ctx, number>((c) => c.parameters.n); // ok
 * const b: TypedInputValue<string> = jsonata<Ctx, number>((c) => c.parameters.n); // ✗ number ≠ string
 * ```
 */
export type TypedInputValue<V> =
  | V
  | TypedMarker<V>
  | UntypedInputMarker
  | (V extends readonly (infer U)[] ? TypedInputValue<U>[] : never)
  | (V extends string | number | boolean | null | undefined
      ? never
      : V extends object
        ? { [K in keyof V]: TypedInputValue<V[K]> }
        : never);

/**
 * The EXTRACTION dual of `TypedInputValue`: the value type a marker carries. Its
 * consumer is `derive`'s input inference — `MarkerValue<Ref<T>>` is `T`, so a
 * `{ name: Ref<T> }` inputs object maps to the lambda context `{ name: T }`.
 *
 * Wrapped in `[…]` tuples so `M` is matched WHOLE (no distribution over a union
 * marker). A literal passes through; anything the DSL does not type (a bare
 * `RawExpr` / `Resolvable`, an untyped `ParamRef`) widens to `unknown`, which is
 * the honest "author must narrow this" signal.
 */
export type MarkerValue<M> = [M] extends [DeriveMarker<infer R>]
  ? R
  : [M] extends [Ref<infer T>]
    ? T
    : // biome-ignore lint/suspicious/noExplicitAny: match any concrete JsonataExpr<Ctx,R> and read R (Ctx is irrelevant to extraction).
      [M] extends [JsonataExpr<any, infer R>]
      ? R
      : // biome-ignore lint/suspicious/noExplicitAny: match any concrete NunjucksExpr<Ctx,R> and read R (Ctx is irrelevant to extraction).
        [M] extends [NunjucksExpr<any, infer R>]
        ? R
        : [M] extends [EnvPick<infer T>]
          ? T
          : [M] extends [string | number | boolean | null]
            ? M
            : unknown;
