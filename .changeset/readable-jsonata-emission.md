---
"@tdk/core": patch
---

Emitted JSONata inlines simple pure operands instead of always hoisting a scoping temp. Previously every `||`/`&&`/`.length` emission introduced a `$__or`/`$__and`/`$__len` temp to guard against double-evaluation; now a temp is only kept when the operand is a call expression, a computed index, or another construct where double-evaluation could change cost or behavior. For a simple operand — a variable reference, a property-access chain, a fixed-index element access, or a literal — the temp is proven redundant (JSONata is pure) and is inlined, e.g. `($boolean(baseFee) ? baseFee : 0)` instead of `($__or3 := baseFee; $boolean($__or3) ? $__or3 : 0)`.

This changes the literal text of compiled expression strings (more readable output), but not the values they evaluate to — differential tests confirm both forms agree with the JS oracle. Templates or tests asserting on exact compiled expression strings (rather than `execute()` results) will see a diff and may need their fixtures regenerated; scenario snapshot outcomes are unaffected.
