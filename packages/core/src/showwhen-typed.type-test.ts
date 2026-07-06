// TYPE-LEVEL proof for typed `showWhen` — the editor catches the typo from #53.
//
// This file is NOT a runtime test (no `.test` in the name, so `bun test` skips it);
// it is checked by `bun run typecheck` (tsc over `src`). Each `@ts-expect-error`
// asserts the line below is a COMPILE error — remove one and typecheck fails, which
// is the load-bearing proof that `orderType.is("zzxcczc")` squiggles in the IDE.
//
// biome-ignore-all lint/correctness/noUnusedVariables: type-level assertions; values exist only to be checked.

import { all, p } from "./index.ts";

const orderType = p.enum(["standard", "custom", "wedding"], { title: "Order type", required: true });
const topper = p.boolean({ title: "Add a topper?" });

// --- Valid literals compile (the day-one win: p.enum captures V) ---------------
const okEnum = orderType.is("wedding");
const okBool = topper.is(true);
const okIn = orderType.in("custom", "wedding");
const okAll = all(orderType.is("wedding"), topper.is(true));

// A field authored with the marker form typechecks.
const okField = p.string({ title: "Topper text", showWhen: all(orderType.is("wedding"), topper.is(true)) });
// The single-condition (no `all`) form typechecks.
const okSingle = p.number({ title: "Tiers", showWhen: orderType.is("wedding") });
// The record form still typechecks (additive — it is unchanged).
const okRecord = p.string({ title: "Note", showWhen: { orderType: "wedding" } });

// --- The typo from the issue is a TYPE ERROR -----------------------------------
// @ts-expect-error — "zzxcczc" is not one of the enum's literals.
const badEnumValue = orderType.is("zzxcczc");

// @ts-expect-error — a boolean controller rejects a string value.
const badBoolValue = topper.is("yes");

// @ts-expect-error — `.in` is literal-checked too.
const badInValue = orderType.in("custom", "weding");

// @ts-expect-error — mixing a bad literal into an otherwise-valid `all`.
const badAll = all(orderType.is("wedding"), topper.is("nope"));

// A `p.enum` value used as a boolean condition is also caught.
// @ts-expect-error — orderType is a string enum, not a boolean.
const badEnumAsBool = orderType.is(true);
