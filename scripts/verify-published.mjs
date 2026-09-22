/**
 * Verify, from the registry itself, that a release actually landed.
 *
 * A green run is not proof. `changeset publish` exits 0 when it publishes NOTHING (it logs
 * "No unpublished projects to publish" and returns success), and exits 0 when it publishes a SUBSET and
 * skips the rest — so "the job was green" and "the family shipped" are different claims. Worse, if a
 * changeset happens to be pending when the publish job runs, `changesets/action` takes its VERSION branch
 * instead of its publish branch and never calls publish at all — which the pre-flight now refuses outright,
 * because the error it would otherwise produce is about a missing push permission and says nothing about
 * the real cause.
 *
 * So this asserts three things against the registry, not against the log:
 *   1. the set of packages the action reports publishing is exactly the set pre-flight said would publish;
 *   2. every one of them is really resolvable at that exact version;
 *   3. every one of them carries a provenance attestation — the whole point of the tokenless pipeline, and
 *      silently absent if the job ever loses `id-token: write` or runs on a self-hosted runner.
 *
 * It reads registry.npmjs.org directly rather than `npm view`, which reads a replica that lags for minutes
 * after a publish and would report a successful release as missing. The registry is still a CDN, so a
 * bounded retry absorbs propagation before the check is allowed to fail.
 *
 * Usage: node scripts/verify-published.mjs '<publishedPackages JSON>' '<expected space-separated names>'
 */
import { pathToFileURL } from 'node:url'

/**
 * Compare what the run says it published against what pre-flight predicted. Returns a problem string, or
 * null when they agree.
 *
 * An EMPTY expected list is itself a failure. This script's whole thesis is "a green run is not proof", and
 * `[] vs []` compares equal — so asked to prove nothing, it would prove nothing and exit 0. Today the only
 * thing preventing that is the pre-flight's non-empty guarantee, arriving through an unvalidated step
 * output: rename that step, add `continue-on-error`, and the last line of defense goes quiet with no
 * signal. A guard must fail closed when its input vanishes.
 */
export function compareSets(published, expectedNames) {
  const want = (expectedNames || '').split(/\s+/).filter(Boolean).sort()
  const got = published.map((p) => p.name).sort()
  if (want.length === 0) {
    return (
      'verify-published: the expected-package list is empty, so there is nothing to verify. That is not a ' +
      'pass — it means the pre-flight output did not reach this step. Refusing to report success.'
    )
  }
  if (want.join(' ') !== got.join(' ')) {
    return (
      `verify-published: pre-flight expected to publish [${want.join(', ')}] but the run reports ` +
      `publishing [${got.join(', ') || '(none)'}].\n` +
      '  An empty list with a green run is the silent-failure shape this check exists for: the publish ' +
      'step can exit 0 having shipped nothing.'
    )
  }
  return null
}

const [publishedJson, expectedNames] = process.argv.slice(2)

// Imported by the test suite; only the block below runs when invoked directly.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

let published = []
let failed = false
if (isMain) {
  try {
    published = JSON.parse(publishedJson || '[]')
  } catch (err) {
    console.error(`verify-published: publishedPackages was not JSON: ${err.message}`)
    process.exit(1)
  }
  if (!Array.isArray(published)) {
    console.error('verify-published: publishedPackages was not an array')
    process.exit(1)
  }
  const mismatch = compareSets(published, expectedNames)
  if (mismatch) {
    console.error(mismatch)
    failed = true
  }
}

/** Poll the registry for one exact version; the registry is a CDN, so allow it a moment to propagate. */
async function resolve(name, version, { attempts = 8, delayMs = 12_000 } = {}) {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2f')}/${version}`
  let last = 'no attempt made'
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } })
      if (res.ok) return await res.json()
      last = `HTTP ${res.status}`
      // A 404 early on is almost certainly propagation; a 5xx is worth retrying too.
    } catch (err) {
      last = err.message
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, delayMs))
  }
  return { __error: last }
}

for (const { name, version } of isMain ? published : []) {
  const doc = await resolve(name, version)
  if (doc.__error) {
    console.error(
      `verify-published: ${name}@${version} is NOT resolvable on the registry (${doc.__error})`,
    )
    failed = true
    continue
  }
  if (!doc.dist?.attestations) {
    console.error(
      `verify-published: ${name}@${version} published WITHOUT a provenance attestation. Check that the ` +
        'publish job still has `id-token: write` and ran on a GitHub-hosted runner — a self-hosted runner ' +
        'has no OIDC identity to attest to and costs the attestation silently.',
    )
    failed = true
    continue
  }
  console.log(`  ok   ${name}@${version} resolvable, provenance attested`)
}

if (isMain) process.exit(failed ? 1 : 0)
