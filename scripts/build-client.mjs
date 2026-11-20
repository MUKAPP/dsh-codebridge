import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const chunk = 'client.formatter.js'

// DSH loads the entry and sibling chunks as separate, lazy CommonJS factories.
function buildFactory(entry, file, chunkName, revision = '') {
  const registration = `id: ${JSON.stringify(manifest.name)}${chunkName === undefined ? '' : `, chunk: ${JSON.stringify(chunkName)}`}`
  return build({
    absWorkingDir: fileURLToPath(root),
    entryPoints: [entry],
    outfile: `lib/${file}`,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
    minify: true,
    sourcemap: true,
    banner: {
      js: `${revision}window.__ModuleLoader__.load({ ${registration}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
    },
    footer: { js: 'return module.exports; } });' },
  })
}

await buildFactory('src/client/format-code.ts', chunk, chunk)
// The loader keys the sibling URL by the entry revision, including on formatter-only rebuilds.
const hash = createHash('sha256').update(await readFile(new URL(`lib/${chunk}`, root))).digest('hex')
await buildFactory('src/client/index.ts', 'client.js', undefined, `/* formatter: ${hash} */\n`)
