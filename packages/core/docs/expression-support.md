# Expression support — `jsonata()` and `nj()`

The full support matrix and every semantic divergence now live in the docs site at
`apps/docs/reference/expression-support.md`. That page carries the complete
`jsonata()`/`nj()` construct tables, the pretty-vs-compact formatting rules, and the
JS-oracle-vs-engine divergences.

The source of truth is the code, not either document. It is the curated maps and
tests in `src/expr/jsonata/` and `src/expr/nunjucks/` — the `METHOD_MAP`,
`GLOBAL_MAP` and `PROPERTY_FN_MAP` plus the `*.test.ts` files. Every
`METHOD_MAP`/`GLOBAL_MAP` row is engine-verified by the mechanical differential suite
(`fnmap.differential.test.ts`): a row cannot be added without a case.

Anything unsupported throws a `TranspileError` / `NjTranspileError` at compile — use
the `raw` escape hatch (`` raw.jsonata`…` `` or `` raw`${{ … }}` ``) for it.
