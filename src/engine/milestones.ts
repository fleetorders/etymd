/**
 * Milestones and the fleet board.
 *
 * A project declares its milestones in ONE file (`MILESTONES.md` by convention, any path via the
 * registry contract key `milestones`). The file has a fixed shape so a fleet can roll every
 * project's plan into one board without an agent reading prose: a `# Milestones` heading, then a
 * pipe table with exactly these columns —
 *
 *   | id | milestone | goal | status | next | effort | depends-on |
 *
 * `id` is `M<n>` and unique in the file; `goal` is the numbered end the milestone serves (1, 2 or
 * 3 — a fleet's own ordered goals, declared outside this tool); `status` is planned | active |
 * blocked | done; `next` is the one concrete next step; `effort` is the S | M | L remaining;
 * `depends-on` is `—` or a comma-separated list of ids from the same table. Anything after the
 * table is free prose and never parsed. A header-only table is a legitimate state: declared, empty.
 *
 * Why a table and not frontmatter or YAML: the file is edited by hand at the end of a session and
 * read back by a person in a terminal; a table reads in both places, and a fixed column list is
 * the smallest grammar a validator can hold a writer to (label fields; do not guard).
 *
 * The board is a pure function of the parsed files plus an optional ranked initiatives table
 * (`| rank | id | initiative | goal | status | next | effort | projects | depends-on |`) — the
 * one hand-edited surface where a fleet's cross-project work and its priority order live.
 */

export const MILESTONES_FILE = "MILESTONES.md"
export const BOARD_JSON_SCHEMA = "fleet-board-experimental-0.1"

export const MILESTONE_COLUMNS = [
  "id",
  "milestone",
  "goal",
  "status",
  "next",
  "effort",
  "depends-on",
] as const
export const INITIATIVE_COLUMNS = [
  "rank",
  "id",
  "initiative",
  "goal",
  "status",
  "next",
  "effort",
  "projects",
  "depends-on",
] as const

export const MILESTONE_GOALS = ["1", "2", "3"] as const
export const MILESTONE_STATUSES = ["planned", "active", "blocked", "done"] as const
export const MILESTONE_EFFORTS = ["S", "M", "L"] as const

export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number]
export type MilestoneEffort = (typeof MILESTONE_EFFORTS)[number]

export interface Milestone {
  id: string
  milestone: string
  goal: string
  status: MilestoneStatus
  next: string
  effort: MilestoneEffort
  dependsOn: string[]
}

export interface Initiative extends Milestone {
  rank: number
  projects: string[]
}

export interface MilestonesDoc {
  rows: Milestone[]
  /** Shape problems, each one sentence naming the line. Empty = the file parses cleanly. */
  problems: string[]
}

export interface InitiativesDoc {
  rows: Initiative[]
  problems: string[]
}

interface RawTable {
  header: string[]
  /** 1-based line number of each body row, beside its cells. */
  rows: { line: number; cells: string[] }[]
  headerLine: number
}

const NONE_MARKERS = new Set(["", "—", "-", "–", "none"])

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "")
  return trimmed.split("|").map((c) => c.trim())
}

function isSeparatorRow(line: string): boolean {
  const cells = splitRow(line)
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c))
}

/** The first pipe table after `startLine` (0-based index into `lines`), or null. */
function firstTable(lines: string[], startLine: number): RawTable | null {
  for (let i = startLine; i < lines.length - 1; i++) {
    const line = lines[i] ?? ""
    const next = lines[i + 1] ?? ""
    if (!line.trim().startsWith("|") || !isSeparatorRow(next)) continue
    const header = splitRow(line).map((h) => h.toLowerCase())
    const rows: RawTable["rows"] = []
    for (let j = i + 2; j < lines.length; j++) {
      const body = lines[j] ?? ""
      if (!body.trim().startsWith("|")) break
      rows.push({ line: j + 1, cells: splitRow(body) })
    }
    return { header, rows, headerLine: i + 1 }
  }
  return null
}

