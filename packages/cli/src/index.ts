import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { BabystackError } from '@babystack/core'
import { DockerBackend, NodeCommandRunner, SystemClock } from '@babystack/docker'
import {
  ensureEnv,
  findRunning,
  leaseEnv,
  loadConfig,
  resolveMysqlService,
  sleep,
  wake,
} from '@babystack/runtime'

/** Canonical `baby` commands (friendly aliases below). All support `--json` for CI/agents. */
export const COMMANDS = ['doctor', 'wake', 'home', 'reset', 'sleep'] as const
export type Command = (typeof COMMANDS)[number]

/** Friendly aliases → canonical command. */
const ALIASES: Readonly<Record<string, Command>> = { up: 'wake', down: 'sleep', env: 'home' }

/** The CLI's single lease key — one seeded DB per project session (what `baby reset` re-freshens). */
const AGENT_KEY = 'agent'

export interface RunResult {
  readonly code: number
  readonly output: string
}

const HELP = [
  'baby — babystack CLI',
  '',
  'Usage: baby <command> [--json]',
  '',
  'Commands:',
  '  doctor         check Docker, Node, and your babystack.config.ts',
  '  wake   (up)    provision + seed a real MySQL and leave it running (--rebuild forces a fresh baseline)',
  '  home   (env)   print an eval-able DATABASE_URL for the running stack',
  '  reset          reload a pristine DB from the baseline (the agent’s undo)',
  '  sleep  (down)  dispose this project’s running stack',
  '',
  '  eval "$(baby home)"   # then your app/tests just read DATABASE_URL',
  '',
].join('\n')

const asJsonText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`
/** Single-quote a value for safe `eval` in a POSIX shell. */
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

/**
 * argv → result (the bin handles process I/O). Async: every real command talks to Docker. `--help`/no-args
 * and unknown commands are Docker-free (unit-tested); the rest are covered by the integration test.
 */
export async function run(argv: readonly string[]): Promise<RunResult> {
  const json = argv.includes('--json')
  const rebuild = argv.includes('--rebuild')
  const raw = argv.find((arg) => !arg.startsWith('-'))
  if (raw === undefined || raw === 'help') return { code: 0, output: HELP }

  const cmd = ALIASES[raw] ?? raw
  try {
    switch (cmd) {
      case 'doctor':
        return await doctor(json)
      case 'wake':
        return await wakeCommand(json, rebuild)
      case 'home':
        return await homeCommand(json)
      case 'reset':
        return await resetCommand(json)
      case 'sleep':
        return await sleepCommand(json)
      default:
        return { code: 1, output: `baby: unknown command "${raw}"\n\n${HELP}` }
    }
  } catch (error) {
    const message =
      error instanceof BabystackError
        ? `${error.code}: ${error.message}`
        : ((error as Error)?.message ?? String(error))
    return {
      code: 1,
      output: json ? asJsonText({ ok: false, error: message }) : `baby: ${message}\n`,
    }
  }
}

function notAwake(json: boolean): RunResult {
  const message = 'nothing is awake — run `baby wake` first'
  return {
    code: 1,
    output: json ? asJsonText({ ok: false, error: message }) : `baby: ${message}\n`,
  }
}

async function wakeCommand(json: boolean, rebuild: boolean): Promise<RunResult> {
  const { instance, alreadyRunning } = await wake(undefined, undefined, { rebuild })
  if (json) {
    return {
      code: 0,
      output: asJsonText({
        ok: true,
        alreadyRunning,
        container: instance.id,
        host: instance.host,
        port: instance.port,
      }),
    }
  }
  return {
    code: 0,
    output: `baby: ${alreadyRunning ? 'already awake' : 'awake'} — real MySQL on ${instance.host}:${instance.port}. Run \`baby home\` for a connection URL.\n`,
  }
}

async function homeCommand(json: boolean): Promise<RunResult> {
  const running = await findRunning()
  if (running === undefined) return notAwake(json)
  // NON-DESTRUCTIVE: create + seed the agent DB only if it doesn't exist yet; otherwise just return its
  // URL. The DB name is stable, so re-running `home` is safe (it never wipes work) — only `reset` wipes.
  const env = await ensureEnv(running.instance, running.baseline, AGENT_KEY)
  if (json) return { code: 0, output: asJsonText({ ok: true, env }) }
  const exports = Object.entries(env)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('\n')
  return { code: 0, output: `${exports}\n` }
}

async function resetCommand(json: boolean): Promise<RunResult> {
  const running = await findRunning()
  if (running === undefined) return notAwake(json)
  // Re-lease the SAME key: drop + recreate + reload the baseline → pristine, with no container re-provision.
  // The connection URL is unchanged, so an agent can reset between attempts and keep using its DATABASE_URL.
  await leaseEnv(running.instance, running.baseline, AGENT_KEY)
  if (json) return { code: 0, output: asJsonText({ ok: true, reset: true }) }
  return { code: 0, output: 'baby: reset — the database is back to the pristine baseline.\n' }
}

