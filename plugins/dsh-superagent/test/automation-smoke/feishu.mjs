import assert from 'node:assert/strict'
import { answer, sealRE, forbiddenRequest, clarification, declineRequest, ignored, laterLine, mergeCase, noteAnswer, noteRequest, oldLines, privateRequest, question, request, rootText, sibling, unselected } from './provider.mjs'

export const source={profile:'smoke',managed:false,tenantId:'demo',recipientId:'ou_fixture'}
export const chatId='oc_demo',root='om_root',firstId='om_first',messageId='om_request',followupId='om_followup',declineId='om_decline'
export const questionId='om_question',receiptId='om_receipt',clarificationId='om_clarification'
export const selfChatId='oc_owner_notes',selfMessageId='om_note_to_self',selfReceiptId='om_note_receipt'
export const otherDM='oc_other_dm',peer='ou_peer',foreignMessageId='om_other_dm',privateMessageId='om_private_message',peerSelfId='om_private_owner_at'
export const mergeRoot='om_merge_root',otherGroup='oc_other_group',otherRoot='om_other_root',colleague='ou_colleague'
export const quietGroup='oc_quiet_group',quietRoot='om_quiet_root'
export const memberGroup='oc_member_group',memberRoot='om_member_root',memberA='ou_member_a',memberB='ou_member_b'
const owner=source.recipientId, api='/open-apis/im/v1/messages'
const groupChats=new Set([chatId,otherGroup,quietGroup,memberGroup])
const groupNames={[chatId]:'Fixture group',[otherGroup]:'Fixture other group',[quietGroup]:'Fixture quiet group',[memberGroup]:'Fixture member group'}
const ok=data=>({ok:true,identity:'user',data})
const flag=(args,key)=>{assert.ok(args.includes(key),key);return args[args.indexOf(key)+1]}

