import {readFile,writeFile,mkdir,readdir,stat,realpath} from 'node:fs/promises'
import {resolve,dirname,join,extname,isAbsolute,relative} from 'node:path'
import {fileURLToPath} from 'node:url'
import {hostname,platform,arch} from 'node:os'
import {gunzipSync} from 'node:zlib'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import * as converter from '@tscircuit/ibis-to-spice'
import type {CircuitJson,SimulationIbisModel} from './schema.js'
import {parseRecord} from './schema.js'
import {geometryFromCircuitJson} from './geometry.js'
import {generalDeclarations,modelRunDefinition} from './declarations.js'
import {electricalSources,generalSimulationSpice,validateProbeScope} from './general-spice.js'
import {channelSpice} from './spice.js'
import {extractChannel} from './extraction.js'
import {probeWaveformRows,foldProbeEye} from './metrics.mjs'
import {command,json,sha256,hashes} from './io.mjs'
import {fail} from './matrices.mjs'
import {downloadIbisAsset,type AssetFetchOptions} from './asset-download.js'
import {packageRoot} from './runtime.mjs'
import {installedArtifacts} from './setup.js'
import {writeViewer} from './viewer.js'
import {validateCircuitRecords} from './circuit-schema.mjs'
import type {Modeling} from './geometry.js'

export interface PipelineProject {
  root: string
  entry: string
  files: Record<string, {path: string; sha256: string}>
  dependencyFiles: Record<string, string>
  scope: string
}

type PipelineModeling = Modeling & {
  ibisModelAssetSha256?: Record<string, string>
  fixtureProvenance?: unknown
  sourceProvenance?: {preSolvedAssessment?: unknown; [key: string]: unknown}
}
type NativeTools = Parameters<typeof extractChannel>[3] & {configPath?: string; ngspice: string}

export interface GeneralPipelineOptions {
  circuitJson: CircuitJson
  modeling: PipelineModeling
  outputDir: string
  tools?: NativeTools
  baseDir?: string
  entryBytes?: Uint8Array
  entryPath?: string
  circuitBytes?: Uint8Array
  originalCircuitBytes?: Uint8Array
  circuitPath?: string
  originalSourceCircuitJsonSha256?: string
  project?: PipelineProject
  vendorCache?: string
  assetFetch?: AssetFetchOptions
  onProgress?: (message: string) => void
}

const missingFile = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'

const exec=promisify(execFile)
const safeId=(id: string): string=>{
  if(typeof id!=='string'||!/^[a-zA-Z0-9_-]+$/.test(id)) fail('simulation_id','Serialized simulation IDs must be safe stable identifiers')
  return id
}
export async function loadModelSource(model: Pick<SimulationIbisModel,'ibis_model_asset'> & {pipelineId: string},baseDir: string,cache: string,fetchOptions: AssetFetchOptions={}) {
  const asset=model.ibis_model_asset,path=asset.project_relative_path
  const parts=path.split(/[\\/]/)
  if(!path||isAbsolute(path)||path.startsWith('\\')||/^[a-z]:/i.test(path)||parts.includes('..')) fail('ibis_asset_path','IBIS project_relative_path must stay inside the circuit project')
  const root=await realpath(baseDir),localPath=resolve(root,...parts)
  let bytes: Buffer | undefined,resolvedPath: string | undefined,resolvedFrom: 'project' | 'url'='project'
  try {
    resolvedPath=await realpath(localPath)
    const location=relative(root,resolvedPath)
    if(location==='..'||location.startsWith('../')||isAbsolute(location)) fail('ibis_asset_path','IBIS asset symlink must stay inside the circuit project')
    bytes=await readFile(resolvedPath)
  } catch(error) {if(!missingFile(error)) throw error}
  if(!bytes) {
    if(!/^https?:\/\//i.test(asset.url)) fail('ibis_asset_missing',`IBIS asset not found at ${path}; provide the file or an HTTP(S) IBIS URL. For repository examples, run pnpm simulate:models`)
    bytes=await downloadIbisAsset(asset.url,fetchOptions);resolvedFrom='url';resolvedPath=undefined
  }
  if(bytes.length>64*1024*1024) fail('ibis_asset','IBIS asset exceeds 64 MiB')
  if(bytes[0]===0x50&&bytes[1]===0x4b) fail('ibis_asset','IBIS asset must be a plain .ibs file; extract ZIP archives before declaring ibisModelAsset')
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)
  if(/^\s*(?:<!doctype\s+html|<html)\b/i.test(text)) fail('ibis_asset','IBIS asset contains HTML instead of model data')
  const id=safeId(model.pipelineId),sourceSha256=sha256(bytes),ibsFile=`inputs/ibis/${id}.ibs`
  if(resolvedFrom==='url') {await mkdir(cache,{recursive:true});await writeFile(join(cache,sourceSha256+'.ibs'),bytes)}
  return {text,bytes,evidence:{simulationIbisModelId:id,ibisModelAsset:asset,resolvedFrom,resolvedPath,ibsFile,sourceSha256,rawSourceFile:ibsFile,rawSourceSha256:sourceSha256}}
}

