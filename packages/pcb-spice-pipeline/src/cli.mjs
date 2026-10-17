#!/usr/bin/env node
import { resolve } from 'node:path'
import { loadEntry,runPipeline } from './pipeline.mjs'
import { runtimePaths,setupRuntime } from './runtime.mjs'
import { repeatEntry } from './repeat.mjs'
import { compareRuns } from './comparison.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { nativeToolEvidence } from './general-pipeline.js'
const args=process.argv.slice(2),usage='Usage: pcb-spice-pipeline [--repeat] ENTRY.tsx|ENTRY.json [--out FRESH_DIRECTORY] [--open]\n       pcb-spice-pipeline --compare RUN_DIRECTORY... --probe PROBE_NAME [--out FRESH_DIRECTORY] [--open]\n       pcb-spice-pipeline --setup [--tools-dir DIRECTORY] [--install-deps]\n       pcb-spice-pipeline --check-tools'
const openResults=async path=>promisify(execFile)(process.platform==='darwin'?'open':'xdg-open',[path])
try {
  if(args.includes('--help')) {console.log(usage);process.exit(0)}
  if(args.includes('--setup')) {
    let toolsDir,installDependencies=false
    for(let i=0;i<args.length;i++) {
      if(args[i]==='--setup') continue
      if(args[i]==='--install-deps') installDependencies=true
      else if(args[i]==='--tools-dir'&&args[i+1]) toolsDir=resolve(args[++i])
      else throw new Error(usage)
    }
    await setupRuntime({toolsDir,installDependencies})
  } else if(args.includes('--check-tools')) {
    if(args.length!==1) throw new Error(usage)
    const {tools}=await runtimePaths()
    const evidence=await nativeToolEvidence(tools)
    console.log(JSON.stringify({status:'ready',tools,versions:evidence.setup.versions},null,2))
  } else {
    const positional=[];let output,repeat=false,compare=false,probeName,open=false
    for(let i=0;i<args.length;i++) {
      if(args[i]==='--out') {output=args[++i];if(!output) throw new Error('--out requires a fresh directory')}
      else if(args[i]==='--repeat') repeat=true
      else if(args[i]==='--compare') compare=true
      else if(args[i]==='--open') open=true
      else if(args[i]==='--probe') {probeName=args[++i];if(!probeName) throw new Error('--probe requires a probe name')}
      else if(args[i].startsWith('--')) throw new Error(`Unknown option: ${args[i]}`)
      else positional.push(args[i])
    }
    if(compare) {
      if(repeat||!probeName||!positional.length) throw new Error(usage)
      const outputDir=resolve(output??`dist/comparison-${Date.now()}`)
      await compareRuns({directories:positional,outputDir,probeName})
      console.log(`Interactive comparison: ${resolve(outputDir,'results.html')}`)
      if(open) await openResults(resolve(outputDir,'results.html'))
      process.exit(0)
    }
    if(positional.length!==1||probeName) throw new Error(usage)
    const entry=positional[0],out=resolve(output??`dist/simulation-${Date.now()}`)
    if(repeat) {await runtimePaths();await repeatEntry(entry,out);console.log(`Repeatability passed: ${resolve(out,'repeatability.json')}`)}
    else {const runtime=await runtimePaths();const receipt=await runPipeline({...await loadEntry(entry),...runtime,outputDir:out,onProgress:console.log});console.log(JSON.stringify({results:resolve(out,'results.html'),receipt:resolve(out,'receipt.json'),metrics:receipt.metrics,experiments:receipt.experiments?.map(run=>({name:run.name,solverInvocations:run.solverInvocations,eyes:run.eyes.map(eye=>({name:eye.name,windows:eye.windows,directory:eye.directory}))}))},null,2));if(open) await openResults(resolve(out,'results.html'))}
  }
}
catch(e) {console.error(e.message);process.exitCode=1}