function parseList(cell: string): string[] {
  if (NONE_MARKERS.has(cell.trim().toLowerCase())) return []
  return cell
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

function checkColumns(table: RawTable, expected: readonly string[], problems: string[]): boolean {
  const got = table.header.join(" | ")
  const want = expected.join(" | ")
  if (got !== want) {
    problems.push(
      `line ${table.headerLine}: table columns are \`${got}\`; the standard is \`${want}\``,
    )
    return false
  }
  return true
}

function checkVocabulary(
  line: number,
  field: string,
  value: string,
  allowed: readonly string[],
  problems: string[],
): boolean {
  if (allowed.includes(value)) return true
  problems.push(
    `line ${line}: ${field} is \`${value}\`; allowed: ${allowed.map((a) => `\`${a}\``).join(", ")}`,
  )
  return false
}

/**
 * Parse a milestones file. Never throws: every shape defect becomes a problem string, and the
 * rows that DID parse are returned beside them, so a board can still show what it can see.
 */
export function parseMilestones(text: string): MilestonesDoc {
  const problems: string[] = []
  const lines = text.split(/\r?\n/)
  const headingIdx = lines.findIndex((l) => /^#\s/.test(l))
  if (headingIdx === -1 || lines[headingIdx]?.trim() !== "# Milestones") {
    problems.push(
      headingIdx === -1
        ? "no heading: the file must start with `# Milestones`"
        : `line ${headingIdx + 1}: first heading is \`${lines[headingIdx]?.trim()}\`; it must be \`# Milestones\``,
    )
  }
  const table = firstTable(lines, headingIdx === -1 ? 0 : headingIdx + 1)
  if (!table) {
    problems.push(
      `no milestones table: expected \`| ${MILESTONE_COLUMNS.join(" | ")} |\` after the heading`,
    )
    return { rows: [], problems }
  }
  if (!checkColumns(table, MILESTONE_COLUMNS, problems)) return { rows: [], problems }

  const rows: Milestone[] = []
  const ids = new Set<string>()
  for (const { line, cells } of table.rows) {
    if (cells.length !== MILESTONE_COLUMNS.length) {
      problems.push(`line ${line}: ${cells.length} cells, expected ${MILESTONE_COLUMNS.length}`)
      continue
    }
    const [id, milestone, goal, status, next, effort, deps] = cells as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ]
    let ok = true
    if (!/^M\d+$/.test(id)) {
      problems.push(`line ${line}: id \`${id}\` is not \`M<number>\``)
      ok = false
    } else if (ids.has(id)) {
      problems.push(`line ${line}: id \`${id}\` is used twice`)
      ok = false
    }
    if (!milestone) {
      problems.push(`line ${line}: milestone title is empty`)
      ok = false
    }
    if (!next) {
      problems.push(`line ${line}: next step is empty — a milestone without a next step is a wish`)
      ok = false
    }
    ok = checkVocabulary(line, "goal", goal, MILESTONE_GOALS, problems) && ok
    ok = checkVocabulary(line, "status", status, MILESTONE_STATUSES, problems) && ok
    ok = checkVocabulary(line, "effort", effort, MILESTONE_EFFORTS, problems) && ok
    if (!ok) continue
    ids.add(id)
    rows.push({
      id,
      milestone,
      goal,
      status: status as MilestoneStatus,
      next,
      effort: effort as MilestoneEffort,
      dependsOn: parseList(deps),
    })
  }
  for (const r of rows) {
    for (const d of r.dependsOn) {
      if (!ids.has(d)) problems.push(`${r.id} depends on \`${d}\`, which is not in the table`)
    }
  }
  return { rows, problems }
}

