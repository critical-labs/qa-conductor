// Promisified execFile with the { stdout } resolution shape the docker module
// depends on (createDocker destructures { stdout } from every call). Kept as
// its own module so the shape is unit-tested rather than assumed by wiring.
import { execFile } from 'node:child_process'

export function makeExecFileFn({ maxBuffer = 64 * 1024 * 1024 } = {}) {
  return (cmd, args, opts) => new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args?.[0] ?? ''}: ${err.message}\n${String(stderr).slice(0, 2000)}`))
      else resolve({ stdout: String(stdout) })
    })
  })
}
