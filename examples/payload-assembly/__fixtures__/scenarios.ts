// Scenario fixtures for the Order Ticket Builder.
//
// The `build-ticket` step is a `roadiehq:utils:jsonata` step, so `execute()` runs
// its expression FOR REAL (no mock needed) — these scenarios pin the assembled
// ticket across the interesting inputs:
//   - a high-priority multi-item order (rush fee + rush meta + a real discount),
//   - a normal order with a NON-numeric discount code (parseInt → missing),
//   - a low-priority order with a code that has no numeric prefix (→ missing).
// The throwing edge (empty customerName → the $assert aborts) is asserted in the
// test rather than snapshotted, since a throwing run has no stable output.

import type { ExecuteFixture } from "@tdk/core";

type TicketParams = {
  customerName: string;
  items: { sku: string; qty: number; options: string[]; unitPrice?: number }[];
  priority: "low" | "normal" | "high";
  discountCode?: string;
} & Record<string, unknown>;

interface Scenario {
  name: string;
  branches?: string[];
  fixture: ExecuteFixture<TicketParams>;
}

export const scenarios: Scenario[] = [
  {
    name: "high priority — rush fee, two items, real discount",
    branches: ["high", "discount"],
    fixture: {
      parameters: {
        customerName: "Alice",
        items: [
          { sku: "CAKE-1", qty: 2, options: ["gluten-free", "vanilla"], unitPrice: 10 },
          { sku: "TOPPER-1", qty: 1, options: [], unitPrice: 4 },
        ],
        priority: "high",
        discountCode: "15OFF", // parseInt → 15
      },
    },
  },
  {
    name: "normal priority — non-numeric-prefix discount → missing",
    branches: ["normal", "no-discount"],
    fixture: {
      parameters: {
        customerName: "Bob",
        items: [{ sku: "CAKE-2", qty: 1, options: ["chocolate"], unitPrice: 8 }],
        priority: "normal",
        discountCode: "SAVE15x", // no LEADING numeric prefix → missing (not 15)
      },
    },
  },
  {
    name: "low priority — free-text discount code → missing, zero-price item",
    branches: ["low", "zero-price"],
    fixture: {
      parameters: {
        customerName: "Cleo",
        // A missing unitPrice defaults to 0 via `|| 0` (value semantics).
        items: [{ sku: "CAKE-3", qty: 3, options: ["red-velvet"] }],
        priority: "low",
        discountCode: "none", // no numeric prefix → missing
      },
    },
  },
];
