import path from "node:path"

import { readText } from "../core/util.js"
import { meetsFailOn, parseFailOnTier } from "../engine/finding.js"
import { runPremise } from "../engine/premise.js"
import { print, renderFindings, section } from "../ui/render.js"
import { theme } from "../ui/theme.js"

export interface PremiseOptions {
  cwd: string
  task?: string
  /** Read the task from a file — a plan, an issue, a prompt — instead of the argument; `-` = stdin. */
  file?: string
  json?: boolean
  /** Skip writing/printing the agent brief. */
  brief?: boolean
  /** Exit non-zero when a finding at (or above) this tier exists. */
  failOn?: string
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

export async function run(opts: PremiseOptions): Promise<void> {
  // Validate the gate tier BEFORE anything runs — a typo must never report success.
  const failOn = opts.failOn === undefined ? undefined : parseFailOnTier(opts.failOn)

  let task = opts.task
  let source = "argument"
  if (opts.file === "-") {
    // Piped in by a hook or a pipeline — no temp file needed.
    task = await readStdin()
    source = "stdin"
  } else if (opts.file) {
    const abs = path.resolve(opts.cwd, opts.file)
    const text = await readText(abs)
    if (text === null) throw new Error(`could not read the task file: ${opts.file}`)
    task = text
    source = opts.file
  }
  if (!task?.trim()) {
    throw new Error(
      'give the task as an argument (etymd premise "…"), with --file <path>, or on stdin (--file -)',
    )
  }

  const result = await runPremise({
    root: opts.cwd,
    task,
    source,
    writeBrief: opts.brief !== false,
  })

  if (failOn && meetsFailOn(result.findings, failOn)) {
    process.exitCode = 1
  }

  if (opts.json) {
    print(JSON.stringify(result, null, 2))
    return
  }

  section(`Premise ${theme.dim(`· ${result.name} · is this the right task?`)}`)
  const shown = result.task.length > 160 ? `${result.task.slice(0, 157)}…` : result.task
  print(`  ${theme.dim("task")}  ${shown.replace(/\n/g, " ")}`)

  section(`Findings ${theme.dim("(a missing thing the task is about ranks as risk)")}`)
  renderFindings(result.findings)
  for (const d of result.disclosures) print(`       ${theme.dim(`◦ ${d}`)}`)

  if (opts.brief === false) return
  section("Brief")
  if (result.briefPath) {
    print(`  ${theme.dim("wrote")} ${theme.info(result.briefPath)}`)
    print(
      `  ${theme.dim("Hand it to the agent with the task:")} ${theme.dim('"Read')} ${theme.info(result.briefPath)}${theme.dim(' before you start."')}`,
    )
  } else {
    print(`  ${theme.dim("(no .etymd/ here, so nothing is written — the brief follows)")}`)
    print()
    for (const line of result.brief.split("\n")) print(`  ${line}`)
  }
}
