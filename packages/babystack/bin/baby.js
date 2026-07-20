#!/usr/bin/env node
// The flagship's `baby` bin delegates to the CLI implementation in @babystack/cli (a dependency), so
// `pnpm add -D babystack` gives you the `baby` command without a separate install.
import { run } from '@babystack/cli'

run(process.argv.slice(2)).then((result) => {
  process.stdout.write(result.output)
  process.exit(result.code)
})
