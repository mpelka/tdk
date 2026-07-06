// The ONE RJSF validator instance every page's Form uses, built to support
// schema-authored `errorMessage` via ajv-errors (issue #59: core will start emitting
// `errorMessage` on generated schemas; this makes the form render it instead of
// ajv's raw phrasing).
//
// CJS-INTEROP (load-bearing — see the note in App.tsx). Under browser bundling
// `@rjsf/validator-ajv8` and `ajv` resolve to their CJS builds. The DEFAULT export
// of `@rjsf/validator-ajv8` interops to the whole module namespace object, whose
// `.isValid` is not a function — a default-imported validator kills every form
// interaction the moment RJSF validates. So we import the NAMED `customizeValidator`
// and the NAMED `default as Ajv` is likewise a namespace, so we import Ajv's default
// through `esModuleInterop`-safe form and construct a SUBCLASS that installs
// ajv-errors in its constructor. The bundle smoke test verifies this actually runs
// (a schema with `errorMessage` renders it, and Next's validation still works).
//
// HOW ajv-errors HOOKS IN. `customizeValidator({ AjvClass })` constructs the ajv
// instance with `new AjvClass({ ...AJV_CONFIG })` — AJV_CONFIG already sets
// `allErrors: true`, which ajv-errors requires. Our subclass calls `ajvErrors(this)`
// after `super(...)`, registering the `errorMessage` keyword on that instance. A
// schema carrying `errorMessage` then produces a single authored message per field
// instead of ajv's default text.

import { customizeValidator } from "@rjsf/validator-ajv8";
import Ajv, { type Options } from "ajv";
import ajvErrors from "ajv-errors";

/**
 * An Ajv subclass that installs the ajv-errors plugin on every instance. RJSF's
 * `customizeValidator` builds the ajv with `new AjvClass(options)` — subclassing is
 * the supported seam to enrich that instance (there is no post-construction hook).
 * The plugin needs `allErrors: true`, which RJSF's default `AJV_CONFIG` already sets;
 * we assert it defensively so a future config change fails loudly, not silently.
 */
class AjvWithErrors extends Ajv {
  constructor(options?: Options) {
    super({ ...options, allErrors: true });
    ajvErrors(this);
  }
}

/**
 * The shared validator: RJSF's ajv8 validator, built through the NAMED
 * `customizeValidator` factory with our ajv-errors-enabled Ajv class. One instance
 * for every page's Form — schemas arrive at runtime from the live compile, so the
 * validator is reused across them.
 */
export const validator = customizeValidator({ AjvClass: AjvWithErrors });
