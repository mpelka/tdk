// The Order Ticket assembler — ONE block-bodied lambda that assembles the whole
// ticket, wired into a `derive("build-ticket", …)` in template.ts (AUTHORING-V2).
// Kept in its own module so the lambda reads cleanly AND the template stays a short
// dataflow graph; the tests import the DERIVE HANDLE (`getDeriveExpr`) for the
// differential harness, so the shared expression object lives on the derive, not
// here. A `derive` transpiles its lambda through the SAME TS→JSONata transpiler
// `jsonata()` uses, so every corner below is exercised exactly as before.
//
// It exercises, in one expression:
//   - `$assert` guard (a ticket must name its customer),
//   - `.map` with a NESTED lambda over each item's options that REDUCES to a scalar
//     (`join`) — the documented AGREEING case for nested maps (a non-reducing nested
//     map would FLATTEN per expression-support.md; invariant b),
//   - `|| 0` VALUE-defaulting (invariant a: the value flows through, never a boolean),
//   - a scalar `total` FOLD of `|| 0`-defaulted fee components,
//   - a spread-merged `meta` ({ ...base, ...override }, later keys win),
//   - `parseInt(discountCode)` via the lenient shim (numeric-prefix → number; no
//     prefix → MISSING, not NaN).

import { assert } from "@tdk/core";

/**
 * The derive's inferred context — the fields `build-ticket` reads. It matches the
 * derive's `inputs` object exactly (`{ customerName, items, priority, discountCode }`),
 * so the lambda's `i` is fully typed with no separate `Ctx` and no `data:` map.
 * `discountCode` is a plain `string` (the field is optional but not conditional, and
 * the roadie `data` always renders it to a string — empty when the param is absent,
 * which the parseInt shim maps to MISSING).
 */
export interface TicketCtx {
  customerName: string;
  items: { sku: string; qty: number; options: string[]; unitPrice?: number }[];
  priority: "low" | "normal" | "high";
  discountCode: string;
}

// The block-bodied assembler — `derive("build-ticket", inputs, assembleTicket)`. An
// ARROW (not a `function` declaration), so the TS→JSONata transpiler parses the whole
// block, exactly as `jsonata((c) => { … })` does.
export const assembleTicket = (i: TicketCtx) => {
  // Guard: a ticket must name its customer, else abort the run (→ $assert).
  assert(i.customerName !== "", "customerName is required");

  // Per-item lines. The nested `.map` folds each item's options into a label and
  // REDUCES to a scalar via `.join(...)` — nested maps that reduce to a scalar
  // agree with JS (a non-reducing nested map would flatten; see the module note).
  const lineItems = i.items.map((item) => ({
    sku: item.sku,
    qty: item.qty,
    // `item.unitPrice || 0` — VALUE semantics: a present price passes through; a
    // missing/zero one defaults to 0. The result is the value, never a boolean.
    unitPrice: item.unitPrice || 0,
    label: item.options.map((o) => o).join(", "),
    lineTotal: (item.unitPrice || 0) * item.qty,
  }));

  // The fee FOLD: fixed components, each `|| 0`-defaulted, summed into a scalar.
  // `rushFee` is only non-zero for high priority — so `rushFee || 0` proves the
  // value (0 or 15) flows through, not `Boolean(rushFee)`.
  const baseFee = 5;
  const rushFee = i.priority === "high" ? 15 : 0;
  const total = (baseFee || 0) + (rushFee || 0);

  // spread-merge: a base object overridden per priority (later keys win on both
  // sides). High priority flips `rush`; others attach the priority label.
  const base = { channel: "web", rush: false };
  const meta = i.priority === "high" ? { ...base, rush: true } : { ...base, priority: i.priority };

  return {
    summary: `Order for ${i.customerName} — ${i.priority} priority (${i.items.length} item(s))`,
    lineItems,
    total,
    meta,
    // Parsed from the code (lenient shim): "15OFF" → 15, "SAVE15x"/"none" → missing.
    // NO radix on purpose — the jsonata() transpiler REJECTS parseInt's radix arg
    // (it maps to a $match-prefix shim, not $number(x, radix)); a base-10 default
    // is exactly the shim's behaviour.
    // biome-ignore lint/correctness/useParseIntRadix: the TDK jsonata transpiler rejects parseInt's radix argument — see docs/expression-support.md
    discountPct: parseInt(i.discountCode),
  };
};
