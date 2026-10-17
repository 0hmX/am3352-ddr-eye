import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {runtimePaths} from '../src/runtime.mjs'
import {parseFasterCap,validateMatrix} from '../src/matrices.mjs'

const exec=promisify(execFile),epsilon0=8.8541878128e-12

// This fixture is generated independently of the PCB geometry/export pipeline.
// Direct triangles avoid the native quad loader's implicit aspect-ratio mesh.
async function groundedWires(dir,{lengthHeights,separationHeights}) {
  await mkdir(dir)
  const h=.001,a=.05*h,length=lengthHeights*h,separation=separationHeights*h,facets=8,step=.25*h
  const triangle=(label,...points)=>`T ${label} ${points.flat().join(' ')}`
  for(let wire=0;wire<2;wire++) {
    const panels=[],label=`WIRE${wire}`
    const point=(x,k)=>[x,(wire-.5)*separation+a*Math.cos(2*Math.PI*k/facets),h+a*Math.sin(2*Math.PI*k/facets)]
    for(let i=0;i<lengthHeights/.25;i++) {
      const x0=-length/2+i*step,x1=x0+step
      for(let k=0;k<facets;k++) {
        const A=point(x0,k),B=point(x1,k),C=point(x1,k+1),D=point(x0,k+1)
        panels.push(triangle(label,A,B,C),triangle(label,A,C,D))
      }
    }
    for(const x of [-length/2,length/2]) for(let k=0;k<facets;k++) panels.push(triangle(label,[x,(wire-.5)*separation,h],point(x,k),point(x,k+1)))
    await writeFile(join(dir,`${label}.txt`),panels.join('\n')+'\n')
  }
  const foil=[],ends=length/2+10*h,side=20*h
  for(let x=-ends;x<ends-h/100;x+=2*h) for(let y=-side;y<side-h/100;y+=h) {
    const A=[x,y,0],B=[x+2*h,y,0],C=[x+2*h,y+h,0],D=[x,y+h,0]
    foil.push(triangle('GROUND',A,B,C),triangle('GROUND',A,C,D))
  }
  await writeFile(join(dir,'GROUND.txt'),foil.join('\n')+'\n')
  await writeFile(join(dir,'channel.lst'),['WIRE0','WIRE1','GROUND'].map(label=>`C ${label}.txt 4.1 0 0 0`).join('\n')+'\n')
}

function expectedPerLength(separationHeights) {
  const epsilon=4.1*epsilon0,aOverH=.05
  const diagonal=Math.log(2/aOverH)/(2*Math.PI*epsilon)
  const mutual=Math.log1p(4/separationHeights**2)/(4*Math.PI*epsilon)
  const determinant=diagonal*diagonal-mutual*mutual
  return [[diagonal/determinant,-mutual/determinant],[-mutual/determinant,diagonal/determinant]]
}

test('native grounded-wire capacitance and crosstalk agree with independent image-charge physics',{timeout:300000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'cap-grounded-wires-'))
  try {
    const {tools}=await runtimePaths({projectDir:fileURLToPath(new URL('../../..',import.meta.url))})
    const slopes=[]
    for(const separationHeights of [1,3]) {
      const matrices=[]
      for(const lengthHeights of [60,120]) {
        const dir=join(root,`L${lengthHeights}-s${separationHeights}`)
        await groundedWires(dir,{lengthHeights,separationHeights})
        const result=await exec(tools.fastercap,['channel.lst','-b','-m2','-d0.003','-t0.0001','-g','-r'],{cwd:dir,timeout:120000,maxBuffer:8*1024*1024,env:{...process.env,OMP_NUM_THREADS:'1'}})
        assert.doesNotMatch(result.stdout+result.stderr,/not converging|\bnan\b|zero conductor self-potential/i)
        const {matrix}=parseFasterCap(result.stdout)
        assert.equal(matrix.length,3)
        validateMatrix(matrix,'grounded-wire primitive C')
        for(let i=0;i<3;i++) for(let j=i+1;j<3;j++) {
          assert.ok(matrix[i][j]<0&&matrix[j][i]<0,'all Maxwell mutual coefficients are negative; no sign clipping')
          assert.ok(Math.abs(matrix[i][j]-matrix[j][i])/Math.sqrt(matrix[i][i]*matrix[j][j])<.002,'pair-normalized reciprocity, independent of the large ground diagonal')
        }
        assert.ok(Math.abs(matrix[0][0]/matrix[1][1]-1)<.01,'identical wires must have reflection-symmetric self capacitance')
        // Ground is held at zero, so the signal block of primitive C is the
        // grounded two-port matrix. No inverse or ground elimination is applied.
        matrices.push(matrix.slice(0,2).map(row=>row.slice(0,2)))
      }
      const slope=matrices[1].map((row,i)=>row.map((value,j)=>(value-matrices[0][i][j])/.06)),expected=expectedPerLength(separationHeights)
      // Lengths are 60h and 120h with identical 10h foil extensions. The length
      // difference cancels leading end capacitance. A 40h-wide finite foil,
      // octagonal wires and finite constant-charge cells remain approximations;
      // 6% is a geometry/discretization budget, not a device-accuracy claim.
      t.diagnostic(JSON.stringify({separationHeights,faradsPerMetre:slope,analyticFaradsPerMetre:expected,relativeErrors:slope.map((row,i)=>row.map((value,j)=>value/expected[i][j]-1))}))
      for(let i=0;i<2;i++) for(let j=0;j<2;j++) assert.ok(Math.abs(slope[i][j]/expected[i][j]-1)<.06,`s/h=${separationHeights}: C'[${i},${j}]=${slope[i][j]} versus image-charge ${expected[i][j]} F/m`)
      slopes.push(slope)
    }
    assert.ok(Math.abs(slopes[1][0][1])<Math.abs(slopes[0][0][1])/3,'wider wire spacing substantially reduces capacitive crosstalk')
  } finally {await rm(root,{recursive:true,force:true})}
})
