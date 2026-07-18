---
"@tdk/core": minor
---

Add `derive(name, inputs, fn)` — typed dataflow values with auto-wired step planning (ADR-0025 Decision 2, phase 3a, #18).

`derive` declares a runtime-computed value as a dataflow node. Its `inputs` are typed references (a field ref `f.x`, a param const, another derive's handle or a property sub-ref of one, an `nj()`/`jsonata()` marker, or a literal); its `fn` transpiles through the SAME TS→JSONata transpiler `jsonata()` uses (never forked); and it returns a typed handle.

- The lambda's context is inferred from `inputs` (`{ [K]: MarkerValue<inputs[K]> }`) — no hand-written `Ctx`, no `data:` map. A conditional field types as `T | undefined`, forcing the lambda to handle absence: BOTH the `.showWhen(...)` method and the `showWhen:` option brand their param `ConditionalBrand` (the option via a branded overload on each `p.*` factory), which `ParamValueOf` reads so a conditional field's ref (`f.x`) is `Ref<T | undefined>`.
- The handle is a first-class `TypedMarker` kind (`DeriveMarker<R>`): it satisfies `TypedInputValue<R>`, `MarkerValue` recovers `R`, and property access on an object-typed handle yields typed sub-refs (`jira.summary` → `${{ steps['jira'].output.result.summary }}`). Sub-ref keys must be plain identifiers — any other key throws at the access site (the segment is spliced into the emitted `${{ }}` path); reserved keys (`then`/`toJSON`/`render`/…) are omitted from the type and unreachable at runtime.
- Consuming a handle anywhere emits `${{ steps['<name>'].output.result }}` — never written by hand. Reachable derives (from the manual `steps` list and `output`) compile to `roadiehq:utils:jsonata` steps; the combined graph is topologically ordered, so a derive lands after everything it reads (the SSA case lookup → derive → register), including step references inside `env.pick` branches (every branch contributes edges — the union over envs). A dependency cycle and a duplicate derive name are loud compile errors; a declared-but-unreachable derive is excluded with a warning on the new optional `CompileResult.diagnostics`, attributed per template by its param refs so one template's orphan never surfaces in another's diagnostics.

Additive: this only adds emission for templates that use `derive`. Templates that use no `derive` compile to byte-identical YAML as before — the planner returns their manual steps unchanged — so no existing gold or scenario snapshot moves. No `output-changing:`/`snapshot-affecting:` flag applies.
