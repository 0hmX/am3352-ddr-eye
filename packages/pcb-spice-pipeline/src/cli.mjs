#!/usr/bin/env node
import { resolve } from 'node:path'
import { loadEntry,runPipeline } from './pipeline.mjs'
import { runtimePaths,setupRuntime } from './runtime.mjs'
import { repeatEntry } from './repeat.mjs'
const args=process.argv.slice(2),usage='Usage: pcb-spice-pipeline [--repeat] ENTRY.tsx|ENTRY.json [--out FRESH_DIRECTORY]\n       pcb-spice-pipeline --setup'
try {
  if(args.includes('--help')) {console.log(usage);process.exit(0)}
  if(args.includes('--setup')) {
    if(args.length!==1) throw new Error('--setup takes no entry or output arguments')
    await setupRuntime()
  } else {
    const positional=[];let output,repeat=false
    for(let i=0;i<args.length;i++) {
      if(args[i]==='--out') {output=args[++i];if(!output) throw new Error('--out requires a fresh directory')}
      else if(args[i]==='--repeat') repeat=true
      else if(args[i].startsWith('--')) throw new Error(`Unknown option: ${args[i]}`)
      else positional.push(args[i])
    }
    if(positional.length!==1) throw new Error(usage)
    const entry=positional[0],out=resolve(output??`dist/simulation-${Date.now()}`)
    if(repeat) {await runtimePaths();await repeatEntry(entry,out);console.log(`Repeatability passed: ${resolve(out,'repeatability.json')}`)}
    else {const receipt=await runPipeline({...await loadEntry(entry),...await runtimePaths(),outputDir:out,onProgress:console.log});console.log(JSON.stringify({receipt:resolve(out,'receipt.json'),metrics:receipt.metrics,experiments:receipt.experiments?.map(run=>({name:run.name,solverInvocations:run.solverInvocations,eyes:run.eyes.map(eye=>({name:eye.name,windows:eye.windows,directory:eye.directory}))}))},null,2))}
  }
}
catch(e) {console.error(e.message);process.exitCode=1}