/** Parse the ranked initiatives table (the hand-edited, fleet-level half of the board). */
export function parseInitiatives(text: string): InitiativesDoc {
  const problems: string[] = []
  const lines = text.split(/\r?\n/)
  const table = firstTable(lines, 0)
  if (!table) {
    problems.push(`no initiatives table: expected \`| ${INITIATIVE_COLUMNS.join(" | ")} |\``)
    return { rows: [], problems }
  }
  if (!checkColumns(table, INITIATIVE_COLUMNS, problems)) return { rows: [], problems }
  const rows: Initiative[] = []
  const ids = new Set<string>()
  const ranks = new Set<number>()
  for (const { line, cells } of table.rows) {
    if (cells.length !== INITIATIVE_COLUMNS.length) {
      problems.push(`line ${line}: ${cells.length} cells, expected ${INITIATIVE_COLUMNS.length}`)
      continue
    }
    const [rankRaw, id, initiative, goal, status, next, effort, projects, deps] = cells as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ]
    let ok = true
    const rank = Number(rankRaw)
    if (!/^\d+$/.test(rankRaw) || rank < 1) {
      problems.push(`line ${line}: rank \`${rankRaw}\` is not a positive integer`)
      ok = false
    } else if (ranks.has(rank)) {
      problems.push(`line ${line}: rank ${rank} is used twice — a rank is an order, not a score`)
      ok = false
    }
    if (!/^I\d+$/.test(id)) {
      problems.push(`line ${line}: id \`${id}\` is not \`I<number>\``)
      ok = false
    } else if (ids.has(id)) {
      problems.push(`line ${line}: id \`${id}\` is used twice`)
      ok = false
    }
    if (!initiative) {
      problems.push(`line ${line}: initiative title is empty`)
      ok = false
    }
    if (!next) {
      problems.push(`line ${line}: next step is empty`)
      ok = false
    }
    ok = checkVocabulary(line, "goal", goal, MILESTONE_GOALS, problems) && ok
    ok = checkVocabulary(line, "status", status, MILESTONE_STATUSES, problems) && ok
    ok = checkVocabulary(line, "effort", effort, MILESTONE_EFFORTS, problems) && ok
    if (!ok) continue
    ids.add(id)
    ranks.add(rank)
    rows.push({
      rank,
      id,
      milestone: initiative,
      goal,
      status: status as MilestoneStatus,
      next,
      effort: effort as MilestoneEffort,
      projects: parseList(projects),
      dependsOn: parseList(deps),
    })
  }
  for (const r of rows) {
    for (const d of r.dependsOn) {
      if (!ids.has(d)) problems.push(`${r.id} depends on \`${d}\`, which is not in the table`)
    }
  }
  rows.sort((a, b) => a.rank - b.rank)
  return { rows, problems }
}

export type BoardProjectState =
  | "ok"
  | "declared-empty"
  | "not-declared"
  | "none"
  | "missing"
  | "invalid"
  | "unresolved"

export interface BoardProject {
  name: string
  kind?: string
  /** The contract value as registered (absent when not declared). */
  file?: string
  state: BoardProjectState
  rows: Milestone[]
  problems: string[]
}

export interface BoardInput {
  /** ISO date (day precision keeps a committed board from churning on every render). */
  generatedOn: string
  manifest: string
  initiatives: Initiative[] | null
  initiativesProblems: string[]
  projects: BoardProject[]
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|")
}

function list(xs: string[]): string {
  return xs.length ? xs.join(", ") : "—"
}

function countBy(rows: Milestone[]): Record<MilestoneStatus, number> {
  const c: Record<MilestoneStatus, number> = { planned: 0, active: 0, blocked: 0, done: 0 }
  for (const r of rows) c[r.status] += 1
  return c
}

function statusLine(rows: Milestone[]): string {
  const c = countBy(rows)
  return MILESTONE_STATUSES.map((s) => `${s} ${c[s]}`).join(" · ")
}

