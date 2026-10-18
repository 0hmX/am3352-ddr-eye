import assert from 'node:assert/strict'
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256, json } from './independent-helpers.mjs'

const ignored = new Set(['.git', 'node_modules', '.cache', '.tscircuit', '.venv', 'dist', 'runs', 'models', '.DS_Store'])
async function sources(root, prefix = '') {
  const files = []
  for (const name of (await readdir(join(root, prefix))).sort()) {
    if (ignored.has(name)) continue
    const path = join(prefix, name)
    if ((await stat(join(root, path))).isDirectory()) files.push(...await sources(root, path))
    else files.push(path)
  }
  return files
}

export async function auditProject(projectRoot) {
  const root = resolve(projectRoot), files = await sources(root)
  const ci = files.filter(path => /(^|\/)(?:\.github\/workflows\/|\.circleci\/|\.gitlab-ci(?:\.|\/)|azure-pipelines\.ya?ml$|Jenkinsfile$|ci(?:[.-]|\/))/i.test(path))
  assert.deepEqual(ci, [], 'No CI configuration/workflow/scripts delivered')
  const pkg = await json(join(root, 'package.json'))
  assert.match(pkg.scripts.dev, /^tsci dev(?:\s|$)/, 'Ordinary tscircuit dev command')
  assert.match(pkg.scripts.build, /(?:^|&& )tsci build(?:\s|$)/, 'Ordinary tscircuit build command')
  assert.match(pkg.scripts.typecheck, /^tsc --noEmit(?:\s|$)/, 'Ordinary TypeScript type checking')
  assert.ok(!Object.keys(pkg.scripts).some(name => /(^|:)ci($|:)/i.test(name)), 'No CI npm scripts')
  const required = [
    'index.circuit.tsx', 'tsconfig.json', 'tscircuit.config.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml',
    'packages/ibis-to-spice/package.json', 'packages/ibis-to-spice/lib/convert.ts', 'packages/ibis-to-spice/lib/parse-ibis.ts', 'packages/ibis-to-spice/lib/load.ts',
    'packages/pcb-spice-pipeline/package.json', 'packages/pcb-spice-pipeline/src/pipeline.mjs', 'packages/pcb-spice-pipeline/src/geometry.ts', 'packages/pcb-spice-pipeline/src/spice.ts', 'packages/pcb-spice-pipeline/src/cli.mjs',
    'packages/pcb-spice-pipeline/src/tsx.ts', 'packages/pcb-spice-pipeline/src/setup.ts', 'packages/pcb-spice-pipeline/src/viewer.ts',
  ]
  const sourceHashes = {}
  for (const path of required) {
    assert.ok(files.includes(path), `Reusable source/configuration included in the one delivered repository: ${path}`)
    sourceHashes[path] = sha256(await readFile(join(root, path)))
  }
  for (const [name, version] of Object.entries(pkg.dependencies)) assert.ok(!String(version).includes('.packages/'), `Published/workspace dependency ${name}`)
  assert.deepEqual(files.filter(path => path.endsWith('.py')), [], 'No Python source or runtime dependency')
  return { status: 'passed', projectRoot: root, sourceFileCount: files.length, ordinaryCommands: { dev: pkg.scripts.dev, build: pkg.scripts.build, typecheck: pkg.scripts.typecheck }, ciFiles: ci, reusableSources: sourceHashes, externalSolverPolicy: 'download and install locally before simulation; no bundled solvers', scope: 'Static packaging and command audit; actual build/dev/typecheck logs are separate execution evidence.' }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [project, destination] = process.argv.slice(2)
  assert.ok(project && destination, 'Usage: node audit-project.mjs PROJECT REPORT.json')
  const report = await auditProject(project)
  await mkdir(dirname(resolve(destination)), { recursive: true })
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n')
  console.log(`Independent project audit passed: ${resolve(destination)}`)
}
