import test from 'node:test'
import assert from 'node:assert/strict'
import { validateMatrix,loopImpedance,referenceCapacitance,multiply,transpose } from '../src/matrices.mjs'
test('shared return resistance survives the full loop transform',()=>{
  assert.deepEqual(loopImpedance([[2,0,0],[0,3,0],[0,0,5]]),[[7,5],[5,8]])
  validateMatrix([[7,5],[5,8]],'R')
})
test('neutral capacitance reduction preserves electrostatic energy and charge neutrality',()=>{
  const C=[[4,-1,-2],[-1,5,-3],[-2,-3,7]],r=referenceCapacitance(C),v=[1.2,-.7]
  const row=C.map(r=>r.reduce((a,b)=>a+b)),den=row.reduce((a,b)=>a+b),offset=-(row[0]*v[0]+row[1]*v[1])/den
  const full=[[v[0]+offset],[v[1]+offset],[offset]],q=multiply(C,full)
  assert.ok(Math.abs(q.flat().reduce((a,b)=>a+b))<1e-12)
  const energy=multiply(transpose(full),q)[0][0],small=multiply(multiply([v],r.matrix),transpose([v]))[0][0]
  assert.ok(Math.abs(energy-small)<1e-12)
  assert.ok(r.matrix[0][1]<0)
})
test('nonpassive and nonreciprocal matrices fail before normalization',()=>{
  assert.throws(()=>validateMatrix([[1,2],[2,1]],'L'),/passivity/)
  assert.throws(()=>validateMatrix([[1,.2],[.5,1]],'C'),/reciprocity/)
  assert.throws(()=>referenceCapacitance([[1,-1,0],[-1,1,0],[0,0,0]]),/reference/)
})