/** Verify binaries and installed dependencies from the pristine pinned build. */
export async function nativeToolEvidence(tools: NativeTools) {
  for(const name of ['SPICE_LIB_DIR','SPICE_SCRIPTS','DYLD_LIBRARY_PATH','DYLD_INSERT_LIBRARIES','LD_LIBRARY_PATH','LD_PRELOAD']) if(process.env[name]) fail('solver_provenance',`Unset ${name} so native solvers use their verified installed runtime`)
  const executableEvidence=async (path: string)=>{
    const executable=resolve(path)
    return {executable,sha256:sha256(await readFile(executable)),host:hostname(),platform:platform(),architecture:arch()}
  }
  const [fasthenry,fastercap,ngspice]=await Promise.all([tools.fasthenry,tools.fastercap,tools.ngspice].map(executableEvidence))
  const receiptPath=join(dirname(tools.configPath??join(packageRoot,'.cache/tools/tools.json')),'build-receipt.json')
  let setup: unknown
  try {setup=JSON.parse(await readFile(receiptPath,'utf8'))} catch(error) {
    if(!missingFile(error)&&!(error instanceof SyntaxError)) throw error
    fail('solver_provenance',`Missing or invalid native build receipt at ${receiptPath}; run pcb-spice-pipeline --setup`)
  }
  const record=(value: unknown): value is Record<string, unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)
  if(!record(setup)||setup.unmodifiedSources!==true||!record(setup.binarySha256)) fail('solver_provenance','A verified unmodified upstream solver build is required; run pcb-spice-pipeline --setup')
  if(setup.lockSha256!==sha256(await readFile(join(packageRoot,'toolchain-lock.json')))) fail('solver_provenance','Native build receipt does not match the pinned toolchain; run pcb-spice-pipeline --setup')
  const evidence={fasthenry,fastercap,ngspice}
  for(const name of ['fasthenry','fastercap','ngspice'] as const) if(evidence[name].sha256!==setup.binarySha256[name]) fail('solver_provenance',`${name} executable does not match the unmodified build receipt; run pcb-spice-pipeline --setup`)
  if(typeof setup.runtimeRoot!=='string'||!isAbsolute(setup.runtimeRoot)||!record(setup.runtimeArtifacts)) fail('solver_provenance','Native build receipt must record installed runtime artifacts; run pcb-spice-pipeline --setup')
  const prefixes=['wxwidgets-prefix','ngspice-prefix']
  if(Object.keys(setup.runtimeArtifacts).length!==prefixes.length) fail('solver_provenance','Native build receipt has unexpected runtime prefixes; run pcb-spice-pipeline --setup')
  for(const prefix of prefixes) {
    const expected=setup.runtimeArtifacts[prefix]
    if(!record(expected)||!Object.keys(expected).length) fail('solver_provenance',`${prefix}: missing runtime artifact manifest; run pcb-spice-pipeline --setup`)
    let actual: Awaited<ReturnType<typeof installedArtifacts>>
    try {actual=await installedArtifacts(join(setup.runtimeRoot,prefix))} catch(error) {
      fail('solver_provenance',`${prefix}: invalid installed runtime artifacts (${error instanceof Error?error.message:String(error)}); run pcb-spice-pipeline --setup`)
    }
    if(Object.keys(actual).length!==Object.keys(expected).length||Object.entries(actual).some(([path,value])=>JSON.stringify(value)!==JSON.stringify(expected[path]))) fail('solver_provenance',`${prefix}: installed runtime artifacts differ from the build receipt; run pcb-spice-pipeline --setup`)
  }
  return {...evidence,setup}
}

