/**
 * Verify, from the registry itself, that a release actually landed.
 *
 * A green run is not proof. `changeset publish` exits 0 when it publishes NOTHING (it logs
 * "No unpublished projects to publish" and returns success), and exits 0 when it publishes a SUBSET and
 * skips the rest — so "the job was green" and "the family shipped" are different claims. Worse, if a
 * changeset happens to be pending when the publish job runs, `changesets/action` takes its VERSION branch
 * instead of its publish branch and never calls publish at all, still exiting 0.
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
const [publishedJson, expectedNames] = process.argv.slice(2)

let published
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

const want = (expectedNames || '').split(/\s+/).filter(Boolean).sort()
const got = published.map((p) => p.name).sort()

let failed = false
if (want.join(' ') !== got.join(' ')) {
  console.error(
    `verify-published: pre-flight expected to publish [${want.join(', ') || '(none)'}] but the run ` +
      `reports publishing [${got.join(', ') || '(none)'}].\n` +
      '  An empty list with a green run is the silent-failure shape this check exists for: the publish ' +
      'step can exit 0 having shipped nothing.',
  )
  failed = true
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

for (const { name, version } of published) {
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

process.exit(failed ? 1 : 0)
