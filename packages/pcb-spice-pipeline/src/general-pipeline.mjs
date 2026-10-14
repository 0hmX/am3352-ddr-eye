import {readFile,writeFile,mkdir,readdir,stat} from 'node:fs/promises'
import {resolve,dirname,join,extname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {hostname,platform,arch} from 'node:os'
import {gunzipSync} from 'node:zlib'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import * as converter from '@tscircuit/ibis-to-spice'
import {any_circuit_element} from 'circuit-json'
import {geometryFromCircuitJson} from './geometry.mjs'
import {generalDeclarations,modelRunDefinition} from './declarations.mjs'
import {electricalSources,generalSimulationSpice,validateProbeScope} from './general-spice.mjs'
import {channelSpice} from './spice.mjs'
import {extractChannel} from './extraction.mjs'
import {probeWaveformRows,foldProbeEye} from './metrics.mjs'
import {command,json,sha256,hashes} from './io.mjs'
import {fail} from './matrices.mjs'
import {packageRoot} from './runtime.mjs'

const exec=promisify(execFile)
const safeId=id=>{
  if(typeof id!=='string'||!/^[a-zA-Z0-9_-]+$/.test(id)) fail('simulation_id','Serialized simulation IDs must be safe stable identifiers')
  return id
}
async function loadModelSource(model,baseDir,cache) {
  const original=model.source,source=original.file?{...original,file:resolve(baseDir,original.file)}:original
  let downloaded
  const fetcher=async url=>{
    if(!source.sha256) fail('vendor_hash','URL imports require exact extracted IBIS SHA-256')
    await mkdir(cache,{recursive:true})
    const path=join(cache,sha256(`${url}:${source.sha256}:${source.archive?.sha256??''}`)+'.source')
    try {downloaded=await readFile(path)} catch(error) {
      if(error.code!=='ENOENT') throw error
      const response=await fetch(url)
      if(!response.ok) fail('vendor_download',`IBIS source HTTP ${response.status}: ${url}`)
      downloaded=Buffer.from(await response.arrayBuffer());await writeFile(path,downloaded)
    }
    return new Response(downloaded,{status:200})
  }
  const reader=async path=>{downloaded=await readFile(path);return downloaded}
  const text=await converter.loadIbisDefinitionSource(source,{fetcher,readFile:reader}),bytes=Buffer.from(text,'utf8')
  const id=safeId(model.pipelineId)
  return {text,bytes,archive:source.archive?downloaded:null,evidence:{simulationIbisModelId:id,source:original,ibsFile:`inputs/ibis/${id}.ibs`,sourceSha256:sha256(bytes),archiveFile:source.archive?`inputs/ibis/${id}.zip`:null,archiveSha256:source.archive&&downloaded?sha256(downloaded):null}}
}

export async function runGeneralPipeline({circuitJson,modeling,outputDir,tools,baseDir=process.cwd(),entryBytes,entryPath,circuitBytes,originalCircuitBytes,circuitPath,originalSourceCircuitJsonSha256,project,python,vendorCache=join(packageRoot,'.cache/vendors'),onProgress=()=>{}}) {
  const out=resolve(outputDir)
  try {await stat(out);fail('output_exists',`Use a fresh output directory: ${out}`)} catch(error) {if(error.code!=='ENOENT') throw error}
  if(typeof converter.convertIbisModelToSpice!=='function'||typeof converter.loadIbisDefinitionSource!=='function') fail('converter_version','Install/build the same-repository general IBIS converter')
  const geometry=geometryFromCircuitJson(circuitJson,modeling),declarations=generalDeclarations(circuitJson,geometry,modeling)
  const electrical=electricalSources(circuitJson,modeling,declarations.nodes)
  for(const plan of declarations.plans) {safeId(plan.simulationExperimentId);for(const eye of plan.eyes) safeId(eye.simulationEyeDiagramId)}
  // Validate every source, buffer state and observation before spending solver work.
  const loaded=[]
  for(const model of declarations.models) loaded.push(await loadModelSource(model,baseDir,vendorCache))
  const compiled=declarations.plans.map(plan=>plan.models.map(model=>{
    const index=declarations.models.findIndex(selected=>selected.pipelineId===model.pipelineId)
    const input=modelRunDefinition(model,plan),result=converter.convertIbisModelToSpice(loaded[index].text,input.definition,input.run)
    return {...result,name:model.component,pipelineId:model.pipelineId,input,sourceEvidence:loaded[index].evidence}
  }))
  for(const [i,plan] of declarations.plans.entries()) validateProbeScope(plan,geometry,compiled[i],declarations.nodes,electrical)
  await mkdir(join(out,'inputs'),{recursive:true})
  await mkdir(join(out,'inputs/ibis'))
  for(const source of loaded) {await writeFile(join(out,source.evidence.ibsFile),source.bytes);if(source.archive) await writeFile(join(out,source.evidence.archiveFile),source.archive)}
  await json(join(out,'inputs/modeling.json'),modeling)
  const inputCircuitBytes=circuitBytes??Buffer.from(JSON.stringify(circuitJson,null,2)+'\n')
  await writeFile(join(out,'inputs/circuit.json'),inputCircuitBytes)
  if(originalCircuitBytes) await writeFile(join(out,'inputs/original.circuit'+(circuitPath.endsWith('.gz')?'.json.gz':'.json')),originalCircuitBytes)
  if(entryBytes) await writeFile(join(out,'inputs/entry'+extname(entryPath)),entryBytes)
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
    try {await stat(join(converterRoot,'package.json'));break} catch(error) {if(error.code!=='ENOENT') throw error}
    const parent=dirname(converterRoot);if(parent===converterRoot) fail('converter_provenance','Cannot locate executed converter package manifest');converterRoot=parent
  }
  const converterEvidence={sourceRoot:converterRoot,entry:converterEntry,version:JSON.parse(await readFile(join(converterRoot,'package.json'),'utf8')).version,files:await hashes(converterRoot,'',(await readdir(converterRoot)).filter(name=>!['dist','package.json'].includes(name)))}
  await json(join(out,'converter-runtime.json'),converterEvidence)
  if(!tools) fail('native_runtime','Pass installed native runtime tools; run pcb-spice-pipeline --setup')
  const toolEvidence={}
  for(const name of ['fasthenry','fastercap','ngspice']) {
    const executable=resolve(tools[name]);toolEvidence[name]={executable,sha256:sha256(await readFile(executable)),host:hostname(),platform:platform(),architecture:arch()}
  }
  try {toolEvidence.setup=JSON.parse(await readFile(join(dirname(tools.configPath??join(packageRoot,'.cache/tools/tools.json')),'build-receipt.json')));await json(join(out,'tool-build-receipt.json'),toolEvidence.setup)} catch(error) {if(error.code!=='ENOENT') throw error}
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
    await command(tools.ngspice,['-b','simulation.cir'],dir,'ngspice')
    let waveformText
    try {waveformText=await readFile(join(dir,'waveform.dat'),'utf8')} catch(error) {
      if(error.code!=='ENOENT') throw error
      fail('native_waveform',`${plan.name}: ngspice exited without waveform.dat; inspect ${join(dir,'ngspice.stderr.log')} and stdout for a singular matrix or aborted transient`)
    }
    const rows=probeWaveformRows(waveformText,plan.probes)
    if(Math.abs(rows.at(-1)[0]-plan.durationSeconds)>plan.durationSeconds*1e-8) fail('simulation_duration',`${plan.name}: native solver did not complete the declared duration`)
    await writeFile(join(dir,'waveform.csv'),'time_s,'+plan.probes.map(probe=>probe.simulationVoltageProbeId+'_v').join(',')+'\n'+rows.map(row=>row.join(',')).join('\n')+'\n')
    await json(join(dir,'waveform.json'),{simulationExperimentId:plan.simulationExperimentId,probes:plan.probes,samples:rows.length,timestamps:'actual adaptive solver times in seconds',source:'waveform.dat',sourceSha256:sha256(await readFile(join(dir,'waveform.dat')))})
    const eyes=[]
    for(const eye of plan.eyes) {
      const relativeEye=join('eyes',eye.simulationEyeDiagramId),eyeDir=join(dir,relativeEye),folded=foldProbeEye(rows,eye)
      await mkdir(eyeDir,{recursive:true})
      await writeFile(join(eyeDir,'eye-data.csv'),'window,folded_time_s,time_s,voltage_v\n'+folded.samples.map(row=>row.join(',')).join('\n')+'\n')
      const descriptor={...eye,directory:relativeEye,windows:folded.windows,pointsPerWindow:folded.pointsPerWindow,windowOriginsSeconds:folded.windowOriginsSeconds,boundaryIndices:folded.boundaryIndices,interpolation:'linear interpolation of actual adaptive solver timestamps',windowDefinition:'b_k=timeOrigin+k*UI; [b_k-UI/2,b_k+3*UI/2]; complete windows only',source:'../../waveform.csv',sourceSha256:sha256(await readFile(join(dir,'waveform.csv'))),metrics:folded.metrics}
      await json(join(eyeDir,'eye-data.json'),descriptor);eyes.push(descriptor)
    }
    await json(join(dir,'eyes.json'),eyes)
    await command(python??process.env.PCB_SPICE_PYTHON,[join(packageRoot,'scripts/plot.py'),dir],dir,'plot')
    for(const probe of plan.probes) results.push(any_circuit_element.parse({type:'simulation_transient_voltage_graph',simulation_transient_voltage_graph_id:`simulation_transient_voltage_graph_${plan.simulationExperimentId}_${probe.column}`,simulation_experiment_id:plan.simulationExperimentId,simulation_voltage_probe_id:probe.simulationVoltageProbeId,timestamps_ms:rows.map(row=>row[0]*1000),voltage_levels:rows.map(row=>row[probe.column]),time_per_step:plan.maxStepSeconds*1000,start_time_ms:rows[0][0]*1000,end_time_ms:rows.at(-1)[0]*1000,name:probe.name}))
    const resultIndex=results.findIndex(record=>record.type==='simulation_experiment'&&record.simulation_experiment_id===plan.simulationExperimentId)
    results[resultIndex]={...results[resultIndex],execution_status:'complete',execution_mode:'external'}
    experiments.push({simulationExperimentId:plan.simulationExperimentId,name:plan.name,directory:relative,durationSeconds:plan.durationSeconds,startTimeSeconds:plan.startTimeSeconds,maxStepSeconds:plan.maxStepSeconds,probes:plan.probes,eyes,solverInvocations:1,waveformSamples:rows.length,assembly:join(relative,'native-ibis-assembly.json')})
  }
  // Registered validation prevents result probe associations from disappearing.
  const canonical=results.map(record=>any_circuit_element.parse(record))
  for(const graph of canonical.filter(record=>record.type==='simulation_transient_voltage_graph')) if(!graph.simulation_voltage_probe_id) fail('result_schema','Installed Circuit JSON schema discarded the result probe ID')
  await json(join(out,'circuit-results.json'),canonical)
  let gitCommit=null,sourceTreeDirty=null
  try {gitCommit=(await exec('git',['rev-parse','HEAD'],{cwd:packageRoot})).stdout.trim();sourceTreeDirty=Boolean((await exec('git',['status','--porcelain'],{cwd:packageRoot})).stdout.trim())} catch {}
  const roots=['LICENSE','package.json','requirements.lock.txt','scripts','src','tests','toolchain-lock.json','tsconfig.json'],sourceFiles=await hashes(packageRoot,'',(await readdir(packageRoot)).filter(name=>!roots.includes(name)))
  const renderedBoard={sourceComponents:circuitJson.filter(e=>e.type==='source_component').length,pcbTraces:circuitJson.filter(e=>e.type==='pcb_trace').length,smtPads:circuitJson.filter(e=>e.type==='pcb_smtpad').length,vias:circuitJson.filter(e=>e.type==='pcb_via').length,platedHoles:circuitJson.filter(e=>e.type==='pcb_plated_hole').length,boards:circuitJson.filter(e=>e.type==='pcb_board').map(({width,height,num_layers,center})=>({widthMm:width,heightMm:height,layers:num_layers,centerMm:center})),errorTypeCounts:{}}
  for(const record of circuitJson.filter(e=>e.type.endsWith('_error'))) renderedBoard.errorTypeCounts[record.type]=(renderedBoard.errorTypeCounts[record.type]??0)+1
  const receipt={schemaVersion:3,status:'executed',description:modeling.description,execution:{host:hostname(),platform:platform(),architecture:arch(),nativeLocalMac:platform()==='darwin',timestampUtc:new Date().toISOString(),node:process.version,gitCommit,sourceTreeDirty,solverResultCache:false},sourceRoot:packageRoot,sourceFiles,project:project??null,entryPath:entryPath??null,sourceCircuitJsonSha256:sha256(inputCircuitBytes),originalSourceCircuitJsonSha256:originalSourceCircuitJsonSha256??(originalCircuitBytes?sha256(circuitPath.endsWith('.gz')?gunzipSync(originalCircuitBytes):originalCircuitBytes):null),originalSourceArchiveSha256:originalCircuitBytes?sha256(originalCircuitBytes):null,fixtureProvenance:modeling.fixtureProvenance??null,sourceProvenance:modeling.sourceProvenance??null,preSolvedAssessment:modeling.sourceProvenance?.preSolvedAssessment??null,renderedBoard,converter:converterEvidence,toolEvidence,vendorSources:loaded.map(source=>source.evidence),matrices:extracted.map(e=>({stage:e.stage,R:e.R,L:e.L,C:e.C,units:e.units})),experiments,limitations:[...geometry.approximations,...compiled.flatMap(models=>models.flatMap(model=>model.warnings??[])),'Only explicitly selected channel components/passives and explicit ideal source rails are simulated; unrelated board electronics excluded','Finite observed transient eyes; no implicit traffic, random jitter, BER extrapolation or protocol compliance','Maximum solver integration step and plotting interpolation resolution are separate settings'],files:await hashes(out)}
  await json(join(out,'receipt.json'),receipt)
  return receipt
}
