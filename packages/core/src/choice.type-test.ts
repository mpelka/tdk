// TYPE-LEVEL proof for `p.choice` (ADR-0025 §5): the value union is TYPED — the
// object form's KEYS or the array form's ELEMENTS flow into the returned
// `Param<V>`, exactly like `p.enum`'s value union does — so `.is()`/`.in()`
// literal-check against them and a typo is a compile error, not a runtime
// showWhen-value miss.
//
// This file is NOT a runtime test (no `.test` in the name, so `bun test` skips
// it); it is checked by `bun run typecheck` (tsc over `src`). Each
// `@ts-expect-error` asserts the line BELOW is a compile error — delete one and
// typecheck fails, which is the load-bearing proof that the constraint bites.
//
// biome-ignore-all lint/correctness/noUnusedVariables: type-level assertions.

import { p } from "./index.ts";

// --- Object form: the union is the object's KEYS -----------------------------
const bakeryCode = p.choice({ BK1: "Riverside", BK2: "Old Town" }, { title: "Bakery site" });
bakeryCode.is("BK1");
bakeryCode.in("BK1", "BK2");
// @ts-expect-error — "BK3" is not one of the object form's keys.
bakeryCode.is("BK3");
// @ts-expect-error — a LABEL (the object's VALUE side) is not a valid value.
bakeryCode.is("Riverside");

// --- Array form: the union is the array's ELEMENTS ---------------------------
const ovenType = p.choice(["deck", "convection", "rack"], { title: "Oven type" });
ovenType.is("deck");
ovenType.in("deck", "rack");
// @ts-expect-error — "microwave" is not one of the array form's values.
ovenType.is("microwave");

// --- No options: still typed (regression guard for the overload without `opts`) --
const size = p.choice(["S", "M", "L"]);
size.is("M");
// @ts-expect-error — "XL" is out of the declared set.
size.is("XL");
