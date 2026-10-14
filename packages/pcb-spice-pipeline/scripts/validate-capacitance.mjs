import {mkdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {sha256} from '../src/pipeline.mjs'
export async function analyticCapacitanceCheck(executable,dir) {
  await mkdir(dir,{recursive:true})
  const rectangle=(name,y)=>`* 2D closed rectangle\nS ${name} -10 ${y} 10 ${y}\nS ${name} 10 ${y} 10 ${y+.035}\nS ${name} 10 ${y+.035} -10 ${y+.035}\nS ${name} -10 ${y+.035} -10 ${y}\n`
  const files={'upper.txt':rectangle('upper',.2),'return.txt':rectangle('return',-.035),'plates.lst':'* 2D wide parallel plates, mm coordinates, last conductor reference\nC upper.txt 4 0 0\nC return.txt 4 0 0\n'}
  for(const [name,body] of Object.entries(files)) await writeFile(join(dir,name),body)
  const args=['plates.lst','-b','-a0.005','-e'],start=Date.now()
  const {stdout,stderr}=await promisify(execFile)(executable,args,{cwd:dir,timeout:60000,maxBuffer:4*1024*1024,env:{...process.env,OMP_NUM_THREADS:'1'}})
  await writeFile(join(dir,'stdout.log'),stdout);await writeFile(join(dir,'stderr.log'),stderr)
  const matches=[...stdout.matchAll(/Dimension 1 x 1\s*\n\S+\s+([\deE+.-]+)/g)]
  if(!matches.length) throw new Error('Analytic capacitance: no executed 2D result')
  const extractedFm=Number(matches.at(-1)[1]),analyticFm=8.8541878128e-12*4*.020/.0002,relativeError=extractedFm/analyticFm-1
  if(relativeError<0||relativeError>.05) throw new Error(`Parallel plate C error ${relativeError}; finite edges should increase infinite-width estimate by <5%`)
  const receipt={status:'passed',executable,args,cwd:dir,exitCode:0,elapsedMs:Date.now()-start,extractedFm,analyticFm,relativeError,units:'F/m (2D FasterCap only; main channel uses 3D F)',geometry:{widthM:.020,gapM:.0002,conductorThicknessM:.000035,relativePermittivity:4},interpretation:'Finite-width fringing increases C over epsilon*w/g; this independent analytic gate is not substituted for channel extraction',inputHashes:Object.fromEntries(Object.entries(files).map(([name,body])=>[name,sha256(body)]))}
  await writeFile(join(dir,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
  return receipt
}