/** Render the board as Markdown. Deterministic for a given input. */
export function renderBoard(input: BoardInput): string {
  const out: string[] = []
  out.push("# Fleet board")
  out.push("")
  out.push(
    `Generated ${input.generatedOn} by \`etymd fleet board\` from \`${input.manifest}\`. ` +
      "Do not edit: change a project's milestones file or the initiatives table and re-render.",
  )
  out.push("")

  out.push("## Initiatives, ranked")
  out.push("")
  if (input.initiatives === null) {
    out.push("No initiatives file given (`--initiatives <file>`).")
  } else {
    if (input.initiativesProblems.length) {
      out.push("Problems in the initiatives table:")
      out.push("")
      for (const p of input.initiativesProblems) out.push(`- ${p}`)
      out.push("")
    }
    if (input.initiatives.length === 0) {
      out.push("No initiatives ranked yet.")
    } else {
      out.push(`| ${INITIATIVE_COLUMNS.join(" | ")} |`)
      out.push(`|${INITIATIVE_COLUMNS.map(() => "---").join("|")}|`)
      for (const i of input.initiatives) {
        out.push(
          `| ${i.rank} | ${i.id} | ${cell(i.milestone)} | ${i.goal} | ${i.status} | ${cell(i.next)} | ${i.effort} | ${cell(list(i.projects))} | ${list(i.dependsOn)} |`,
        )
      }
    }
  }
  out.push("")

  out.push("## Milestones by project")
  out.push("")
  const all: Milestone[] = []
  for (const p of input.projects) {
    const kind = p.kind ? ` (${p.kind})` : ""
    switch (p.state) {
      case "ok":
      case "declared-empty":
      case "invalid": {
        const head =
          p.state === "declared-empty"
            ? "declared, empty"
            : p.state === "invalid"
              ? `INVALID — ${p.problems.length} problem${p.problems.length === 1 ? "" : "s"}`
              : statusLine(p.rows)
        out.push(`### ${p.name}${kind} — ${head}`)
        out.push("")
        if (p.problems.length) {
          for (const pr of p.problems) out.push(`- ${pr}`)
          out.push("")
        }
        if (p.rows.length) {
          out.push(`| ${MILESTONE_COLUMNS.join(" | ")} |`)
          out.push(`|${MILESTONE_COLUMNS.map(() => "---").join("|")}|`)
          for (const r of p.rows) {
            out.push(
              `| ${r.id} | ${cell(r.milestone)} | ${r.goal} | ${r.status} | ${cell(r.next)} | ${r.effort} | ${list(r.dependsOn)} |`,
            )
          }
          out.push("")
          all.push(...p.rows)
        }
        break
      }
      case "not-declared":
        out.push(`### ${p.name}${kind} — not declared (no \`milestones\` contract key)`)
        out.push("")
        break
      case "none":
        out.push(`### ${p.name}${kind} — none, by declaration`)
        out.push("")
        break
      case "missing":
        out.push(
          `### ${p.name}${kind} — MISSING: \`${p.file ?? MILESTONES_FILE}\` is declared and absent`,
        )
        out.push("")
        break
      case "unresolved":
        out.push(`### ${p.name}${kind} — not read: ${p.problems[0] ?? "unresolved"}`)
        out.push("")
        break
    }
  }

  out.push("## Totals")
  out.push("")
  const c = countBy(all)
  out.push("| status | count |")
  out.push("|---|---|")
  for (const s of MILESTONE_STATUSES) out.push(`| ${s} | ${c[s]} |`)
  out.push("")
  const byGoal: Record<string, number> = { "1": 0, "2": 0, "3": 0 }
  for (const r of all) if (r.status !== "done") byGoal[r.goal] = (byGoal[r.goal] ?? 0) + 1
  out.push("| goal | open milestones |")
  out.push("|---|---|")
  for (const g of MILESTONE_GOALS) out.push(`| ${g} | ${byGoal[g] ?? 0} |`)
  out.push("")
  const states = input.projects.reduce<Record<string, number>>((acc, p) => {
    acc[p.state] = (acc[p.state] ?? 0) + 1
    return acc
  }, {})
  out.push(
    `Projects: ${input.projects.length} — ` +
      Object.entries(states)
        .map(([k, v]) => `${k} ${v}`)
        .join(" · "),
  )
  out.push("")
  return out.join("\n")
}
