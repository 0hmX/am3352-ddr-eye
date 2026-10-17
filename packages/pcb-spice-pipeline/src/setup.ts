import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { arch, cpus, platform, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { t as listTar, x as extractTar } from 'tar'
import { json, sha256 } from './io.mjs'
import { packageRoot } from './runtime.mjs'

const exec = promisify(execFile)
const exists = async (path: string) => { try { await lstat(path); return true } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e } }
export async function installedArtifacts(root: string): Promise<Record<string, { sha256: string } | { symlink: string }>> {
  if (!(await lstat(root)).isDirectory()) throw new Error(`Expected a real install directory: ${root}`)
  const artifacts: Record<string, { sha256: string } | { symlink: string }> = {}
  const visit = async (path: string) => {
    for (const name of (await readdir(join(root, path))).sort()) {
      const key = path ? `${path}/${name}` : name, file = join(root, key), entry = await lstat(file)
      if (entry.isSymbolicLink()) artifacts[key] = { symlink: await readlink(file) }
      else if (entry.isDirectory()) await visit(key)
      else if (entry.isFile()) artifacts[key] = { sha256: sha256(await readFile(file)) }
      else throw new Error(`Unsupported runtime artifact: ${file}`)
    }
  }
  await visit(''); return artifacts
}

