// `printTemplate(model, opts)` — phase (b): turn a validated model into the FILES of
// one template directory (ADR-0026 Decision 2).
//
// The output shape is the flagship `examples/oven-support-v2`: module-scope field
// consts with `.showWhen`, `p.choice` for options maps, a `derive` per logic node,
// effects through org-supplied pack helpers, pages as the table of contents, and a
// handle-based output. The printer emits the code a human would keep and own.
//
// One invariant holds it together: NOTHING is silently dropped. Every construct the
// printer cannot map becomes a flagged `TODO(migration)` in the code AND a
// `migration-report.json` entry. The printer is DETERMINISTIC — same model in,
// byte-identical files out, no timestamps.

import type {
  Effect,
  ExpressionEscape,
  JsonValue,
  LogicExpr,
  LogicNode,
  Lookup,
  MigrationMapping,
  MigrationModel,
  Question,
  ValueRef,
  VisibleWhen,
} from "./model.ts";
import { buildNameMap, type NameMap } from "./naming.ts";

// ---------------------------------------------------------------------------
// Public surface.
// ---------------------------------------------------------------------------

/** Options for `printTemplate`. */
export interface PrintOptions {
  /** The org-supplied action/lookup mapping. Fully optional. */
  mapping?: MigrationMapping;
}

/** One flagged construct — quoted in the report with its model path. */
export interface FlaggedConstruct {
  /** What kind of construct was flagged. */
  construct: "lookup" | "effect" | "expression" | "inline-expression";
  /** The construct's name. */
  name: string;
  /** Why it was flagged. */
  reason: string;
  /** The model path (e.g. `lookups[0]`). */
  path: string;
  /** A source location from the model, when the producer supplied one. */
  at?: string;
  /** The verbatim source preserved from the model. */
  verbatim?: string;
  /** A short description of what the printer emitted in its place. */
  emittedAs?: string;
}

/** The machine-readable migration report for one template. */
export interface MigrationReport {
  /** The template id. */
  template: string;
  /** The model dialect version. */
  modelVersion: string;
  /** The translated / flagged counts. */
  counts: { translated: number; flagged: number };
  /** Every flagged construct, quoted with its model path. */
  flagged: FlaggedConstruct[];
  /** Non-fatal notes (e.g. a defaulted output). */
  notes: string[];
}

/** The files the printer emits for one template directory, plus the report object. */
export interface PrintResult {
  /** The emitted files, keyed by their path within the template directory. */
  files: {
    "template.ts": string;
    "__fixtures__/scenarios.ts": string;
    "migration-report.json": string;
  };
  /** The structured report (also serialized into `files["migration-report.json"]`). */
  report: MigrationReport;
}

// ---------------------------------------------------------------------------
// Small rendering helpers.
// ---------------------------------------------------------------------------

/** Whether a string is a bare (unquoted) object-literal key. */
function isIdent(key: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}

/** Render an object-literal key, quoting it when it is not a bare identifier. */
function objKey(key: string): string {
  return isIdent(key) ? key : JSON.stringify(key);
}

