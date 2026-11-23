import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createThreadReader } from './thread-context.js'
import { fileKey, imageKey, legacyPostText, postText, renderTextMentions } from './mention-text.js'
import { validAdmissionScope } from './admission.js'
import { replyScopes } from './auth.js'
import { cliExecutable } from './cli-path.js'
import { cliProblem,itemDiagnostic,pollDiagnostic } from './poll-diagnostics.js'

const messages = '/open-apis/im/v1/messages'
const chat = /^oc_[a-zA-Z0-9_-]{1,128}$/
const person = /^ou_[a-zA-Z0-9_-]{1,128}$/
const message = /^om_[a-zA-Z0-9_-]{1,128}$/
const topic = /^omt_[a-zA-Z0-9_-]{1,128}$/
const matches = (re, value) => typeof value === 'string' && re.test(value) && value === value.trim()
export const hasFeishuIdentity = config => config?.enabled === true && validAdmissionScope(config)
class SourceFailure extends Error {}
const failure = (detail,reason,stage,larkCode) => Object.assign(new SourceFailure(detail), {code:'source-unavailable',
  ...(reason ? {reason} : {}),...(stage ? {stage} : {}),...(larkCode !== undefined ? {larkCode} : {})})
const malformed = stage => failure('飞书返回的数据不足以核实来源。','invalid-response',stage)
const validText = text => typeof text==='string' && text.length<=65536 && !!text.trim()
const positiveTime = at => Number.isSafeInteger(at) && at>0
const maxImageBytes = 50*1024*1024
// Feishu search rejects fractional seconds. Widen only the wire range; admission uses the exact milliseconds.
const searchTime = (ms,round) => new Date(round(ms/1000)*1000).toISOString().replace('.000Z','Z')
const groupName = group => typeof group?.name==='string' && group.name.trim().slice(0,256)
const tokenOK = s => typeof s==='string' && !!s.trim() && s.length<=4096
const providerFailure = (error,envelope) => Object.assign(failure('无法使用指定的飞书配置，请核对 CLI、登录及权限。'),cliProblem(error,envelope))
const rows = (data,stage) => { if (!Array.isArray(data?.items)) throw malformed(stage); return data.items }
const json = s => { try { return JSON.parse(s) } catch { return undefined } }
function errorEnvelope(stream) {
  if (!stream) return
  const value=json(stream)
  if (value?.ok === false && value.error) return value
  // The CLI may prepend a human-readable notice to its JSON error on stderr.
  const start=stream.search(/^\s*\{/m)
  if (start>0) { const value=json(stream.slice(start)); if (value?.ok===false && value.error) return value }
}

async function runCli(cliPath, args, input = '', cliDir, cwd) {
  // Never surface CLI stdout/stderr: either stream can contain private information.
  return new Promise((resolve,reject) => {
    const child = execFile(cliExecutable(cliPath), args, {timeout:30_000,maxBuffer:4*1024*1024,windowsHide:true,...(cwd ? {cwd} : {}),
      env:{...process.env,...(cliDir ? {LARKSUITE_CLI_CONFIG_DIR:cliDir} : {}),LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'}}, (err,stdout,stderr) => {
      const out=json(stdout), diagnostic=errorEnvelope(stderr)
      // lark-cli auth check exits 1 for a verified missing scope, not just for process failures.
      const scope=args[5]
      if (err?.code===1 && !err.signal && !err.killed && !diagnostic &&
          args.length===7 && args[0]==='--profile' && args[2]==='auth' && args[3]==='check' &&
          args[4]==='--scope' && args[6]==='--json' && /^[a-z][a-z0-9_.:-]*$/.test(scope) &&
          out?.ok===false && !Object.hasOwn(out,'error') && Array.isArray(out.missing) && out.missing.length===1 &&
          out.missing[0]===scope && (out.granted===null || Array.isArray(out.granted) && !out.granted.length))
        return resolve({ok:false,granted:[],missing:[scope]})
      const problem=diagnostic ?? (out?.ok===false ? out : undefined)
      if (err || problem) return reject(providerFailure(err,problem))
      if (out === undefined) return reject(malformed())
      resolve(out)
    })
    child.stdin.on('error', () => {}) // The exit callback reports an early CLI exit.
    child.stdin.end(input)
  })
}

// The discussion a message belongs to, named by its root message. A native thread reply belongs to its
// thread's root; any other message starts its own discussion, because SuperAgent's in-thread reply roots
// a native thread at that very message. A quoted message is a clue for the Router, not the discussion.
function rootOf(row) {
  // A parent without a root is not a consistent reply.
  if (!matches(message,row.message_id) || row.parent_id && !row.root_id) return null
  if (!row.thread_id) return row.message_id
  if (!matches(topic,row.thread_id)) return null
  return row.root_id ? (matches(message,row.root_id) ? row.root_id : null) : row.message_id
}
// Whether a verified row may be named by a recorded discussion: its own message (it later became a
// thread root), the root above it, or the quoted root that older records used for a flat reply.
const belongs = (row,threadId) => matches(message,threadId) && !(row?.parent_id && !row.root_id) &&
  (row?.message_id===threadId || row?.root_id===threadId)

function mention(row, scope, group, claimed) {
  const {tenantId,recipientId,chatId} = scope
  const sender = row?.sender
  const threadId = row && (claimed===undefined ? rootOf(row) : belongs(row,claimed) ? claimed : null)
  if (!threadId || !matches(chat,chatId) || row.chat_id !== chatId || !matches(message,row.message_id) ||
      row.deleted !== false || !['text','post'].includes(row.msg_type) || row.upper_message_id ||
      sender?.sender_type !== 'user' || sender.id_type !== 'open_id' ||
      !matches(person,sender.id)) return null
  if (group?.peerId && !(Number(row.create_time)>group.privateSince)) return null
  const inbound=group?.peerId && sender.id===group.peerId && sender.id!==recipientId
  if (!inbound && (group?.peerId && sender.id!==recipientId || sender.tenant_key!==tenantId ||
    !Array.isArray(row.mentions) || !row.mentions.some(m=>m?.id_type==='open_id' && m.id===recipientId && m.tenant_key===tenantId))) return null
  return {chatId,threadId,messageId:row.message_id,at:Number(row.create_time),senderId:sender.id,...(sender.id===recipientId ? {ownerSelfMention:true} : {})}
}

function messageText(row,scope,legacy=false) {
  let previous=null
  try {
    const body=JSON.parse(row.body?.content), mentions=row.mentions ?? [], post=row.msg_type==='post'
    const original=post ? legacyPostText(body,mentions) : body.text
    if (!validText(original)) return null
    previous=original
    if (legacy) return previous
    const text=post ? postText(body,mentions,scope) : renderTextMentions(previous,mentions,scope)
    // Formatting a long name must not truncate a request or change whether it can be received.
    return validText(text) ? text : previous
  } catch { return previous }
}

const peerFields = group => group?.peerId ? {privatePeerId:group.peerId,privateChatsSince:group.privateSince} : {}
function envelope(row, scope, group, displayScope, claimed) {
  const ref=mention(row,scope,group,claimed)
  if (!ref) return null
  const text=messageText(row,displayScope)
  if (!text) return null
  return {...scope,...peerFields(group),threadId:ref.threadId,messageId:ref.messageId,senderId:row.sender.id,text}
}

// Private Host adapter. No event listener, public ingress, credential or implicit send permission.
export function createFeishuSource({config = {}, cliDir, admission, scopeForGrant, receive, isSentMessage=()=>false, onPollWarning=()=>{}, run = runCli.bind(null,config.cliPath), check=()=>{}}) {
  const {profile,tenantId,recipientId} = config
  const enabled = config.enabled === true
  const configured = hasFeishuIdentity(config) && typeof admission?.run === 'function'
  let state = !enabled ? 'disabled' : configured ? 'unverified' : 'error'
  const automated=configured && Number.isSafeInteger(config.automationSince) && config.automationSince>0
  let detail = !enabled ? '飞书来源未启用。' : !configured ? '请配置飞书身份与群准入。' :
    automated ? '自动查找内部群及与自己的聊天中直接 @本人的新消息。' : '当前为只读绑定；重新授权后才能自动办理并回复。'
  const status = () => ({state,detail,automationEnabled:automated,canDeliver:automated,canReply:automated})
  async function cli(args, input, stage='poll') {
    check()
    let out
    try {
      out = await run(['--profile',profile,...args,'--as','user','--format','json'],input,cliDir)
      if (out?.ok===false) throw providerFailure(undefined,out)
    } catch (err) {
      const d=pollDiagnostic(err,stage)
      throw failure('无法使用指定的飞书配置，请核对 CLI、登录及权限。',d.reason==='unknown' ? 'cli-failed' : d.reason,stage,d.larkCode)
    }
    check()
    if (out?.ok !== true || out.dry_run === true || !out.data || typeof out.data !== 'object') throw malformed(stage)
    if (out.identity !== 'user') throw failure('飞书调用身份未确认为本人。','identity-mismatch',stage)
    return out.data
  }
  function api(method,path,params,body,jq,stage) {
    return cli(['api',method,path,'--params',JSON.stringify(params),...(body ? ['--data',JSON.stringify(body)] : []),...(jq ? ['--jq',jq] : [])],undefined,stage)
  }
  let selfName
  function mentionScope(row) {
    const s=row?.sender, same=s?.sender_type==='user' && s.id_type==='open_id' && s.id===recipientId && s.tenant_key===tenantId
    return {recipientId,tenantId,recipientName:same && typeof s.sender_name==='string' && s.sender_name.trim() ? s.sender_name : selfName}
  }
  async function self() {
    const {user} = await cli(['contact','+get-user','--jq','{ok,identity,dry_run,data:{user:(.data.user | {open_id,tenant_key,name})}}'],undefined,'identity')
    if (user?.open_id !== recipientId || user.tenant_key !== tenantId) throw failure('飞书登录身份与绑定的本人或租户不一致。','identity-mismatch','identity')
    selfName=typeof user.name==='string' ? user.name : undefined
  }
  // This binding's OAuth generation is immutable. A failed lookup is retried on the next poll;
  // no failure (including a missing optional P2P permission) blocks the established group path.
  const selfInfo={chat_mode:'self',name:'与自己的聊天'}
  let selfChatId, p2pScope, triedSelf=false
  async function resolveSelfChat(retry=false) {
    if (!automated || selfChatId || p2pScope===false || triedSelf && !retry) return selfChatId
    triedSelf=true
    try {
      if (!p2pScope) {
        const scope='im:message.p2p_msg:get_as_user'
        check()
        const result=await run(['--profile',profile,'auth','check','--scope',scope,'--json'],undefined,cliDir)
        check()
        if (result?.ok===false && !result.error && Array.isArray(result.missing) && result.missing.length===1 && result.missing[0]===scope &&
          (result.granted===null || Array.isArray(result.granted) && !result.granted.length)) {
          p2pScope=false
          throw failure('尚未授权读取与自己的聊天。','permission-denied','group')
        }
        if (result?.ok!==true || !Array.isArray(result.granted) || !result.granted.includes(scope) ||
          !(result.missing===null || Array.isArray(result.missing) && !result.missing.length)) throw malformed('group')
        p2pScope=true
      }
      const data=await api('POST','/open-apis/im/v1/chat_p2p/batch_query',{chatter_id_type:'open_id'},{chatter_ids:[recipientId]},
        '{ok,identity,dry_run,data:{p2p_chats:[.data.p2p_chats[]|{chat_id,chatter_id1,chatter_id2}]}}','group')
      const list=data.p2p_chats
      if (Array.isArray(list) && !list.length) return
      if (!Array.isArray(list) || list.length!==1 || list[0]?.chatter_id1!==recipientId || list[0].chatter_id2!==recipientId ||
        !matches(chat,list[0].chat_id)) throw malformed('group')
      return selfChatId=list[0].chat_id
    } catch(err) {
      check()
      await onPollWarning(err,'group')
    }
  }
  const hasPeer = proof => proof?.privatePeerId!==undefined || proof?.privateChatsSince!==undefined
  const privateEpoch = () => automated && config.allowPrivateChats===true && positiveTime(config.privateChatsSince) ? config.privateChatsSince : 0
  function checkPrivate(group) {
    check()
    if (group?.privateSince!==undefined && (!privateEpoch() || privateEpoch()!==group.privateSince))
      throw failure('私聊读取许可已变更。','admission-denied','group')
  }
  async function peerMappings(peers,epoch) {
    const allowed=new Set(peers), proof={privateSince:epoch}, pairs=new Map()
    checkPrivate(proof)
    if (!allowed.size) return pairs
    if (allowed.size>50 || [...allowed].some(id=>id===recipientId || !matches(person,id))) throw malformed('group')
    const data=await api('POST','/open-apis/im/v1/chat_p2p/batch_query',{chatter_id_type:'open_id'},{chatter_ids:[...allowed]},
      '{ok,identity,dry_run,data:{p2p_chats:[.data.p2p_chats[]|{chat_id,chatter_id1,chatter_id2}]}}','group')
    checkPrivate(proof)
    if (!Array.isArray(data.p2p_chats)) throw malformed('group')
    const owners=new Map()
    for (const r of data.p2p_chats) {
      const peer=r?.chatter_id1===recipientId ? r.chatter_id2 : r?.chatter_id2===recipientId ? r.chatter_id1 : undefined
      if (!allowed.has(peer) || !matches(chat,r.chat_id) || r.chat_id===selfChatId) continue
      if (pairs.has(peer) && pairs.get(peer)!==r.chat_id || owners.has(r.chat_id) && owners.get(r.chat_id)!==peer) throw malformed('group')
      pairs.set(peer,r.chat_id);owners.set(r.chat_id,peer)
    }
    return pairs
  }
  async function conversation(chatId,proof={}) {
    if (hasPeer(proof)) {
      const {privatePeerId:peerId,privateChatsSince:privateSince}=proof, group={chat_mode:'p2p',peerId,privateSince}
      if (!matches(person,peerId) || peerId===recipientId || !positiveTime(privateSince)) throw malformed('group')
      checkPrivate(group)
      await resolveSelfChat(true)
      checkPrivate(group)
      if (p2pScope!==true) throw failure('未确认读取私聊权限。','permission-denied','group')
      return (await peerMappings([peerId],privateSince)).get(peerId)===chatId ? group : null
    }
    return chatId===await resolveSelfChat() ? selfInfo : internalGroup(chatId)
  }
  async function internalGroup(chatId) {
    try {
      const group = await cli(['im','chats','get','--chat-id',chatId,'--jq','{ok,identity,dry_run,data:(.data | {chat_mode,group_message_type,chat_status,external,tenant_key,name})}'],undefined,'group')
      return ['group','topic'].includes(group.chat_mode) && (group.chat_status==null || group.chat_status==='normal') &&
        group.external===false && group.tenant_key===tenantId ? group : null
    } catch(err) {
      // Invalid chat, different tenant, no longer a member, or external group: skip only this candidate.
      if ([232006,232010,232011,232033].includes(err?.larkCode)) return null
      throw err
    }
  }
  async function identity(chatId,proof) {
    await self()
    const group=await conversation(chatId,proof)
    if (!group) throw failure('无法确认为本租户内部群或与自己的聊天。','admission-denied','group')
    return group
  }
  // target.senderId, when known, lets a grant for that one member apply; the read then checks the author.
  async function guarded(target, fn, before, useGrantPeer=false) {
    const {chatId,threadId,senderId}=target
    if (!configured) throw failure(detail)
    // A bare omt_ does not establish the owning chat before reading the thread.
    if (!matches(chat,chatId) || (threadId !== undefined && !matches(message,threadId)))
      throw Object.assign(new Error('请指定已批准的群；一次准入须提供 om_ 原话题根消息。'),{code:'invalid-input'})
    const select=scopeForGrant && target.scopeId ? g=>scopeForGrant(g)===target.scopeId : undefined
    return admission.run({chatId,threadId,...(senderId ? {senderId} : {})}, async (grant,eligible) => {
      check()
      before?.(grant,eligible)
      const proof=useGrantPeer ? grant : target
      if (proof.privatePeerId!==grant.privatePeerId || proof.privateChatsSince!==grant.privateChatsSince)
        throw failure('私聊与原准入不匹配。','admission-denied','group')
      if (hasPeer(proof)) checkPrivate({privateSince:proof.privateChatsSince})
      try {
        const group=await identity(chatId,proof)
        checkPrivate(group)
        const result=await fn(grant,group)
        checkPrivate(group)
        return result
      }
      catch (err) {
        state = 'error'
        detail = err instanceof SourceFailure ? err.message : '无法核实本次飞书操作。'
        const d = pollDiagnostic(err,'receive')
        throw failure(detail,d.reason,d.stage,d.larkCode)
      }
    },select)
  }
  // The endpoints have no field mask. Do not import other groups or nested forwarded bodies into the Host.
  const selfSender = chatId => chatId===selfChatId ? ' and .sender.id=='+JSON.stringify(recipientId)+' and .sender.sender_type=="user" and .sender.id_type=="open_id" and .sender.tenant_key=='+JSON.stringify(tenantId) : ''
  const scopedRows = chatId => '{ok,identity,dry_run,data:{items:[.data.items[]|select(.chat_id=='+JSON.stringify(chatId)+
    selfSender(chatId)+' and (.upper_message_id // "")=="")],has_more:.data.has_more,page_token:.data.page_token}}'
  const tenant=JSON.stringify(tenantId), me=JSON.stringify(recipientId)
  // An edit can remove the mention after discovery. Only emit a direct human mention's body from CLI.
  const human='.deleted==false and (.msg_type=="text" or .msg_type=="post") and .sender.sender_type=="user" and .sender.id_type=="open_id"'
  const atMe='(.mentions // [] | arrays | any(.[]; .id_type=="open_id" and .id=='+me+' and .tenant_key=='+tenant+'))'
  const direct=human+' and .sender.tenant_key=='+tenant+' and (.sender.id | strings | test("^ou_[a-zA-Z0-9_-]{1,128}$")) and '+atMe
  const byOwner='.sender.id=='+me+' and .sender.tenant_key=='+tenant+' and '+atMe
  async function exact(id,chatId,threadId,at,group) {
    checkPrivate(group)
    const eligible=group?.peerId ? human+' and (.sender.id=='+JSON.stringify(group.peerId)+' or ('+byOwner+')) and ((.create_time|tonumber?)>'+Math.max(config.automationSince,group.privateSince)+')' : direct
    const sameId=JSON.stringify(id), sameChat=JSON.stringify(chatId), sameRoot=JSON.stringify(threadId)
    // Filter the exact row before it crosses into the Host: GET can include nested/forwarded rows.
    const selection='.chat_id=='+sameChat+' and .message_id=='+sameId+' and (.upper_message_id // "")==""'+selfSender(chatId)+
      (threadId ? ' and '+eligible+' and (.root_id=='+sameRoot+' or .message_id=='+sameRoot+')' : '')+
      (at!==undefined ? ' and (.create_time | tostring)=='+JSON.stringify(String(at)) : '')
    try {
      const items = rows(await api('GET',messages+'/'+id,{user_id_type:'open_id'},undefined,
        '{ok,identity,dry_run,data:{items:[.data.items[] | select('+selection+')]}}','message'),'message')
      checkPrivate(group)
      return items.find(row => row?.message_id===id && row.chat_id===chatId && !row.upper_message_id &&
        (chatId!==selfChatId || row.sender?.id===recipientId && row.sender.sender_type==='user' && row.sender.id_type==='open_id' && row.sender.tenant_key===tenantId))
    } catch(err) {
      if (err?.larkCode!==230110) throw err // A deleted message cannot become actionable on retry.
    }
  }
  function pageCursor(data,previous,stage) {
    if(data.has_more!==true) return undefined
    const token=data.page_token
    if(!tokenOK(token) || token===previous) throw malformed(stage)
    return token
  }
  const metadataRows=(onlyPrivate=false)=>'{ok,identity,dry_run,data:{items:[.data.items[]|'+(onlyPrivate ? 'select(.sender.id!='+me+' or ('+human+' and '+byOwner+'))|' : '')+
    '{message_id,chat_id,thread_id,root_id,parent_id,upper_message_id,msg_type,deleted,create_time,'+
    'sender:(.sender|{id,id_type,sender_type,tenant_key}),mentions:[.mentions[]?|{id,id_type,tenant_key}]}]}}'
  // Only SuperAgent's own posts are left out. A reply to its question is a new request only when it @s the owner.
  const excluded=async row=>row.sender.id===recipientId && await isSentMessage(row.chat_id,row.message_id)
  // Only for verified owner self-mention candidates: a sender cannot identify the *other* participant.
  async function partnerIds(chatIds,epoch) {
    const ids=[...new Set(chatIds)], partners=new Map()
    if (!ids.length) return partners
    checkPrivate({privateSince:epoch})
    const detail=await api('POST','/open-apis/im/v1/chats/batch_query',{user_id_type:'open_id'},{chat_ids:ids},
      '{ok,identity,dry_run,data:{items:[.data.items[]|{chat_id,chat_mode,p2p_target_type,p2p_target_id}]}}','group')
    checkPrivate({privateSince:epoch})
    for (const r of rows(detail,'group')) {
      if (!ids.includes(r?.chat_id) || r.chat_mode!=='p2p' || (r.p2p_target_type!=null && r.p2p_target_type!=='user') ||
          !matches(person,r.p2p_target_id) || r.p2p_target_id===recipientId) continue
      if (partners.has(r.chat_id) && partners.get(r.chat_id)!==r.p2p_target_id) throw malformed('group')
      partners.set(r.chat_id,r.p2p_target_id)
    }
    return partners
  }
  // Separate cursor from direct mentions. When off, this path does not query any other private chat.
  async function privatePage({since,until,pageToken},allowedChat) {
    const epoch=privateEpoch()
    if (!epoch) return {mentions:[]}
    if (!positiveTime(since) || !positiveTime(until) || until>8.64e15 || until<since || pageToken!==undefined && !tokenOK(pageToken)) throw malformed('search')
    since=Math.max(since,config.automationSince,epoch)
    if (since>=until) return {mentions:[]}
    const proof={privateSince:epoch}
    await self()
    checkPrivate(proof)
    await resolveSelfChat(true)
    checkPrivate(proof)
    if (p2pScope!==true) throw failure('未确认读取私聊权限。','permission-denied','group')
    const filter={chat_type:'p2p',from_types:['user'],...(allowedChat ? {chat_ids:[allowedChat]} : {}),
      time_range:{start_time:searchTime(since,Math.floor),end_time:searchTime(until,Math.ceil)}}
    const projection='{ok,identity,dry_run,data:{items:[.data.items[].meta_data|select(.is_p2p_chat==true'+
      (selfChatId ? ' and .chat_id!='+JSON.stringify(selfChatId) : '')+')|{meta_data:{message_id,chat_id,is_p2p_chat,from_id}}],has_more:.data.has_more,page_token:.data.page_token}}'
    const hits=await api('POST',messages+'/search',{page_size:50,...(pageToken ? {page_token:pageToken} : {})},{query:'',filter},projection,'search')
    checkPrivate(proof)
    const page=rows(hits,'search'),next=pageCursor(hits,pageToken,'search'), candidates=new Map()
    if (page.length>50) throw malformed('search')
    for (const {meta_data:m} of page) {
      if (m?.is_p2p_chat!==true || !matches(chat,m.chat_id) || m.chat_id===selfChatId || allowedChat && m.chat_id!==allowedChat ||
          !matches(message,m.message_id)) continue
      if (candidates.has(m.message_id)) throw malformed('search')
      candidates.set(m.message_id,m)
    }
    // A returned open_id allows us to verify the pair before even requesting message metadata.
    const pairs=await peerMappings([...candidates.values()].map(m=>m.from_id).filter(id=>id!==recipientId && matches(person,id)),epoch)
    const ids=[...candidates].filter(([,m])=>!matches(person,m.from_id) || m.from_id===recipientId || pairs.get(m.from_id)===m.chat_id).map(([id])=>id)
    checkPrivate(proof)
    const data=ids.length ? rows(await api('GET',messages+'/mget',{message_ids:ids,user_id_type:'open_id'},undefined,metadataRows(true),'metadata'),'metadata') : []
    checkPrivate(proof)
    const eligible=[]
    for (const row of data) {
      const m=candidates.get(row?.message_id), author=row?.sender?.id, at=Number(row?.create_time)
      if (!m || !ids.includes(row.message_id) || row.chat_id!==m.chat_id || !matches(person,author) ||
          matches(person,m.from_id) && author!==m.from_id || !positiveTime(at) || at<=since || at>until) continue
      const ref=mention(row,{chatId:m.chat_id,tenantId,recipientId},author===recipientId ? undefined : {peerId:author,privateSince:epoch})
      if (ref && !await excluded(row)) eligible.push({author,ref})
      checkPrivate(proof)
    }
    const partners=await partnerIds(eligible.filter(c=>c.ref.ownerSelfMention).map(c=>c.ref.chatId),epoch)
    const other=await peerMappings([...eligible.filter(c=>!c.ref.ownerSelfMention).map(c=>c.author),...partners.values()].filter(id=>!pairs.has(id)),epoch)
    const seen=new Set(),mentions=[]
    for (const {ref,author} of eligible) {
      const peerId=ref.ownerSelfMention ? partners.get(ref.chatId) : author
      if (!peerId || (pairs.get(peerId) ?? other.get(peerId))!==ref.chatId || seen.has(ref.messageId)) continue
      seen.add(ref.messageId)
      mentions.push({...ref,privatePeerId:peerId,privateChatsSince:epoch})
    }
    checkPrivate(proof)
    return {mentions:mentions.sort((a,b)=>a.at-b.at),...(next ? {nextPageToken:next} : {})}
  }
  async function search({chatId,since,until,cursor}) {
    const mine=selfChatId
    const region='(.chat_id | strings | test("^oc_[a-zA-Z0-9_-]{1,128}$")) and '+
      (mine ? '((.is_p2p_chat==false and .chat_id!='+JSON.stringify(mine)+') or (.is_p2p_chat==true and .chat_id=='+JSON.stringify(mine)+'))' : '.is_p2p_chat==false')
    const projectionHits=chatId ? '[.data.items[]|{meta_data:{message_id:.meta_data.message_id}}]' :
      '[.data.items[].meta_data|select('+region+')|{meta_data:{message_id,chat_id,is_p2p_chat}}]'
    const hits = await api('POST',messages+'/search',{page_size:50,...cursor},{query:'',filter:{
      ...(chatId ? {chat_ids:[chatId],chat_type:chatId===mine ? 'p2p' : 'group'} : mine ? {} : {chat_type:'group'}),from_types:['user'],at_chatter_ids:[recipientId],
      ...(since ? {time_range:{start_time:searchTime(since,Math.floor),...(until ? {end_time:searchTime(until,Math.ceil)} : {})}} : {})}},
      '{ok,identity,dry_run,data:{items:'+projectionHits+',has_more:.data.has_more,page_token:.data.page_token}}','search')
    const next=pageCursor(hits,cursor.page_token,'search')
    const allowed=new Map(), found=rows(hits,'search')
    if (found.length>50) throw malformed('search')
    for (const hit of found) {
      const m=hit?.meta_data
      if (!chatId && (!matches(chat,m?.chat_id) || (m.chat_id===mine ? m.is_p2p_chat!==true : m.is_p2p_chat!==false))) continue
      if (!matches(message,m?.message_id) || allowed.has(m.message_id) && allowed.get(m.message_id)!==(chatId || m.chat_id)) throw malformed('search')
      allowed.set(m.message_id,chatId || m.chat_id)
    }
    const ids=[...allowed.keys()]
    // No API field mask: without an approved chat, strip bodies and display text inside the CLI.
    const projection=chatId ? scopedRows(chatId) : metadataRows()
    async function fetch(batch) {
      if (!batch.length) return []
      return rows(await api('GET',messages+'/mget',{message_ids:batch,user_id_type:'open_id'},undefined,projection,'metadata'),'metadata')
        .filter(row => matches(chat,row?.chat_id) && batch.includes(row.message_id) && allowed.get(row.message_id)===row.chat_id &&
          (row.chat_id!==mine || row.sender?.id===recipientId))
    }
    let items
    try {items=await fetch(ids)}
    catch(err) {
      const groups=ids.filter(id=>allowed.get(id)!==mine)
      if (chatId || groups.length===ids.length || err?.reason!=='permission-denied' && err?.larkCode!==230027) throw err
      // An OAuth scope can be revoked after the cached proof. Retry only already-filtered group IDs.
      selfChatId=undefined;p2pScope=undefined
      await onPollWarning(err,'metadata')
      items=await fetch(groups)
    }
    return {items,more:!!next,next}
  }
  async function threadRows(chatId,threadId,since,cursor) {
    // Resolving this explicitly approved message may return its body; never follow a mismatched root.
    const root = await exact(threadId,chatId)
    if (!root || root.chat_id !== chatId || root.sender?.tenant_key !== tenantId || rootOf(root) !== threadId)
      throw failure('无法核实该根消息属于获准的群与话题。','invalid-response','message')
    const container = root.thread_id
    if (!container) return {items:[root],more:false}
    if (!matches(topic,container)) throw malformed()
    const data = await api('GET',messages,{container_id_type:'thread',container_id:container,
      sort_type:'ByCreateTimeDesc',page_size:50,user_id_type:'open_id',...cursor},undefined,scopedRows(chatId))
    const items = rows(data).filter(row => row?.thread_id === container && rootOf(row) === threadId)
    const token=pageCursor(data,cursor.page_token)
    // Thread containers don't accept a time range. Stop descending once this page crosses the cutoff.
    const oldest=Number(items.at(-1)?.create_time)
    const next=since && Number.isSafeInteger(oldest) && oldest>0 && oldest<=since ? undefined : token
    return {items:[root,...items],more:!!next,next}
  }
  function historyLimits() {
    const {historyCount:count=10,historyMinutes:minutes=5}=config
    if (!Number.isInteger(count) || count<0 || count>100 || !Number.isInteger(minutes) || minutes<0 || minutes>1440) throw malformed()
    return {count,minutes}
  }
  const {addHistory}=createThreadReader({api,config,pageCursor,mentionScope,check,checkPrivate,failure})
  function validateRef(ref) {
    if (!automated) throw failure('未完成自动办理授权。')
    if (!matches(chat,ref?.chatId) || !matches(message,ref.threadId) || !matches(message,ref.messageId) || !positiveTime(ref.at)) throw malformed()
  }
  function ownerTrigger(grant,id) {return grant?.triggers?.find(t=>t.messageId===id && t.ownerSelfMention===true)}
  function stillOwnerRequest(grant,row,event) {
    const trigger=ownerTrigger(grant,event.messageId)
    return !trigger || event.senderId===recipientId && event.threadId===trigger.threadId && Number(row.create_time)===trigger.at
  }
  async function exactEvent({chatId,threadId,messageId,at,ownerSelfMention},group,grant) {
    const row=await exact(messageId,chatId,threadId,at,group)
    const event=envelope(row,{chatId,tenantId,recipientId},group,mentionScope(row),threadId)
    if (!event || event.threadId!==threadId || Number(row.create_time)!==at || ownerSelfMention===true && event.senderId!==recipientId ||
        grant?.mode==='sender' && event.senderId!==grant.senderId ||
        !stillOwnerRequest(grant,row,event) || await excluded(row)) return null
    checkPrivate(group)
    return {row,event}
  }
  // One image or file of a verified job conversation. The CLI writes into a private directory that is
  // removed once `use` has read it; a recalled message or a refused download leaves only the marker.
  async function download(messageId,key,type,use) {
    const dir=await realpath(await mkdtemp(join(tmpdir(),'superagent-'+type+'-')))
    try {
      check()
      let out
      try {
        out=await run(['--profile',profile,'im','+messages-resources-download','--message-id',messageId,'--file-key',key,
          '--type',type,'--output',type,'--as','user','--format','json'],undefined,cliDir,dir)
      } catch { return null }
      check()
      if (out?.ok!==true || out.identity!=='user' || typeof out.data?.saved_path!=='string') return null
      const path=await realpath(out.data.saved_path).catch(()=>null), info=path && await stat(path)
      if (!info || dirname(path)!==dir || !info.isFile() || type==='image' && info.size>maxImageBytes) return null
      return await use(path)
    } finally { await rm(dir,{recursive:true,force:true}) }
  }
  function inGrant(grant,{messageId,threadId,at}) {
    return positiveTime(at) && at>config.automationSince && (at>(grant.approvedAt ?? 0) ||
      grant.triggers?.some(t=>t.messageId===messageId && t.threadId===threadId && t.at===at))
  }
  return {
    status,
    // Images of a job's conversation, under the job's current grant; null for each one not obtained.
    async images({source,requesterId,refs},checkGrant) {
      if (!automated || source?.kind!=='feishu' || source.tenantId!==tenantId || source.recipientId!==recipientId ||
        !matches(message,source.threadId) || !Array.isArray(refs) || refs.length>100 ||
        !refs.every(r=>matches(message,r?.messageId) && imageKey(r.key)) || typeof checkGrant!=='function') throw malformed('message')
      return guarded({...source,...(matches(person,requesterId) ? {senderId:requesterId} : {})},async (grant,group)=>{
        const out=[]
        for (const r of refs) {
          checkGrant(grant);checkPrivate(group)
          out.push(await download(r.messageId,r.key,'image',path=>readFile(path)))
        }
        return out
      },checkGrant)
    },
    // Files of a job's conversation, under the job's current grant. `use(index,path)` reads each file while
    // it exists; the result is null for a file not obtained.
    async files({source,requesterId,refs},checkGrant,use) {
      if (!automated || source?.kind!=='feishu' || source.tenantId!==tenantId || source.recipientId!==recipientId ||
        !matches(message,source.threadId) || !Array.isArray(refs) || refs.length>100 ||
        !refs.every(r=>matches(message,r?.messageId) && fileKey(r.key)) || typeof checkGrant!=='function' || typeof use!=='function') throw malformed('message')
      return guarded({...source,...(matches(person,requesterId) ? {senderId:requesterId} : {})},async (grant,group)=>{
        const out=[]
        for (const [i,r] of refs.entries()) {
          checkGrant(grant);checkPrivate(group)
          out.push(await download(r.messageId,r.key,'file',path=>use(i,path)))
        }
        return out
      },checkGrant)
    },
    async groupName(chatId) {
      if (!automated) throw failure('未完成自动办理授权。')
      if (!matches(chat,chatId)) throw malformed()
      await self()
      return groupName(await conversation(chatId)) || null
    },
    discoverPrivate:request=>privatePage(request),
    async discover({since,until,pageToken}) {
      if (!automated) throw failure('未完成自动办理授权。')
      if (!positiveTime(since) || !positiveTime(until) || until<since || since<config.automationSince ||
          until>8.64e15 || (pageToken!==undefined && !tokenOK(pageToken))) throw malformed()
      await self()
      await resolveSelfChat(true)
      const {items,next}=await search({since,until,cursor:pageToken ? {page_token:pageToken} : {}})
      const mentions=[], groups=new Map(), seen=new Set()
      for (const row of items) {
        const ref=mention(row,{chatId:row?.chat_id,tenantId,recipientId})
        if (!ref || !positiveTime(ref.at) || ref.at<=since || ref.at>until || seen.has(ref.messageId)) continue
        if (!groups.has(ref.chatId)) groups.set(ref.chatId,ref.chatId===selfChatId ? selfInfo : await internalGroup(ref.chatId))
        const group=groups.get(ref.chatId)
        if (!group || await excluded(row)) continue
        seen.add(ref.messageId)
        const name=groupName(group)
        mentions.push(name ? {...ref,name} : ref)
      }
      state='ready'
      detail='已核实当前账号并查找了直接 @本人的消息。'
      return {mentions:mentions.sort((a,b)=>a.at-b.at),...(next ? {nextPageToken:next} : {})}
    },
    // Reading one's mentions is not authorization to dispatch a task or reply.
    async readMention(ref,{legacyText=false}={}) {
      validateRef(ref)
      const {chatId,threadId,messageId,at}=ref
      if (at<=config.automationSince || hasPeer(ref) && (!privateEpoch() || privateEpoch()!==ref.privateChatsSince || at<=ref.privateChatsSince)) return null
      await self()
      const group=await conversation(chatId,ref)
      if (!group) return null
      const verified=await exactEvent(ref,group)
      if (!verified) return null
      const name=groupName(group)
      checkPrivate(group)
      const {row,event}=verified
      // Raw GET echoes creation time as update_time even on unedited messages.
      const unchanged=(row.updated==null || row.updated===false) && (row.update_time==null || row.update_time==='' ||
        row.update_time===0 || row.update_time==='0' || String(row.update_time)===String(row.create_time))
      const old=legacyText===true && unchanged ? messageText(row,undefined,true) : null
      return {chatId,threadId,messageId,at,senderId:event.senderId,text:event.text,...(old && old!==event.text ? {legacyText:old} : {}),...peerFields(group),...(verified.event.senderId===recipientId ? {ownerSelfMention:true} : {}),...(name ? {name} : {})}
    },
    async consumeMention(ref,recordedText,checkGrant) {
      validateRef(ref)
      if (recordedText!==undefined && !validText(recordedText)) throw malformed()
      const limits=historyLimits()
      if (hasPeer(ref) && (!privateEpoch() || privateEpoch()!==ref.privateChatsSince || ref.at<=ref.privateChatsSince)) return {accepted:0}
      return guarded(ref,async (grant,group)=>{
        if (!inGrant(grant,ref)) return {accepted:0}
        try {
          const verified=await exactEvent(ref,group,grant)
          if (!verified || ref.senderId && verified.event.senderId!==ref.senderId) return {accepted:0}
          const {row,event}=verified
          // Dispatch the version the owner saw, but only while this exact message remains eligible.
          if (recordedText!==undefined) event.text=recordedText
          await addHistory(event,row,grant,group,limits)
          checkPrivate(group)
          await receive(event,grant)
          return {accepted:1}
        } catch (error) {
          // The scanner can defer this exact item; identity and admission failures stay outside this path.
          const intakeFailure=checkGrant && itemDiagnostic(error)
          if (!intakeFailure) throw error
          return {accepted:0,intakeFailure}
        }
      },checkGrant)
    },
    async assertAllowed(target,before) {
      if (!automated) throw failure('未完成自动办理授权。')
      return guarded(target,()=>{},before)
    },
    async sync({chatId,threadId}, plan=()=>({})) {
      const limits=automated && historyLimits()
      return guarded({chatId,threadId}, async (grant,group) => {
        const {since,pageToken}=plan(grant), cursor=pageToken ? {page_token:pageToken} : {}
        const seen = new Set(), cases=[]
        let items,more,next
        if (group.peerId) {
          const page=await privatePage({since:Math.max(since ?? 0,group.privateSince),until:Date.now(),pageToken},chatId)
          checkPrivate(group)
          next=page.nextPageToken;more=!!next;items=[]
          for (const ref of page.mentions) {
            if (ref.privatePeerId!==group.peerId || ref.privateChatsSince!==group.privateSince || threadId && ref.threadId!==threadId || !inGrant(grant,ref)) continue
            const verified=await exactEvent(ref,group,grant)
            if (!verified) continue
            await addHistory(verified.event,verified.row,grant,group,limits)
            checkPrivate(group)
            const item=await receive(verified.event,grant)
            if (typeof item?.id==='string') cases.push({caseId:item.id,messageId:ref.messageId})
            seen.add(ref.messageId)
          }
        } else ({items,more,next}=threadId ? await threadRows(chatId,threadId,since,cursor) : await search({chatId,since,cursor}))
        for (const row of items.sort((a,b) => Number(a?.create_time)-Number(b?.create_time))) {
          let event = envelope(row,{chatId,tenantId,recipientId},group,mentionScope(row),threadId)
          const at=Number(row?.create_time)
          if (!event || seen.has(event.messageId) || since && (!Number.isSafeInteger(at) || at<=since)) continue
          if (!automated && await excluded(row)) continue
          if (automated) {
            const ref={...event,at}
            if (!inGrant(grant,ref)) continue
            const verified=await exactEvent(ref,group,grant)
            if (!verified) continue
            event=verified.event
            await addHistory(event,verified.row,grant,group,limits)
          }
          const item=await receive(event,grant)
          if(typeof item?.id==='string') cases.push({caseId:item.id,messageId:event.messageId})
          seen.add(event.messageId)
        }
        state = 'ready'
        detail = more ? '已验证；本次仅处理一页，仍有未读取的匹配项。' : '已核实当前账号与群，已同步本次匹配的消息。'
        return {accepted:seen.size,cases,status:status(),...(next ? {nextPageToken:next} : {})}
      },undefined,true)
    },
    // Private Host path: original target from the durable job; reviewed text is never parsed as a file or URL.
    async reply({source,messageId,text,idempotencyKey,signal,requesterId},before) {
      if (!automated || source?.kind !== 'feishu' ||
          source.tenantId !== tenantId || source.recipientId !== recipientId ||
          !matches(message,messageId) || !matches(message,source.threadId) ||
          typeof text !== 'string' || !text.trim() || text.length > 65536 || /<at(?:\s|>)/i.test(text) || !matches(/^[\w-]{1,50}$/,idempotencyKey))
        throw failure('未获准向该来源回复。')
      const {chatId,threadId} = source
      let attempted=false
      try {return await guarded({...source,...(matches(person,requesterId) ? {senderId:requesterId} : {})},async (grant,group) => {
        check()
        const perm=await run(['--profile',profile,'auth','check','--scope',replyScopes.join(' '),'--json'],undefined,cliDir)
        if(perm?.ok!==true || !Array.isArray(perm.granted) || !replyScopes.every(s=>perm.granted.includes(s)) ||
          !(perm.missing===null || Array.isArray(perm.missing) && !perm.missing.length)) throw failure('没有本人发送权限。')
        checkPrivate(group)
        const row=await exact(messageId,chatId,threadId,undefined,group)
        const event = envelope(row,{chatId,tenantId,recipientId},group,mentionScope(row),threadId)
        if (event?.threadId!==threadId || grant.mode==='sender' && event.senderId!==grant.senderId ||
            !stillOwnerRequest(grant,row,event) || await excluded(row)) throw failure('不能核实原消息与话题，未发送。')
        if (!inGrant(grant,{messageId,threadId,at:Number(row.create_time)})) throw failure('原消息早于此次授权。')
        signal?.throwIfAborted()
        checkPrivate(group)
        attempted=true
        const data = await cli(['im','+messages-reply','--message-id',messageId,...(group===selfInfo || group.peerId ? [] : ['--reply-in-thread']),
          '--msg-type','text','--content','-','--idempotency-key',idempotencyKey],JSON.stringify({text}))
        if (!matches(message,data.message_id) || data.message_id === messageId || data.chat_id !== chatId)
          throw failure('缺少匹配原群的发送回执，交付状态未确认。')
        return {chatId,messageId:data.message_id,inReplyTo:messageId}
      },before)} catch(e) {
        if(attempted) throw Object.assign(new Error('交付状态未确认，不会重发。'),{code:'delivery-uncertain'})
        throw e
      }
    },
  }
}
