import {spawn} from 'node:child_process'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {packageRoot} from './runtime.mjs'
const {compareFreshRuns}=await import(pathToFileURL(join(packageRoot,'scripts/audit-eye.mjs')).href)

async function freshRun(entry,out,proofRoot) {
  const executable=process.execPath,args=[fileURLToPath(new URL('./cli.mjs',import.meta.url)),entry,'--out',out]
  const start=Date.now(),logs={stdout:'',stderr:''}
  const code=await new Promise((done,reject)=>{
    const child=spawn(executable,args,{cwd:process.cwd(),env:process.env,stdio:['inherit','pipe','pipe']})
    for(const kind of ['stdout','stderr']) child[kind].on('data',data=>{logs[kind]+=data;process[kind].write(data)})
    child.on('error',reject);child.on('exit',done)
  })
  const label=out.endsWith('run-a')?'run-a':'run-b'
  for(const kind of ['stdout','stderr']) await writeFile(join(proofRoot,`${label}.${kind}.log`),logs[kind])
  const command={executable,args,cwd:process.cwd(),exitCode:code,elapsedMs:Date.now()-start}
  await writeFile(join(proofRoot,`${label}.command.json`),JSON.stringify(command,null,2)+'\n')
  if(code!==0) throw new Error(`Fresh repetition ${label} failed (${code}); see ${proofRoot}`)
  return command
}
export async function repeatEntry(entry,output) {
  const out=resolve(output)
  await mkdir(dirname(out),{recursive:true});await mkdir(out)
  const a=join(out,'run-a'),b=join(out,'run-b'),commands=[]
  for(const path of [a,b]) commands.push(await freshRun(resolve(entry),path,out))
  const comparison=await compareFreshRuns(a,b)
  const receipts=[]
  for(const path of [a,b]) receipts.push(JSON.parse(await readFile(join(path,'receipt.json'))))
  if(receipts.some(receipt=>receipt.execution.solverResultCache!==false)) throw new Error('Fresh solver cache policy missing')
  const summary={status:'passed',entry:resolve(entry),solverResultsReused:false,commands,comparison,metrics:receipts[0].metrics,experiments:receipts[0].experiments?.map(run=>({simulationExperimentId:run.simulationExperimentId,name:run.name,solverInvocations:run.solverInvocations,waveformSamples:run.waveformSamples,eyes:run.eyes.map(eye=>({simulationEyeDiagramId:eye.simulationEyeDiagramId,simulationVoltageProbeId:eye.simulationVoltageProbeId,windows:eye.windows,timeOriginSeconds:eye.timeOriginSeconds}))}))}
  await writeFile(join(out,'repeatability.json'),JSON.stringify(summary,null,2)+'\n')
  return summary
}
