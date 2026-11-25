import { run as auditRun } from "./audit.js"

export interface DoctorOptions {
  cwd: string
  json?: boolean
  /** This fork's upstream remote — inherited comments are its upstream's to fix, not the fork's. */
  upstream?: string
}

/** Doctor is the audit's truth subset: "is the recorded reckoning still true?" */
export async function run(opts: DoctorOptions): Promise<void> {
  await auditRun({ cwd: opts.cwd, json: opts.json, truth: true, upstream: opts.upstream })
}
