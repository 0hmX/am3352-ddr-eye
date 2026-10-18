import {command,vendorSource,hashes,json,sha256} from './io.mjs'
import {extractChannel} from './extraction.js'
import {runGeneralPipeline,nativeToolEvidence} from './general-pipeline.js'
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, dirname, join, extname } from 'node:path'
import { fileURLToPath,pathToFileURL } from 'node:url'
import { hostname, platform, arch } from 'node:os'
import { gunzipSync } from 'node:zlib'
import { tsImport } from 'tsx/esm/api'
import { convertIbisComponentToSpice,seconds } from '@tscircuit/ibis-to-spice'
import { geometryFromCircuitJson } from './geometry.js'
import { fail } from './matrices.mjs'
import { simulationSpice, channelSpice } from './spice.js'
import { waveformRows, measureWaveform, foldEye } from './metrics.mjs'
import { useNativeIbis } from './native-ibis.mjs'
import { eyeSimulation, resolveEyeDiagram } from './eyediagram.mjs'
import { projectProvenance } from './project-provenance.mjs'
import { serializeSimulation } from './tsx-render.js'
import { writeViewer } from './viewer.js'
const exec=promisify(execFile),repo=resolve(dirname(fileURLToPath(import.meta.url)),'..')
export {sha256} from './io.mjs'
export {compareRuns} from './comparison.js'
const renderedBoardSummary=circuitJson=>{
  const count=type=>circuitJson.filter(element=>element.type===type).length,errorTypeCounts={}
  for(const element of circuitJson) if(element.type.endsWith('_error')) errorTypeCounts[element.type]=(errorTypeCounts[element.type]??0)+1
  return {sourceComponents:count('source_component'),sourcePorts:count('source_port'),sourceTraces:count('source_trace'),pcbTraces:count('pcb_trace'),smtPads:count('pcb_smtpad'),platedHoles:count('pcb_plated_hole'),vias:count('pcb_via'),boards:circuitJson.filter(element=>element.type==='pcb_board').map(({width,height,num_layers,center})=>({widthMm:width,heightMm:height,layers:num_layers,centerMm:center})),errorTypeCounts,scope:'Records the whole rendered board; successful selected-channel simulation does not resolve unrelated board diagnostics'}
}
export async function loadEntry(path) {
  const absolute=resolve(path),baseDir=dirname(absolute)
  if(/\.(tsx|ts|mjs|js)$/.test(path)) {
    const importedUrls=new Set(['@tscircuit/core','@tscircuit/props','@tscircuit/ibis-to-spice','circuit-json','react','tsx','fflate'].map(name=>import.meta.resolve(name)))
    let tsconfig,search=baseDir
    while(true) {
      const candidate=join(search,'tsconfig.json')
      try {await stat(candidate);tsconfig=candidate;importedUrls.add(pathToFileURL(candidate).href);break} catch(error) {if(error.code!=='ENOENT') throw error}
      const parent=dirname(search);if(parent===search) break;search=parent
    }
    const mod=await tsImport(pathToFileURL(absolute).href,{parentURL:import.meta.url,tsconfig,onImport:url=>importedUrls.add(url)})
    let cj=mod.circuitJson,eyeDiagrams=[]
    if(!cj) {
      const {Circuit}=await import('@tscircuit/core'),c=new Circuit()
      if(!mod.default) fail('tsx_entry','Export default TSX board or circuitJson, plus modeling')
      c.add(typeof mod.default==='function'?mod.default():mod.default)
      await c.renderUntilSettled();cj=serializeSimulation(c)
    }
    if(!mod.modeling) fail('tsx_entry','Export modeling with explicit physical inputs')
    let originalCircuitBytes,circuitPath,originalSourceCircuitJsonSha256
    if(mod.modeling.circuit) {
      circuitPath=resolve(baseDir,mod.modeling.circuit);originalCircuitBytes=await readFile(circuitPath)
      const originalJson=circuitPath.endsWith('.gz')?gunzipSync(originalCircuitBytes):originalCircuitBytes
      originalSourceCircuitJsonSha256=sha256(originalJson)
      if(mod.modeling.fixtureProvenance?.originalJsonSha256&&originalSourceCircuitJsonSha256!==mod.modeling.fixtureProvenance.originalJsonSha256)
        fail('geometry_hash','Original source Circuit JSON differs from pinned provenance')
    }
    const project=await projectProvenance(absolute,importedUrls,circuitPath?[circuitPath]:[])
    return {circuitJson:cj,modeling:mod.modeling,eyeDiagrams,baseDir,entryBytes:await readFile(absolute),entryPath:absolute,originalCircuitBytes,circuitPath,originalSourceCircuitJsonSha256,project}
  }
  const entryBytes=await readFile(absolute),modeling=JSON.parse(entryBytes)
  if(!modeling.circuit) fail('circuit_json','JSON entry needs circuit path to array or gzip array')
  const circuitPath=resolve(baseDir,modeling.circuit),original=await readFile(circuitPath),bytes=circuitPath.endsWith('.gz')?gunzipSync(original):original
  const circuitJson=JSON.parse(bytes)
  if(modeling.fixtureProvenance?.originalJsonSha256&&sha256(bytes)!==modeling.fixtureProvenance.originalJsonSha256) fail('geometry_hash','Original source Circuit JSON differs from pinned provenance')
  return {circuitJson,modeling,baseDir,entryBytes,entryPath:absolute,circuitBytes:bytes,originalCircuitBytes:original,circuitPath,project:await projectProvenance(absolute,[],[circuitPath])}
}
export async function runPipeline({circuitJson,modeling,eyeDiagrams=[],outputDir,tools,baseDir=repo,entryBytes,entryPath,circuitBytes,originalCircuitBytes,circuitPath,originalSourceCircuitJsonSha256,project,vendorCache=join(repo,'.cache/vendors'),onProgress=()=>{}}) {
  if(circuitJson.some(e=>e.type==='simulation_ibis_model')) return runGeneralPipeline({circuitJson,modeling,outputDir,tools,baseDir,entryBytes,entryPath,circuitBytes,originalCircuitBytes,circuitPath,originalSourceCircuitJsonSha256,project,vendorCache,onProgress})
  const out=resolve(outputDir)
  try {await stat(out);fail('output_exists',`Use a fresh output directory for regeneration: ${out}`)} catch(e) {if(e.code!=='ENOENT') throw e}
  modeling=eyeSimulation(modeling,eyeDiagrams)
  const geometry=geometryFromCircuitJson(circuitJson,modeling),eye=resolveEyeDiagram(geometry,modeling,eyeDiagrams)
  const handoff={package:'@tscircuit/ibis-to-spice',source:'same repository workspace; see project dependency and package source hashes'}
  for(const lane of modeling.lanes) {
    const output=modeling.driver?.pins?.[lane.driverPort??lane.port],input=modeling.receiver?.pins?.[lane.receiverPort??lane.port]
    if(output?.mode!=='output'||input?.mode!=='input'||output.stimulus?.type!=='clock') fail('ibis_mapping',`${lane.port}: explicit output clock driver and input receiver required`)
    if(Math.abs(seconds(output.stimulus.period)/(2*modeling.simulation.uiSeconds)-1)>1e-10) fail('clock_ui',`${lane.port}: UI must equal driver clock period/2`)
    if(seconds(output.stimulus.duration)<modeling.simulation.durationSeconds) fail('clock_duration',`${lane.port}: driver stimulus ends before simulation`)
  }
  await mkdir(join(out,'inputs'),{recursive:true})
  await json(join(out,'inputs/modeling.json'),modeling)
  await writeFile(join(out,'inputs/circuit.json'),circuitBytes??JSON.stringify(circuitJson,null,2)+'\n')
  if(originalCircuitBytes) await writeFile(join(out,'inputs/original.circuit'+(circuitPath.endsWith('.gz')?'.json.gz':'.json')),originalCircuitBytes)
  if(entryBytes) await writeFile(join(out,'inputs/entry'+extname(entryPath)),entryBytes)
  if(project) {
    for(const [path,file] of Object.entries(project.files)) {const target=join(out,'inputs/project',path);await mkdir(dirname(target),{recursive:true});await writeFile(target,await readFile(file.path))}
    await json(join(out,'project-provenance.json'),project)
  }
  await json(join(out,'geometry.json'),geometry)
  await json(join(out,'eyediagram.json'),eye)
  const renderedBoard=renderedBoardSummary(circuitJson)
  await json(join(out,'rendered-board.json'),renderedBoard)
  if(!tools) tools=JSON.parse(await readFile(process.env.PCB_SPICE_TOOLS??join(repo,'.cache/tools/tools.json')))
  const toolEvidence=await nativeToolEvidence(tools)
  await json(join(out,'tool-build-receipt.json'),toolEvidence.setup)
  await json(join(out,'tool-evidence.json'),toolEvidence)
  const extracted=await extractChannel(geometry,modeling,out,tools,onProgress)
  onProgress('Load hash-locked original vendor models and call reusable converter')
  if(!Array.isArray(modeling.vendors)||modeling.vendors.length!==2) fail('ibis_mapping','Explicit driver and receiver vendor download locks required')
  const sources=[]
  for(const lock of modeling.vendors) {const s=await vendorSource(lock,vendorCache);sources.push(s);await writeFile(join(out,'inputs',lock.file),s.bytes);await writeFile(join(out,'inputs',`${lock.vendor.replaceAll(' ','-')}.zip`),s.archive)}
  for(const [name,config] of [['driver',modeling.driver],['receiver',modeling.receiver]]) {
    if(!config) fail('ibis_mapping',`${name} configuration required`)
    for(const lane of modeling.lanes) {const port=lane[name==='driver'?'driverPort':'receiverPort']??lane.port;if(!config.pins[port]) fail('ibis_mapping',`${name} lacks ${port}`)}
  }
  let driver=convertIbisComponentToSpice(sources[0].text,modeling.driver),receiver=convertIbisComponentToSpice(sources[1].text,modeling.receiver)
  let nativeEvidence=null
  if(modeling.requireNativeIbis) {
    const nativePackages={source:'same repository workspace; see project dependency hashes'}
    const native=useNativeIbis(circuitJson,geometry,modeling,{driver,receiver})
    driver=native.driver;receiver=native.receiver;nativeEvidence={...native.evidence,packages:nativePackages}
    await json(join(out,'native-ibis-assembly.json'),nativeEvidence)
  }
  await json(join(out,'ibis-conversion.json'),{driver:{spicePinMapping:driver.spicePinMapping,warnings:driver.warnings},receiver:{spicePinMapping:receiver.spicePinMapping,warnings:receiver.warnings},vendors:modeling.vendors})
  await writeFile(join(out,'driver.lib'),driver.source);await writeFile(join(out,'receiver.lib'),receiver.source);await writeFile(join(out,'channel.cir'),channelSpice(extracted,modeling.sections));await writeFile(join(out,'simulation.cir'),simulationSpice(modeling,extracted,driver,receiver))
  onProgress('Run actual native ngspice transient and measure generated samples')
  await command(tools.ngspice,['-n','-b','simulation.cir'],out,'ngspice')
  const rows=waveformRows(await readFile(join(out,'waveform.dat'),'utf8')),metrics=measureWaveform(rows,modeling.simulation,eye),folded=foldEye(rows,metrics,eye)
  await writeFile(join(out,'waveform.csv'),'time_s,driver_p_v,driver_n_v,receiver_p_v,receiver_n_v,receiver_diff_v,driver_diff_v\n'+rows.map(r=>r.join(',')).join('\n')+'\n')
  await json(join(out,'metrics.json'),metrics)
  await writeFile(join(out,'eye-data.csv'),'window,folded_time_s,differential_v\n'+folded.samples.map(r=>r.join(',')).join('\n')+'\n')
  await json(join(out,'eye-data.json'),{name:eye.name,endpoint:eye.endpoint,polarity:eye.polarity,windows:folded.windows,pointsPerWindow:folded.pointsPerWindow,interpolation:'linear interpolation of executed adaptive ngspice samples',source:'waveform.csv',sourceSha256:sha256(await readFile(join(out,'waveform.csv')))})
  await writeViewer(out,[{name:eye.name,directory:'.',probes:[{name:'receiver_diff',simulationVoltageProbeId:'receiver_diff',column:5}],eyes:[{name:eye.name,simulationVoltageProbeId:'receiver_diff',unitIntervalSeconds:modeling.simulation.uiSeconds,windowOriginsSeconds:folded.windowOriginsSeconds??[]}]}],geometry.approximations)
  let gitCommit=null,sourceTreeDirty=null
  try {if(resolve((await exec('git',['rev-parse','--show-toplevel'],{cwd:repo})).stdout.trim())===repo) {gitCommit=(await exec('git',['rev-parse','HEAD'],{cwd:repo})).stdout.trim();sourceTreeDirty=Boolean((await exec('git',['status','--porcelain'],{cwd:repo})).stdout.trim())}} catch {}
  const sourceRoots=['.gitignore','.github','LICENSE','README.md','examples','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','scripts','src','tests','toolchain-lock.json','tsconfig.json','vendor']
  const sourceFiles=await hashes(repo,'',(await readdir(repo)).filter(name=>!sourceRoots.includes(name)))
  const receipt={schemaVersion:2,status:'executed',execution:{host:hostname(),platform:platform(),architecture:arch(),nativeLocalMac:platform()==='darwin',timestampUtc:new Date().toISOString(),node:process.version,gitCommit,sourceTreeDirty,solverResultCache:false},sourceFiles,project:project??null,entryPath:entryPath??null,description:modeling.description,sourceCircuitJsonSha256:sha256(circuitBytes??JSON.stringify(circuitJson,null,2)+'\n'),originalSourceCircuitJsonSha256:originalSourceCircuitJsonSha256??(originalCircuitBytes?sha256(circuitPath.endsWith('.gz')?gunzipSync(originalCircuitBytes):originalCircuitBytes):null),originalSourceArchiveSha256:originalCircuitBytes?sha256(originalCircuitBytes):null,fixtureProvenance:modeling.fixtureProvenance??null,sourceProvenance:modeling.sourceProvenance??null,preSolvedAssessment:modeling.sourceProvenance?.preSolvedAssessment??null,renderedBoard,converter:handoff,nativeIbis:nativeEvidence,eyeDiagram:eye,toolEvidence,matrices:extracted.map(e=>({stage:e.stage,R:e.R,L:e.L,C:e.C,units:e.units})),metrics,limitations:[...geometry.approximations,...driver.warnings,...receiver.warnings,'TI Model_655/847 and Winbond ODT_60 are explicit demonstration IO settings, not known board firmware','This reduced channel is not full-board EM extraction or independent silicon validation'],files:await hashes(out)}
  await json(join(out,'receipt.json'),receipt)
  return receipt
}
