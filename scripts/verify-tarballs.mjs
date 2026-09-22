/**
 * Hold the PACKED ARTIFACT to the same standard as the source, before it is published.
 *
 * ENGINEERING-STANDARDS § Release pipelines: "Verify the artifact you ship, not the source that produced
 * it. Build output is routinely excluded from source-level checks — it is gitignored, so file- and
 * history-based scanners cannot see it at all — while being the overwhelming majority of the published
 * bytes. Sourcemaps make this sharper still: they can carry every source comment verbatim into the
 * package."
 *
 * That last part is the one that catches people. `dist/*.js.map` embeds `sourcesContent` — the complete
 * original source of every file, comments included — so a secret-scanner, a licence check or a
 * no-internal-references rule that only ever reads `src/` is blind to the copy that actually ships.
 *
 * This packs each publishable package exactly as `changeset publish` would and scans everything inside the
 * tarball. It is a PRE-FLIGHT: it runs before the irreversible step, because an npm tarball is immutable
 * outside a 72-hour window and a leak in one cannot be withdrawn.
 *
 * Usage: node scripts/verify-tarballs.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * What must never reach the registry. Each entry says WHY, because a hit needs a decision, not a deletion —
 * the handbook's point about removing a reference being an edit to a sentence rather than of a token.
 */
export const NEEDLES = [
  { name: 'private key', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'absolute home path', re: /\/(?:Users|home)\/[a-z][a-z0-9._-]*\//i },
  { name: 'work email domain', re: /@pray\.com\b/i },
  // A public artifact must carry no pointer the public cannot follow — not a private repo link, and not a
  // bare internal citation either, which implies checkable evidence and then withholds it.
  { name: 'private/internal repo reference', re: /\b[\w.-]+-internal\b|\bdocs\/internal\//i },
  { name: 'internal numbered doc', re: /\b\d{2}-[A-Z][A-Z0-9-]*\.md\b/ },
  { name: 'unresolvable internal citation', re: /\b(?:gap|finding|ADR)\s*#?\s*\d+\b/i },
]

/** Names of the publishable packages, read the same way the release workflow reads them. */
function publishablePackages() {
  const dir = join(ROOT, 'packages')
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'package.json')))
    .map((e) => ({
      dir: join(dir, e.name),
      pkg: JSON.parse(readFileSync(join(dir, e.name, 'package.json'), 'utf8')),
    }))
    .filter(({ pkg }) => pkg.private !== true)
}

/** Scan one blob of text, returning every needle that matched. */
export function scan(text) {
  return NEEDLES.filter(({ re }) => re.test(text)).map(({ name }) => name)
}

function main() {
  const packages = publishablePackages()
  if (packages.length === 0) {
    console.error(
      'verify-tarballs: no publishable packages found — refusing to report success having scanned nothing',
    )
    return 1
  }

  const out = mkdtempSync(join(tmpdir(), 'tarball-scan-'))
  let failed = false
  try {
    for (const { dir, pkg } of packages) {
      execFileSync('npm', ['pack', '--pack-destination', out, '--silent'], {
        cwd: dir,
        stdio: 'pipe',
      })
      const tarball = readdirSync(out).find((f) => f.endsWith('.tgz'))
      if (!tarball) {
        console.error(`verify-tarballs: npm pack produced nothing for ${pkg.name}`)
        failed = true
        continue
      }
      // `-O` streams every member's CONTENT to stdout, which is what must be scanned — the file list is
      // not enough, since the leak lives inside dist/ and inside the sourcemaps' sourcesContent.
      const contents = execFileSync('tar', ['-xzOf', join(out, tarball)], {
        maxBuffer: 256 * 1024 * 1024,
        encoding: 'utf8',
      })
      const hits = scan(contents)
      if (hits.length > 0) {
        console.error(
          `verify-tarballs: ${pkg.name} tarball contains ${hits.join(', ')} — refusing to publish`,
        )
        failed = true
      } else {
        console.log(`  ok   ${pkg.name} (${(contents.length / 1024).toFixed(0)} KB scanned)`)
      }
      rmSync(join(out, tarball))
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }

  if (failed) return 1
  console.log(`\nverify-tarballs: ${packages.length} tarball(s) clean`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