/** Downloads and builds external programs into the user's cache, never the npm package. */
export async function setupTools(toolsDirectory: string, installDependencies = false, progress = console.log) {
  if (!['darwin', 'linux'].includes(platform())) throw new Error('Native setup currently supports macOS and Linux')
  const tools = resolve(toolsDirectory), mac = platform() === 'darwin', lockPath = join(packageRoot, 'toolchain-lock.json')
  const lock = JSON.parse(await readFile(lockPath, 'utf8')) as {
    sources: Record<string, { url: string; commit: string }>
    wxWidgets: { url: string; sha256: string; version: string }
    ngspice: { url: string; sha256: string; version: string }
  }
  const logDir = join(tools, 'logs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`)
  await mkdir(logDir, { recursive: true })
  const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}` }
  const commands: unknown[] = []
  const run = async (name: string, command: string[], cwd = tools, check = true) => {
    progress(name)
    const started = Date.now(), stdout = join(logDir, `${name}.stdout.log`), stderr = join(logDir, `${name}.stderr.log`)
    let result: { stdout: string; stderr: string }, code = 0
    try { result = await exec(command[0], command.slice(1), { cwd, env, maxBuffer: 128 * 1024 * 1024 }) }
    catch (error) {
      const e = error as Error & { code?: number; stdout?: string; stderr?: string }
      result = { stdout: e.stdout ?? '', stderr: e.stderr ?? e.message }; code = typeof e.code === 'number' ? e.code : 1
    }
    await writeFile(stdout, result.stdout); await writeFile(stderr, result.stderr)
    commands.push({ command, cwd, exitCode: code, wallSeconds: (Date.now() - started) / 1000, stdout, stderr })
    await json(join(tools, 'commands.json'), commands)
    if (check && code) throw new Error(`${name} failed (${code}); see ${stderr} and ${stdout}`)
    return (result.stdout || result.stderr).trim()
  }
  // Invalidate readiness before any mutation; a failed installation cannot be run.
  await rm(join(tools, 'tools.json'), { force: true })
  if (installDependencies) {
    if (mac) await run('dependencies', ['brew', 'install', 'cmake', 'llvm', 'libomp'])
    else {
      const apt = process.getuid?.() === 0 ? ['apt-get'] : ['sudo', 'apt-get']
      await run('apt-update', [...apt, 'update'])
      await run('dependencies', [...apt, 'install', '-y', 'build-essential', 'git', 'curl', 'cmake', 'bison', 'flex', 'bzip2'])
    }
  }
  for (const name of ['git', 'curl', 'make', 'cmake', 'cc', 'c++', 'bzip2', ...(mac ? ['brew'] : [])])
    try { await exec('which', [name], { env }) } catch { throw new Error(`Missing ${name}; install the documented prerequisites or run --setup --install-deps`) }
  const sourceRoot = join(tools, 'source'), provenance: Record<string, unknown> = {}
  await mkdir(sourceRoot, { recursive: true })
  const verifyGit = async (name: string) => {
    const cwd = join(sourceRoot, name)
    const commit = await run(`${name}-commit`, ['git', 'rev-parse', 'HEAD'], cwd)
    const dirty = await run(`${name}-status`, ['git', 'status', '--porcelain', '--untracked-files=all', '--ignored'], cwd)
    if (commit !== lock.sources[name].commit || dirty) throw new Error(`${cwd} is not pristine at its pinned commit; use a fresh tools directory`)
    provenance[name] = { commit, tree: await run(`${name}-tree`, ['git', 'rev-parse', 'HEAD^{tree}'], cwd), trackedDiff: '' }
  }
  for (const [name, source] of Object.entries(lock.sources)) {
    const cwd = join(sourceRoot, name)
    if (!await exists(cwd)) {
      await run(`${name}-clone`, ['git', 'clone', '--no-checkout', source.url, cwd])
      await run(`${name}-checkout`, ['git', 'checkout', '--detach', source.commit], cwd)
    }
    await verifyGit(name)
  }
  const verifyArchive = async (name: 'wxWidgets' | 'ngspice') => {
    const source = lock[name], archive = join(tools, new URL(source.url).pathname.split('/').at(-1)!)
    if (!await exists(archive)) await run(`${name}-download`, ['curl', '-L', '--fail', '--retry', '2', source.url, '-o', archive])
    if (sha256(await readFile(archive)) !== source.sha256) throw new Error(`Checksum mismatch: ${archive}`)
    const scratch = await mkdtemp(join(tmpdir(), 'pcb-solver-source-'))
    try {
      let file = archive
      if (archive.endsWith('.bz2')) {
        file = join(scratch, 'source.tar')
        const decoded = await exec('bzip2', ['-dc', archive], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 })
        await writeFile(file, decoded.stdout)
      }
      await listTar({ file, strict: true, onReadEntry: entry => {
        for (const path of [entry.path, ...(entry.linkpath ? [join(dirname(entry.path), entry.linkpath)] : [])])
          if (isAbsolute(path) || relative(scratch, resolve(scratch, path)).split(/[\\/]/).includes('..')) throw new Error(`Unsafe archive path: ${path}`)
      } })
      await extractTar({ file, cwd: scratch, strict: true, preservePaths: false })
      const nameWithVersion = `${name}-${source.version}`, clean = join(scratch, nameWithVersion), target = join(sourceRoot, nameWithVersion)
      const expected = await installedArtifacts(clean)
      if (!await exists(target)) await cp(clean, target, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
      if (JSON.stringify(expected) !== JSON.stringify(await installedArtifacts(target))) throw new Error(`Modified archive source: ${target}; use a fresh tools directory`)
      // Preserve upstream release timestamps so make never regenerates configure
      // scripts merely because the source was copied during installation.
      await cp(clean, target, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
      provenance[name] = { archiveSha256: source.sha256, sourceSha256: sha256(JSON.stringify(expected)) }
      return target
    } finally { await rm(scratch, { recursive: true, force: true }) }
  }
  const wxSource = await verifyArchive('wxWidgets'), ngSource = await verifyArchive('ngspice')
  const fresh = async (name: string) => { const path = join(tools, name); await rm(path, { recursive: true, force: true }); await mkdir(path); return path }
  const jobs = String(Math.min(cpus().length || 2, 4)), capFlags = ['-DCMAKE_POLICY_VERSION_MINIMUM=3.5', '-DCMAKE_CXX_STANDARD=11']
  let cc = 'cc', cxx = 'c++'
  if (mac) {
    const llvm = await run('llvm-prefix', ['brew', '--prefix', 'llvm']), omp = await run('libomp-prefix', ['brew', '--prefix', 'libomp'])
    cc = join(llvm, 'bin/clang'); cxx = join(llvm, 'bin/clang++')
    capFlags.push(`-DCMAKE_CXX_FLAGS=-I${omp}/include`, `-DCMAKE_EXE_LINKER_FLAGS=-L${omp}/lib`)
  }
  const wxBuild = await fresh('wxwidgets-build'), wxPrefix = await fresh('wxwidgets-prefix')
  await run('wxwidgets-configure', [join(wxSource, 'configure'), `--prefix=${wxPrefix}`, '--disable-gui', '--disable-debug', '--enable-shared', 'CXXFLAGS=-std=c++11'], wxBuild)
  await run('wxwidgets-build', ['make', '-j', jobs], wxBuild)
  await run('wxwidgets-install', ['make', 'install'], wxBuild)
  const fhBuild = await fresh('fasthenry-build')
  await cp(join(sourceRoot, 'FastHenry2'), fhBuild, { recursive: true, filter: path => !path.split('/').includes('.git') })
  const cflags = '-O2 -DFOUR -std=gnu89 -fcommon -Wno-implicit-function-declaration -Wno-int-conversion -Wno-incompatible-pointer-types' + (mac ? ' -Wno-return-mismatch' : '')
  await run('fasthenry-build', ['make', 'fasthenry', `CC=${cc}`, `CFLAGS=${cflags}`], fhBuild)
  const capBuild = await fresh('fastercap-build')
  await run('fastercap-configure', ['cmake', '-S', join(sourceRoot, 'FasterCap'), '-B', capBuild, '-DCMAKE_BUILD_TYPE=Release',
    '-DFASTFIELDSOLVERS_HEADLESS=ON', `-DCMAKE_C_COMPILER=${cc}`, `-DCMAKE_CXX_COMPILER=${cxx}`, `-DwxWidgets_CONFIG_EXECUTABLE=${wxPrefix}/bin/wx-config`, ...capFlags])
  await run('fastercap-build', ['cmake', '--build', capBuild, '-j', jobs])
  const ngBuild = await fresh('ngspice-build'), ngPrefix = await fresh('ngspice-prefix')
  await run('ngspice-configure', [join(ngSource, 'configure'), `--prefix=${ngPrefix}`, '--without-x', '--with-readline=no', '--disable-openmp', '--disable-debug', '--enable-xspice'], ngBuild)
  await run('ngspice-build', ['make', '-j', jobs], ngBuild)
  await run('ngspice-install', ['make', 'install'], ngBuild)
  for (const name of Object.keys(lock.sources)) await verifyGit(name)
  await verifyArchive('wxWidgets'); await verifyArchive('ngspice')
  const original = await installedArtifacts(join(sourceRoot, 'FastHenry2')), built = await installedArtifacts(fhBuild)
  for (const [path, value] of Object.entries(original)) if (!path.startsWith('.git/') && JSON.stringify(value) !== JSON.stringify(built[path]))
    throw new Error(`FastHenry build modified source: ${path}`)
  const paths = { fasthenry: join(fhBuild, 'bin/fasthenry'), fastercap: join(capBuild, 'FasterCap'), ngspice: join(ngPrefix, 'bin/ngspice') }
  const versions = { compiler: await run('compiler-version', [cc, '--version']), cmake: await run('cmake-version', ['cmake', '--version']),
    wxWidgets: await run('wx-version', [join(wxPrefix, 'bin/wx-config'), '--version']),
    fasthenry: await run('fasthenry-version', [paths.fasthenry, '-h'], tools, false),
    fastercap: await run('fastercap-version', [paths.fastercap], tools, false), ngspice: await run('ngspice-version', [paths.ngspice, '--version']) }
  const binarySha256 = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, sha256(await readFile(path))])))
  await json(join(tools, 'build-receipt.json'), { host: platform(), architecture: arch(), lockSha256: sha256(await readFile(lockPath)),
    sources: lock.sources, unmodifiedSources: true, sourceProvenance: provenance, versions, binarySha256, runtimeRoot: tools,
    runtimeArtifacts: { 'wxwidgets-prefix': await installedArtifacts(wxPrefix), 'ngspice-prefix': await installedArtifacts(ngPrefix) }, commands })
  await json(join(tools, 'tools.json'), paths)
  progress(`Native solvers installed separately: ${tools}`)
  return paths
}
