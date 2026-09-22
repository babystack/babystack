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
import { fileURLToPath, pathToFileURL } from 'node:url'

// GitHub rejects a release body over this many characters. A first release is the likely offender: it can
// absorb the whole pre-1.0 development log into one section.
export const MAX_BODY = 125_000

/**
 * Pull one `## <version>` section out of a Changesets-formatted CHANGELOG.
 *
 * Returns the body, or throws with the reason. It must fail LOUDLY rather than emit something plausible:
 * a missing section, an empty one, or one past the host's size cap all stop the job, because the
 * alternative is a release whose notes silently say nothing.
 */
export function extractSection(changelogText, version) {
  const lines = changelogText.split('\n')
  const start = lines.findIndex((l) => l.trim() === `## ${version}`)
  if (start === -1) throw new Error(`no "## ${version}" section`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^## /.test(l))
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()
  if (body === '') throw new Error(`the "## ${version}" section is empty`)
  if (body.length > MAX_BODY) {
    throw new Error(
      `the "## ${version}" section is ${body.length} characters, past GitHub's ${MAX_BODY}-character ` +
        'release-body cap. Trim it, or point the release at the changelog.',
    )
  }
  return body
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
function main(argv) {
  const [name, version] = argv
  if (!name || !version) {
    console.error('usage: node scripts/release-notes.mjs <package-name> <version>')
    return 2
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
    return 1
  }

  const changelog = join(dir, 'CHANGELOG.md')
  if (!existsSync(changelog)) {
    console.error(
      `release-notes: ${name} has no CHANGELOG.md. Changesets writes one during \`changeset version\`, so ` +
        `its absence means this version was not produced by the Version Packages PR.`,
    )
    return 1
  }

  try {
    console.log(extractSection(readFileSync(changelog, 'utf8'), version))
  } catch (err) {
    console.error(`release-notes: ${changelog}: ${err.message}`)
    return 1
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
