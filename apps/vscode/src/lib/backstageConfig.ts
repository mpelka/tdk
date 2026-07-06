// The dry-run's setup state — is Backstage configured? — as a PURE decision so it can
// be unit-tested without `vscode`. The extension reads the `tdk.backstage.baseUrl`
// setting and the SecretStorage token, hands both to `backstageSetup`, and acts on the
// returned state (run, or prompt the user at the missing piece).
//
// The token is OPTIONAL: some Backstage backends allow unauthenticated dry-runs, and a
// present-but-wrong token is caught at the HTTP layer (the client's `authFailed`). So the
// only HARD requirement here is the base URL; a missing token is a soft "you may need to
// set one" note, not a blocker.

/** The parsed setup state: ready to run, or blocked on a missing base URL. */
export type BackstageSetup =
  | { ready: true; baseUrl: string; token?: string; hasToken: boolean }
  | { ready: false; reason: string };

/**
 * Decide whether a dry-run can proceed from the raw setting + secret. The base URL is
 * required (an empty/whitespace one blocks with an actionable reason naming the setting
 * and the token command); the token is optional (passed through when present). Trims the
 * base URL so a stray trailing space in the setting doesn't produce a bad URL.
 */
export function backstageSetup(baseUrlSetting: string | undefined, token: string | undefined): BackstageSetup {
  const baseUrl = (baseUrlSetting ?? "").trim();
  if (!baseUrl) {
    return {
      ready: false,
      reason:
        "Set tdk.backstage.baseUrl to your Backstage URL (e.g. http://localhost:7007), then set a token with TDK: Set Backstage Token.",
    };
  }
  const trimmedToken = token?.trim() ? token.trim() : undefined;
  return { ready: true, baseUrl, token: trimmedToken, hasToken: Boolean(trimmedToken) };
}

/** The SecretStorage key the Backstage bearer token is stored under. */
export const BACKSTAGE_TOKEN_KEY = "tdk.backstage.token";

/** The `tdk.backstage.baseUrl` configuration key. */
export const BACKSTAGE_BASE_URL_KEY = "backstage.baseUrl";
