/**
 * The one gate whose verdict changes with no commit at all.
 *
 * ENGINEERING-STANDARDS § Release pipelines: "Re-run the gates whose verdict changes without a commit.
 * Most checks are a function of the tree, so a green `main` genuinely covers them. A dependency/
 * vulnerability audit is not: an advisory disclosed after the merge makes the *unchanged* tree newly
 * vulnerable. Any time-varying gate must run against the release commit at release time."
 *
 * Why this is a script and not `pnpm audit --audit-level=high` in the workflow: `pnpm audit` walks the
 * WHOLE workspace and cannot be filtered to a subset. This repo's workspace includes `examples/`, which is
 * a demo app that is never published — so a plain audit fails the release on a vulnerability that reaches
 * no consumer, and a gate that fails for reasons the release cannot fix is one people learn to bypass.
 *
 * So: audit production dependencies, then keep only the advisories that reach a package this repo actually
 * publishes. Anything else is reported as context and does not block.
 *
 * Usage: node scripts/audit-release.mjs [--level=high|moderate|low]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ORDER = ['info', 'low', 'moderate', 'high', 'critical']

/** Workspace directories whose contents are published — the only ones an advisory can block a release on. */
export function publishableDirs(root = ROOT) {
  const dir = join(root, 'packages')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'package.json')))
    .filter(
      (e) => JSON.parse(readFileSync(join(dir, e.name, 'package.json'), 'utf8')).private !== true,
    )
    .map((e) => `packages/${e.name}`)
}

/**
 * Split advisories into the ones that reach a published package and the ones that do not.
 * A finding path looks like `examples/users-api > express@5.2.1 > qs@6.15.3`; its first segment is the
 * workspace project the dependency belongs to.
 */
export function partition(advisories, dirs, level) {
  const min = ORDER.indexOf(level)
  const blocking = []
  const informational = []
  for (const a of advisories) {
    if (ORDER.indexOf(a.severity) < min) continue
    const paths = (a.findings ?? []).flatMap((f) => f.paths ?? [])
    const roots = [...new Set(paths.map((p) => p.split(' > ')[0].trim()))]
    const reaches = roots.filter((r) => dirs.includes(r))
    ;(reaches.length > 0 ? blocking : informational).push({ ...a, roots, reaches })
  }
  return { blocking, informational }
}

function main(argv) {
  const level = (argv.find((a) => a.startsWith('--level=')) ?? '--level=high').split('=')[1]
  if (!ORDER.includes(level)) {
    console.error(`audit-release: unknown level ${level}`)
    return 2
  }
  const dirs = publishableDirs()
  if (dirs.length === 0) {
    console.error(
      'audit-release: found no publishable packages — refusing to report success having audited nothing',
    )
    return 1
  }

  let raw
  try {
    raw = execFileSync('pnpm', ['audit', '--prod', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (err) {
    // `pnpm audit` exits non-zero WHEN IT FINDS SOMETHING, so a non-zero exit is not an error — but an
    // empty stdout is: it means the audit did not run, and "could not check" must never read as "clean".
    raw = err.stdout ?? ''
    if (raw.trim() === '') {
      console.error(
        `audit-release: could not run pnpm audit — refusing to publish unaudited. ${err.message}`,
      )
      return 1
    }
  }

  let advisories
  try {
    advisories = Object.values(JSON.parse(raw).advisories ?? {})
  } catch (err) {
    console.error(
      `audit-release: could not parse the audit report — refusing to publish unaudited. ${err.message}`,
    )
    return 1
  }

  const { blocking, informational } = partition(advisories, dirs, level)
  for (const a of informational) {
    console.log(
      `  note  ${a.severity} in ${a.module_name} — reaches ${a.roots.join(', ')} only, not published`,
    )
  }
  if (blocking.length > 0) {
    for (const a of blocking) {
      console.error(
        `::error::${a.severity} advisory in ${a.module_name} reaches published ${a.reaches.join(', ')} — ` +
          `${a.url ?? a.title ?? ''}`,
      )
    }
    console.error(
      `\naudit-release: ${blocking.length} advisory/advisories at or above "${level}" reach a published package`,
    )
    return 1
  }
  console.log(
    `\naudit-release: no ${level}+ advisories reach the ${dirs.length} published package(s)`,
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