/** Render a JSON value as a readable (space-separated) TypeScript literal expression. */
function lit(value: JsonValue | undefined): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map((v) => lit(v)).join(", ")}]`;
  const entries = Object.entries(value).map(([k, v]) => `${objKey(k)}: ${lit(v)}`);
  return entries.length ? `{ ${entries.join(", ")} }` : "{}";
}

/** Render an object literal from key→value-expression pairs, collapsing `k: k` to `k`. */
function objectLiteral(entries: Array<[string, string]>): string {
  if (entries.length === 0) return "{}";
  const parts = entries.map(([key, expr]) => {
    const k = objKey(key);
    return isIdent(key) && key === expr ? key : `${k}: ${expr}`;
  });
  return `{ ${parts.join(", ")} }`;
}

/** Escape text for inclusion inside a template literal (backtick / backslash / `${`). */
function escapeTemplate(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/**
 * Make a string safe to interpolate into a SINGLE `//` comment line: every control
 * character and JS line terminator (\n \r U+2028 U+2029) becomes a space, so nothing
 * can break out of the comment and inject code. The injection guard, mirroring the
 * validator's rejection (defense in depth).
 */
function commentSafe(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to strip them.
  return text.replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ");
}

/**
 * Split a possibly MULTI-LINE value (an escape-hatch source) into comment lines,
 * splitting on ALL JS line terminators and sanitizing each line. Prefixes each line.
 */
function commentSafeLines(text: string, prefix: string): string[] {
  return text.split(/\r\n|[\n\r\u2028\u2029]/).map((line) => prefix + commentSafe(line));
}

/** A `// --- <title> ` banner padded with dashes to a fixed width (title sanitized). */
function banner(title: string): string {
  const head = `// --- ${commentSafe(title)} `;
  const pad = Math.max(0, 84 - head.length);
  return head + "-".repeat(pad);
}

// ---------------------------------------------------------------------------
// The printer.
// ---------------------------------------------------------------------------

class Printer {
  private readonly model: MigrationModel;
  private readonly mapping: MigrationMapping;
  private readonly names: NameMap;
  private readonly flagged: FlaggedConstruct[] = [];
  private readonly notes: string[] = [];
  private translated = 0;

  /** Which `@tdk/core` identifiers the emitted module imports. */
  private readonly coreImports = new Set<string>(["defineTemplate", "p", "page"]);
  /** Org imports, grouped by module specifier → the sorted identifier set. */
  private readonly orgImports = new Map<string, Set<string>>();
  /** Comment lines to place just above the org import block. */
  private readonly orgImportNotes: string[] = [];

  constructor(model: MigrationModel, opts: PrintOptions) {
    this.model = model;
    this.mapping = opts.mapping ?? {};
    // Reserve the org-supplied helper/marker names so a const never shadows one.
    const reserved = new Set<string>();
    for (const a of Object.values(this.mapping.actions ?? {})) reserved.add(a.import.name);
    for (const l of Object.values(this.mapping.lookups ?? {})) reserved.add(l.import.name);
    this.names = buildNameMap(model, reserved);
  }

  // --- name resolution ---

  private questionByName(name: string): Question | undefined {
    return (this.model.questions ?? []).find((q) => q.name === name);
  }

  /** The const that holds the value a `{ ref }` resolves to (question/logic/lookup). */
  private constForRef(name: string): { const: string; conditional: boolean } | undefined {
    const list = this.names.byName.get(name);
    if (!list || list.length === 0) return undefined;
    const first = list[0];
    return { const: first.const, conditional: first.conditional };
  }

  private addOrgImport(spec: { name: string; from: string }): void {
    const set = this.orgImports.get(spec.from) ?? new Set<string>();
    set.add(spec.name);
    this.orgImports.set(spec.from, set);
  }

  // --- value references in a MODULE-SCOPE position (effect input, lookup param, output) ---

  /**
   * Render a value reference as a module-scope expression. `position` decides how a
   * bare question is rendered: an effect input / lookup param can take the bare const
   * (the effect normalizes it), but an output map needs the param's `.ref`.
   */
  private renderMappingValue(vref: ValueRef, position: "effectInput" | "lookupParam" | "output", path: string): string {
    if ("literal" in vref) return lit(vref.literal);
    if ("effectRef" in vref) {
      const c = this.names.effect.get(vref.effectRef);
      const sub = (vref.path ?? []).map((p) => `.${p}`).join("");
      return `${c}.output${sub}`;
    }
    if ("op" in vref) return this.renderInlineLeaf(vref, position, path);

    const name =
      "ref" in vref
        ? vref.ref
        : "questionRef" in vref
          ? vref.questionRef
          : "logicRef" in vref
            ? vref.logicRef
            : vref.lookupRef;
    return this.renderNamedRef(name, position);
  }

  /** Render a named reference (a question/logic/lookup const) for a module position. */
  private renderNamedRef(name: string, position: "effectInput" | "lookupParam" | "output"): string {
    const resolved = this.constForRef(name);
    if (!resolved) return `undefined /* unresolved ref: ${name} */`;
    const kind = this.names.byName.get(name)?.[0].kind;
    if (kind === "question") {
      if (resolved.conditional) return `${resolved.const}.ref.orElse("")`;
      return position === "output" ? `${resolved.const}.ref` : resolved.const;
    }
    // logic and lookup consts are handles/values — usable bare in every position.
    return resolved.const;
  }

  /** Render an inline logic expression that appears in a module-scope mapping slot. */
  private renderInlineLeaf(expr: LogicExpr, position: "effectInput" | "lookupParam" | "output", path: string): string {
    switch (expr.op) {
      case "literal":
        return lit(expr.value);
      case "fieldRef":
        return this.renderNamedRef(expr.field, position);
      case "logicRef":
        return this.renderNamedRef(expr.ref, position);
      case "lookupRef":
        return this.renderNamedRef(expr.ref, position);
      default: {
        // A non-leaf inline expression has no module-scope form — flag it, don't drop
        // it. (Producers should name complex logic so it becomes a `derive`.)
        this.flagged.push({
          construct: "inline-expression",
          name: expr.op,
          reason: "a complex inline logic expression has no module-scope form; name it as a logic node",
          path,
          verbatim: JSON.stringify(expr),
          emittedAs: "a flagged raw placeholder",
        });
        this.coreImports.add("raw");
        return "raw`TODO(migration): inline expression — re-author as a named logic node`";
      }
    }
  }

  // --- value references in a DERIVE LAMBDA (renders `i.<const>` and collects inputs) ---

  /** Render a logic expression as a derive-lambda body, collecting its inputs. */
  private renderDeriveExpr(expr: LogicExpr, inputs: string[], locals: Set<string>): string {
    const addInput = (name: string, kind: "question" | "logic" | "lookup"): string => {
      const c =
        kind === "question"
          ? this.names.question.get(name)
          : kind === "logic"
            ? this.names.logic.get(name)
            : this.names.lookup.get(name);
      const id = c ?? name;
      if (!inputs.includes(id)) inputs.push(id);
      return `i.${id}`;
    };

    switch (expr.op) {
      case "literal":
        return lit(expr.value);
      case "fieldRef": {
        const head = expr.field.split(".")[0];
        if (locals.has(head)) return expr.field; // a listMap item reference
        return addInput(expr.field, "question");
      }
      case "logicRef":
        return addInput(expr.ref, "logic");
      case "lookupRef":
        return addInput(expr.ref, "lookup");
      case "concat": {
        const body = expr.parts.map((p) => this.renderTemplatePart(p, inputs, locals)).join("");
        return `\`${body}\``;
      }
      case "template": {
        // Split the template into literal segments and `{key}` placeholders. Only the
        // literal segments are escaped; a bound placeholder becomes a raw `${expr}`.
        let out = "";
        let lastIndex = 0;
        const re = /\{([^}]+)\}/g;
        let m: RegExpExecArray | null = re.exec(expr.template);
        while (m !== null) {
          out += escapeTemplate(expr.template.slice(lastIndex, m.index));
          const binding = expr.bindings[m[1]];
          out += binding ? `\${${this.renderDeriveExpr(binding, inputs, locals)}}` : escapeTemplate(m[0]);
          lastIndex = re.lastIndex;
          m = re.exec(expr.template);
        }
        out += escapeTemplate(expr.template.slice(lastIndex));
        return `\`${out}\``;
      }
      case "conditional": {
        const arms = expr.cases
          .map((c) => `${this.renderCondition(c.when, inputs)} ? ${this.renderDeriveExpr(c.then, inputs, locals)} : `)
          .join("");
        return `${arms}${this.renderDeriveExpr(expr.else, inputs, locals)}`;
      }
      case "listMap": {
        const source = this.renderDeriveExpr(expr.source, inputs, locals);
        const inner = new Set(locals);
        inner.add(expr.as);
        const body = this.renderDeriveExpr(expr.body, inputs, inner);
        return `${source}.map((${expr.as}) => ${body})`;
      }
    }
  }

  /** Render one `concat` part inside a template literal (literal text stays inline). */
  private renderTemplatePart(expr: LogicExpr, inputs: string[], locals: Set<string>): string {
    if (expr.op === "literal" && typeof expr.value === "string") {
      return escapeTemplate(expr.value);
    }
    return `\${${this.renderDeriveExpr(expr, inputs, locals)}}`;
  }

  /** Render a visibleWhen predicate as a boolean expression inside a derive lambda. */
  private renderCondition(vw: VisibleWhen, inputs: string[]): string {
    if ("all" in vw) {
      return `(${vw.all.map((sub) => this.renderCondition(sub, inputs)).join(" && ")})`;
    }
    const c = this.names.question.get(vw.field) ?? vw.field;
    if (!inputs.includes(c)) inputs.push(c);
    if ("in" in vw) {
      return `(${vw.in.map((v) => `i.${c} === ${lit(v)}`).join(" || ")})`;
    }
    return `i.${c} === ${lit(vw.is)}`;
  }

  // --- visibleWhen as a `.showWhen(...)` / `.when(...)` predicate ---

  private renderPredicate(vw: VisibleWhen): string {
    if ("all" in vw) {
      this.coreImports.add("all");
      return `all(${vw.all.map((sub) => this.renderPredicate(sub)).join(", ")})`;
    }
    const c = this.names.question.get(vw.field) ?? vw.field;
    if ("in" in vw) return `${c}.in([${vw.in.map((v) => lit(v)).join(", ")}])`;
    return `${c}.is(${lit(vw.is)})`;
  }

  // --- sections ---

  private renderFieldOptions(q: Question): string {
    const parts: string[] = [];
    if (q.title !== undefined) parts.push(`title: ${lit(q.title)}`);
    if (q.description !== undefined) parts.push(`description: ${lit(q.description)}`);
    if (q.required) parts.push(`required: true`);
    if (q.default !== undefined) parts.push(`default: ${lit(q.default)}`);
    if (q.format !== undefined) parts.push(`format: ${lit(q.format)}`);
    if (q.pattern !== undefined) parts.push(`pattern: ${lit(q.pattern)}`);
    if (q.minLength !== undefined) parts.push(`minLength: ${q.minLength}`);
    if (q.maxLength !== undefined) parts.push(`maxLength: ${q.maxLength}`);
    if (q.minimum !== undefined) parts.push(`minimum: ${q.minimum}`);
    if (q.maximum !== undefined) parts.push(`maximum: ${q.maximum}`);
    if (q.uiWidget !== undefined) parts.push(`uiWidget: ${lit(q.uiWidget)}`);
    if (q.uiOptions !== undefined) parts.push(`uiOptions: ${lit(q.uiOptions)}`);
    if (q.items !== undefined) parts.push(`items: ${lit(q.items)}`);
    return `{ ${parts.join(", ")} }`;
  }

  private renderField(q: Question): string {
    const c = this.names.question.get(q.name) as string;
    const opts = this.renderFieldOptions(q);
    let builder: string;
    if (q.type === "choice") {
      const options = q.options ?? {};
      const allEqual = Object.entries(options).every(([k, v]) => k === v);
      const optionsSrc = allEqual
        ? `[${Object.keys(options)
            .map((k) => lit(k))
            .join(", ")}]`
        : `{ ${Object.entries(options)
            .map(([k, v]) => `${objKey(k)}: ${lit(v)}`)
            .join(", ")} }`;
      builder = `p.choice(${optionsSrc}, ${opts})`;
    } else {
      builder = `p.${q.type}(${opts})`;
    }
    let line = `export const ${c} = ${builder}`;
    if (q.visibleWhen) line += `.showWhen(${this.renderPredicate(q.visibleWhen)})`;
    return `${line};`;
  }

  private renderLogicNode(node: LogicNode, index: number): string {
    if ("op" in node) {
      const c = this.names.logic.get(node.name) as string;
      const inputs: string[] = [];
      const body = this.renderDeriveExpr(node, inputs, new Set());
      const inputsSrc = inputs.length ? `{ ${inputs.join(", ")} }` : `{}`;
      this.translated++;
      return `${banner(`Logic node '${node.name}' -> a derive`)}\nexport const ${c} = derive(${lit(node.name)}, ${inputsSrc}, (i) => ${body});`;
    }
    // The escape hatch — a verbatim expression the IR could not express.
    return this.renderEscape(node, index);
  }

  private renderEscape(node: ExpressionEscape, index: number): string {
    const c = this.names.logic.get(node.name) as string;
    this.coreImports.add("raw");
    this.flagged.push({
      construct: "expression",
      name: node.name,
      reason: `verbatim ${node.language} expression the logic IR cannot express`,
      path: `logic[${index}]`,
      verbatim: node.source,
      emittedAs: "a flagged raw placeholder; re-author as a derive",
    });
    const lines = [
      banner(`Logic node '${node.name}' — FLAGGED verbatim expression`),
      `// TODO(migration): the model could not express this in the logic IR, so its`,
      `//   source is preserved verbatim. Re-author it as a derive (or wire it into the`,
      `//   right step) before relying on it. See migration-report.json.`,
      `//   language: ${commentSafe(node.language)}`,
      ...commentSafeLines(node.source, "//   source: "),
      `const ${c} = raw\`TODO(migration) unported expression: ${escapeTemplate(node.name)}\`;`,
    ];
    return lines.join("\n");
  }

  private renderLookup(lookup: Lookup, index: number): string {
    const c = this.names.lookup.get(lookup.name) as string;
    const map = this.mapping.lookups?.[lookup.kind];
    const paramsSrc = this.renderParams(lookup.params ?? {}, `lookups[${index}].params`);

    // Every lookup is flagged — its external semantics stay unresolved by design.
    if (map) {
      this.addOrgImport(map.import);
      this.orgImportNotes.push(
        `// Resolver convention (org-supplied): ${commentSafe(lookup.kind)} lookups -> the ${commentSafe(map.import.name)} marker.`,
      );
      this.flagged.push({
        construct: "lookup",
        name: lookup.name,
        reason: "external reference, no interpretable semantics",
        path: `lookups[${index}]`,
        at: lookup.at,
        verbatim: lookup.source,
        emittedAs: `${map.import.name}({ ${Object.keys(lookup.params ?? {}).join(", ")} }) with a TODO`,
      });
      const lines = [
        banner(`Lookup '${lookup.name}' — FLAGGED, see migration-report.json`),
        `// TODO(migration): external reference preserved verbatim from the legacy export.`,
        `//   source: ${commentSafe(lookup.source)}`,
        `// Emitted against the org's resolver convention. VERIFY the resolver exists and`,
        `// returns the expected shape before you rely on it.`,
        `const ${c} = ${map.import.name}(${paramsSrc});`,
      ];
      return lines.join("\n");
    }

    // Unmapped: a placeholder stub that COMPILES and is loudly flagged.
    this.coreImports.add("raw");
    this.flagged.push({
      construct: "lookup",
      name: lookup.name,
      reason: "external reference with no resolver mapping supplied",
      path: `lookups[${index}]`,
      at: lookup.at,
      verbatim: lookup.source,
      emittedAs: "a flagged raw placeholder",
    });
    const lines = [
      banner(`Lookup '${lookup.name}' — FLAGGED (no resolver mapping)`),
      `// TODO(migration): external reference preserved verbatim; no resolver mapping was`,
      `//   supplied, so this is a placeholder. Wire it to your org's resolver marker,`,
      `//   then replace the placeholder. See migration-report.json.`,
      `//   kind: ${commentSafe(lookup.kind)}`,
      `//   source: ${commentSafe(lookup.source)}`,
      `const ${c} = raw\`TODO(migration) unresolved lookup: ${escapeTemplate(lookup.name)}\`;`,
    ];
    return lines.join("\n");
  }

  private renderParams(params: Record<string, ValueRef>, path: string): string {
    const entries: Array<[string, string]> = Object.entries(params).map(([k, v]) => [
      k,
      this.renderMappingValue(v, "lookupParam", `${path}.${k}`),
    ]);
    return objectLiteral(entries);
  }

  private renderEffect(effect: Effect, index: number): string {
    const c = this.names.effect.get(effect.name) as string;
    const inputsEntries: Array<[string, string]> = Object.entries(effect.inputs ?? {}).map(([k, v]) => [
      k,
      this.renderMappingValue(v, "effectInput", `effects[${index}].inputs.${k}`),
    ]);
    const inputsSrc = objectLiteral(inputsEntries);
    const whenSrc = effect.when ? `.when(${this.renderPredicate(effect.when)})` : "";

    const map = this.mapping.actions?.[effect.actionRef];
    if (map) {
      this.addOrgImport(map.import);
      this.orgImportNotes.push(
        `// Action mapping (org-supplied): ${commentSafe(effect.actionRef)} -> ${commentSafe(map.import.name)}.`,
      );
      this.translated++;
      const lines = [
        banner(`Effect '${effect.name}' via the mapped pack helper`),
        `export const ${c} = ${map.import.name}(${lit(effect.name)}, ${inputsSrc})${whenSrc};`,
      ];
      return lines.join("\n");
    }

    // Unmapped: a direct `effect(...)` with a TODO and a report flag.
    this.coreImports.add("effect");
    this.flagged.push({
      construct: "effect",
      name: effect.name,
      reason: "unmapped legacy action — no action mapping supplied",
      path: `effects[${index}]`,
      at: effect.at,
      verbatim: effect.actionRef,
      emittedAs: `effect(${lit(effect.name)}, ${lit(effect.actionRef)}, { input })`,
    });
    const lines = [
      banner(`Effect '${effect.name}' — FLAGGED, unmapped legacy action`),
      `// TODO(migration): unmapped legacy action ${commentSafe(effect.actionRef)}.`,
      `//   Supply an action mapping (actionRef -> a pack helper) to emit a typed helper`,
      `//   call, or keep this direct effect() and confirm the action id + input shape.`,
      `export const ${c} = effect(${lit(effect.name)}, ${lit(effect.actionRef)}, { input: ${inputsSrc} })${whenSrc};`,
    ];
    return lines.join("\n");
  }

  // --- output ---

  private renderOutput(): string {
    const effects = this.model.effects ?? [];
    if (this.model.outputs && Object.keys(this.model.outputs).length > 0) {
      const entries = Object.entries(this.model.outputs).map(([k, v]) => {
        const expr = this.renderMappingValue(v, "output", `outputs.${k}`);
        const entry = isIdent(k) && k === expr ? k : `${objKey(k)}: ${expr}`;
        return `    ${entry},`;
      });
      return `  output: {\n${entries.join("\n")}\n  },`;
    }
    if (effects.length > 0) {
      const last = effects[effects.length - 1];
      const c = this.names.effect.get(last.name) as string;
      const key = c;
      this.notes.push(
        `The model declared no outputs, so a default output referencing the last effect ('${last.name}') was emitted.`,
      );
      return `  // TODO(migration): the model declared no outputs — this default references the\n  //   last effect's whole output. Narrow it to the fields you actually publish.\n  output: {\n    ${objKey(key)}: ${c}.output,\n  },`;
    }
    this.notes.push("The model declared no outputs and no effects, so an empty output was emitted.");
    return `  // TODO(migration): the model declared no outputs and no effects.\n  output: {},`;
  }

  // --- pages ---

  private pageGroups(): Array<{ title: string; consts: string[] }> {
    const order: string[] = [];
    const groups = new Map<string, string[]>();
    for (const q of this.model.questions ?? []) {
      if (!groups.has(q.page)) {
        order.push(q.page);
        groups.set(q.page, []);
      }
      groups.get(q.page)?.push(this.names.question.get(q.name) as string);
    }
    return order.map((title) => ({ title, consts: groups.get(title) as string[] }));
  }

  // --- the template.ts assembly ---

  private renderImports(): string {
    const core = [...this.coreImports].sort();
    const lines = [`import { ${core.join(", ")} } from "@tdk/core";`];
    // Notes: action mappings first, then resolver conventions; de-duplicated.
    const actionNotes = this.orgImportNotes.filter((n) => n.includes("Action mapping"));
    const resolverNotes = this.orgImportNotes.filter((n) => !n.includes("Action mapping"));
    const seenNotes = new Set<string>();
    for (const note of [...actionNotes, ...resolverNotes]) {
      if (!seenNotes.has(note)) {
        seenNotes.add(note);
        lines.push(note);
      }
    }
    for (const from of [...this.orgImports.keys()].sort()) {
      const ids = [...(this.orgImports.get(from) as Set<string>)].sort();
      lines.push(`import { ${ids.join(", ")} } from ${lit(from)};`);
    }
    return lines.join("\n");
  }

  private renderTemplateFile(): string {
    // Render the body sections FIRST — they populate `coreImports`/`orgImports`.
    const fieldLines = (this.model.questions ?? []).map((q) => this.renderField(q));
    this.translated += (this.model.questions ?? []).length;

    const logicLines = (this.model.logic ?? []).map((n, i) => this.renderLogicNode(n, i));
    if ((this.model.logic ?? []).some((n) => "op" in n)) this.coreImports.add("derive");

    const lookupLines = (this.model.lookups ?? []).map((l, i) => this.renderLookup(l, i));
    const effectLines = (this.model.effects ?? []).map((e, i) => this.renderEffect(e, i));
    const output = this.renderOutput();

    const meta = this.model.template;
    const metaLines = [`  id: ${lit(meta.id)},`, `  title: ${lit(meta.title)},`];
    if (meta.description !== undefined) metaLines.push(`  description: ${lit(meta.description)},`);
    metaLines.push(`  type: ${lit(meta.type ?? "service")},`);
    if (meta.tags !== undefined) metaLines.push(`  tags: ${lit(meta.tags)},`);
    if (meta.owner !== undefined) metaLines.push(`  owner: ${lit(meta.owner)},`);

    const pages = this.pageGroups()
      .map((g) => `    page(${lit(g.title)}, { ${g.consts.join(", ")} }),`)
      .join("\n");

    const effectConsts = (this.model.effects ?? []).map((e) => this.names.effect.get(e.name) as string);
    const effectsSrc = `  effects: [${effectConsts.join(", ")}],`;

    const header = [
      "// GENERATED by `tdk migrate` from a migration model (ADR-0026).",
      "//",
      "// This is authoring-v2 source you now OWN: the printer produced the first version,",
      "// and from here people own the file (generate-once). Regenerating OVERWRITES it.",
      "// Anything the printer could not translate is a flagged TODO(migration) — see the",
      "// sibling migration-report.json for the full account. Nothing was dropped in silence.",
    ].join("\n");

    const sections: string[] = [];
    if (fieldLines.length)
      sections.push(
        [banner("Fields (one const per question; page tags become the pages TOC)"), ...fieldLines].join("\n"),
      );
    if (logicLines.length) sections.push(logicLines.join("\n\n"));
    if (lookupLines.length) sections.push(lookupLines.join("\n\n"));
    if (effectLines.length) sections.push(effectLines.join("\n\n"));

    const define = [
      `export default defineTemplate({`,
      ...metaLines,
      `  // Pages ARE the ordered table of contents; ui:order is inferred per page.`,
      `  pages: [`,
      pages,
      `  ],`,
      effectsSrc,
      output,
      `});`,
    ].join("\n");

    // Imports are rendered LAST (after the sections populated the import sets).
    const imports = this.renderImports();
    return `${header}\n\n${imports}\n\n${sections.join("\n\n")}\n\n${define}\n`;
  }

  // --- scenarios ---

  // DIVERGENCE from ADR-0026: the ADR sketches "one scenario per visibleWhen branch".
  // We emit a SINGLE happy-path scenario (with a `branches` list naming the reveals it
  // exercises) rather than enumerating branches. A faithful per-branch enumerator is
  // genuinely gnarly — "branch" is ambiguous (visible-only vs visible+hidden vs
  // per-controller-value), controllers interact (revealing one field can hide another),
  // and when the exampleValues already reveal every conditional (the common case, and
  // the ADR's own worked example) the extra scenarios are near-duplicates. The single
  // baseline is born-testable and the author extends it. Tracked for an ADR amendment.
  private renderScenariosFile(): string {
    const questions = this.model.questions ?? [];

    // branches = the distinct example values of the controllers that drive reveals.
    const controllerFields = new Set<string>();
    const addControllers = (vw: VisibleWhen | undefined): void => {
      if (!vw) return;
      if ("all" in vw) vw.all.forEach(addControllers);
      else controllerFields.add(vw.field);
    };
    for (const q of questions) addControllers(q.visibleWhen);
    for (const e of this.model.effects ?? []) addControllers(e.when);
    const branchValues: string[] = [];
    for (const field of controllerFields) {
      const q = this.questionByName(field);
      if (q?.exampleValue !== undefined) {
        const v = String(q.exampleValue);
        if (!branchValues.includes(v)) branchValues.push(v);
      }
    }

    const lines: string[] = [
      "// GENERATED by `tdk migrate` from the model's exampleValues (ADR-0026).",
      "//",
      "// A born-testable baseline: one happy-path scenario. `tdk test` writes the first",
      "// snapshot from this; edit freely — this is your file now.",
      "",
      `import type { ExecuteFixture } from "@tdk/core";`,
      "",
      "export const scenarios = [",
      "  {",
      `    name: "example — happy path",`,
    ];
    if (branchValues.length) lines.push(`    branches: [${branchValues.map((v) => lit(v)).join(", ")}],`);
    lines.push("    fixture: {");

    // parameters (from exampleValues, keyed by the field CONST = the param name).
    const params = questions
      .filter((q) => q.exampleValue !== undefined)
      .map((q) => `        ${objKey(this.names.question.get(q.name) as string)}: ${lit(q.exampleValue as JsonValue)},`);
    if (params.length) {
      lines.push("      parameters: {", ...params, "      },");
    } else {
      lines.push("      parameters: {},");
    }

    // effect output mocks — deterministic, covering the sub-paths the outputs read.
    for (const line of this.renderEffectMocks()) lines.push(line);

    lines.push("    } satisfies ExecuteFixture,", "  },", "];", "");
    return lines.join("\n");
  }

  private renderEffectMocks(): string[] {
    const effects = this.model.effects ?? [];
    if (effects.length === 0) return [];
    // Collect, per effect, the output sub-paths the outputs read.
    const pathsByEffect = new Map<string, string[][]>();
    for (const vref of Object.values(this.model.outputs ?? {})) {
      if (typeof vref === "object" && vref !== null && "effectRef" in vref) {
        const list = pathsByEffect.get(vref.effectRef) ?? [];
        if (vref.path?.length) list.push(vref.path);
        pathsByEffect.set(vref.effectRef, list);
      }
    }
    const lines = ["      steps: {"];
    for (const e of effects) {
      const paths = pathsByEffect.get(e.name) ?? [];
      lines.push(`        ${JSON.stringify(e.name)}: { output: ${buildMockObject(paths, e.name)} },`);
    }
    lines.push("      },");
    return lines;
  }

  // --- report ---

  private buildReport(): MigrationReport {
    return {
      template: this.model.template.id,
      modelVersion: this.model.modelVersion,
      counts: { translated: this.translated, flagged: this.flagged.length },
      flagged: this.flagged,
      notes: this.notes,
    };
  }

  print(): PrintResult {
    const templateFile = this.renderTemplateFile();
    const scenariosFile = this.renderScenariosFile();
    const report = this.buildReport();
    return {
      files: {
        "template.ts": templateFile,
        "__fixtures__/scenarios.ts": scenariosFile,
        "migration-report.json": `${JSON.stringify(report, null, 2)}\n`,
      },
      report,
    };
  }
}

/** Build a deterministic mock output object covering the given sub-paths. */
function buildMockObject(paths: string[][], effectName: string): string {
  if (paths.length === 0) return "{}";
  const root: Record<string, unknown> = {};
  for (const path of paths) {
    let node = root;
    path.forEach((seg, i) => {
      if (i === path.length - 1) {
        node[seg] = `${effectName}-${seg}`;
      } else {
        node[seg] = (node[seg] as Record<string, unknown>) ?? {};
        node = node[seg] as Record<string, unknown>;
      }
    });
  }
  return lit(root as JsonValue);
}

/**
 * Print a validated model into the FILES of one template directory: an idiomatic v2
 * `template.ts`, a born-testable `__fixtures__/scenarios.ts`, and a
 * `migration-report.json`. Deterministic — the same model yields byte-identical
 * files. Validate the model with `validateModel` FIRST; the printer assumes a
 * schema-valid, semantically-sound document.
 */
export function printTemplate(model: MigrationModel, opts: PrintOptions = {}): PrintResult {
  return new Printer(model, opts).print();
}