export function fakeFeishu(rows=[]) {
  const posts=[],exactReads=[],searches=[],privateSearches=[],mgets=[],mgetBodies=[],historyReads=[],reverseProofs=[]
  let error,p2pChecked=false
  function publish(id,text,{at=Date.now(),chat=chatId,from='ou_sender',thread=root,parent=thread,mention=true}={}) {
    const r={message_id:id,chat_id:chat,create_time:String(at),msg_type:'text',deleted:false,
      ...(groupChats.has(chat) && {thread_id:'omt_'+thread.slice(3)}),
      ...(groupChats.has(chat) && id!==thread && {root_id:thread}),
      ...(parent && parent!==id && {parent_id:parent}),
      sender:{sender_type:'user',id_type:'open_id',id:from,tenant_key:source.tenantId},
      mentions:mention?[{id_type:'open_id',id:owner,tenant_key:source.tenantId}]:[],body:{content:JSON.stringify({text})}}
    rows.push(r)
    return r
  }
  async function run(argv,stdin) {
    assert.equal(flag(argv,'--profile'),source.profile)
    const has=(...parts)=>parts.every(part=>argv.includes(part))
    if(has('auth','check')) {
      const granted=flag(argv,'--scope').split(/\s+/)
      if(granted.length===1){assert.deepEqual(granted,['im:message.p2p_msg:get_as_user']);p2pChecked=true}
      else assert.deepEqual(granted.sort(),['im:message','im:message.send_as_user'])
      return {ok:true,granted,missing:[]}
    }
    assert.equal(flag(argv,'--as'),'user')
    if(has('contact','+get-user'))return ok({user:{open_id:owner,tenant_key:source.tenantId}})
    if(has('api','POST','/open-apis/im/v1/chat_p2p/batch_query')) {
      assert.ok(p2pChecked)
      assert.deepEqual(JSON.parse(flag(argv,'--params')),{chatter_id_type:'open_id'})
      const {chatter_ids}=JSON.parse(flag(argv,'--data'))
      assert.ok(chatter_ids.length && chatter_ids.every(id=>[owner,peer].includes(id)))
      assert.ok(flag(argv,'--jq'))
      return ok({p2p_chats:chatter_ids.map(id=>({chat_id:id===owner?selfChatId:otherDM,chatter_id1:owner,chatter_id2:id}))})
    }
    if(has('api','POST','/open-apis/im/v1/chats/batch_query')) {
      assert.ok(p2pChecked)
      assert.deepEqual(JSON.parse(flag(argv,'--params')),{user_id_type:'open_id'})
      const {chat_ids}=JSON.parse(flag(argv,'--data'))
      assert.deepEqual(chat_ids,[otherDM],'resolve only the target of an actual owner self-mention')
      assert.ok(flag(argv,'--jq'))
      reverseProofs.push(...chat_ids)
      return ok({items:[{chat_id:otherDM,chat_mode:'p2p',p2p_target_id:peer,p2p_target_type:'user'}]})
    }
    if(has('im','chats','get')) {
      const id=flag(argv,'--chat-id')
      assert.ok(groupChats.has(id),'only groups use group metadata')
      return ok({name:groupNames[id],chat_mode:'topic',external:false,tenant_key:source.tenantId})
    }
    if(has('api','POST',api+'/search')) {
      const {filter}=JSON.parse(flag(argv,'--data'))
      const privateOnly=filter.chat_type==='p2p'
      assert.deepEqual(filter.from_types,['user'])
      assert.equal(filter.is_at_me,undefined)
      if(privateOnly)assert.equal(filter.at_chatter_ids,undefined,'peer DMs do not need a mention')
      else {assert.equal(filter.chat_type,undefined);assert.deepEqual(filter.at_chatter_ids,[owner])}
      assert.equal(filter.chat_ids,undefined)
      const from=Date.parse(filter.time_range.start_time),to=Date.parse(filter.time_range.end_time)
      assert.ok(Number.isFinite(from) && Number.isFinite(to) && from<=to)
      const hits=rows.filter(r=>(privateOnly?!groupChats.has(r.chat_id):r.mentions.length || r.message_id==='om_not_direct') &&
        +r.create_time>=from && +r.create_time<=to)
      ;(privateOnly?privateSearches:searches).push(hits.map(r=>r.message_id))
      return ok({items:hits.map(r=>({meta_data:{message_id:r.message_id,chat_id:r.chat_id,from_id:r.sender.id,is_p2p_chat:!groupChats.has(r.chat_id)}})),has_more:false})
    }
    if(has('api','GET',api+'/mget')) {
      const {message_ids,user_id_type}=JSON.parse(flag(argv,'--params'))
      assert.equal(user_id_type,'open_id')
      const jq=flag(argv,'--jq')
      assert.ok(jq,'metadata-only batch read')
      mgets.push(...message_ids)
      // Only a projection that names its fields strips the body inside the CLI.
      if(!jq.includes('{message_id,chat_id,'))mgetBodies.push(...message_ids)
      return ok({items:rows.filter(r=>message_ids.includes(r.message_id)).map(({body,...meta})=>meta)})
    }
    if(has('api','GET',api)) {
      const p=JSON.parse(flag(argv,'--params'))
      assert.ok(flag(argv,'--jq'))
      assert.ok(p.page_size>0 && p.page_size<=50)
      const thread=p.container_id_type==='thread'
      if(thread) {
        assert.ok(['omt_root','omt_another_topic','omt_merge_root','omt_other_root','omt_quiet_root','omt_member_root','omt_member_a_later','omt_member_a_cold'].includes(p.container_id))
        assert.equal(p.sort_type,'ByCreateTimeAsc')
        assert.equal(p.start_time,undefined)
        assert.equal(p.end_time,undefined)
      } else {
        assert.equal(p.container_id_type,'chat')
        assert.ok([selfChatId,otherDM].includes(p.container_id),'no flat scan instead of an entire native thread')
      }
      historyReads.push({...p,replyLookup:flag(argv,'--jq').includes('.parent_id=='+JSON.stringify(questionId))})
      // Partial pages even if the server was asked for 50. A sibling leak in an upstream page must be discarded.
      const matches=rows.filter(r=>thread?r.thread_id===p.container_id || r.message_id==='om_sidebar':r.chat_id===p.container_id)
        .sort((a,b)=>p.sort_type==='ByCreateTimeDesc'?+b.create_time- +a.create_time:+a.create_time- +b.create_time)
      const from=p.page_token ? Number(p.page_token.slice(1)) : 0
      const limit=Math.min(7,p.page_size)
      const next=from+limit
      return ok({items:matches.slice(from,next),has_more:next<matches.length,...(next<matches.length && {page_token:'p'+next})})
    }
    if(has('api','GET')) {
      assert.ok(flag(argv,'--jq'))
      const path=argv.find(a=>a.startsWith(api+'/'))
      assert.ok(path)
      const id=path.slice(api.length+1)
      exactReads.push(id)
      return ok({items:rows.filter(r=>r.message_id===id)})
    }
    if(has('im','+messages-reply')) {
      const id=flag(argv,'--message-id'),text=JSON.parse(stdin).text
      const target=rows.find(r=>r.message_id===id)
      assert.ok(target && [messageId,selfMessageId,privateMessageId,peerSelfId,mergeCase.work.id].includes(id),'send only to the approved original request')
      assert.equal(has('--reply-in-thread'),groupChats.has(target.chat_id))
      assert.equal(flag(argv,'--msg-type'),'text');assert.equal(flag(argv,'--content'),'-')
      const key=flag(argv,'--idempotency-key')
      assert.ok(key && !posts.some(p=>p.key===key),'every individually approved output has a distinct delivery key')
      const sealed=base=>text.startsWith(base+' ') && sealRE.test(text.slice(base.length+1))
      // A reply reopened by a merged message is a new post with its own receipt.
      const sent=id===mergeCase.work.id?'om_merge_receipt_'+(posts.filter(p=>p.anchor===id).length+1):
        id===selfMessageId?selfReceiptId:id===privateMessageId?'om_private_receipt':id===peerSelfId?'om_peer_self_receipt':sealed(question)?questionId:receiptId
      assert.ok(id===mergeCase.work.id?[mergeCase.answers.more,mergeCase.answers.late].includes(text):sealed(question) || sealed(answer) || text===noteAnswer)
      assert.ok(!rows.some(r=>r.message_id===sent),'never post a question or final output twice')
      const r=publish(sent,text,{chat:target.chat_id,from:owner,thread:target.root_id ?? target.message_id,parent:id,mention:false})
      posts.push({id:sent,anchor:id,key,text})
      return ok({chat_id:r.chat_id,message_id:sent})
    }
    assert.fail('unexpected synthetic CLI operation: '+argv.slice(2,4).join(' '))
  }
  return {
    run:async(...args)=>{try{return await run(...args)}catch(e){error=e;throw e}},get error(){return error},
    exactReads,searches,privateSearches,mgets,mgetBodies,historyReads,reverseProofs,posts,rows,
    replayReceipt(){rows.find(r=>r.message_id===receiptId).mentions=[{id_type:'open_id',id:owner,tenant_key:source.tenantId}]},
    publishHistory(){
      const old=Date.now()-11*60_000
      publish(root,rootText,{at:old,mention:false})
      for(const [i,line] of oldLines.entries())publish('om_history_'+i,line,{at:old+1000*(i+1),mention:false})
      publish('om_another_topic','Another topic.',{thread:'om_another_topic',mention:false})
      publish('om_sidebar',sibling,{thread:'om_unrelated',mention:false})
    },
    publishLaterReply:()=>publish('om_before_grant_reply',laterLine,{from:'ou_colleague',mention:false}),
    publishFirst:()=>+publish(firstId,unselected).create_time,
    publishRequest:()=>+publish(messageId,request,{from:owner}).create_time,
    publishFollowup:()=>publish(followupId,ignored),
    publishGranted:(id,text)=>publish(id,text,{thread:'om_another_topic'}),
    publishMergeRoot:()=>publish(mergeRoot,mergeCase.root,{thread:mergeRoot,mention:false}),
    publishMerge:(m,from)=>publish(m.id,m.text,{thread:mergeRoot,from}),
    publishOther(){
      publish(otherRoot,'Fixture other group root.',{chat:otherGroup,thread:otherRoot,mention:false})
      publish(mergeCase.other.id,mergeCase.other.text,{chat:otherGroup,thread:otherRoot,from:owner})
    },
    publishToDecline:()=>publish(declineId,declineRequest,{thread:'om_another_topic'}),
    publishQuietRoot:()=>publish(quietRoot,'Fixture quiet group root.',{chat:quietGroup,thread:quietRoot,mention:false}),
    // An @ in its own new topic unless a thread is given.
    publishQuiet:(id,text,thread=id)=>publish(id,text,{chat:quietGroup,thread}),
    publishOtherTopic:(id,text)=>publish(id,text,{chat:otherGroup,thread:id}),
    publishMemberRoot:()=>publish(memberRoot,'Fixture member group root.',{chat:memberGroup,thread:memberRoot,mention:false}),
    publishMember:(id,text,from,thread=id)=>publish(id,text,{chat:memberGroup,thread,from}),
    publishWrongReplies(){
      publish('om_wrong_person','WRONG-REPLY: somebody else.',{parent:questionId,mention:false})
      publish('om_wrong_parent','WRONG-REPLY: not a response to the question.',{parent:messageId,from:owner,mention:false})
    },
    publishClarification:()=>publish(clarificationId,clarification,{from:owner,parent:questionId}),
    publishSelf(){
      publish('om_plain_self','@owner is just text.',{chat:selfChatId,from:owner,parent:null,mention:false})
      const note=publish(selfMessageId,'@_user_1 ping',{chat:selfChatId,from:owner,parent:null})
      Object.assign(note.mentions[0],{key:'@_user_1',name:'测试用户'})
      publish(foreignMessageId,'Not in my notes.',{chat:otherDM,from:owner,parent:null})
      publish('om_dm_before','Before opting in.',{chat:otherDM,from:peer,parent:null,mention:false})
    },
    publishPeerSelf(){
      publish('om_outbound_plain','Ordinary message sent to the peer.',{chat:otherDM,from:owner,parent:null,mention:false})
      publish(peerSelfId,noteRequest,{chat:otherDM,from:owner,parent:null})
    },
    publishProbe:(id='om_missing_tool',text=forbiddenRequest)=>publish(id,text,{chat:otherDM,from:peer,parent:null,mention:false}),
    publishPrivate:()=>publish(privateMessageId,privateRequest,{chat:otherDM,from:peer,parent:null,mention:false}),
    editRequest(){rows.find(r=>r.message_id===messageId).body.content=JSON.stringify({text:'Edited after display.'})},
    indexStaleHit(){publish('om_not_direct','Not a direct mention.',{thread:'om_unrelated',mention:false})},
    indexHistorical:at=>publish('om_historical',ignored,{at,thread:'om_old_root'}),
  }
}
