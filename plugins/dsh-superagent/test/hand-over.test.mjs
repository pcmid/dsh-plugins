import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash,randomUUID } from 'node:crypto'
import { createActors } from '../host/actors.js'
import { makeApp } from '../host/app.js'

const kind='plugin:superagent-handoff'
const source={kind:'feishu',scopeId:'f'.repeat(64),tenantId:'tenant',recipientId:'ou_owner',chatId:'oc_thread',threadId:'om_root'}
const hash=data=>createHash('sha256').update(JSON.stringify(data)).digest('hex')
const ids=(caseId,messageId)=>{
  const id=hash([caseId,source.scopeId,source.tenantId,source.recipientId,source.chatId,source.threadId,messageId])
  return {worker:'superagent-auto-'+id,router:'superagent-auto-'+hash([id,'decide',0])}
}
const job=(caseId,messageId,sessionId=ids(caseId,messageId).worker)=>({caseId,messageId,source,sessionId,
  workspaceId:'project',status:'taken-over',role:'develop',presetId:'',attempt:1,updatedAt:1})
const {worker,router}=ids('case_a','om_request')
const human=(text,source={})=>({id:randomUUID(),role:'user',source:{kind:'user',rpcId:randomUUID(),...source},content:[{type:'text',text}]})
const enter=messages=>({kind:'enter',messages,startsRequestSeries:true})
const event=data=>({type:'user/message',data})

function fixture(log=[]) {
  const hooks=new Map(), registrations=[]
  const ctx={on(name,fn){hooks.set(name,fn);return ()=>hooks.delete(name)},get(name){
    // No prompt, wake, tool, preset or permission service is involved in handing over.
    assert.equal(name,'sessionProjections')
    return {async register(def){
      registrations.push(def.key);assert.equal(def.wire,undefined)
      return {stateOf(session){return session.events.reduce(def.apply,def.init())}}
    }}
  }}
  const actors=createActors(ctx,{workspacePath:'/offline'})
  const step=(id,inputs,decision=enter(inputs),signal=new AbortController().signal)=>
    hooks.get('agent/pre-step')({agent:{id,session:{events:log}},messages:inputs,signal},()=>Promise.resolve(decision))
  return {actors,step,registrations}
}

test('only an admitted DSH owner prompt on the handed-over worker gets a producer notice',async()=>{
  const f=fixture(), owner=human('SUPERAGENT_WORK\nThis is my own text now.'), entered=enter([owner])
  assert.equal(await f.step(worker,[owner],entered),entered)
  f.actors.handOver([worker])
  assert.deepEqual(f.registrations,[],'handover alone does not wake or queue anything')
  for(const id of [router,ids('another','om_other').worker,'ordinary']){
    assert.equal(await f.step(id,[owner],entered),entered)
  }
  const peer=human('delegated user',{principal:{kind:'guest'}})
  const late=human('late automation',{rpcId:'superagent-auto-'+randomUUID()})
  for (const input of [peer,late,human('retry',{kind:'retry'}),human('timer',{kind:'schedule'}),human('memory',{kind:'plugin:hindsight'})]){
    const d=enter([input]);assert.equal(await f.step(worker,[input],d),d)
  }
  const rejected={kind:'reject'},withoutOwner=enter([human('replacement')])
  assert.equal(await f.step(worker,[owner],rejected),rejected)
  assert.equal(await f.step(worker,[owner],withoutOwner),withoutOwner)
  assert.equal(await f.step(worker,[peer],entered),entered,'a middleware-added user message is not a claimed owner input')
  assert.equal(await f.step(worker,[owner],entered,AbortSignal.abort()),entered)
  assert.deepEqual(f.registrations,[])

  const recall=human('other context',{kind:'plugin:hindsight'}), batch=enter([owner,recall])
  const admitted=await f.step(worker,[owner],batch), note=admitted.messages.at(-1)
  assert.equal(admitted.startsRequestSeries,true)
  assert.equal(admitted.messages[0],owner);assert.equal(admitted.messages[1],recall)
  assert.deepEqual(batch.messages,[owner,recall],'do not rewrite the human prompt or other middleware')
  assert.deepEqual([note.role,note.source.kind,note.source.form],['user',kind,'notice'])
  assert.ok(note.source.summary && !Object.hasOwn(note.source,'rpcId'))
  assert.match(note.content[0].text,/local DSH owner/i)
  assert.match(note.content[0].text,/not post.*Feishu/i)
  assert.match(note.content[0].text,/preset, tools, permissions and approval/i)
})

test('raw committed native source is the receipt, even after compaction and cold recovery',async()=>{
  const owner=human('Where did you stop?'), first=fixture()
  first.actors.handOver([worker])
  const abandoned=(await first.step(worker,[owner])).messages.at(-1)
  const history=[event(human(abandoned.content[0].text)),event(human(kind)),
    {type:'agent/inbox/spliced',data:{target:'next-step',start:0,inserted:[abandoned]}}]
  const restored=fixture(history);restored.actors.handOver([worker])
  const accepted=await restored.step(worker,[owner]), note=accepted.messages.at(-1)
  assert.equal(note.source.kind,kind,'a copied notice body, queued message or uncommitted pre-step cannot spend the notice')
  history.push(event(owner),event(note),{type:'user/message',data:human('Compacted history',{kind:'summary'})})
  for(const f of [restored,fixture(structuredClone(history))]){
    f.actors.handOver([worker])
    const later=human('Continue here.'), d=enter([later])
    assert.equal(await f.step(worker,[later],d),d,'do not repeat, including after plugin/process restart')
  }
})

test('cold startup waits for durable worker ownership without granting a Router or another worker',async t=>{
  const f=fixture(), load=Promise.withResolvers(), valid=job('case_a','om_request')
  const wrongWorker=ids('case_other','om_other').worker
  const app=makeApp({state:{},runCli:assert.fail,actors:f.actors,automationStore:{load:()=>load.promise,save:assert.fail}})
  t.after(()=>app.dispose())
  const startup=app.start(), owner=human('Local question'), d=enter([owner])
  const early=f.step(worker,[owner],d)
  assert.equal(await f.step('unrelated',[owner],d),d,'ordinary prompts never wait for this startup read')
  // Structurally valid tombstones, but their session ids belong to another seat.
  load.resolve({schema:1,jobs:[valid,job('case_b','om_bad_router',router),job('case_c','om_bad_worker',wrongWorker)]})
  await startup
  assert.equal((await early).messages.at(-1).source.kind,kind)
  assert.equal(await f.step(router,[owner],d),d)
  assert.equal(await f.step(wrongWorker,[owner],d),d)
})