async function sleepCommand(json: boolean): Promise<RunResult> {
  const disposed = await sleep()
  if (json) return { code: 0, output: asJsonText({ ok: true, disposed }) }
  return {
    code: 0,
    output: disposed > 0 ? 'baby: asleep — container disposed.\n' : 'baby: nothing was awake.\n',
  }
}

export interface Check {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
  /** A warning is shown but does NOT fail the preflight (heuristics live here). */
  readonly warn?: boolean
}

/** The real Docker-reachability probe (shells out to `docker info`). */
function dockerReachable(): Promise<boolean> {
  return new DockerBackend({
    runner: new NodeCommandRunner(),
    clock: new SystemClock(),
  }).isAvailable()
}

/** Run every preflight check (node · docker · config · env-read) and return them in display order.
 * Exported so the check set + verdicts are testable without going through the formatted `doctor` output; the
 * Docker probe is injectable so unit tests stay deterministic (no real `docker info` I/O). */
export async function doctorChecks(
  dockerAvailable: () => Promise<boolean> = dockerReachable,
): Promise<Check[]> {
  const nodeMajor = Number(process.versions.node.split('.')[0])
  const dockerOk = await dockerAvailable()
  return [
    {
      name: 'node',
      ok: nodeMajor >= 22, // engines: >=22 (Node 20 is EOL); CI tests on 22 & 24
      detail: `v${process.versions.node} (needs >=22; tested on 22, 24)`,
    },
    {
      name: 'docker',
      ok: dockerOk,
      detail: dockerOk ? 'engine reachable' : 'not reachable — is Docker running?',
    },
    await configCheck(),
    await envReadCheck(),
  ]
}

async function doctor(json: boolean): Promise<RunResult> {
  const checks = await doctorChecks()
  const failed = checks.some((c) => !c.ok && c.warn !== true)
  if (json) return { code: failed ? 1 : 0, output: asJsonText({ ok: !failed, checks }) }
  const mark = (c: Check): string => (c.ok ? '✔' : c.warn ? '⚠' : '✗')
  const lines = checks.map((c) => `  ${mark(c)} ${c.name.padEnd(9)} ${c.detail}`)
  return {
    code: failed ? 1 : 0,
    output: `baby doctor\n\n${lines.join('\n')}\n\n${failed ? 'some checks failed.' : 'all good.'}\n`,
  }
}

async function configCheck(): Promise<Check> {
  try {
    const { name, service } = resolveMysqlService(await loadConfig())
    return {
      name: 'config',
      ok: true,
      detail: `1 service: ${name} → ${service.image ?? 'mysql:8.4'}`,
    }
  } catch (error) {
    return { name: 'config', ok: false, detail: (error as Error).message }
  }
}

// A MODULE-LEVEL binding that reads DATABASE_URL at import — before babystack's setup injects it (the #1
// footgun). Best-effort + warn-only: catches the common single-line assignment and destructured forms and
// ignores comment text; a real lazy getter (RHS starting with a function/arrow) is NOT flagged. Known miss:
// a read buried inside multi-line call arguments (that needs a parser) — see docs/guide/getting-started.md.
const ASSIGN_READ =
  /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=(?![ \t]*(?:async\b|function\b|\([^)]*\)\s*=>|[\w$]+\s*=>))[^\n]*\bDATABASE_URL\b/
const DESTRUCTURE_READ =
  /^(?:export\s+)?(?:const|let|var)\s*\{[^}]*\bDATABASE_URL\b[^}]*\}\s*=\s*[^\n]*\bprocess\.env\b/
export function readsEnvTooEarly(source: string): boolean {
  return source
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '')) // ignore line-comment text (avoids false positives)
    .some((line) => ASSIGN_READ.test(line) || DESTRUCTURE_READ.test(line))
}

async function envReadCheck(): Promise<Check> {
  const offenders: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // no such dir (e.g. no ./src) — nothing to scan
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') await walk(path)
      } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
        const content = await readFile(path, 'utf8').catch(() => '')
        if (readsEnvTooEarly(content)) offenders.push(path)
      }
    }
  }
  await walk('src')
  return offenders.length === 0
    ? { name: 'env-read', ok: true, detail: 'no import-time DATABASE_URL reads found in src/' }
    : {
        name: 'env-read',
        ok: false,
        warn: true,
        detail: `DATABASE_URL may be read at import in: ${offenders.join(', ')} — read it lazily`,
      }
}
