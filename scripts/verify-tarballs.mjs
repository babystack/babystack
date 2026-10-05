/**
 * Hold the PACKED ARTIFACT to the same standard as the source, before it is published.
 *
 * Verify the artifact you ship, not the source that produced it. Build output is left out of most
 * source-level checks — it is gitignored, so file- and history-based scanners never see it — yet it is almost
 * all of the published bytes. Sourcemaps make this sharper: `dist/*.js.map` embeds `sourcesContent`, the
 * complete original source of every file, comments included, so a secret scanner or a rule against internal
 * references that only ever reads `src/` is blind to the copy that actually ships.
 *
 * This packs each publishable package with `pnpm pack` — the packer `changeset publish` uses in a pnpm
 * workspace, so `workspace:` and `catalog:` ranges are rewritten exactly as they will be on the registry — and
 * scans every byte inside the tarball. It is a PRE-FLIGHT: it runs before the irreversible step, because an npm
 * tarball is immutable outside a 72-hour window and a leak in one cannot be withdrawn.
 *
 * Private needles. Some strings must never ship and must never be committed either — an employer's name, a
 * private repository's name. Writing them into this file would publish the very thing they guard. They live in
 * a gitignored `.leak-needles` file (this checkout's, or the main worktree's when this runs from a linked
 * worktree) or in the `LEAK_SCAN_EXTRA` environment variable (a repository secret in CI): one case-insensitive
 * regular expression per line, `#` comments allowed. A hit on one is reported by its number, never by the text
 * it matched. `--require-extra` refuses to pass when neither source supplies a needle; the release job sets it,
 * so a missing secret stops the release instead of quietly scanning less.
 *
 * Usage: node scripts/verify-tarballs.mjs [--require-extra]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * What must never reach the registry. Each entry says WHY, because a hit needs a decision, not a deletion:
 * removing a reference means rewriting the sentence around it, not deleting a token and leaving the sentence
 * without its subject.
 */
export const NEEDLES = [
  { name: 'private key', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  // AKIAIOSFODNN7EXAMPLE is the example key AWS's own documentation uses; it is never a credential.
  { name: 'AWS access key id', re: /\bAKIA(?!IOSFODNN7EXAMPLE)[0-9A-Z]{16}\b/ },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'absolute home path', re: /\/(?:Users|home)\/[a-z][a-z0-9._-]*\//i },
  // A public artifact must carry no pointer the public cannot follow — not a private repo link, and not a
  // bare internal citation either, which implies checkable evidence and then withholds it.
  { name: 'private/internal repo reference', re: /\b[\w.-]+-internal\b|\bdocs\/internal\//i },
  // A numbered planning doc, with or without its extension: `42-EXAMPLE.md`, and `see 42-EXAMPLE`.
  { name: 'internal numbered doc', re: /\b\d{2}-[A-Z]{3,}[A-Z0-9-]*(?:\.md)?\b/ },
  {
    name: 'unresolvable internal citation',
    re: /\b(?:gap|finding|ADR|PRD)[ -]?#?\s*[A-Z]?\d+\b|\b[\w-]+-strategy\s+T\d+\b/i,
  },
  { name: 'reference to a private handbook', re: /\bhandbook\b/i },
]

/**
 * Parse operator-supplied needles: one case-insensitive regular expression per line; blank lines and `#`
 * comments are ignored. An invalid expression is an error, never a skip — a needle that silently drops out is
 * a check that silently switched off. The message names the needle's number only, never its text.
 */
export function parseExtraNeedles(...sources) {
  const out = []
  for (const line of sources.join('\n').split('\n')) {
    const text = line.trim()
    if (text === '' || text.startsWith('#')) continue
    const name = `private needle #${out.length + 1}`
    try {
      out.push({ name, re: new RegExp(text, 'i') })
    } catch {
      throw new Error(`${name} is not a valid regular expression`)
    }
  }
  return out
}

/** The `.leak-needles` file to read: this checkout's, else the main worktree's. `undefined` when neither exists. */
function needlesFile() {
  const own = join(ROOT, '.leak-needles')
  if (existsSync(own)) return own
  let common
  try {
    common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
  if (basename(common) !== '.git') return undefined
  const main = join(dirname(common), '.leak-needles')
  return existsSync(main) ? main : undefined
}

/**
 * The private needles from `.leak-needles` and `LEAK_SCAN_EXTRA`, parsed. Throws on an invalid expression.
 * Exported so the tracked-tree check (tests/scripts/public-pointers.test.mjs) scans with the same set.
 */
export function loadExtraNeedles() {
  const file = needlesFile()
  return parseExtraNeedles(
    file ? readFileSync(file, 'utf8') : '',
    process.env.LEAK_SCAN_EXTRA ?? '',
  )
}

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

/** Scan one blob of text, returning the name of every needle that matched. */
export function scan(text, extra = []) {
  return [...NEEDLES, ...extra].filter(({ re }) => re.test(text)).map(({ name }) => name)
}

function main(argv) {
  let extra
  try {
    extra = loadExtraNeedles()
  } catch (err) {
    console.error(`verify-tarballs: ${err.message}`)
    return 1
  }
  if (extra.length === 0) {
    if (argv.includes('--require-extra')) {
      console.error(
        'verify-tarballs: no private needles supplied (.leak-needles or LEAK_SCAN_EXTRA) and --require-extra is set — ' +
          'refusing to pass with employer and private-repo names unchecked',
      )
      return 1
    }
    console.log(
      'verify-tarballs: no private needles supplied — employer and private-repo names are NOT checked',
    )
  } else {
    console.log(`verify-tarballs: ${extra.length} private needle(s) loaded`)
  }

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
      execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: dir, stdio: 'pipe' })
      const tarball = readdirSync(out).find((f) => f.endsWith('.tgz'))
      if (!tarball) {
        console.error(`verify-tarballs: pnpm pack produced nothing for ${pkg.name}`)
        failed = true
        continue
      }
      // `-O` streams every member's CONTENT to stdout, which is what must be scanned — the file list is
      // not enough, since the leak lives inside dist/ and inside the sourcemaps' sourcesContent.
      const contents = execFileSync('tar', ['-xzOf', join(out, tarball)], {
        maxBuffer: 256 * 1024 * 1024,
        encoding: 'utf8',
      })
      const hits = scan(contents, extra)
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
  process.exit(main(process.argv.slice(2)))
}
