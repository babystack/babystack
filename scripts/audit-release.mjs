/**
 * The one gate whose verdict changes with no commit at all.
 *
 * Re-run the gates whose verdict changes without a commit. Most checks are a function of the tree, so a
 * green `main` genuinely covers them. A dependency/vulnerability audit is not: an advisory disclosed after
 * the merge makes the *unchanged* tree newly vulnerable. So this one runs against the release commit, at
 * release time.
 *
 * Why this is a script and not `pnpm audit --audit-level=high` in the workflow: `pnpm audit` walks the
 * WHOLE workspace and cannot be filtered to a subset. A workspace can hold projects that are never
 * published (a demo app, a test helper) — so a plain audit fails the release on a vulnerability that
 * reaches no consumer, and a gate that fails for reasons the release cannot fix is one people learn to
 * bypass.
 *
 * So: audit production dependencies, then keep only the advisories that reach a package this repo actually
 * publishes. Anything else is reported as context and does not block — but only when the report can be
 * read with certainty. An advisory whose path starts somewhere this script cannot place, and totals that
 * the listed advisories do not account for, both fail closed. "Could not tell" must never read as "safe":
 * a change in pnpm's output format once turned this gate into one that passed everything.
 *
 * Usage: node scripts/audit-release.mjs [--level=high|moderate|low]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseAllDocuments } from 'yaml'

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
 * Every workspace project the lockfile knows: `.` for the root, then `packages/core`, `examples/app` and so
 * on. pnpm 12 writes the lockfile as several YAML documents (its own toolchain first, then the workspace), so
 * the projects are the union of `importers` across all of them.
 */
export function workspaceProjects(lockfileText) {
  const out = new Set()
  for (const doc of parseAllDocuments(lockfileText)) {
    for (const id of Object.keys(doc.toJS()?.importers ?? {})) out.add(id)
  }
  return out
}

/**
 * The workspace project a finding path starts from. pnpm 12 writes `packages__core>dep>sub` (`__` for `/`,
 * `.` for the root); pnpm 9 wrote `packages/core > dep@1.0.0 > sub@2.0.0`. Both start with the project.
 */
export function projectOf(path) {
  return path.split('>')[0].trim().replaceAll('__', '/')
}

/**
 * Split the advisories at or above `level` into the ones that block a release and the ones that do not. An
 * advisory blocks when it reaches a published package, or when any of its paths starts at a project this
 * repo cannot place — including an advisory that lists no path at all.
 */
export function partition(advisories, published, projects, level) {
  const min = ORDER.indexOf(level)
  const blocking = []
  const informational = []
  for (const a of advisories) {
    if (ORDER.indexOf(a.severity) < min) continue
    const paths = (a.findings ?? []).flatMap((f) => f.paths ?? [])
    const roots = [...new Set(paths.map(projectOf))]
    const reaches = roots.filter((r) => published.includes(r))
    const unplaced = paths.length === 0 ? ['(no path)'] : roots.filter((r) => !projects.has(r))
    const entry = { ...a, roots, reaches, unplaced }
    ;(reaches.length > 0 || unplaced.length > 0 ? blocking : informational).push(entry)
  }
  return { blocking, informational }
}

/**
 * pnpm's own totals must be accounted for by the advisories it listed. Returns a description of every
 * severity at or above `level` where they disagree; an empty list means the report is consistent.
 */
export function unexplained(report, level) {
  const counts = report?.metadata?.vulnerabilities
  if (!counts) return ['the report carries no metadata.vulnerabilities totals']
  const listed = Object.values(report.advisories ?? {})
  const problems = []
  for (const severity of ORDER.slice(ORDER.indexOf(level))) {
    const n = listed.filter((a) => a.severity === severity).length
    const total = counts[severity] ?? 0
    if (total !== n) problems.push(`pnpm counts ${total} ${severity} but lists ${n}`)
  }
  return problems
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
  let projects
  try {
    projects = workspaceProjects(readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8'))
  } catch (err) {
    console.error(
      `audit-release: could not read the workspace projects from pnpm-lock.yaml — ${err.message}`,
    )
    return 1
  }
  if (projects.size === 0) {
    console.error('audit-release: pnpm-lock.yaml lists no workspace projects — refusing to guess')
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

  let report
  try {
    report = JSON.parse(raw)
  } catch (err) {
    console.error(
      `audit-release: could not parse the audit report — refusing to publish unaudited. ${err.message}`,
    )
    return 1
  }
  const gaps = unexplained(report, level)
  if (gaps.length > 0) {
    console.error(
      `audit-release: the report does not add up (${gaps.join('; ')}) — refusing to publish unaudited`,
    )
    return 1
  }

  const { blocking, informational } = partition(
    Object.values(report.advisories ?? {}),
    dirs,
    projects,
    level,
  )
  for (const a of informational) {
    console.log(
      `  note  ${a.severity} in ${a.module_name} — reaches ${a.roots.join(', ')} only, not published`,
    )
  }
  if (blocking.length > 0) {
    for (const a of blocking) {
      const why =
        a.reaches.length > 0
          ? `reaches published ${a.reaches.join(', ')}`
          : `starts at ${a.unplaced.join(', ')}, which is not a known workspace project`
      console.error(
        `::error::${a.severity} advisory in ${a.module_name} ${why} — ${a.url ?? a.title ?? ''}`,
      )
    }
    console.error(
      `\naudit-release: ${blocking.length} advisory/advisories at or above "${level}" block the release`,
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
