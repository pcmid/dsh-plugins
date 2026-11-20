import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { validAdmissionScope } from './admission.js'
import { cliExecutable } from './cli-path.js'

// +messages-reply in lark-cli 1.0.100 declares both user scopes (not the bot scope).
export const replyScopes = ['im:message.send_as_user','im:message']
const scopes = ['contact:user.basic_profile:readonly','im:chat:read','im:message.group_msg:get_as_user','im:message.p2p_msg:get_as_user','search:message',...replyScopes]
const error = code => Object.assign(new Error(code),{code})
const unavailable = () => error('auth-unavailable')
const safe = err => ['auth-expired','auth-busy','auth-setup-locked','auth-denied','auth-profile-exists','auth-profile-missing'].includes(err?.code) ? error(err.code) : unavailable()
const json = s => {try {return JSON.parse(s)} catch {return null}}
const maxTime = 600_000

function officialURL(raw,kind) {
  if (typeof raw !== 'string' || raw.length > 4096 || /[\s\\#]/.test(raw)) throw unavailable()
  const u = new URL(raw)
  const setup = kind === 'setup'
  const base = setup ? 'https://open.feishu.cn/page/cli' : 'https://accounts.feishu.cn/oauth/v1/device/verify'
  const keys = setup ? ['user_code','from','lpv','ocv'] : ['user_code','flow_id']
  if (!raw.startsWith(base+'?') || !u.searchParams.get('user_code') ||
      [...u.searchParams.keys()].some(k => !keys.includes(k) || u.searchParams.getAll(k).length !== 1)) throw unavailable()
  return raw // Verification URL is opaque; do not rebuild its query.
}

function exitError(stdout,stderr) {
  const detail = [stdout,stderr].join('\n')
  // init mixes its progress/QR with an error envelope. Classify only; never relay diagnostics.
  if (/"subtype"\s*:\s*"not_configured"/.test(detail)) return error('auth-profile-missing')
  if (/"subtype"\s*:\s*"token_expired"|device code expired|authorization timed out/i.test(detail)) return error('auth-expired')
  if (/"subtype"\s*:\s*"access_denied"|denied by user|access_denied|"missing"\s*:\s*\[\s*"/i.test(detail)) return error('auth-denied')
  return unavailable()
}

// The npm launcher spawns a native CLI. Cancel the whole POSIX process group, not just its wrapper.
function runCli(cliPath,args,{signal,cliDir,cwd,onLine}) {
  signal.throwIfAborted()
  if (process.platform === 'win32') throw unavailable()
  return new Promise((resolve,reject) => {
    const child = spawn(cliExecutable(cliPath),args,{cwd,detached:true,stdio:['ignore','pipe','pipe'],
      env:{...process.env,...(cliDir ? {LARKSUITE_CLI_CONFIG_DIR:cliDir} : {}),
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'}})
    let size=0, fault
    const full = {stdout:'',stderr:''}
    const kill = () => {
      if (child.pid) {try {process.kill(-child.pid,'SIGKILL')} catch {}}
    }
    signal.addEventListener('abort',kill,{once:true})
    for (const name of ['stdout','stderr']) {
      let partial=''
      child[name].setEncoding('utf8')
      child[name].on('data',chunk => {
        if (fault || signal.aborted) return
        size+=Buffer.byteLength(chunk)
        if (size>128*1024) {fault=unavailable(); kill(); return}
        full[name]+=chunk
        if (!onLine) return
        const lines=(partial+chunk).split('\n')
        partial=lines.pop()
        try {for(const line of lines) onLine(name,line.trim())}
        catch(e) {fault=safe(e); kill()}
      })
    }
    child.on('error',() => {fault=unavailable()})
    child.once('close',code => {
      signal.removeEventListener('abort',kill)
      if(signal.aborted || fault || code!==0) reject(signal.reason ?? fault ?? exitError(full.stdout,full.stderr))
      else resolve(full.stdout)
    })
  })
}

// Never read the CLI config. Reserve only the plugin-owned directory and refuse even a malformed existing config.
async function reserve(cliDir) {
  await mkdir(cliDir,{mode:0o700,recursive:true})
  if (!(await lstat(cliDir)).isDirectory()) throw unavailable()
  const lock=join(cliDir,'.superagent-init.lock')
  const checkEmpty = async () => {
    for(const workspace of ['','openclaw','hermes','lark-channel']) {
      try {await lstat(join(cliDir,workspace,'config.json'))}
      catch(e) {if(e.code==='ENOENT') continue; throw e}
      throw error('auth-profile-exists')
    }
  }
  try {await mkdir(lock,{mode:0o700})}
  catch(e) {
    if(e.code!=='EEXIST') throw e
    await checkEmpty()
    throw error('auth-setup-locked') // A crashed initializer can leave its lock. Never steal it.
  }
  const unlock = () => rmdir(lock)
  try {await checkEmpty()} catch(e) {await unlock();throw e}
  return unlock
}

async function makeQR(url,exec) {
  const cwd=await mkdtemp(join(tmpdir(),'dsh-feishu-qr-'))
  try {
    const name='authorize.png'
    const out=json(await exec(['auth','qrcode',url,'--output',name],{cwd,timeout:10_000}))
    const path=join(cwd,name), st=await lstat(path)
    if(out?.ok!==true || !st.isFile() || st.size>64*1024 || st.size<33) throw unavailable()
    const png=await readFile(path)
    if(!png.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) || png.toString('ascii',12,16)!=='IHDR' ||
      png.readUInt32BE(16)!==256 || png.readUInt32BE(20)!==256 ||
      !png.subarray(-12).equals(Buffer.from('0000000049454e44ae426082','hex'))) throw unavailable()
    return 'data:image/png;base64,'+png.toString('base64')
  } finally {await rm(cwd,{force:true,recursive:true})}
}

// No login, status probe or CLI IO on construction. cliDir is an absolute, Host-owned path or absent for shared profiles.
export function createFeishuAuth({cliDir,cliPath,run=runCli.bind(null,cliPath)}={}) {
  let current, closed=false
  function stop(f,reason='auth-expired') {
    if(current===f) current=null
    clearTimeout(f.timer)
    f.controller.abort(error(reason))
  }
  async function drain(f) {
    stop(f)
    await Promise.allSettled([f.job,f.effect])
  }
  function arm(f,ms,reason) {
    clearTimeout(f.timer)
    f.timer=setTimeout(()=>stop(f,reason),ms)
    f.timer.unref?.()
  }
  function lookup({profile,flowId}) {
    if(!current || current.profile!==profile || current.id!==flowId) throw error('auth-expired')
    if(current.expiresAt<=Date.now()) {stop(current);throw error('auth-expired')}
    return current
  }
  return {
    async start({profile,kind}) {
      if(closed) throw unavailable()
      if(typeof profile!=='string' || !/^\w[\w.-]{0,127}$/.test(profile) || profile!==profile.trim() || (cliDir && profile.length>64) ||
          !['setup','login'].includes(kind) || (kind==='setup' && !cliDir)) throw error('invalid-input')
      if(cliDir!==undefined && (typeof cliDir!=='string' || !isAbsolute(cliDir))) throw unavailable()
      if(current) throw error('auth-busy')
      const f=current={id:randomUUID(),profile,controller:new AbortController()}
      const signal=f.controller.signal
      const exec=(argv,{timeout,...opts}={}) => {
        signal.throwIfAborted()
        return run(argv,{...opts,signal:timeout ? AbortSignal.any([signal,AbortSignal.timeout(timeout)]) : signal,cliDir})
      }
      const setup=kind==='setup'
      arm(f,35_000,'auth-unavailable')
      const first=Promise.withResolvers()
      signal.addEventListener('abort',()=>first.reject(signal.reason),{once:true})
      // Streaming JSON avoids --no-wait, which stores the device code in a cache filename.
      const watch=(stream,line)=>{
        if(f.expiresAt) return
        const event=!setup && stream==='stdout' && json(line)
        const raw=setup && stream==='stderr' && /^https:\/\//.test(line) ? line :
          event?.event==='device_authorization' ? event.verification_uri_complete : null
        if(!raw) return
        if(!setup && (!Number.isSafeInteger(event.expires_in) || event.expires_in<=0)) throw unavailable()
        const ms=setup ? maxTime : Math.min(maxTime,event.expires_in*1000)
        const url=officialURL(raw,kind)
        f.expiresAt=Date.now()+ms
        arm(f,ms,'auth-expired')
        first.resolve(url)
      }
      async function authorize() {
        const unlock=setup ? await reserve(cliDir) : null
        try {
          const args=setup ? ['config','init','--new','--name',profile,'--brand','feishu'] :
            ['--profile',profile,'auth','login','--scope',scopes.join(' '),'--json']
          const out=await exec(args,{onLine:watch})
          if(setup) {
            const result=json(out)
            if(result?.brand!=='feishu' || !/^cli_[\w-]+$/.test(result?.appId ?? '')) throw unavailable()
            return {kind}
          }
          const result=json(out.trim().split('\n').at(-1))
          if(result?.event!=='authorization_complete' || !Array.isArray(result.missing) ||
              result.missing.length || !scopes.every(s=>Array.isArray(result.granted) && result.granted.includes(s)) ||
              typeof result.user_open_id!=='string' || !/^ou_[\w-]{1,128}$/.test(result.user_open_id)) throw unavailable()
          return {kind,recipientId:result.user_open_id}
        } finally {if(unlock) await unlock()}
      }
      f.job=authorize().then(result=>{f.result=result},e=>{f.error=safe(e)}).finally(()=>first.reject(f.error ?? unavailable()))
      try {
        const url=await first.promise
        signal.throwIfAborted()
        f.effect=makeQR(url,exec)
        const qrDataUrl=await f.effect
        f.effect=null
        signal.throwIfAborted()
        if(f.error) throw f.error
        return {flowId:f.id,url,qrDataUrl,expiresAt:f.expiresAt}
      } catch(e) {await drain(f);throw safe(e)}
    },
    async finish(payload) {
      const f=lookup(payload)
      if(f.checking) throw error('auth-busy')
      if(!f.error && !f.result) throw error('auth-pending')
      f.checking=true
      try {
        if(f.error) throw f.error
        if(f.result.kind==='setup') return {kind:'setup'}
        const signal=f.controller.signal
        arm(f,Math.max(1,Math.min(30_000,f.expiresAt-Date.now())),'auth-expired')
        f.effect=run(['--profile',f.profile,'contact','+get-user','--as','user','--format','json',
          '--jq','{ok,identity,dry_run,data:{user:(.data.user | {open_id,tenant_key})}}'],{signal,cliDir})
        const out=json(await f.effect)
        signal.throwIfAborted()
        if(f.expiresAt<=Date.now()) throw error('auth-expired')
        const user=out?.data?.user, tenantId=user?.tenant_key, recipientId=user?.open_id
        if(out?.ok!==true || out.identity!=='user' || out.dry_run===true || recipientId!==f.result.recipientId ||
          !validAdmissionScope({profile:f.profile,tenantId,recipientId})) throw unavailable()
        return {kind:'login',tenantId,recipientId}
      } catch(e) {throw safe(e)} finally {stop(f)}
    },
    async cancel(payload) {await drain(lookup(payload))},
    dispose() {closed=true;if(current) return drain(current)},
  }
}
