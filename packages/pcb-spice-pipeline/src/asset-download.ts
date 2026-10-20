import {lookup} from 'node:dns/promises'
import type {LookupAddress} from 'node:dns'
import {request as httpRequest} from 'node:http'
import {request as httpsRequest} from 'node:https'
import {isIP} from 'node:net'
import {fail} from './matrices.mjs'

/** Trusted caller settings (GeneralPipelineOptions.assetFetch), never circuit JSON.
 * CLI/env equivalents: PCB_SPICE_IBIS_ALLOW_HTTP=1, PCB_SPICE_IBIS_ALLOWED_HOSTS
 * (comma-separated exact hosts), PCB_SPICE_IBIS_TIMEOUT_MS (default 30000) and
 * PCB_SPICE_IBIS_MAX_BYTES (default 67108864). Allowlisting never bypasses DNS checks.
 */
export interface AssetFetchOptions {
  /** HTTP requires explicit opt-in; private networks remain blocked. */
  allowHttp?: boolean
  /** Exact hostnames, without scheme or port. An empty list denies all hosts. */
  allowedHosts?: readonly string[]
  timeoutMs?: number
  maxBytes?: number
  /** For loopback test servers only. Never populate this from circuit JSON or env. */
  testAllowLoopback?: boolean
}

const normalizeHost=(host: string)=>host.toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'')
const loopback=(address: string)=>address==='::1'||(isIP(address)===4&&address.split('.')[0]==='127')

function publicAddress(address: string): boolean {
  if(isIP(address)===4) {
    const [a,b,c]=address.split('.').map(Number)
    return !(a===0||a===10||a===127||a>=224||
      (a===100&&b>=64&&b<=127)||(a===169&&b===254)||
      (a===172&&b>=16&&b<=31)||(a===192&&(b===168||(b===0&&c===0)))||(a===198&&(b===18||b===19)))
  }
  if(isIP(address)!==6) return false
  // Only native global unicast IPv6. This excludes unspecified, mapped IPv4,
  // NAT64, unique-local and link-local addresses, including metadata endpoints.
  const canonical=normalizeHost(new URL(`https://[${address}]/`).hostname)
  const [firstPart,secondPart]=canonical.split(':')
  const first=parseInt(firstPart,16),second=parseInt(secondPart||'0',16)
  return first>=0x2000&&first<=0x3fff&&first!==0x2002&&!(first===0x2001&&second===0)
}

/** Validate every DNS answer before a connection; callers must pin one answer. */
export async function resolveAssetUrl(input: string,options: AssetFetchOptions={},resolveHost: (host: string)=>Promise<LookupAddress[]>=host=>lookup(host,{all:true,verbatim:true})) {
  const url=new URL(input),host=normalizeHost(url.hostname)
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&options.allowHttp)) fail('ibis_fetch_policy','IBIS downloads require HTTPS (HTTP needs explicit allowHttp opt-in)')
  if(url.username||url.password) fail('ibis_fetch_policy','IBIS download URLs must not contain credentials')
  if(options.allowedHosts&&!options.allowedHosts.some(allowed=>normalizeHost(allowed)===host)) fail('ibis_fetch_policy',`IBIS download host is not allowlisted: ${host}`)
  const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await resolveHost(host)
  if(!addresses.length||addresses.some(({address})=>!publicAddress(address)&&!(options.testAllowLoopback&&loopback(address)))) fail('ibis_fetch_policy',`IBIS download host resolves to a disallowed address: ${host}`)
  return {url,addresses}
}

function positiveLimit(value: number,name: string) {
  if(!Number.isSafeInteger(value)||value<=0||value>0x7fffffff) fail('ibis_fetch_policy',`${name} must be a positive integer no greater than 2147483647`)
  return value
}

/** Bounded download, including DNS, redirect hops, response headers and body. */
export async function downloadIbisAsset(input: string,options: AssetFetchOptions={}) {
  const policy={...options,
    allowHttp:options.allowHttp??process.env.PCB_SPICE_IBIS_ALLOW_HTTP==='1',
    allowedHosts:options.allowedHosts??process.env.PCB_SPICE_IBIS_ALLOWED_HOSTS?.split(',').map(host=>host.trim()).filter(Boolean),
  }
  const timeoutMs=positiveLimit(options.timeoutMs??Number(process.env.PCB_SPICE_IBIS_TIMEOUT_MS??30000),'IBIS timeoutMs')
  const maxBytes=positiveLimit(options.maxBytes??Number(process.env.PCB_SPICE_IBIS_MAX_BYTES??64*1024*1024),'IBIS maxBytes')
  const controller=new AbortController()
  const timer=setTimeout(()=>controller.abort(new Error(`IBIS download timed out after ${timeoutMs} ms`)),timeoutMs)
  const aborted=new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true}))
  try {
    let next=input
    for(let hop=0;hop<=5;hop++) {
      const {url,addresses}=await Promise.race([resolveAssetUrl(next,policy),aborted])
      controller.signal.throwIfAborted()
      const response=await Promise.race([new Promise<import('node:http').IncomingMessage>((resolve,reject)=>{
        const address=addresses[0]
        const request=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{
          signal:controller.signal,agent:false,family:address.family,
          // Pin the validated answer to prevent DNS rebinding between check and use.
          lookup:(_host,_options,callback)=>callback(null,address.address,address.family),
        },resolve)
        request.on('error',reject)
        request.end()
      }),aborted])
      try {
        if([301,302,303,307,308].includes(response.statusCode??0)) {
          if(!response.headers.location) fail('vendor_download','IBIS redirect has no Location header')
          next=new URL(response.headers.location,url).href
          continue
        }
        if(!response.statusCode||response.statusCode<200||response.statusCode>=300) fail('vendor_download',`IBIS asset HTTP ${response.statusCode}: ${url.href}`)
        if(/text\/html/i.test(response.headers['content-type']??'')) fail('ibis_asset','IBIS asset URL returned HTML instead of model data')
        const tooLarge=()=>{
          const error=new Error(`IBIS asset exceeds ${maxBytes} bytes`)
          controller.abort(error)
          throw error
        }
        if(Number(response.headers['content-length'])>maxBytes) tooLarge()
        const chunks: Buffer[]=[]
        let size=0
        for await(const chunk of response) {
          size+=chunk.length
          if(size>maxBytes) tooLarge()
          chunks.push(chunk)
        }
        return Buffer.concat(chunks,size)
      } finally {response.destroy()}
    }
    fail('vendor_download','IBIS download exceeded 5 redirects')
  } catch(error) {
    if(controller.signal.aborted) throw controller.signal.reason
    throw error
  } finally {clearTimeout(timer)}
}
