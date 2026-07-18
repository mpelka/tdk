// TYPE-LEVEL proof for `effect` (ADR-0025 Decision 3, phase 3b). The output handle
// is a result-typed marker; navigating it types each leaf; a wrong-typed output is
// rejected in a `TypedInputValue<V>` slot; it composes into a `derive`'s inputs and
// another effect's inputs; and the both-shapes-at-once v2 config is a type error.
//
// This file is NOT a runtime test (no `.test` in the name, so `bun test` skips it);
// it is checked by `bun run typecheck`. Each `@ts-expect-error` asserts the line
// BELOW is a compile error — delete one and typecheck fails.
//
// biome-ignore-all lint/correctness/noUnusedVariables: type-level assertions; values exist only to be checked.

import { defineTemplate } from "./define.ts";
import { derive } from "./derive.ts";
import type { EffectHandle, OutputRef } from "./effects.ts";
import { effect, rawEffect } from "./effects.ts";
import { page } from "./pages.ts";
import { p } from "./params.ts";
import type { MarkerValue, TypedInputValue } from "./typed-input.ts";

/** True only when A and B are mutually assignable (exact, invariant match). */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// The declared output SHAPE — the effect's type parameter `O`.
interface TicketOutput {
  body: { url: string; id: string };
  attempts: number;
}
const ticket = effect<TicketOutput>("open-ticket", "bakery:raise-ticket", {});

// ---------------------------------------------------------------------------
// The output handle — navigate, and each leaf carries its property's type.
// ---------------------------------------------------------------------------

// `.output` is `OutputRef<TicketOutput>`; `MarkerValue` recovers the whole shape.
const exactRoot: Exact<MarkerValue<typeof ticket.output>, TicketOutput> = true;

// A nested leaf types as its property's type.
const exactUrl: Exact<MarkerValue<typeof ticket.output.body.url>, string> = true;
const exactId: Exact<MarkerValue<typeof ticket.output.body.id>, string> = true;
const exactAttempts: Exact<MarkerValue<typeof ticket.output.attempts>, number> = true;

// A sub-ref is itself an `OutputRef` of its field type.
const bodyRef: OutputRef<{ url: string; id: string }> = ticket.output.body;
const urlRef: OutputRef<string> = ticket.output.body.url;

// ---------------------------------------------------------------------------
// TypedInputValue composition — an output ref is rejected in a wrong-typed slot.
// ---------------------------------------------------------------------------

const okUrlSlot: TypedInputValue<string> = ticket.output.body.url;
const okAttemptsSlot: TypedInputValue<number> = ticket.output.attempts;
// @ts-expect-error — the url leaf is a string; a number slot rejects it.
const badUrlSlot: TypedInputValue<number> = ticket.output.body.url;
// @ts-expect-error — the attempts leaf is a number; a string slot rejects it.
const badAttemptsSlot: TypedInputValue<string> = ticket.output.attempts;

// ---------------------------------------------------------------------------
// Composition into a derive's inputs — the leaf type threads through.
// ---------------------------------------------------------------------------

const fromEffect = derive(
  "from-effect",
  { u: ticket.output.body.url, n: ticket.output.attempts },
  (i) => `${i.u}:${i.n}`,
);
// @ts-expect-error — i.n is `number`; calling a string method is a type error.
const badFromEffect = derive("bad-from-effect", { n: ticket.output.attempts }, (i) => i.n.toUpperCase());

// Composition into ANOTHER effect's input (a data dependency between effects).
const chained = effect<{ ok: boolean }>("chained", "bakery:confirm", {
  input: { ticketId: ticket.output.body.id, whole: ticket.output },
});
const exactChainedHandle: Exact<typeof chained, EffectHandle<{ ok: boolean }>> = true;

// ---------------------------------------------------------------------------
// Reserved keys are OMITTED from sub-refs (the type matches the runtime).
// ---------------------------------------------------------------------------

// @ts-expect-error — `then` is reserved (a sub-ref here would make the handle thenable).
const badThen = ticket.output.then;
// @ts-expect-error — `toJSON` is reserved (serialization probes must see undefined).
const badToJson = ticket.output.toJSON;

// ---------------------------------------------------------------------------
// rawEffect — the escape hatch — also yields a typed handle.
// ---------------------------------------------------------------------------

const wrapped = rawEffect<{ ref: string }>({ id: "wrapped", action: "svc:do", input: { x: "y" } });
const exactWrappedRef: Exact<MarkerValue<typeof wrapped.output.ref>, string> = true;

// ---------------------------------------------------------------------------
// The both-shapes-at-once v2 config is a TYPE error where expressible.
// ---------------------------------------------------------------------------

const bakeryCode = p.choice(["BK1", "BK2"], { title: "Site", required: true });

// A clean v2 config type-checks.
const okV2 = defineTemplate({
  id: "ok-v2",
  title: "OK",
  type: "service",
  pages: [page("P", { bakeryCode })],
  effects: [ticket],
  output: { url: ticket.output.body.url },
});

// @ts-expect-error — a v2 config declares `effects:` and must NOT also declare `steps:`.
const badBothShapes = defineTemplate({
  id: "bad",
  title: "Bad",
  type: "service",
  pages: [page("P", { bakeryCode })],
  effects: [ticket],
  steps: () => [],
});
