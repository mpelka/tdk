// Parsing the raw text a user types into the FALLBACK field.
//
// A Backstage template can reference a custom `ui:field` extension we cannot
// render — a `CakePickerWithDefault`, say (see the `plugin-composed` example).
// Rather than crash the form, the webview registers a fallback field: a labelled
// input with a hint, into which the user types the value the real field would
// produce. That value might be a plain string, or JSON (a number, boolean,
// object, array). This parses the raw text: valid JSON becomes the parsed value,
// anything else stays the verbatim string — so `deck-3000` stays `"deck-3000"`
// but `{"path":"…"}`, `42`, and `true` round-trip as their JSON types.

/**
 * Parse the raw text of a fallback custom-field input. Returns the JSON value
 * when the text parses as JSON (object, array, number, boolean, null), otherwise
 * the original string. Empty / whitespace-only input stays the empty string
 * (never `undefined`), so the field always holds a concrete value.
 */
export function parseCustomFieldValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  // Only ATTEMPT JSON when the text looks like JSON — a bare word like `deck-3000`
  // is not valid JSON and must stay a string, and we don't want to pay a
  // try/catch on every keystroke of ordinary text. JSON values start with one of
  // these leading characters (object, array, string, digit, minus) or are a JSON
  // literal.
  if (!looksLikeJson(trimmed)) return raw;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Looked like JSON but wasn't (a half-typed `{` ) — keep the raw string so the
    // field never rejects input mid-edit.
    return raw;
  }
}

/** Whether `trimmed` plausibly starts a JSON value worth a parse attempt. */
function looksLikeJson(trimmed: string): boolean {
  if (trimmed === "true" || trimmed === "false" || trimmed === "null") return true;
  const first = trimmed[0];
  if (first === undefined) return false;
  // object / array / string / number (digit or leading minus).
  return first === "{" || first === "[" || first === '"' || first === "-" || (first >= "0" && first <= "9");
}
