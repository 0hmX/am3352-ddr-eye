import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,mkdir,stat} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {any_circuit_element} from 'circuit-json'
import {loadEntry,runPipeline} from '../src/pipeline.mjs'
import {runtimePaths} from '../src/runtime.mjs'

const root=fileURLToPath(new URL('../../../',import.meta.url)),output=join(root,'dist',`native-general-test-${Date.now()}`)
const readJson=async path=>JSON.parse(await readFile(path,'utf8'))
const exists=async path=>{try {await stat(path);return true}catch{return false}}

test('actual vendor non-DDR differential and CMOS single-ended data execute one solver run for multiple eyes',async()=>{
  await mkdir(output,{recursive:true})
  const runtime=await runtimePaths({projectDir:root})
  for(const name of ['differential-data','single-ended']) {
    const input=await loadEntry(join(root,'examples',name,'index.circuit.tsx')),dir=join(output,name)
    assert.ok(input.circuitJson.some(e=>e.type==='simulation_digital_stimulus'&&/(00|11)/.test(e.pattern.bits)),'source contains repeated arbitrary data bits')
    const receipt=await runPipeline({...input,...runtime,outputDir:dir})
    assert.equal(receipt.schemaVersion,3);assert.equal(receipt.execution.solverResultCache,false)
    assert.equal(receipt.experiments.length,1)
    const experiment=receipt.experiments[0]
    assert.ok(experiment.eyes.length>=2)
    assert.equal(experiment.solverInvocations,1)
    const solverCommands=Object.keys(receipt.files).filter(file=>file.endsWith('/ngspice.command.json'))
    assert.equal(solverCommands.length,1,'multiple eyes share exactly one actual native process')
    const command=await readJson(join(dir,solverCommands[0]));assert.equal(command.exitCode,0)
    const circuit=(await readJson(join(dir,'circuit-results.json'))).map(record=>any_circuit_element.parse(record))
    const assembly=await readJson(join(dir,experiment.directory,'native-ibis-assembly.json'))
    for(const model of assembly) assert.equal(model.metadata.tableExtrapolation,'hold-endpoint-current','the numerical table boundary policy is recorded')
    const wave=(await readFile(join(dir,experiment.directory,'waveform.csv'),'utf8')).trim().split(/\r?\n/).slice(1).map(line=>line.split(',').map(Number))
    if(name==='single-ended') {
      const stimulus=input.circuitJson.find(record=>record.type==='simulation_digital_stimulus')
      assert.equal(stimulus.initial_state,0);assert.equal(stimulus.inverted,false)
      assert.equal(wave[0][0],0,'startup remains in the raw record before the eye gate')
      const supply=input.circuitJson.find(record=>record.type==='simulation_voltage_source').voltage
      for(const probe of experiment.probes) {
        assert.ok(Math.abs(wave[0][probe.column])<.05,'declared low CMOS output and its DC-connected receiver settle near ground')
        const peak=wave.reduce((largest,row)=>Math.max(largest,Math.abs(row[probe.column])),0)
        // This fixture rings above its rail; the loose full-record guard catches the former 61 V false DC root.
        assert.ok(peak<3*supply,`full raw CMOS ${probe.name} peak ${peak} V exceeds the fixture startup regression limit`)
      }
      const deck=await readFile(join(dir,experiment.directory,'simulation.cir'),'utf8')
      assert.doesNotMatch(deck,/^\s*\.nodeset\b|^\s*\.ic\b|\buic\b/im,'startup comes from the nonlinear operating-point solve')
    }
    for(const probe of experiment.probes) {
      const graph=circuit.find(record=>record.type==='simulation_transient_voltage_graph'&&record.simulation_experiment_id===experiment.simulationExperimentId&&record.simulation_voltage_probe_id===probe.simulationVoltageProbeId)
      assert.ok(graph,'registered result remains bound to its probe')
      assert.deepEqual(graph.timestamps_ms,wave.map(row=>row[0]*1000))
      assert.deepEqual(graph.voltage_levels,wave.map(row=>row[probe.column]))
      const range=graph.voltage_levels.reduce(([low,high],v)=>[Math.min(low,v),Math.max(high,v)],[Infinity,-Infinity])
      assert.ok(range[1]-range[0]>.5,'actual data waveform varies')
    }
    for(const eye of experiment.eyes) {
      const declared=input.circuitJson.find(record=>record.type==='simulation_eye_diagram'&&record.simulation_eye_diagram_id===eye.simulationEyeDiagramId)
      assert.equal(eye.timeOriginSeconds,declared.time_origin_ms/1000)
      assert.ok(eye.windows>3)
      const samples=(await readFile(join(dir,experiment.directory,eye.directory,'eye-data.csv'),'utf8')).trim().split(/\r?\n/)
      assert.equal(samples.shift(),'window,folded_time_s,time_s,voltage_v')
      assert.equal(samples.length,eye.windows*1200)
    }
    for(const [label,mutate] of [
      ['bad-probe',cj=>{cj.find(record=>record.type==='simulation_eye_diagram').simulation_voltage_probe_id='missing'}],
      ['bad-gate',cj=>{cj.find(record=>record.type==='simulation_eye_diagram').end_time_ms=100}],
    ]) {
      const circuitJson=structuredClone(input.circuitJson);mutate(circuitJson)
      const rejected=join(output,name+'-'+label)
      await assert.rejects(runPipeline({...input,circuitJson,...runtime,outputDir:rejected}),/reference|gate/)
      assert.equal(await exists(rejected),false,'invalid declarations fail before creating solver output')
    }
  }
})
