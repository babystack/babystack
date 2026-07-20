/**
 * Redact secret-shaped substrings from text BEFORE it enters an error message or a log line. The credential
 * boundary keeps ambient secrets out of a seed's environment, but a seed command can still *print* a secret
 * to stderr (a URL with a password, a leaked API key), and that stderr is interpolated into build errors
 * that reach CI logs. This scrubs the obvious shapes. Pure — no I/O.
 *
 * It is best-effort defense-in-depth, NOT a guarantee: novel secret formats can slip through. Pass any
 * KNOWN literals (e.g. the minted password) to redact them exactly.
 */
export function redactSecrets(text: string, literals: readonly string[] = []): string {
  let out = text

  // 1. Known literal secrets (exact) — e.g. the minted DB password. Guard against redacting trivially
  //    short/empty strings (which would blanket the whole message).
  for (const literal of literals) {
    if (literal.length >= 4) out = out.split(literal).join('***')
  }

  // 2. Credentials embedded in a URL: scheme://user:PASSWORD@host  →  scheme://user:***@host
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@]+@/gi, '$1***@')

  // 3. key=value / key: value secret shapes (password, secret, token, api_key, access_key, …).
  out = out.replace(
    /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth)\b(\s*[=:]\s*)("?)[^\s"']+\3/gi,
    '$1$2***',
  )

  // 4. AWS access key IDs (a common, distinctive shape).
  out = out.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '***')

  // 5. Bearer auth tokens (`Authorization: Bearer <token>` — the `auth` keyword in rule 3 has a word
  //    boundary that "Authorization" doesn't satisfy, so the token itself needs its own rule).
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1***')

  // 6. JSON Web Tokens (header.payload.signature). The `eyJ` prefix is base64 of `{"` — distinctive enough
  //    to redact on sight, and JWTs routinely embed credentials/PII in the payload.
  out = out.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '***')

  // 7. Provider tokens with a distinctive prefix (GitHub PATs, Slack). Low false-positive: the prefixes
  //    don't occur in ordinary MySQL/seed output.
  out = out.replace(/\b(?:gh[oprsu]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{10,}/g, '***')

  return out
}
