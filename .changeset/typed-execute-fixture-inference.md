---
"@tdk/core": major
---

`defineTemplate` now returns a `TypedTemplate<ParamValues<P>>`, and `execute<T extends TemplateInput>` infers the scenario fixture type from the template's own param typing (`P extends Record<string, unknown>`).

**Breaking (type-level only — runtime behavior is unchanged).** A hand-declared fixture interface (e.g. `interface OrderParams { flavor?: string; … }`) no longer satisfies the new constraint on its own. Add an index signature (`[key: string]: unknown`) to the interface, or switch to inline literal fixtures, to keep it assignable. This is a compile-time-only migration: no scenario output changes.

Note on bump level: TDK is pre-1.0, where a minor is the conventional way to record a breaking change. This note uses `major` instead, deliberately, to make the break impossible to miss in the changelog — treat it as equivalent to "breaking" under the 0.x convention, not as a claim that TDK has reached 1.0.