export async function runGeneralPipeline({circuitJson,modeling,outputDir,tools,baseDir=process.cwd(),entryBytes,entryPath,circuitBytes,originalCircuitBytes,circuitPath,originalSourceCircuitJsonSha256,project,vendorCache=join(packageRoot,'.cache/vendors'),assetFetch,onProgress=()=>{}}: GeneralPipelineOptions) {
  const out=resolve(outputDir)
  try {await stat(out);fail('output_exists',`Use a fresh output directory: ${out}`)} catch(error) {if(!missingFile(error)) throw error}
  validateCircuitRecords(circuitJson)
  const roots=['dist','LICENSE','package.json','scripts','src','tests','toolchain-lock.json','tsconfig.json']
  const sourceExclusions=(await readdir(packageRoot)).filter(name=>!roots.includes(name))
  const sourceFiles=await hashes(packageRoot,'',sourceExclusions)
  if(typeof converter.convertIbisModelToSpice!=='function') fail('converter_version','Install/build the same-repository general IBIS converter')
  const geometry=geometryFromCircuitJson(circuitJson,modeling),declarations=generalDeclarations(circuitJson,geometry,modeling)
  const electrical=electricalSources(circuitJson,modeling,declarations.nodes)
  for(const plan of declarations.plans) {safeId(plan.simulationExperimentId);for(const eye of plan.eyes) safeId(eye.simulationEyeDiagramId)}
  // Validate every source, buffer state and observation before spending solver work.
  const expectedHashes=modeling.ibisModelAssetSha256
  if(expectedHashes!==undefined&&(!expectedHashes||typeof expectedHashes!=='object'||Array.isArray(expectedHashes))) fail('vendor_hash','modeling.ibisModelAssetSha256 must map project-relative IBIS asset paths to SHA-256 hashes')
  const loaded: Awaited<ReturnType<typeof loadModelSource>>[]=[]
  for(const model of declarations.models) {
    const path=model.ibis_model_asset.project_relative_path
    let expected: string | undefined
    if(expectedHashes!==undefined) {
      expected=expectedHashes[path]
      if(typeof expected!=='string'||!/^[a-f0-9]{64}$/i.test(expected)) fail('vendor_hash',`${path}: modeling.ibisModelAssetSha256 requires an expected 64-digit SHA-256 hash for each used IBIS asset`)
    }
    const source=await loadModelSource(model,project?.root??baseDir,vendorCache,assetFetch)
    if(expected!==undefined&&source.evidence.sourceSha256!==expected.toLowerCase()) fail('vendor_hash',`${path}: IBIS asset bytes differ from modeling.ibisModelAssetSha256`)
    loaded.push(source)
  }
  const compiled=declarations.plans.map(plan=>plan.models.map(model=>{
    const index=declarations.models.findIndex(selected=>selected.pipelineId===model.pipelineId)
    const input=modelRunDefinition(model,plan),source=loaded[index]
    input.definition.source={file:source.evidence.ibsFile,sha256:source.evidence.sourceSha256}
    const result=converter.convertIbisModelToSpice(source.bytes,input.definition,input.run)
    return {...result,name:model.ibis_component_name,pipelineId:model.pipelineId,input,sourceEvidence:loaded[index].evidence}
  }))
  for(const [i,plan] of declarations.plans.entries()) validateProbeScope(plan,geometry,compiled[i],declarations.nodes,electrical)
  if(!tools) fail('native_runtime','Pass installed native runtime tools; run pcb-spice-pipeline --setup')
  const toolEvidence=await nativeToolEvidence(tools)
  await mkdir(join(out,'inputs'),{recursive:true})
  await mkdir(join(out,'inputs/ibis'))
  for(const source of loaded) await writeFile(join(out,source.evidence.ibsFile),source.bytes)
  await json(join(out,'inputs/modeling.json'),modeling)
  const inputCircuitBytes=circuitBytes??Buffer.from(JSON.stringify(circuitJson,null,2)+'\n')
  await writeFile(join(out,'inputs/circuit.json'),inputCircuitBytes)
  if(originalCircuitBytes) await writeFile(join(out,'inputs/original.circuit'+(circuitPath?.endsWith('.gz')?'.json.gz':'.json')),originalCircuitBytes)
  if(entryBytes) {if(!entryPath) fail('entry_provenance','Entry bytes require their source path');await writeFile(join(out,'inputs/entry'+extname(entryPath)),entryBytes)}
  if(project) {
    for(const [path,file] of Object.entries(project.files)) {const target=join(out,'inputs/project',path);await mkdir(dirname(target),{recursive:true});await writeFile(target,await readFile(file.path))}
    await json(join(out,'project-provenance.json'),project)
  }
  await json(join(out,'geometry.json'),geometry)
  await json(join(out,'electrical-node-map.json'),{nodes:declarations.nodes.mapping,channelReferenceSourcePortId:declarations.nodes.groundSourcePortId,scope:electrical.scope})
  await json(join(out,'vendor-sources.json'),loaded.map(source=>source.evidence))
  const converterEntry=fileURLToPath(import.meta.resolve('@tscircuit/ibis-to-spice'))
  let converterRoot=dirname(converterEntry)
  while(true) {
    try {await stat(join(converterRoot,'package.json'));break} catch(error) {if(!missingFile(error)) throw error}
    const parent=dirname(converterRoot);if(parent===converterRoot) fail('converter_provenance','Cannot locate executed converter package manifest');converterRoot=parent
  }
  const converterEvidence={sourceRoot:converterRoot,entry:converterEntry,version:JSON.parse(await readFile(join(converterRoot,'package.json'),'utf8')).version,files:await hashes(converterRoot,'',(await readdir(converterRoot)).filter(name=>!['dist','package.json'].includes(name)))}
  await json(join(out,'converter-runtime.json'),converterEvidence)
  await json(join(out,'tool-build-receipt.json'),toolEvidence.setup)
  await json(join(out,'tool-evidence.json'),toolEvidence)
  const extracted=await extractChannel(geometry,modeling,out,tools,onProgress)
  await writeFile(join(out,'channel.cir'),channelSpice(extracted,modeling.sections))
  const results=[...circuitJson],experiments=[]
  for(const [index,plan] of declarations.plans.entries()) {
    const relative=join('experiments',plan.simulationExperimentId),dir=join(out,relative)
    await mkdir(dir,{recursive:true})
    const models=compiled[index],assembly=[]
    for(const model of models) {
      await writeFile(join(dir,`${safeId(model.pipelineId)}.lib`),model.source)
      assembly.push({simulationIbisModelId:model.pipelineId,definition:model.input.definition,run:model.input.run,spicePinMapping:model.spicePinMapping,sourceSha256:model.sourceSha256,spiceSha256:sha256(model.source),sourceEvidence:model.sourceEvidence,metadata:model.metadata,warnings:model.warnings})
    }
    await json(join(dir,'native-ibis-assembly.json'),assembly)
    await json(join(dir,'experiment.json'),plan)
    await writeFile(join(dir,'simulation.cir'),generalSimulationSpice(plan,geometry,modeling,extracted,models,declarations.nodes,electrical))
    onProgress(`Execute ONE native ngspice transient for ${plan.name} (${plan.probes.length} probes, ${plan.eyes.length} eyes)`)
    await command(tools.ngspice,['-n','-b','simulation.cir'],dir,'ngspice')
    let waveformText
    try {waveformText=await readFile(join(dir,'waveform.dat'),'utf8')} catch(error) {
      if(!missingFile(error)) throw error
      fail('native_waveform',`${plan.name}: ngspice exited without waveform.dat; inspect ${join(dir,'ngspice.stderr.log')} and stdout for a singular matrix or aborted transient`)
    }
    const rows: number[][]=probeWaveformRows(waveformText,plan.probes)
    if(Math.abs(rows[rows.length-1][0]-plan.durationSeconds)>plan.durationSeconds*1e-8) fail('simulation_duration',`${plan.name}: native solver did not complete the declared duration`)
    await writeFile(join(dir,'waveform.csv'),'time_s,'+plan.probes.map(probe=>probe.simulationVoltageProbeId+'_v').join(',')+'\n'+rows.map(row=>row.join(',')).join('\n')+'\n')
    await json(join(dir,'waveform.json'),{simulationExperimentId:plan.simulationExperimentId,probes:plan.probes,samples:rows.length,timestamps:'actual adaptive solver times in seconds',source:'waveform.dat',sourceSha256:sha256(await readFile(join(dir,'waveform.dat')))})
    const eyes=[]
    for(const eye of plan.eyes) {
      const relativeEye=join('eyes',eye.simulationEyeDiagramId),eyeDir=join(dir,relativeEye),folded=foldProbeEye(rows,eye)
      await mkdir(eyeDir,{recursive:true})
      await writeFile(join(eyeDir,'eye-data.csv'),'window,folded_time_s,time_s,voltage_v\n'+folded.samples.map((row: number[])=>row.join(',')).join('\n')+'\n')
      const descriptor={...eye,directory:relativeEye,windows:folded.windows,pointsPerWindow:folded.pointsPerWindow,windowOriginsSeconds:folded.windowOriginsSeconds,boundaryIndices:folded.boundaryIndices,interpolation:'linear interpolation of actual adaptive solver timestamps',windowDefinition:'b_k=timeOrigin+k*UI; [b_k-UI/2,b_k+3*UI/2]; complete windows only',source:'../../waveform.csv',sourceSha256:sha256(await readFile(join(dir,'waveform.csv'))),metrics:folded.metrics}
      await json(join(eyeDir,'eye-data.json'),descriptor);eyes.push(descriptor)
    }
    await json(join(dir,'eyes.json'),eyes)
    for(const probe of plan.probes) results.push(parseRecord({type:'simulation_transient_voltage_graph',simulation_transient_voltage_graph_id:`simulation_transient_voltage_graph_${plan.simulationExperimentId}_${probe.column}`,simulation_experiment_id:plan.simulationExperimentId,simulation_voltage_probe_id:probe.simulationVoltageProbeId,timestamps_ms:rows.map(row=>row[0]*1000),voltage_levels:rows.map(row=>row[probe.column]),time_per_step:plan.maxStepSeconds*1000,start_time_ms:rows[0][0]*1000,end_time_ms:rows[rows.length-1][0]*1000,name:probe.name}))
    experiments.push({simulationExperimentId:plan.simulationExperimentId,name:plan.name,directory:relative,durationSeconds:plan.durationSeconds,startTimeSeconds:plan.startTimeSeconds,maxStepSeconds:plan.maxStepSeconds,probes:plan.probes,eyes,solverInvocations:1,waveformSamples:rows.length,assembly:join(relative,'native-ibis-assembly.json')})
  }
  // Registered validation prevents result probe associations from disappearing.
  const canonical=results.map(record=>parseRecord(record))
  const pcbExperimentIds=new Set(declarations.plans.map(plan=>plan.simulationExperimentId))
  for(const graph of canonical.filter(record=>record.type==='simulation_transient_voltage_graph')) if(pcbExperimentIds.has(graph.simulation_experiment_id)&&!graph.simulation_voltage_probe_id) fail('result_schema','Installed Circuit JSON schema discarded the result probe ID')
  await json(join(out,'circuit-results.json'),canonical)
  const limitations=[...geometry.approximations,...compiled.flatMap(models=>models.flatMap(model=>model.warnings??[])),
    'Only selected channel components/passives and explicit ideal source rails are simulated; unrelated board electronics excluded',
    'Finite observed transient eyes; no implicit traffic, random jitter, BER extrapolation, protocol compliance or hardware accuracy claim',
    'Maximum solver integration step and display resolution are separate settings']
  await writeViewer(out,experiments,limitations)
  let gitCommit: string | null=null,sourceTreeDirty: boolean | null=null
  try {gitCommit=(await exec('git',['rev-parse','HEAD'],{cwd:packageRoot})).stdout.trim();sourceTreeDirty=Boolean((await exec('git',['status','--porcelain'],{cwd:packageRoot})).stdout.trim())} catch {}
  if(JSON.stringify(await hashes(packageRoot,'',sourceExclusions))!==JSON.stringify(sourceFiles)) fail('source_changed','Pipeline source changed during this solve; rerun into a fresh directory after editing is complete')
  if(JSON.stringify(await nativeToolEvidence(tools))!==JSON.stringify(toolEvidence)) fail('tool_changed','Native toolchain evidence changed during this solve')
  const renderedBoard={sourceComponents:circuitJson.filter(e=>e.type==='source_component').length,pcbTraces:circuitJson.filter(e=>e.type==='pcb_trace').length,smtPads:circuitJson.filter(e=>e.type==='pcb_smtpad').length,vias:circuitJson.filter(e=>e.type==='pcb_via').length,platedHoles:circuitJson.filter(e=>e.type==='pcb_plated_hole').length,boards:circuitJson.filter(e=>e.type==='pcb_board').map(({width,height,num_layers,center})=>({widthMm:width,heightMm:height,layers:num_layers,centerMm:center})),errorTypeCounts:{} as Record<string, number>}
  for(const record of circuitJson.filter(e=>e.type.endsWith('_error'))) renderedBoard.errorTypeCounts[record.type]=(renderedBoard.errorTypeCounts[record.type]??0)+1
  const receipt={schemaVersion:3,status:'executed',description:modeling.description,execution:{host:hostname(),platform:platform(),architecture:arch(),nativeLocalMac:platform()==='darwin',timestampUtc:new Date().toISOString(),node:process.version,gitCommit,sourceTreeDirty,solverResultCache:false},sourceRoot:packageRoot,sourceFiles,project:project??null,entryPath:entryPath??null,sourceCircuitJsonSha256:sha256(inputCircuitBytes),originalSourceCircuitJsonSha256:originalSourceCircuitJsonSha256??(originalCircuitBytes?sha256(circuitPath?.endsWith('.gz')?gunzipSync(originalCircuitBytes):originalCircuitBytes):null),originalSourceArchiveSha256:originalCircuitBytes?sha256(originalCircuitBytes):null,fixtureProvenance:modeling.fixtureProvenance??null,sourceProvenance:modeling.sourceProvenance??null,preSolvedAssessment:modeling.sourceProvenance?.preSolvedAssessment??null,renderedBoard,converter:converterEvidence,toolEvidence,vendorSources:loaded.map(source=>source.evidence),matrices:extracted.map(e=>({stage:e.stage,R:e.R,L:e.L,C:e.C,units:e.units})),experiments,limitations,files:await hashes(out)}
  await json(join(out,'receipt.json'),receipt)
  return receipt
}
