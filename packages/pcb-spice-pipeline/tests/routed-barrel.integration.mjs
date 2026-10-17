import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {runtimePaths} from '../src/runtime.mjs'

test('emitted vertical barrel filaments have tangential width, radial plating and unchanged distributed return contacts',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'routed-barrel-'))
  try {
    const {python}=await runtimePaths({projectDir:fileURLToPath(new URL('../../..',import.meta.url))})
    const geometryRoot=dirname(createRequire(import.meta.url).resolve('circuit-json-to-gmsh/package.json'))
    const script=fileURLToPath(new URL('../scripts/routed-geometry.py',import.meta.url))
    // A tiny actual exporter mesh, with a through-via and two distributed
    // source/receiver return pairs. No field solver or board fixture is used.
    const fixture=String.raw`
import runpy, sys, math
from pathlib import Path
from shapely.geometry import box
sys.path.insert(0, sys.argv[3])
exporter = runpy.run_path(sys.argv[1])
foils = [{"name":"top","zMin":.965,"zMax":1}, {"name":"bottom","zMin":0,"zMax":.035}]
terminal = lambda x,y,z,net: {"positionMm":[x,y,z], "netId":net}
returns = [{"from":terminal(a,-1,.9825,"G"),"to":terminal(b,-1,.9825,"G")} for a,b in [(-1,1),(-1.5,1.5)]]
route = [{"route_type":"wire","x":-1,"y":0,"layer":"top","width":.1}, {"route_type":"wire","x":0,"y":0,"layer":"top","width":.1}, {"route_type":"via","x":0,"y":0,"to_layer":"bottom"}, {"route_type":"wire","x":1,"y":0,"layer":"bottom","width":.1}]
signal = {"name":"DQ", "from":terminal(-1,0,.9825,"S"), "to":terminal(1,0,.0175,"S"), "route":route}
barrel = {"netId":"S", "hole":[{"x":.15*math.cos(a),"y":.15*math.sin(a)} for a in [i*math.pi/16 for i in range(32)]], "platingThickness":.025, "zMin":0,"zMax":1}
context = {"settings":{"referenceMeshMm":.5,"referenceBoundaryToleranceMm":.001,"signalFilaments":3,"modelHz":1e8}, "returns":returns,"signals":[signal],"conductivitySm":58e6}
model = {"multilayer":{"stackup":{"copperLayers":foils},"barrels":[barrel]}}
exporter["write_inductance"]({"context":context,"model":model,"copper":{"top":{"G":box(-2,-2,2,-.5)},"bottom":{}},"output":Path(sys.argv[2])})
`
    await promisify(execFile)(python,['-c',fixture,script,dir,join(geometryRoot,'lib/python')],{timeout:30000})
    const lines=(await readFile(join(dir,'channel.inp'),'utf8')).trim().split('\n')
    const properties=line=>Object.fromEntries([...line.matchAll(/(\w+)=([^\s]+)/g)].map(([,key,value])=>[key,Number(value)]))
    const nodes=new Map(lines.filter(line=>/^N\d+ /.test(line)).map(line=>[line.split(' ')[0],properties(line)]))
    const vertical=lines.filter(line=>/^E\d+ /.test(line)).map(line=>{
      const [,a,b]=line.split(' ')
      return {a:nodes.get(a),b:nodes.get(b),...properties(line)}
    }).filter(({a,b})=>a.x===b.x&&a.y===b.y&&a.z!==b.z)
    assert.equal(vertical.length,12,'four shell filaments retain all three spans between foil midplanes and barrel ends')
    for(const segment of vertical) {
      const {a,b,wx,wy,wz,w,h}=segment,radius=Math.hypot(a.x,a.y),radial=[a.x/radius,a.y/radius],widthNorm=Math.hypot(wx,wy,wz)
      assert.ok(Math.abs(radius/.0001625-1)<1e-10)
      assert.ok(Math.abs(widthNorm-1)<1e-10)
      assert.ok(Math.abs(wx*radial[0]+wy*radial[1])<1e-10,'circumference width is perpendicular to the radial vector')
      assert.ok(Math.abs(wx+radial[1])<1e-10&&Math.abs(wy-radial[0])<1e-10,'width is the positive tangent at the actual emitted node')
      assert.equal(wz,0);assert.ok(b.z>a.z,'actual emitted length axis remains vertical')
      assert.ok(Math.abs(w/(Math.PI*radius/2)-1)<1e-10,'width remains one quarter circumference')
      assert.ok(Math.abs(h/.000025-1)<1e-10,'height remains radial plating thickness')
      // FastHenry computes height = unit(length cross width).
      const height=[-wy/widthNorm,wx/widthNorm]
      assert.ok(Math.abs(Math.abs(height[0]*radial[0]+height[1]*radial[1])-1)<1e-10)
    }
    const nodeAt=(x,y,z)=>[...nodes].find(([,point])=>Math.hypot(point.x-x,point.y-y,point.z-z)<1e-12)?.[0]
    const source=nodeAt(-.001,-.001,.0009825),receiver=nodeAt(.001,-.001,.0009825)
    assert.ok(source&&receiver)
    for(const [x,target] of [[-.0015,source],[.0015,receiver]]) {
      const contact=nodeAt(x,-.001,.0009825)
      assert.ok(contact,'additional distributed terminal is embedded in the reference mesh')
      assert.ok(lines.includes(`.equiv ${contact} ${target}`),'additional return pair preserves source/receiver AC association')
    }
  } finally {await rm(dir,{recursive:true,force:true})}
})
