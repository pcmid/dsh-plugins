// Private source adapter: no browser route, chat discovery, resource downloads, or model calls.
import {postText,renderTextMentions} from './mention-text.js'

const messages='/open-apis/im/v1/messages', maxContext=262144
const q=JSON.stringify, mid=s=>typeof s==='string' && /^om_[\w-]{1,128}$/.test(s), tid=s=>typeof s==='string' && /^omt_[\w-]{1,128}$/.test(s)
const time=t=>Number.isSafeInteger(Number(t)) && Number(t)>0
const noParents='((.root_id // "")=="" and (.parent_id // "")=="")'
const meta='{chat_id,message_id,thread_id,root_id,parent_id,upper_message_id,create_time,update_time,updated,deleted,msg_type,sender:(.sender|{id,id_type,sender_type,tenant_key})}'
const human='.deleted==false and (.msg_type=="text" or .msg_type=="post") and .sender.sender_type=="user" and .sender.id_type=="open_id" and (.sender.id | strings | test("^ou_[a-zA-Z0-9_-]{1,128}$"))'
const speech='(. as $m | (.body.content|fromjson?) as $b | if .msg_type=="text" then $b.text else '+
  '($b.content|arrays|select(all(.[]; type=="array"))) as $lines | [($b.title|strings),($lines[]|map('+
  'if .tag=="text" or .tag=="code_block" then (.text|strings) elif .tag=="a" then '+
  '(.text // "") as $l | (.href // "") as $h | if $l!="" and $h!="" and $l!=$h then "["+$l+"]("+$h+")" elif $l!="" then $l else $h end '+
  'elif .tag=="at" and (.user_id|type)=="string" then .user_id as $id | (.user_name // first($m.mentions[]?|select(.key==$id)|.name) // "") as $n | '+
  'if $n!="" then "@"+$n else $id end else "" end)|join("")|select(length>0))]|join([10]|implode) end | strings|select(test("[^[:space:]]")))'
// Only speech-bearing parts survive. Never run a plain-text tokenizer over flattened links or code.
const cleanPost='{title:(.title | strings // ""),content:[.content[]|map('+
  'if (.tag=="text" or .tag=="code_block") and (.text|type)=="string" then {tag,text} '+
  'elif .tag=="a" then {tag,text:(.text|strings // ""),href:(.href|strings // "")} '+
  'elif .tag=="at" and (.user_id|type)=="string" then {tag,user_id:(if (.user_name|strings // ""|test("[^[:space:]]")) and (.user_id|test("^@_user_[0-9]+$")|not) then "" else .user_id end),user_name:(.user_name|strings // "")} else empty end)]}'
const sameRoot=root=>'.message_id=='+q(root)+' and '+noParents
const rootRow=(r,root)=>r.message_id===root && !r.root_id && !r.parent_id
const flatRow=r=>!r.thread_id && !r.root_id && !r.parent_id
const sameThread=(r,root,container)=>r.thread_id===container && (r.root_id===root || rootRow(r,root))
const textual=r=>r.deleted===false && ['text','post'].includes(r.msg_type) && r.sender?.sender_type==='user' &&
  r.sender.id_type==='open_id' && /^ou_[\w-]{1,128}$/.test(r.sender.id)
const order=(a,b)=>a.at-b.at || a.id.localeCompare(b.id)

