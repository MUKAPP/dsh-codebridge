import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

// 仅创建本项目内的临时 profile；DSH 应用仍由公开 CLI 入口启动。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const executable = process.argv[2]
const entry = process.argv[3]
if (!executable || !entry) throw new Error('Usage: node verification/run.mjs <node-or-electron> <dsh-cli-entry> [--electron] [--restart]')
const restart = process.argv.includes('--restart')
const home = join(root, 'verification', '.profile', ...(restart ? ['restart'] : []))
const profile = join(home, 'profiles', 'codebridge-verify')
const workspace = join(home, 'workspace')
mkdirSync(join(profile, 'node_modules'), { recursive: true })
mkdirSync(workspace, { recursive: true })
const linked = join(profile, 'node_modules', 'dsh-codebridge')
if (existsSync(linked)) {
  if (realpathSync(linked) !== realpathSync(root)) throw new Error('Verification package link points to another project')
} else {
  symlinkSync(root, linked, process.platform === 'win32' ? 'junction' : 'dir')
}
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-codebridge-verify', private: true, type: 'module',
  dependencies: { 'dsh-codebridge': `link:${root.replaceAll('\\', '/')}` },
  dsh: { profile: { bundles: ['dsh-codebridge'] } },
}, null, 2) + '\n')
const patch = readFileSync(join(root, 'verification', 'profile.patch.yml'), 'utf8')
const probe = join(root, 'verification', restart ? 'restart-probe.mjs' : 'probe.mjs').replaceAll('\\', '/')
writeFileSync(join(profile, 'cordis.patch.yml'), `${patch}    - id: verification\n      name: '${probe.replaceAll("'", "''")}'\n`)
if (restart) {
  const storage = join(home, 'sessions').replaceAll('\\', '/')
  const restartPatch = `- id: codebridge
  config:
    retainSessionState: true
    restoreOnRestart: true
- insert:
    - id: restart-persistence
      name: '@deepseek-ai/dsh-session-persistence-jsonl'
      config:
        root: '${storage.replaceAll("'", "''")}'
        compression: none
    - id: restart-config-editor
      name: '@deepseek-ai/dsh-config-editor'
    - id: restart-settings
      name: '@deepseek-ai/dsh-settings'
`
  writeFileSync(join(profile, 'cordis.patch.yml'), `${readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')}\n${restartPatch}`)
}
const env = { ...process.env, DSH_HOME: home, CODEBRIDGE_RESTART_ID: `codebridge-restart-${Date.now()}` }
if (process.argv.includes('--electron')) env.ELECTRON_RUN_AS_NODE = '1'
for (const phase of restart ? ['seed', 'restore'] : ['default']) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(executable, [entry, '--profile', 'codebridge-verify'], {
      cwd: workspace, env: { ...env, CODEBRIDGE_RESTART_PHASE: phase }, stdio: ['inherit', 'pipe', 'inherit'],
    })
    let output = ''
    child.stdout.on('data', chunk => { process.stdout.write(chunk); output = (output + chunk.toString()).slice(-16384) })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) console.error(`Verification terminated by ${signal}`)
      const expected = phase === 'seed' ? 'CODEBRIDGE_RESTART_SEEDED' : phase === 'restore' ? 'CODEBRIDGE_RESTART_VERIFIED' : 'CODEBRIDGE_VERIFIED'
      if (code === 0 && !output.includes(expected)) {
        console.error(`Verification did not reach ${expected}`)
        resolve(1)
      } else resolve(code ?? 1)
    })
  })
  if (code !== 0) { process.exitCode = code; break }
}
