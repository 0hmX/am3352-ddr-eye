import {access,mkdir,readFile,writeFile} from 'node:fs/promises'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'

export const packageRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const exists=async path=>{try {await access(path);return true}catch{return false}}
const cacheRoot=(projectDir=process.cwd())=>resolve(process.env.PCB_SPICE_CACHE??join(projectDir,'node_modules/.cache/pcb-spice-pipeline'))
export async function runtimePaths({projectDir=process.cwd()}={}) {
  const cache=cacheRoot(projectDir),localTools=join(cache,'tools/tools.json'),legacyTools=join(packageRoot,'.cache/tools/tools.json')
  const config=process.env.PCB_SPICE_TOOLS??(await exists(localTools)?localTools:legacyTools)
  const localPython=join(cache,'python/bin/python3'),legacyPython=join(packageRoot,'.venv/bin/python3')
  const python=process.env.PCB_SPICE_PYTHON??(await exists(localPython)?localPython:legacyPython)
  if(!await exists(config)||!await exists(python)) throw new Error('Native simulation runtime is missing. Run pcb-spice-pipeline --setup first.')
  return {tools:{...JSON.parse(await readFile(config)),configPath:resolve(config)},python,vendorCache:join(cache,'vendors')}
}

async function liveCommand(executable,args,env=process.env) {
  const start=Date.now()
  const code=await new Promise((done,reject)=>{
    const child=spawn(executable,args,{cwd:process.cwd(),env,stdio:'inherit'})
    child.on('error',reject);child.on('exit',done)
  })
  if(code!==0) throw new Error(`Setup command failed (${code}): ${executable} ${args.join(' ')}`)
  return {executable,args,cwd:process.cwd(),exitCode:code,elapsedMs:Date.now()-start}
}
export async function setupRuntime() {
  const cache=cacheRoot(),python=process.env.PCB_SPICE_BOOTSTRAP_PYTHON??'python3.11'
  const env={...process.env,PATH:`/opt/homebrew/bin:/usr/local/bin:${process.env.PATH??''}`}
  let version
  try {version=(await promisify(execFile)(python,['-c','import sys; assert sys.version_info[:2] == (3, 11), "Python 3.11 required"; print(sys.version)'],{env})).stdout.trim()}
  catch {throw new Error('Setup requires Python 3.11. Install python3.11 or set PCB_SPICE_BOOTSTRAP_PYTHON to its executable.')}
  await mkdir(cache,{recursive:true})
  const commands=[]
  commands.push(await liveCommand(python,[join(packageRoot,'scripts/setup-tools.py'),'--tools-dir',join(cache,'tools'),'--install-deps'],env))
  const venv=join(cache,'python'),venvPython=join(venv,'bin/python3')
  if(!await exists(venvPython)) commands.push(await liveCommand(python,['-m','venv',venv],env))
  commands.push(await liveCommand(venvPython,['-m','pip','install','-r',join(packageRoot,'requirements.lock.txt')],env))
  const hashes={}
  for(const name of ['requirements.lock.txt','toolchain-lock.json']) hashes[name]=createHash('sha256').update(await readFile(join(packageRoot,name))).digest('hex')
  await writeFile(join(cache,'setup-receipt.json'),JSON.stringify({status:'ready',packageRoot,cacheRoot:cache,python:version,hashes,commands},null,2)+'\n')
  console.log(`Native simulation runtime ready: ${cache}`)
}
