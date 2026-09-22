/**
 * Print the CHANGELOG section for one package version.
 *
 * Two callers, deliberately the same code:
 *   • the publish job, BEFORE it publishes — a missing or empty section is a two-line edit, while an npm
 *     tarball is immutable outside a 72-hour window, so the cheap thing is checked first. The sibling
 *     project learned this by creating a GitHub Release for a version that never reached npm.
 *   • the github-release job, AFTER the publish succeeded — the real extraction.
 * Because it is one script, the two cannot disagree about whether notes exist.
 *
 * Usage: node scripts/release-notes.mjs <package-name> <version>
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [name, version] = process.argv.slice(2)
if (!name || !version) {
  console.error('usage: node scripts/release-notes.mjs <package-name> <version>')
  process.exit(2)
}

const dir = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => join(ROOT, 'packages', e.name))
  .find((d) => {
    const m = join(d, 'package.json')
    return existsSync(m) && JSON.parse(readFileSync(m, 'utf8')).name === name
  })

if (!dir) {
  console.error(`release-notes: no package named ${name} under packages/`)
  process.exit(1)
}

const changelog = join(dir, 'CHANGELOG.md')
if (!existsSync(changelog)) {
  console.error(
    `release-notes: ${name} has no CHANGELOG.md. Changesets writes one during \`changeset version\`, so ` +
      `its absence means this version was not produced by the Version Packages PR.`,
  )
  process.exit(1)
}

// Changesets writes `## <version>` headings under a `# <package name>` title.
const lines = readFileSync(changelog, 'utf8').split('\n')
const start = lines.findIndex((l) => l.trim() === `## ${version}`)
if (start === -1) {
  console.error(`release-notes: ${changelog} has no "## ${version}" section`)
  process.exit(1)
}
const rest = lines.slice(start + 1)
const end = rest.findIndex((l) => /^## /.test(l))
const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()

if (body === '') {
  console.error(`release-notes: the "## ${version}" section in ${changelog} is empty`)
  process.exit(1)
}
console.log(body)
