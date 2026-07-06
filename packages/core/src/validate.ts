// Validation.
//
// Validates a compiled Template entity against the REAL Backstage Scaffolder
// JSON schema (`schema/Template.v1beta3.schema.json`), with its `$ref`
// dependencies (Entity, EntityMeta, common) registered with AJV so refs
// resolve. Schemas are vendored copies of the upstream Backstage checkout.
//
// A pragmatic structural fallback (`structuralCheck`) is also provided.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, "..", "schema");

const SCHEMA_FILES = {
  template: "Template.v1beta3.schema.json",
  entity: "Entity.schema.json",
  entityMeta: "EntityMeta.schema.json",
  common: "common.schema.json",
} as const;

let cachedValidator: ValidateFunction | undefined;

async function loadJson(file: string): Promise<Record<string, unknown>> {
  // node:fs (not Bun.file) — core must stay Node-clean (ADR-0001 distribution).
  const text = await readFile(join(schemaDir, file), "utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Build (and cache) an AJV validator for the Template schema with all `$ref`
 * dependencies registered. The upstream schemas use draft-07 and `$id`-based
 * refs ("Entity", "EntityMeta", "common"), which AJV resolves once each schema
 * is added.
 */
export async function getValidator(): Promise<ValidateFunction> {
  if (cachedValidator) return cachedValidator;

  const ajv = new Ajv({
    allErrors: true,
    strict: false, // upstream schemas use `examples`, `deprecated`, etc.
  });
  addFormats(ajv);

  // Register the ref targets first, then compile the Template schema.
  ajv.addSchema(await loadJson(SCHEMA_FILES.common));
  ajv.addSchema(await loadJson(SCHEMA_FILES.entityMeta));
  ajv.addSchema(await loadJson(SCHEMA_FILES.entity));
  const templateSchema = await loadJson(SCHEMA_FILES.template);

  cachedValidator = ajv.compile(templateSchema);
  return cachedValidator;
}

export interface ValidationResult {
  valid: boolean;
  errors: ErrorObject[];
}

/**
 * Validate a compiled entity against the real Backstage Template schema.
 * Returns `{ valid, errors }`; use `assertValid` to throw instead.
 */
export async function validate(entity: unknown): Promise<ValidationResult> {
  const validator = await getValidator();
  const valid = validator(entity) as boolean;
  return { valid, errors: valid ? [] : (validator.errors ?? []) };
}

/** Validate and throw a readable error if the entity is invalid. */
export async function assertValid(entity: unknown): Promise<void> {
  const { valid, errors } = await validate(entity);
  if (!valid) {
    const lines = errors.map((e) => `  - ${e.instancePath || "(root)"} ${e.message ?? ""}`);
    throw new Error(`Template entity failed schema validation:\n${lines.join("\n")}`);
  }
}

/** Lazily-built AJV instance for parameter-form validation (draft-07 pages). */
let paramAjv: Ajv | undefined;

/**
 * Validate one run's parameter VALUES against a compiled `spec.parameters` —
 * a single JSON-Schema object or an array of form pages, each validated in
 * turn (required, enum, types, dependencies…). Also flags parameter names the
 * form doesn't know (a renamed param in a stale fixture), which open page
 * schemas would otherwise let through. Used by `execute`'s `validateParams`.
 */
export async function validateParameters(
  parameters: unknown,
  values: Record<string, unknown>,
): Promise<ValidationResult> {
  if (!paramAjv) {
    paramAjv = new Ajv({ allErrors: true, strict: false });
    addFormats(paramAjv);
  }
  const pages = Array.isArray(parameters) ? parameters : [parameters];
  const errors: ErrorObject[] = [];
  for (const page of pages) {
    const validatePage = paramAjv.compile(page as object);
    if (!validatePage(values)) errors.push(...(validatePage.errors ?? []));
  }
  const known = new Set<string>();
  for (const page of pages) collectPropertyNames(page, known);
  for (const name of Object.keys(values)) {
    if (!known.has(name)) {
      errors.push({
        instancePath: `/${name}`,
        schemaPath: "",
        keyword: "unknownParameter",
        params: { name },
        message: "is not a parameter of this template (renamed or removed?)",
      } as ErrorObject);
    }
  }
  return { valid: errors.length === 0, errors };
}

/** Collect every property name a form can reveal: top-level properties plus
 * every `dependencies`/`oneOf` branch, recursively. */
function collectPropertyNames(schema: unknown, into: Set<string>): void {
  if (!schema || typeof schema !== "object") return;
  const s = schema as Record<string, unknown>;
  if (s.properties && typeof s.properties === "object") {
    for (const name of Object.keys(s.properties)) into.add(name);
  }
  if (s.dependencies && typeof s.dependencies === "object") {
    for (const dep of Object.values(s.dependencies)) {
      const oneOf = (dep as { oneOf?: unknown[] })?.oneOf;
      if (Array.isArray(oneOf)) {
        for (const branch of oneOf) collectPropertyNames(branch, into);
      }
    }
  }
}

/**
 * Pragmatic structural check (schema-lite). Independent of AJV; useful as a
 * fast sanity gate or fallback. The real `validate()` above is preferred.
 */
export function structuralCheck(entity: unknown): ValidationResult {
  const errors: ErrorObject[] = [];
  const fail = (instancePath: string, message: string) =>
    errors.push({
      instancePath,
      schemaPath: "",
      keyword: "structural",
      params: {},
      message,
    } as ErrorObject);

  const e = entity as Record<string, unknown> | null;
  if (!e || typeof e !== "object") {
    fail("", "entity must be an object");
    return { valid: false, errors };
  }
  if (e.apiVersion !== "scaffolder.backstage.io/v1beta3") {
    fail("/apiVersion", "must be scaffolder.backstage.io/v1beta3");
  }
  if (e.kind !== "Template") fail("/kind", 'must be "Template"');
  const metadata = e.metadata as Record<string, unknown> | undefined;
  if (!metadata || typeof metadata.name !== "string" || !metadata.name) {
    fail("/metadata/name", "is required");
  }
  const spec = e.spec as Record<string, unknown> | undefined;
  if (!spec || typeof spec !== "object") {
    fail("/spec", "is required");
  } else {
    if (typeof spec.type !== "string" || !spec.type) {
      fail("/spec/type", "is required");
    }
    if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
      fail("/spec/steps", "must be a non-empty array");
    }
  }
  return { valid: errors.length === 0, errors };
}
