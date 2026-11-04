import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

// 仅创建本项目内的临时 profile；DSH 应用仍由公开 CLI 入口启动。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const executable = process.argv[2]
const entry = process.argv[3]
if (!executable || !entry) throw new Error('Usage: node verification/run.mjs <node-or-electron> <dsh-cli-entry> [--electron]')
const home = join(root, 'verification', '.profile')
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
const probe = join(root, 'verification', 'probe.mjs').replaceAll('\\', '/')
writeFileSync(join(profile, 'cordis.patch.yml'), `${patch}    - id: verification\n      name: '${probe.replaceAll("'", "''")}'\n`)
const env = { ...process.env, DSH_HOME: home }
if (process.argv.includes('--electron')) env.ELECTRON_RUN_AS_NODE = '1'
const child = spawn(executable, [entry, '--profile', 'codebridge-verify'], { cwd: workspace, env, stdio: 'inherit' })
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', (code, signal) => {
  if (signal) console.error(`Verification terminated by ${signal}`)
  process.exitCode = code ?? 1
})
