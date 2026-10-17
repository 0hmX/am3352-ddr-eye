import {access,readFile} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

export const packageRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const exists=async path=>{try {await access(path);return true}catch{return false}}
export const cacheRoot=(projectDir=process.cwd())=>resolve(process.env.PCB_SPICE_CACHE??join(projectDir,'node_modules/.cache/pcb-spice-pipeline'))
export async function runtimePaths({projectDir=process.cwd()}={}) {
  const cache=cacheRoot(projectDir),config=resolve(process.env.PCB_SPICE_TOOLS??join(cache,'tools/tools.json'))
  if(!await exists(config)) throw new Error('Native solvers are not installed. Run pcb-spice-pipeline --setup before simulating. External programs are downloaded and built separately; they are not bundled.')
  const tools={...JSON.parse(await readFile(config)),configPath:config}
  for(const name of ['fasthenry','fastercap','ngspice']) if(typeof tools[name]!=='string'||!await exists(tools[name]))
    throw new Error(`Installed native solver ${name} is missing. Run pcb-spice-pipeline --setup again.`)
  return {tools,vendorCache:join(cache,'vendors')}
}
export async function setupRuntime({toolsDir=join(cacheRoot(),'tools'),installDependencies=false}={}) {
  const {setupTools}=await import('./setup.js')
  return setupTools(toolsDir,installDependencies)
}