export function createThreadReader({api,config,pageCursor,mentionScope,check,checkPrivate,failure}) {
  const {recipientId,tenantId}=config
  const isMe='.id_type=="open_id" and .id=='+q(recipientId)+' and .tenant_key=='+q(tenantId)
  const display=speech+' as $s | (.body.content|fromjson?) as $b | '+
    '([if .msg_type=="text" then $s|scan("@_user_[A-Za-z0-9_]+") else $b.content[][]|select(.tag=="at")|.user_id|strings end | select(test("^@_user_[0-9]+$"))] | unique) as $keys | '+
    '[.mentions[]? | .key as $k | select(($k|type)=="string" and ($keys|index($k))!=null) | '+
    '{key,name:(.name|strings // "")} + (if '+isMe+' then {id,id_type,tenant_key} else {} end)] as $mentions | '+
    '(if .msg_type=="text" then {speech:$s} else {post:($b|'+cleanPost+'),speechSize:($s|length)} end) + {mentions:$mentions} + '+
    '(if ($keys|length)>0 and (.sender|'+isMe+') and (.sender.sender_name|type)=="string" then {sender:(.sender|{id,id_type,sender_type,tenant_key,sender_name})} else {} end)'
  const fields=meta+' + ('+display+')'
  const bad=(message='无法核实完整的飞书话题或分页。')=>failure(message,'invalid-response','history')
  const tooLarge=()=>failure('飞书上下文过大，未提交不完整的内容办理。','context-too-large','history')
  function scope(chatId,group) {
    const mine='.sender.id=='+q(recipientId)+' and .sender.tenant_key=='+q(tenantId)
    const who=group.chat_mode==='p2p' ? '(('+mine+') or .sender.id=='+q(group.peerId)+')' :
      group.chat_mode==='self' ? '('+mine+')' : '.sender.tenant_key=='+q(tenantId)
    return {
      jq:'.chat_id=='+q(chatId)+' and (.message_id | strings | test("^om_[a-zA-Z0-9_-]{1,128}$")) and (.upper_message_id // "")=="" and ('+who+')',
      ok:r=>r?.chat_id===chatId && mid(r.message_id) && !r.upper_message_id && (group.chat_mode==='p2p' ?
        r.sender?.id===group.peerId || r.sender?.id===recipientId && r.sender.tenant_key===tenantId :
        r.sender?.tenant_key===tenantId && (group.chat_mode!=='self' || r.sender.id===recipientId)),
    }
  }
  function rowText(row) {
    const binding=mentionScope(row)
    const mentions=row.mentions ?? []
    if (typeof row.speech==='string') return renderTextMentions(row.speech,mentions,binding)
    // Recheck raw adapter responses too. No image/file expansion, URL fetches or arbitrary post fields.
    let b=row.post
    if (!b) try {b=JSON.parse(row.body?.content)} catch {return null}
    return row.msg_type==='post' ? postText(b,mentions,binding) : typeof b?.text==='string' ? renderTextMentions(b.text,mentions,binding) : null
  }
  async function get(group,path,params,projection) {
    check();checkPrivate(group)
    const data=await api('GET',path,params,undefined,projection,'history')
    check();checkPrivate(group)
    if (data?.too_large) throw tooLarge()
    if (!Array.isArray(data?.items)) throw bad()
    return data
  }
  // Bound transfer without silently shortening any selected text. Pages that cannot fit are reported.
  const envelope=(items,paged)=>'{ok,identity,dry_run,data:(('+items+') as $i | if ([$i[]|(.speechSize // (.speech // ""|length))]|add // 0)>'+maxContext+
    ' then {too_large:true} else {items:$i'+(paged?',has_more:.data.has_more,page_token:.data.page_token':'')+'} end)}'
  async function one(group,id,filter,project) {
    try {return (await get(group,messages+'/'+id,{user_id_type:'open_id'},envelope('[.data.items[]|select('+filter+')|'+project+']',false))).items}
    catch(e) {if (e?.larkCode===230110) return [];throw e}
  }
  async function pages(group,params,items,consume) {
    const visited=new Set()
    for (;;) {
      const data=await get(group,messages,params,envelope(items(),true))
      if (await consume(data.items)) return
      if (typeof data.has_more!=='boolean') throw bad()
      const token=pageCursor(data,params.page_token,'history')
      if (!token) return
      if (visited.has(token)) throw bad()
      visited.add(token);params.page_token=token
    }
  }
  function containerOf(row) {
    if (row?.thread_id && !tid(row.thread_id)) throw bad()
    return row?.thread_id || undefined
  }
  async function addHistory(event,target,grant,group,{count,minutes}) {
    const {chatId,threadId:root,messageId}=event, at=Number(target.create_time)
    if (grant.chatId!==chatId || !(grant.mode==='permanent' || grant.mode==='once' && grant.threadId===root)) throw bad()
    const s=scope(chatId,group)
    let container=containerOf(target), anchor
    if (root!==messageId) {
      // If the verified reply omitted its container, only its exact root may supply it. A quote
      // without a native thread does not authorize importing that root's old text as flat history.
      const want=container ? '((.thread_id // "")=="" or .thread_id=='+q(container)+')' : 'true'
      const filter=s.jq+' and '+sameRoot(root)+' and '+want
      const project='('+meta+') + (if ('+human+' and '+(container?'true':'(.thread_id // "" | test("^omt_[a-zA-Z0-9_-]{1,128}$"))')+
        ') then (('+display+') // {}) else {} end)'
      anchor=(await one(group,root,filter,project)).find(r=>s.ok(r) && rootRow(r,root) && (!container || !r.thread_id || r.thread_id===container))
      if (!container && !anchor) throw bad('无法核实原消息是否属于独立飞书话题。')
      container??=containerOf(anchor)
    }
    const found=new Map()
    let length=0
    const put=(id,at,sender,text)=>{
      if (found.has(id) || typeof text!=='string' || !text.trim()) return
      length+=text.length+(found.size?1:0)
      if(length>maxContext) throw tooLarge()
      found.set(id,{id,at,sender,text})
    }
    if (container) {
      // The archived request wins over an edited copy in a subsequent root or thread listing.
      put(messageId,at,event.senderId,event.text)
      if (anchor && textual(anchor) && time(anchor.create_time)) put(root,Number(anchor.create_time),anchor.sender.id,rowText(anchor))
      const region='.thread_id=='+q(container)+' and (.root_id=='+q(root)+' or ('+sameRoot(root)+'))'
      const items=()=>'[.data.items[]|select('+s.jq+' and '+human+' and .message_id!='+q(messageId)+' and ('+region+'))|'+fields+']'
      await pages(group,{container_id_type:'thread',container_id:container,sort_type:'ByCreateTimeAsc',page_size:50},items,rows=>{
        for(const r of rows) if (s.ok(r) && textual(r) && time(r.create_time) && r.message_id!==messageId && sameThread(r,root,container))
          put(r.message_id,Number(r.create_time),r.sender.id,rowText(r))
      })
      // Only a verified root (including an explicit deleted/non-text root) or the same root
      // in the validated thread listing establishes completeness; an empty lookup cannot.
      if (messageId!==root && !anchor && !found.has(root)) throw bad('未能核实原话题根消息，未提交缺少根消息的上下文。')
    } else {
      const since=Math.max(config.automationSince+1,(group.privateSince || 0)+1,at-minutes*60_000)
      if (group.chat_mode==='topic' || group.group_message_type==='thread') throw bad('未能核实话题群的原生话题编号，未读取其他话题。')
      if (count && minutes && since<at) {
        const cutoff=grant.approvedAt ?? at
        const eligible='(.create_time|tonumber?) as $t | $t>='+since+' and $t<'+at+
          ' and ($t>'+cutoff+' or ((.mentions // [])|arrays|all(.[]; .id!='+q(recipientId)+')))'+
          ' and ((.updated!=true and ((.update_time // "")|tostring|(.=="" or .=="0"))) or ((.update_time|tonumber?) as $u|$u>0 and $u<'+at+'))'
        const items=()=>'([.data.items[]|select('+s.jq+' and '+human+' and '+noParents+' and (.thread_id // "")=="" and ('+eligible+'))|'+fields+']|.[:'+(count-found.size)+'])'
        await pages(group,{container_id_type:'chat',container_id:chatId,sort_type:'ByCreateTimeDesc',page_size:50,only_thread_root_messages:true,
          start_time:String(Math.floor(since/1000)),end_time:String(Math.ceil(at/1000))},items,rows=>{
          for(const r of rows.filter(r=>s.ok(r) && textual(r) && flatRow(r)).sort((a,b)=>Number(b.create_time)-Number(a.create_time))) {
            const t=Number(r.create_time), u=Number(r.update_time)
            if (!time(t) || t<since || t>=at || (r.updated===true || r.update_time && u!==0) && !(time(u) && u<at) ||
              t<=cutoff && r.mentions?.some(m=>m?.id===recipientId)) continue
            put(r.message_id,t,r.sender.id,rowText(r))
            if (found.size>=count) return true
          }
        })
      }
    }
    check();checkPrivate(group)
    const aliases=new Map()
    const turns=[...found.values()].sort(order).map(({sender,at,text,id})=>{
      let speaker=sender===event.senderId?'requester':sender===recipientId?'owner':aliases.get(sender)
      if (!speaker) {speaker='participant-'+(aliases.size+1);aliases.set(sender,speaker)}
      return {speaker,at,text,...(id===messageId?{request:true}:{})}
    })
    const context=turns.length ? JSON.stringify(turns) : ''
    if (context.length>maxContext) throw tooLarge()
    event.workerContext=context
    return found
  }
  async function readReply({source,messageId,requesterId,questionId,originalText},original,grant,group,live) {
    const {chatId,threadId:root}=source, s=scope(chatId,group)
    live()
    const filter=s.jq+' and '+human+' and .message_id=='+q(questionId)+' and .sender.id=='+q(recipientId)+
      ' and .parent_id=='+q(messageId)+' and ((.root_id // "")=="" or .root_id=='+q(root)+')'
    const question=(await one(group,questionId,filter,meta)).find(r=>s.ok(r) && textual(r) && r.message_id===questionId &&
      r.sender.id===recipientId && r.parent_id===messageId && (!r.root_id || r.root_id===root) && time(r.create_time) && Number(r.create_time)>=Number(original.create_time))
    live()
    if (!question) return null
    const originalContainer=containerOf(original), ownContainer=containerOf(question)
    if (originalContainer && ownContainer && originalContainer!==ownContainer) throw bad()
    let container=ownContainer || originalContainer
    if(!container && original.message_id!==root) {
      const anchor=(await one(group,root,s.jq+' and '+sameRoot(root),meta)).find(r=>s.ok(r) && rootRow(r,root))
      if (!anchor) throw bad()
      container=containerOf(anchor)
    }
    const after=Number(question.create_time), params={container_id_type:container?'thread':'chat',container_id:container || chatId,
      sort_type:'ByCreateTimeAsc',page_size:50,...(container?{}:{start_time:String(Math.floor(after/1000))})}
    const region=container ? '.thread_id=='+q(container)+' and .root_id=='+q(root) :
      '((.root_id // "")=="" or .root_id=='+q(root)+' or .root_id=='+q(questionId)+')'
    const items=()=>'([.data.items[]|select('+s.jq+' and '+human+' and .sender.id=='+q(requesterId)+' and .parent_id=='+q(questionId)+
      ' and .message_id!='+q(questionId)+' and .message_id!='+q(messageId)+' and (.create_time|tonumber?)>='+after+' and ('+region+'))|'+fields+']|.[:1])'
    let reply=null
    await pages(group,params,items,rows=>{
      live()
      for (const r of rows.filter(r=>s.ok(r) && textual(r) && r.sender.id===requesterId && r.parent_id===questionId &&
        ![questionId,messageId].includes(r.message_id) && time(r.create_time) && Number(r.create_time)>=after &&
        (container ? r.thread_id===container && r.root_id===root : !r.root_id || r.root_id===root || r.root_id===questionId))
        .sort((a,b)=>Number(a.create_time)-Number(b.create_time))) {
        const text=rowText(r)
        if (typeof text!=='string' || !text.trim()) continue
        if (text.length>65536) throw tooLarge()
        reply={chatId,threadId:root,messageId:r.message_id,senderId:requesterId,parentId:questionId,at:Number(r.create_time),text}
        return true
      }
    })
    live()
    if (reply && container) {
      const event={chatId,threadId:root,messageId,senderId:requesterId,text:originalText}
      const snapshot=await addHistory(event,{...original,thread_id:container},grant,group,{})
      live()
      // Do not resume a request on a reply that was recalled/edited between the exact search and refresh.
      const seen=snapshot.get(reply.messageId)
      if (seen?.sender!==requesterId || seen.at!==reply.at || seen.text!==reply.text) return null
      reply.workerContext=event.workerContext
    }
    return reply
  }
  return {addHistory,readReply}
}
