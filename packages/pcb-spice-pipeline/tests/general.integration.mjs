import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {resolve,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {any_circuit_element} from 'circuit-json'
import {loadEntry,runPipeline} from '../src/pipeline.mjs'
import {runtimePaths} from '../src/runtime.mjs'
import {channelSpice} from '../src/spice.mjs'

const root=fileURLToPath(new URL('../../../',import.meta.url)),output=join(root,'dist',`native-general-test-${Date.now()}`)
const readJson=async path=>JSON.parse(await readFile(path,'utf8'))
const exists=async path=>{try {await stat(path);return true}catch{return false}}

test('native three-signal channel obeys the complete R + j*w*L impedance matrix and Maxwell C',async()=>{
  const runtime=await runtimePaths({projectDir:root}),dir=join(output,'three-signal-matrix')
  await mkdir(dir,{recursive:true})
  const R=[[2,.3,.4],[.3,3,.5],[.4,.5,4]],L=[[4e-9,1e-9,.8e-9],[1e-9,5e-9,1.2e-9],[.8e-9,1.2e-9,6e-9]],C=[[5e-12,-1e-12,-.5e-12],[-1e-12,6e-12,-.8e-12],[-.5e-12,-.8e-12,7e-12]]
  const currents=[.001,.002,.004],voltage=[1,2,3],frequency=1e8
  // Independent AC columns: grounded outputs reveal series Z; open outputs reveal shunt C.
  const deck=['Matrix regression',channelSpice([{R,L,C}],1)]
  for(let i=0;i<3;i++) deck.push(`IR${i} 0 in${i} AC ${currents[i]}`,`VC${i} c${i} 0 AC ${voltage[i]}`)
  deck.push('XR in0 in1 in2 0 0 0 0 CHANNEL','XC c0 c1 c2 open0 open1 open2 0 CHANNEL','.control','set wr_singlescale','set wr_vecnames',`ac lin 1 ${frequency} ${frequency}`,'wrdata result.dat v(in0) v(in1) v(in2) i(VC0) i(VC1) i(VC2)','quit','.endc','.end')
  await writeFile(join(dir,'matrix.cir'),deck.join('\n')+'\n')
  await promisify(execFile)(runtime.tools.ngspice,['-b','matrix.cir'],{cwd:dir})
  const values=(await readFile(join(dir,'result.dat'),'utf8')).trim().split(/\r?\n/)[1].trim().split(/\s+/).map(Number)
  const omega=2*Math.PI*frequency
  // Independently solve the complex pi-network: (Z^-1 + j*w*C/2)^-1 * I.
  const complex=(real,imag=0)=>[real,imag],add=(a,b)=>[a[0]+b[0],a[1]+b[1]],mul=(a,b)=>[a[0]*b[0]-a[1]*b[1],a[0]*b[1]+a[1]*b[0]],div=(a,b)=>mul(a,[b[0]/(b[0]**2+b[1]**2),-b[1]/(b[0]**2+b[1]**2)])
  const solve=(matrix,rhs)=>{
    const a=matrix.map((row,i)=>[...row.map(v=>[...v]),[...rhs[i]]])
    for(let i=0;i<3;i++) {
      const pivot=a[i][i];a[i]=a[i].map(v=>div(v,pivot))
      for(let j=0;j<3;j++) if(j!==i) {const factor=a[j][i];a[j]=a[j].map((v,k)=>add(v,mul(complex(-1),mul(factor,a[i][k]))))}
    }
    return a.map(row=>row[3])
  }
  const Z=R.map((row,i)=>row.map((v,j)=>complex(v,omega*L[i][j])))
  const admittance=Array.from({length:3},(_,j)=>solve(Z,Array.from({length:3},(_,i)=>complex(Number(i===j)))))
  const Y=C.map((row,i)=>row.map((v,j)=>add(admittance[j][i],complex(0,omega*v/2))))
  const expected=solve(Y,currents.map(v=>complex(v)))
  for(let i=0;i<3;i++) for(let part=0;part<2;part++) assert.ok(Math.abs(values[1+2*i+part]-expected[i][part])<1e-8,'full series impedance, including every mutual term')
  // Open-end voltages require a second complex network solve to include all shunt couplings.
  const openY=C.map((row,i)=>row.map((v,j)=>add(admittance[j][i],complex(0,omega*v/2))))
  const rhs=admittance[0].map((_,i)=>voltage.reduce((s,v,j)=>add(s,mul(admittance[j][i],complex(v))),complex(0)))
  const open=solve(openY,rhs)
  const supplyCurrent=voltage.map((v,i)=>voltage.reduce((s,w,j)=>add(s,add(mul(complex(0,omega*C[i][j]/2),complex(w)),mul(admittance[j][i],add(complex(w),mul(complex(-1),open[j]))))),complex(0)))
  for(let i=0;i<3;i++) for(let part=0;part<2;part++) assert.ok(Math.abs(values[7+2*i+part]+supplyCurrent[i][part])<1e-8,'all Maxwell shunts and mutual capacitors survive')
})

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
