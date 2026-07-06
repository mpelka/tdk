// The `TDK: Set Backstage Base URL` command's PURE input logic — the decision the
// InputBox needs, split out so it can be unit-tested without `vscode`.
//
// Two pure pieces:
//   - `validateBaseUrl` — the InputBox's live `validateInput`: an EMPTY value is allowed
//     (it clears the setting = turns the dry-run off), any other value must parse as an
//     http/https URL; anything else returns an error string to show under the box.
//   - `normalizeBaseUrl` — turn the accepted value into what gets written to the setting:
//     `undefined` to CLEAR (empty), or the trimmed URL string.
//
// The base URL is a plain SETTING (unlike the token, which is a secret) — the command is
// the discoverable counterpart to `TDK: Set Backstage Token`, so a user never has to hunt
// through the settings UI to point at their Backstage.

/**
 * Validate a candidate base URL for the InputBox. Returns `undefined` when the value is
 * ACCEPTABLE (empty — which clears the setting — or a well-formed http/https URL), or a
 * short error string to display otherwise. Trims first, so trailing/leading whitespace
 * never produces a bad URL or a spurious error.
 */
export function validateBaseUrl(value: string): string | undefined {
  const trimmed = value.trim();
  // Empty is a valid choice: it clears the setting and turns the feature off.
  if (trimmed === "") return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "Enter a full http/https URL, e.g. http://localhost:7007 (or leave empty to clear).";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "The base URL must use http or https.";
  }
  return undefined;
}

/**
 * Normalize an ACCEPTED base-URL value to what gets written to the setting: `undefined`
 * when it is empty (clear the setting — the feature turns off), else the trimmed URL.
 * Only call this on a value `validateBaseUrl` accepted.
 */
export function normalizeBaseUrl(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
