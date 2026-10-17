export class Diagnostic extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.code = code }
}
/** @param {string} code @param {string} message @returns {never} */
export function fail(code, message) { throw new Diagnostic(code, message) }
export const sum = xs => xs.reduce((a,b) => a+b,0)
export const scale = (a,k) => a.map(r => r.map(v => v*k))
export const transpose = a => a[0].map((_,j) => a.map(r => r[j]))
export const multiply = (a,b) => a.map(r => transpose(b).map(c => sum(r.map((v,k) => v*c[k]))))
export const symmetrize = a => a.map((r,i) => r.map((v,j) => (v+a[j][i])/2))
export function validateMatrix(a, name, tolerance = 0.02) {
  const n=a.length
  if (!n || a.some(r => r.length!==n || r.some(v => !Number.isFinite(v)))) fail('matrix_format', `${name}: finite square matrix required`)
  const norm=Math.max(...a.flat().map(Math.abs))
  if (!norm) fail('matrix_zero',name)
  const residual=Math.max(...a.flatMap((r,i) => r.map((v,j) => Math.abs(v-a[j][i]))))/norm
  if (residual>tolerance) fail('reciprocity', `${name}: residual ${residual} > ${tolerance}`)
  const m=symmetrize(a), l=m.map(() => Array(n).fill(0))
  for(let i=0;i<n;i++) for(let j=0;j<=i;j++) {
    const v=m[i][j]-sum(l[i].slice(0,j).map((x,k)=>x*l[j][k]))
    if(i===j) {
      if(v<=norm*1e-12) fail('passivity', `${name}: nonpositive Cholesky pivot ${v}`)
      l[i][j]=Math.sqrt(v)
    } else l[i][j]=v/l[j][j]
  }
  return {matrix:m,reciprocityResidual:residual,cholesky:l}
}
export function loopImpedance(a) {
  const n=a.length-1
  if(![1,2,3].includes(n)) fail('matrix_dimension','One to three signals plus a return required')
  const A=Array.from({length:n+1},(_,i)=>Array.from({length:n},(_,j)=>i===n?-1:Number(i===j)))
  return multiply(multiply(transpose(A),a),A)
}
export function referenceCapacitance(c) {
  const row=c.map(sum), denominator=sum(row)
  if(denominator<=0) fail('reference', 'C to infinity must have positive total common capacitance')
  const n=c.length-1,matrix=c.slice(0,n).map((r,i)=>r.slice(0,n).map((v,j)=>v-row[i]*row[j]/denominator))
  const checked=validateMatrix(matrix,'C loop')
  if(checked.matrix.some((r,i)=>r.some((v,j)=>i!==j&&v>0)||sum(r)<=0)) fail('capacitance_sign', 'Referenced Maxwell C needs nonpositive mutual C and positive shunt C')
  return {...checked,denominator,convention:'Q_total=0; Vsignal relative to finite return; infinity common voltage eliminated'}
}
export function parseFastHenry(text) {
  const blocks=[...text.matchAll(/Impedance matrix for frequency\s*=\s*([\deE+.-]+)\s+(\d+)\s*x\s*(\d+)\s*\n([^]*?)(?=Impedance matrix|$)/g)]
  if(!blocks.length) fail('fasthenry_output','No frequency matrices in Zc.mat')
  return blocks.map(b=>{
    const n=Number(b[2]), rows=b[4].trim().split(/\n/).filter(r=>r.trim()).slice(0,n)
    if(![2,3,4].includes(n) || Number(b[3])!==n) fail('fasthenry_ports', 'One to three signals and one return required')
    const matrix=rows.map(r=>[...r.matchAll(/([+-]?[\d.]+(?:[eE][+-]?\d+)?)\s+([+-]?[\d.]+(?:[eE][+-]?\d+)?)j/g)].map(m=>[Number(m[1]),Number(m[2])]))
    if(matrix.length!==n || matrix.some(r=>r.length!==n)) fail('fasthenry_output','Malformed complex matrix')
    return {frequencyHz:Number(b[1]),R:matrix.map(r=>r.map(v=>v[0])),L:matrix.map(r=>r.map(v=>v[1]/(2*Math.PI*Number(b[1]))))}
  })
}
export function parseFasterCap(text) {
  const blocks=[...text.matchAll(/Capacitance matrix is:\s*\nDimension\s+(\d+)\s+x\s+(\d+)\s*\n([^]*?)(?=\n\s*\n|\nTotal|\nMemory|$)/gi)]
  if(!blocks.length) fail('fastercap_output','No 3D capacitance matrix in solver stdout')
  const b=blocks.at(-1),n=Number(b[1])
  if(![2,3,4].includes(n) || Number(b[2])!==n) fail('fastercap_ports','Expected 2x2, 3x3 or 4x4 Maxwell matrix')
  const names=[],matrix=b[3].trim().split('\n').slice(0,n).map(r=>{const parts=r.trim().split(/\s+/);names.push(parts.shift());return parts.map(Number)})
  if(matrix.some(r=>r.length!==n || r.some(v=>!Number.isFinite(v)))) fail('fastercap_output','Malformed C matrix')
  return {names,matrix,units:'F (3D FasterCap coordinates in metres)'}
}
