import test from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { mkdtemp, rm, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActors } from '../host/actors.js'
import { createLoop } from '../host/loop.js'
import { builtinHelpers as helpers } from '../host/helpers.js'

const base = {caseId:'case-1',messageId:'om_m1',text:'Write out an example function.',context:'For a training handout.',
  source:{kind:'feishu',scopeId:'a'.repeat(64),tenantId:'t',recipientId:'ou_a',chatId:'oc_x',threadId:'om_t'},
  team:{lead:'',develop:'engineer',answer:''},roleModels:{lead:{provider:'offline',model:'director'},develop:{provider:'offline',model:'coder'}},
  role:'develop',attempt:1,requesterId:'ou_owner',workerContext:'Work context '+ 'x'.repeat(5000)+' THREAD-MARKER',signal:new AbortController().signal}
const denied = {code:'AUTOMATION_UNAVAILABLE'}
const uncertain = {code:'WORK_UNCERTAIN'}
const block = text => ({type:'text',text})
// What the simulated model does in one step: call tools (one spec or a list), or reply in plain text.
const call = (name,args={}) => ({name,args})
const route = role => call('superagent_route',{role})
const ignore = () => call('superagent_ignore')
const answer = text => call('superagent_answer',{answer:text})
const ask = question => call('superagent_ask_requester',{question})
// Not a SuperAgent tool: a worker that cannot do the work says so with superagent_answer.
const stop = () => call('superagent_stop')
const say = (text,end) => ({text,...end && {end}})
const legacy = value => say(JSON.stringify(value)) // A worker recorded before result tools finished with JSON text.
const routerTools = ['superagent_route','superagent_ignore']
const workerTools = ['superagent_answer','superagent_ask_requester']
const continued = /^SUPERAGENT_CONTINUE\n/
// Raw model stream chunks for one step.
const chunks = (out,{end,id=i=>'tc-'+i}={}) => [{type:'block-end',index:0,block:{type:'reasoning',text:'PRIVATE REASONING'}},
  ...'text' in out ? [{type:'block-end',index:1,block:block(out.text)}] :
    [out].flat().map((c,i)=>({type:'block-end',index:i+1,block:{type:'tool-call',id:c.id ?? id(i),name:c.name,arguments:c.arguments ?? JSON.stringify(c.args)}})),
  {type:'finish',reason:{kind:end ?? out.end ?? ('text' in out ? 'stop' : 'tool-calls')}}]

async function fixture(t,priorApproval) {
  const tmp = await realpath(tmpdir()), prefix = join(tmp,'sa-actors-'), dir = await mkdtemp(prefix)
  t.after(async()=>{assert.equal(await realpath(dir),dir);assert.ok(dir.startsWith(prefix));await rm(dir,{recursive:true})})
  const workspace = {id:'ws',title:'SuperAgent',path:join(dir,'work'),sessionIds:[],status:async()=>'ok'}, agents = new Map(), hooks = new Map()
  // Other registered DSH workspaces the Router may choose from; SuperAgent's own is listed once created.
  const places = new Map()
  const f = {requested:[],prompts:[],nativeRequests:[],oneShots:[],globalTools:[],registrations:[],lookups:[],archives:[],worker:answer('First draft.'),
    control:route('develop'),approved:[],modelInfo:[],uploads:[],uploaded:new Map()}
  // DSH stores each prompt image as an attachment; with `offload`, the model surface later shows it as a placeholder.
  const admit = b => b.type === 'image' && b.data !== undefined && !f.rawImages ? {type:'image',attachment:{attachmentId:'att-'+createHash('sha256').update(b.data).digest('hex').slice(0,12),
    mediaType:b.mediaType,bytes:Buffer.from(b.data,'base64').length,width:1,height:1}} :
    // A staged upload enters the message as its stored file.
    b.type === 'file' && f.uploaded.has(b.receiptId) ? {type:'file',attachment:f.uploaded.get(b.receiptId)} : b
  const shown = m => f.offload && m.role === 'user' && m.content.some(b=>b.type === 'image') ?
    {...m,content:m.content.map(b=>b.type === 'image' ? {...b,offloaded:true} : b)} : m
  if(priorApproval)hooks.set('approval/request',[priorApproval])
  const ctx = { get:key=>services[key],on(event,fn,prepend=false) {
    const rows = hooks.get(event) || [];if(prepend)rows.unshift(fn);else rows.push(fn);hooks.set(event,rows)
    return ()=>{if (rows.includes(fn)) rows.splice(rows.indexOf(fn),1)}
  } }
  // The global registry must stay untouched: SuperAgent's tools belong to one seat's own scope.
  const tools = {register(def){f.globalTools.push(def.name)},guard(){f.globalTools.push('guard')}}
  const services = {
    approval:{request:async req=>{f.approved.push(req);return f.localDecision?.(req) ?? 'unavailable'}},
    tools,agentDefaultModel:{currentSelection:()=>({provider:'offline',model:'native-default'})},
    agentPresets:{resolve:id=>({id,broken:id === 'broken' ? 'private diagnostic' : undefined}),
      presetForSession:s=>s.header.agentPreset,composedPreset:c=>c.preset},
    sessionPersistence:{stat(id){assert.match(id,/^superagent-auto-[0-9a-f]{64}$/);f.lookups.push(id);return f.existing}},
    workspaceRegistry:{create(path){assert.equal(path,workspace.path);workspace.registered=true;return workspace},
      list:()=>[...workspace.registered ? [workspace] : [],...places.values()],
      get:id=>id === workspace.id ? workspace.registered && workspace : places.get(id),archivedSessionIds:[],
      // Archiving records the id; with stopActivity, DSH also stops the session's running work.
      async archiveSession(id,options){
        f.archives.push([id,options])
        if(f.failArchive) throw Error('registry offline')
        const archived=services.workspaceRegistry.archivedSessionIds
        if(!archived.includes(id)) archived.push(id)
        if(options?.stopActivity) agents.get(id)?.cancel({kind:'archive'})
      }},
    workingDirectory:{get:s=>s.header.cwd},agents:{get:id=>agents.get(id)},
    llm:{async resolveCallConfig(route,signal){signal.throwIfAborted();return route},
      // A model's input modalities; undefined when the provider does not say.
      async resolveModelInfo(provider,model){f.modelInfo.push([provider,model]);return {...f.modalities && {inputModalities:f.modalities}}},
      stream(req){f.oneShots.push(req);return f.directStream || chunks(f.control)}},
    // Uploads staged on one session; a prompt cites them by receipt.
    fileUploads:{async uploadStream({sessionId,data,name}) {
      const chunks=[];for await(const c of data) chunks.push(Buffer.from(c))
      const bytes=Buffer.concat(chunks)
      if(f.failUpload?.(name)) throw Error('storage refused')
      const receiptId='rcpt-'+(f.uploads.length+1), file={attachmentId:'sha256:'+createHash('sha256').update(bytes).digest('hex'),name,bytes:bytes.length}
      f.uploads.push({sessionId,name,text:bytes.toString()});f.uploaded.set(receiptId,file)
      return {receiptId,file}
    }},
    attachments:{imageLimits:{maxImageBytes:1024,maxImagesPerMessage:4,maxMessageImageBytes:4096,maxImagePixels:1e6,maxImageDimension:1024,
      mediaTypes:['image/png','image/jpeg','image/gif','image/webp']},
      async validateImage({data}){if(data.includes('CORRUPT')) throw Error('cannot decode')}},
    sessionController:{
      create(req){
        const {sessionId,agentPreset='workspace-default'} = req, home = services.workspaceRegistry.get(req.workspaceId)
        assert.ok(home);f.requested.push(req);home.sessionIds.push(sessionId)
        let route, running = Promise.resolve(), working = false, budget = 0, stop = new AbortController()
        const events=[], history=[]
        let surface=[]
        // The agent's own tool scope: registrations and guards apply to this agent only and return disposers.
        const scope={tools:new Map(),guards:new Set()}
        const scoped={
          register(def){
            if(f.failRegister?.(def.name)) throw Error('registration refused')
            assert.equal(scope.tools.has(def.name),false)
            const row={sessionId,name:def.name,disposed:false};f.registrations.push(row);scope.tools.set(def.name,def)
            return ()=>{row.disposed=true;scope.tools.delete(def.name)}
          },
          guard(fn){
            const row={sessionId,name:'guard',disposed:false};f.registrations.push(row);scope.guards.add(fn)
            return ()=>{row.disposed=true;scope.guards.delete(fn)}
          },
        }
        const session={header:{id:sessionId,agentPreset,cwd:home.path},snapshotEvents:()=>events.slice(),deriveMessages:()=>surface.slice()}
        const agent={id:sessionId,ctx:{preset:agentPreset,get:k=>k==='tools'?scoped:undefined},session,model:{select(r){route=r},current:()=>route},
          inbox:{nextTurn:[],nextStep:[...(f.inbox ?? [])]},status:'idle',cancel(){f.cancelled=true;stop.abort()},whenIdle:()=>running}
        const emit = (type,data) => {
          events.push({type,data})
          for(const cb of hooks.get('session/event') || []) cb(session,{type,data})
        }
        // Native execution of one call: guards, then this scope's tools, then preset tools under native policy.
        const run = async (c,signal) => {
          const exec={callId:c.id,name:c.name,agent,signal,deferContext(){},concludeTurn(){exec.concluded=true}}
          for(const guard of scope.guards) {
            const reason=guard(exec)
            if(reason) return {error:true,text:reason}
          }
          const tool=scope.tools.get(c.name)
          if(tool) {
            let args
            try { args=JSON.parse(c.arguments) } catch { return {error:true,text:'Invalid JSON arguments.'} }
            try {
              const output=await tool.execute(args,exec)
              if(f.failResult?.(c) || f.resultErrors>0 && f.resultErrors-- > 0) return {error:true,text:'Result rejected by the native loop.'}
              return {error:false,text:tool.output.render(output)[0].text,concludes:exec.concluded}
            } catch (e) { return {error:true,text:e.message} }
          }
          if(!(f.toolSchemas ?? []).some(s=>s.name===c.name)) return {error:true,text:'Unknown tool: '+c.name}
          if(f.toolGate) { // A preset tool that keeps running until the turn is cancelled.
            f.onTool?.()
            await new Promise((resolve,reject)=>{f.toolGate.then(resolve);signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true})})
          }
          // Native policy: allow by default, an `ask` goes to DSH approval, a deny never runs.
          if(!f.nativeDeny && (!f.nativeAsk ||
            await services.approval.request({agent,toolName:c.name,callId:c.id,signal})==='allowed-once')) {
            f.toolRan=(f.toolRan||0)+1;return {error:false,text:'fixture stamp'}
          }
          return {error:true,text:'not run'}
        }
        agent.prompt=req=>{
          // A SuperAgent nudge continues the same run; a model that never submits a result runs until
          // stopped, which the fixture does once the run's step budget is spent.
          if(!continued.test(req.content[0].text)){working=req.content[0].text.startsWith('SUPERAGENT_WORK');budget=f.budget ?? 6}
          running = (async()=>{
            const turn=f.turn=(f.turn||0)+1
            emit('turn/start',{turn})
            if(f.ackOnly) return
            const user={id:'u'+turn,role:'user',source:{kind:'user',rpcId:req.requestId},content:req.content.map(admit)}
            if(f.sideCall) {
              const invoke=hooks.get('llm/stream')[0]
              const result=invoke({purpose:'compaction',sessionId,provider:'aux',model:'summary',tools:[]},()=>42)
              assert.equal(result,42); f.sideCalls=(f.sideCalls||0)+1
            }
            const task=f.replacePrompt ? {...user,content:[block('substituted')]} : user
            const admitted=[...agent.inbox.nextStep.splice(0),task,...(f.additions ?? [])]
            if(f.preStepReject){emit('turn/end',{turn,reason:{kind:'blocked'}});return}
            const system={role:'system',source:{kind:'system-prompt'},content:[block(f.persona ?? 'Actual persona: '+agentPreset)]}
            emit('system/message',{turn,step:1,message:system})
            for(const m of admitted){emit('user/message',m);history.push(m)}
            const replay=(f.compact ? admitted : history).map(m=>f.replacePrior && m.id===f.replacePrior ? {...m,content:[block('substituted history')]} : m)
            surface=[system,...(f.moreSystem ? [{role:'system',source:{kind:'system-prompt'},content:[block('extra native section')]}]:[]),...replay.map(shown)]
            stop=new AbortController()
            const loopSignal=stop.signal
            try {
              let reason='completed'
              for(let step=1; ; step++) {
                if(budget--<=0){reason='aborted';break}
                if(step>1)surface=[system,...history.map(shown)]
                const schemas=[...scope.tools.values()].map(({name,description,parameters})=>({name,description,parameters}))
                const options={sessionId,...route,signal:loopSignal,tools:[...(f.toolSchemas || []),...schemas],messages:surface.slice()}
                if(f.fakeSurface) options.messages.push({role:'user',source:{kind:'made-up'},content:[block('not the native surface')]})
                const stream = hooks.get('llm/stream')[0](options,()=>{
                  f.nativeRequests.push({...options})
                  if(f.workerChunks) return f.workerChunks
                  const out=step===1 && working && f.issueCalls || f.script?.shift() || (working ? f.worker : f.control)
                  return chunks(typeof out === 'function' ? out() : out,{id:i=>`tc${turn}-${step}-${i}`})
                })
                const blocks=[]
                let finish
                for await(const c of stream) {
                  if(c.type==='block-end')blocks.push(c.block)
                  if(c.type==='finish')finish=c.reason.kind
                }
                const content=f.counterfeit ? f.counterfeit(blocks) : blocks
                if(f.tamperCall && step===1 && working && f.issueCalls) {
                  const i=content.findIndex(b=>b.type==='tool-call');content[i]={...content[i],arguments:'{"stamp":"other"}'}
                }
                const message={id:'a'+turn+(step>1?'-'+step:''),role:'assistant',source:{kind:'model',provider:route.provider,model:route.model},content}
                emit('assistant/message',{message,turn,step});history.push(message)
                const calls=content.filter(b=>b.type==='tool-call')
                // A step without tool calls ends the turn: 'max-tokens' on an output-length stop, else 'completed'.
                if(!calls.length){reason=finish==='max-tokens' ? 'max-tokens' : 'completed';break}
                let concluded=false
                for(const c of calls) {
                  emit('tool/call',{turn,step,callId:c.id,name:c.name,arguments:c.arguments})
                  const out=await run(c,loopSignal)
                  const m={id:'res'+turn+'-'+c.id,role:'tool',toolCallId:c.id,source:{kind:'tool',callId:c.id},content:[block(out.text)],isError:out.error}
                  emit('tool/result',{turn,step,message:m});history.push(m)
                  concluded||=!out.error && !!out.concludes
                }
                if(concluded)break
              }
              emit('turn/end',{turn,reason:{kind:f.end||reason}})
            } catch { emit('turn/end',{turn,reason:{kind:loopSignal.aborted ? 'aborted' : 'error'}}) }
          })()
        }
        agents.set(sessionId,agent)
        return {sessionId,agentPreset}
      },
      prompt(req,signal){
        assert.equal(req.mode,'queue');signal.throwIfAborted()
        if(f.failPrompt) throw Error('private provider diagnostics')
        if (f.stall) return new Promise(()=>{})
        f.prompts.push({sessionId:req.sessionId,requestId:req.requestId,text:req.content[0].text,content:req.content})
        agents.get(req.sessionId).prompt(req)
        return {accepted:true}
      },
    },
  }
  f.actors=createActors(ctx,{workspacePath:workspace.path})
  f.place=(id,title,state='ok')=>{
    const ws={id,title,path:join(dir,'places',id),sessionIds:[],state,status:async()=>ws.state};places.set(id,ws);return ws
  }
  Object.assign(f,{ctx,hooks,workspace,places,agents,services})
  return f
}

const follow = out => ({previousSessionId:out.sessionId,previousResolvedPresetId:out.resolvedPresetId,
  previousWorkspaceId:out.workspaceId,workerProof:out.workerProof})
const taskOf = r => r.messages.findLast(m=>m.role==='user' && m.source.kind==='user').content[0].text
const inputOf = r => JSON.parse(taskOf(r).split('\n').at(-1))
const names = r => r.tools.map(t=>t.name)
const seatRows = (f,id) => f.registrations.filter(r=>r.sessionId===id)
const resultsOf = (f,id) => f.agents.get(id).session.snapshotEvents().filter(e=>e.type==='tool/result').map(e=>e.data.message)
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const prove = (prev,m) => sha([prev,m.id,m.role,m.source?.kind,m.source?.rpcId,m.source?.provider,m.source?.model,m.content,
  ...m.role === 'tool' ? [m.toolCallId,m.isError] : []])
const settle = () => new Promise(resolve=>setImmediate(resolve))

test('empty director binding routes natively with the authorized topic and no acceptance criteria',async t=>{
  const f=await fixture(t)
  assert.deepEqual(await f.actors.decide(base),{action:'work',role:'develop'})
  const req=f.nativeRequests[0]
  assert.equal(req.model,'director');assert.deepEqual(names(req),routerTools);assert.ok(!('agentPreset' in f.requested[0]))
  assert.match(taskOf(req),/short reference, even a bare @mention/i)
  assert.match(taskOf(req),/no matching material or follow-up appeared before the trigger, call superagent_ignore/i)
  assert.match(taskOf(req),/superagent_route with the id of the helper in "helpers" whose description best fits/)
  assert.deepEqual(inputOf(req),{request:base.text,topic:base.workerContext,helpers})
  assert.equal(f.oneShots.length,0)
  for(const response of [route('lead'),call('superagent_route',{role:'answer',criteria:'not requested'}),call('superagent_deliver'),answer('Not the Router’s tool.')]) {
    f.control=response; await assert.rejects(f.actors.decide({...base,messageId:String(f.requested.length)}),denied)
  }
  f.control=ignore();assert.deepEqual(await f.actors.decide({...base,messageId:'skip'}),{action:'ignore'})
  f.workerChunks=chunks(ignore(),{end:'max-tokens'})
  await assert.rejects(f.actors.decide({...base,messageId:'incomplete'}),denied)
})

test('the router dispatches once and the selected worker checks its own public answer',async t=>{
  const f=await fixture(t), job={...base,team:{...base.team,lead:'my-team-lead'}}
  assert.equal(f.actors.review,undefined)
  assert.deepEqual(await f.actors.decide(job),{action:'work',role:'develop'})
  const result=await f.actors.work(job)
  assert.equal(result.answer,'First draft.')
  assert.deepEqual(f.requested.map(row=>row.agentPreset),['my-team-lead','engineer'])
  const [d,w]=f.nativeRequests
  assert.deepEqual(inputOf(d),{request:job.text,topic:job.workerContext,helpers})
  assert.deepEqual(inputOf(w),{role:job.role,request:job.text,topic:job.workerContext})
  assert.equal(d.model,'director');assert.equal(w.model,'coder');assert.notEqual(d.sessionId,w.sessionId)
  assert.equal(w.messages[0].content[0].text,'Actual persona: engineer')
  assert.match(taskOf(w),/Check your own result against the request/)
  assert.equal(f.nativeRequests.length,2);assert.equal(f.oneShots.length,0)
})

test('a worker asks for an @ only when the requester needs one to resume',async t=>{
  const f=await fixture(t), peer='ou_peer', dm={...base.source,privatePeerId:peer,privateChatsSince:1}
  for(const [i,[source,requesterId,needsMention]] of [
    [base.source,peer,true], [base.source,base.source.recipientId,true], [dm,peer,false], [dm,dm.recipientId,true],
  ].entries()) {
    await f.actors.work({...base,messageId:'om_ask'+i,source,requesterId})
    const req=f.nativeRequests.at(-1), instruction=taskOf(req).split('\n').slice(0,-1).join('\n')
    assert.equal(instruction.includes('补充后请 @我'),needsMention)
    assert.equal(instruction.includes('reply normally in this opted-in private chat'),!needsMention)
    assert.match(instruction,/Inspect the actual read-only attachment/)
    assert.match(instruction,/state what you tried and the concrete obstacle/)
    assert.ok(!instruction.includes(requesterId),'no raw Feishu identity in the rule')
    assert.deepEqual(names(req),workerTools)
  }
})

test('result tools exist only on the seat’s own agent scope and only for its turn',async t=>{
  const f=await fixture(t)
  await f.actors.decide(base)
  await f.actors.work(base)
  const [router,worker]=f.requested.map(r=>r.sessionId), [d,w]=f.nativeRequests
  assert.equal(d.sessionId,router);assert.deepEqual(names(d),routerTools)
  assert.equal(w.sessionId,worker);assert.deepEqual(names(w),workerTools)
  for(const r of [d,w]) for(const tool of r.tools) assert.equal(tool.parameters.additionalProperties,false)
  assert.deepEqual(seatRows(f,router).map(r=>r.name),routerTools)
  assert.deepEqual(seatRows(f,worker).map(r=>r.name),workerTools)
  assert.ok(f.registrations.every(r=>r.disposed),'withdrawn when the turn ends')
  assert.deepEqual(f.globalTools,[])
  // A later turn registers its tools afresh and withdraws them again.
  f.worker=ask('Which format?')
  const asked=await f.actors.work({...base,messageId:'om_m2'})
  f.worker=answer('Done.')
  await f.actors.work({...base,messageId:'om_m2',...follow(asked),previousQuestion:asked.question,requesterReply:'Markdown.'})
  assert.deepEqual(seatRows(f,asked.sessionId).map(r=>r.name),[...workerTools,...workerTools])
  assert.deepEqual(f.nativeRequests.slice(2).map(names),[workerTools,workerTools])
  assert.ok(f.registrations.every(r=>r.disposed))
})

test('result tools are withdrawn after a failed, aborted or refused turn',async t=>{
  const f=await fixture(t)
  f.end='aborted'
  await assert.rejects(f.actors.work(base),denied)
  assert.equal(seatRows(f,f.requested[0].sessionId).length,workerTools.length)
  assert.ok(f.registrations.every(r=>r.disposed))
  f.end=undefined
  const controller=new AbortController()
  f.script=[()=>{controller.abort();return answer('Too late.')}]
  await assert.rejects(f.actors.work({...base,messageId:'om_abort',signal:controller.signal}),uncertain)
  const aborted=f.requested[1].sessionId
  await f.agents.get(aborted).whenIdle();await settle()
  assert.equal(f.cancelled,true);assert.equal(seatRows(f,aborted).length,workerTools.length)
  assert.ok(f.registrations.every(r=>r.disposed))
  f.failRegister=name=>name==='superagent_ask_requester'
  const turns=f.turn
  await assert.rejects(f.actors.work({...base,messageId:'om_refused'}),denied)
  assert.deepEqual(seatRows(f,f.requested[2].sessionId).map(r=>[r.name,r.disposed]),[['superagent_answer',true]])
  assert.equal(f.turn,turns,'nothing is sent without the result tools')
  assert.deepEqual(f.globalTools,[])
})

test('invalid result arguments yield an error tool result; a second valid call in the same turn succeeds',async t=>{
  const f=await fixture(t)
  f.script=[call('superagent_answer',{answer:'   '}),answer('Valid answer.')]
  const out=await f.actors.work(base)
  assert.equal(out.answer,'Valid answer.')
  const [bad,good]=resultsOf(f,out.sessionId)
  assert.equal(bad.isError,true);assert.match(bad.content[0].text,/^Invalid arguments/)
  assert.equal(good.isError,false);assert.equal(good.content[0].text,'Recorded.')
  assert.equal(f.nativeRequests.length,2)
  assert.ok(f.nativeRequests[1].messages.includes(bad),'the model sees the error and retries')
  for(const [first,result] of [[route('lead'),route('answer')],[call('superagent_route','not json'),ignore()]]) {
    f.script=[first.args === 'not json' ? {name:first.name,arguments:'{"role":'} : first,result]
    const decision=await f.actors.decide({...base,messageId:'om_'+result.name})
    assert.deepEqual(decision,result.name==='superagent_ignore' ? {action:'ignore'} : {action:'work',role:'answer'})
    assert.deepEqual(resultsOf(f,f.requested.at(-1).sessionId).map(m=>m.isError),[true,false])
  }
})

test('a result the native loop records as an error does not commit',async t=>{
  const f=await fixture(t)
  f.resultErrors=1;f.script=[answer('Staged but failed.'),answer('Committed.')]
  const out=await f.actors.work(base)
  assert.equal(out.answer,'Committed.')
  assert.deepEqual(resultsOf(f,out.sessionId).map(m=>m.isError),[true,false])
  // The failed result never commits; after the plain reply the continued turn submits its own.
  f.resultErrors=1;f.script=[answer('Staged but failed.'),say('I have answered above.')]
  assert.equal((await f.actors.work({...base,messageId:'om_failed'})).answer,'First draft.')
  f.resultErrors=1;f.script=[route('answer'),say('Routed.')]
  assert.deepEqual(await f.actors.decide({...base,messageId:'om_failed'}),{action:'work',role:'develop'})
})

test('a worker has no stop tool: calling one is an unknown-tool error and the same turn continues to a real result',async t=>{
  const f=await fixture(t), refusal='I could not deploy this: the seat has no access to production.'
  f.script=[stop()];f.worker=answer(refusal)
  const out=await f.actors.work(base)
  assert.equal(out.answer,refusal)
  assert.deepEqual(resultsOf(f,out.sessionId).map(m=>[m.isError,m.content[0].text]),[[true,'Unknown tool: superagent_stop'],[false,'Recorded.']])
  assert.equal(f.nativeRequests.length,2);assert.equal(f.prompts.length,1,'the same turn continues without a nudge')
  assert.ok(f.nativeRequests.every(r=>!names(r).includes('superagent_stop')))
  assert.doesNotMatch(taskOf(f.nativeRequests[0]),/superagent_stop/)
  // Calling it again and again never produces a result; the run ends unfinished.
  f.script=undefined;f.worker=stop()
  await assert.rejects(f.actors.work({...base,messageId:'om_stuck'}),denied)
  assert.ok(f.registrations.every(r=>r.disposed))
})

test('a turn that ends in plain text continues in the same session until a result tool is called',async t=>{
  const f=await fixture(t)
  f.script=[say('This is a development request.'),say(JSON.stringify({action:'work',role:'answer'}))]
  assert.deepEqual(await f.actors.decide(base),{action:'work',role:'develop'})
  const router=f.requested[0].sessionId
  assert.deepEqual(f.prompts.map(p=>p.sessionId),[router,router,router]);assert.equal(f.requested.length,1)
  assert.match(f.prompts[0].text,/^SUPERAGENT_DECIDE\n/);assert.ok(f.prompts.slice(1).every(p=>continued.test(p.text)))
  assert.equal(new Set(f.prompts.map(p=>p.requestId)).size,3,'each continuation is a new request')
  // Neither plain text nor the legacy JSON text counts as a result in a new turn.
  f.prompts.length=0
  f.script=[say('Here is the function.'),legacy({action:'clarify',question:'Plain JSON?'})];f.worker=ask('Which language?')
  const asked=await f.actors.work(base)
  assert.equal(asked.question,'Which language?');assert.equal(f.prompts.length,3)
  const events=f.agents.get(asked.sessionId).session.snapshotEvents()
  assert.deepEqual(events.filter(e=>e.type==='turn/end').map(e=>e.data.reason.kind),['completed','completed','completed'])
  const nudges=events.filter(e=>e.type==='user/message' && continued.test(e.data.content[0].text)).map(e=>e.data)
  assert.equal(nudges.length,2)
  const last=f.nativeRequests.at(-1)
  assert.ok(nudges.every(m=>last.messages.includes(m)),'the model sees each continuation in its session')
  assert.deepEqual(names(last),workerTools)
  // The receipt chain covers the continuation turns, so the requester's reply resumes this worker.
  f.hooks.clear();f.actors=createActors(f.ctx,{workspacePath:f.workspace.path}) // Fresh host registration; no in-process state.
  f.worker=answer('The Chinese function.')
  const reply={...base,...follow(asked),previousQuestion:asked.question,requesterReply:'Chinese.'}
  await assert.rejects(f.actors.work({...reply,previousQuestion:'Plain JSON?'}),denied)
  const out=await f.actors.work(reply)
  assert.equal(out.answer,'The Chinese function.');assert.equal(out.sessionId,asked.sessionId)
  assert.equal(inputOf(f.nativeRequests.at(-1)).requesterReply,'Chinese.')
  assert.ok(f.registrations.every(r=>r.disposed))
})

test('an output-length stop continues the same session; other turn endings fail without continuing',async t=>{
  const f=await fixture(t)
  f.script=[say('A long answer that was cut','max-tokens')]
  const out=await f.actors.work(base)
  assert.equal(out.answer,'First draft.')
  const events=f.agents.get(out.sessionId).session.snapshotEvents()
  assert.deepEqual(events.filter(e=>e.type==='turn/end').map(e=>e.data.reason.kind),['max-tokens','completed'])
  assert.equal(f.prompts.length,2);assert.match(f.prompts[1].text,continued)
  f.script=[say('Still choosing','max-tokens')]
  assert.deepEqual(await f.actors.decide(base),{action:'work',role:'develop'})
  assert.equal(f.prompts.length,4)
  // Tool calls cut off by the output limit are a protocol violation, not a continuation.
  f.workerChunks=chunks(answer('Cut off.'),{end:'max-tokens'})
  await assert.rejects(f.actors.work({...base,messageId:'om_cut'}),denied)
  assert.equal(f.prompts.length,5);f.workerChunks=undefined
  f.worker=say('No result yet.')
  for(const end of ['aborted','error','blocked','interrupted']) {
    f.end=end
    await assert.rejects(f.actors.work({...base,messageId:'om_'+end}),denied)
    assert.ok(!continued.test(f.prompts.at(-1).text),'no continuation after '+end)
  }
  assert.ok(f.registrations.every(r=>r.disposed))
})

test('repeated result calls in one step: the latest successful one counts and ordinary tools still run',async t=>{
  const f=await fixture(t), stamp=call('fixture_stamp',{stamp:'late'})
  f.toolSchemas=[{name:'fixture_stamp'}]
  f.script=[[answer('Done.'),stamp,answer('Second result.')]]
  const out=await f.actors.work(base)
  assert.equal(out.answer,'Second result.');assert.equal(f.toolRan,1)
  assert.deepEqual(resultsOf(f,out.sessionId).map(m=>[m.isError,m.content[0].text]),
    [[false,'Recorded.'],[false,'fixture stamp'],[false,'Recorded.']])
  assert.equal(f.nativeRequests.length,1,'the turn concludes after that step')
  // An invalid or failed later call leaves the earlier successful result in place.
  f.script=[[answer('Kept.'),call('superagent_answer',{answer:'Kept.',extra:true})]]
  assert.equal((await f.actors.work({...base,messageId:'om_kept'})).answer,'Kept.')
  f.failResult=c=>c.arguments.includes('Rejected');f.script=[[answer('Kept again.'),answer('Rejected by the loop.')]]
  const kept=await f.actors.work({...base,messageId:'om_kept_again'})
  assert.equal(kept.answer,'Kept again.')
  assert.deepEqual(resultsOf(f,kept.sessionId).map(m=>m.isError),[false,true])
  // The Router's latest successful route counts too.
  f.script=[[route('answer'),ignore()]]
  assert.deepEqual(await f.actors.decide(base),{action:'ignore'})
})

test('seats reflect real live or persisted sessions; only the handed-over worker returns to native handling',async t=>{
  const f=await fixture(t), created=[]
  f.actors.observe(()=>created.push(f.requested.at(-1).sessionId))
  assert.deepEqual(await f.actors.seats(base),{})
  await f.actors.decide(base)
  const routerSessionId=f.requested[0].sessionId
  assert.deepEqual(await f.actors.seats(base),{routerSessionId})
  await f.actors.work(base)
  const workerSessionId=f.requested[1].sessionId, worker=f.agents.get(workerSessionId)
  assert.deepEqual(created,[routerSessionId,workerSessionId])
  assert.deepEqual(await f.actors.seats(base),{routerSessionId,workerSessionId})
  // A worker retry raises retries without a new Router decision; the earlier Router session still shows.
  assert.deepEqual(await f.actors.seats({...base,retries:1}),{routerSessionId,workerSessionId})
  assert.equal(await f.actors.workerWorkspace(workerSessionId),f.workspace.id)
  const stream=f.hooks.get('llm/stream')[0], question=f.hooks.get('user-questions/request')[0]
  let n=0;const next=()=>++n
  assert.throws(()=>stream({sessionId:workerSessionId},next),denied)
  await assert.rejects(question({agent:worker},next))
  f.actors.handOver([workerSessionId])
  assert.equal(stream({sessionId:workerSessionId},next),1)
  assert.equal(await question({agent:worker},next),2)
  assert.throws(()=>stream({sessionId:routerSessionId},next),denied)
  await assert.rejects(question({agent:f.agents.get(routerSessionId)},next))
  assert.equal(n,2)
  await assert.rejects(f.actors.work({...base,continueWork:true,retries:1}),denied)
  assert.equal(f.nativeRequests.length,2)
  assert.ok(f.registrations.every(r=>r.disposed),'a handed-over worker keeps no SuperAgent tools')
  f.agents.delete(workerSessionId)
  f.services.sessionPersistence.stat=id=>id===workerSessionId ? {header:worker.session.header} : undefined
  assert.deepEqual(await f.actors.seats(base),{routerSessionId,workerSessionId})
  assert.deepEqual(await f.actors.seats({...base,messageId:'om_other'}),{})
  assert.equal(created.length,2,'observing a stored session does not create one')
})

test('observing native approvals preserves every outcome and error and stays pending until the last concurrent request settles',async t=>{
  const gates=[],seq=[], answerer=()=>gates.shift().promise
  const f=await fixture(t,answerer), [observer,nativeAnswerer]=f.hooks.get('approval/request')
  assert.equal(nativeAnswerer,answerer,'observe before the native answerer claims the waterfall')
  const req={agent:{id:'superagent-auto-'+'1'.repeat(64)},toolName:'fixture'}
  f.actors.observe(()=>seq.push(f.actors.awaitingApproval()))
  const pending=()=>{const gate=Promise.withResolvers();gates.push(gate);return {...gate,reply:observer(req,nativeAnswerer)}}
  assert.equal(f.actors.awaitingApproval(),false)
  const first=pending(),second=pending()
  assert.equal(f.actors.awaitingApproval(),true)
  first.resolve('allowed-once');assert.equal(await first.reply,'allowed-once')
  assert.equal(f.actors.awaitingApproval(),true)
  second.resolve('rejected');assert.equal(await second.reply,'rejected')
  assert.equal(f.actors.awaitingApproval(),false)
  const last=pending(), err=Error('fixture failure')
  last.reject(err);await assert.rejects(last.reply,e=>e===err)
  assert.equal(f.actors.awaitingApproval(),false)
  assert.deepEqual(seq,[true,true,true,false,true,false])
})

test('handed-over and ordinary approvals never count; takeover drops any already pending notification without deciding it',async t=>{
  const f=await fixture(t), observer=f.hooks.get('approval/request')[0]
  const req={agent:{id:'superagent-auto-'+'2'.repeat(64)},toolName:'fixture'}
  const old=Promise.withResolvers(), reply=observer(req,()=>old.promise)
  assert.equal(f.actors.awaitingApproval(),true)
  f.actors.handOver([req.agent.id])
  assert.equal(f.actors.awaitingApproval(),false)
  for(const id of [req.agent.id,'ordinary-session']){
    const gate=Promise.withResolvers(), answer=observer({...req,agent:{id}},()=>gate.promise)
    assert.equal(f.actors.awaitingApproval(),false)
    gate.resolve('cancelled');assert.equal(await answer,'cancelled')
  }
  old.resolve('rejected');assert.equal(await reply,'rejected')
  assert.equal(f.actors.awaitingApproval(),false)
})

const ambient=(id,kind)=>({id,role:'user',source:{kind},content:[block(id)]})

test('native context and scoped schemas reach all seats',async t=>{
  const f=await fixture(t)
  f.inbox=[ambient('before','runtime-context')]
  f.additions=[ambient('recall','plugin:hindsight'),ambient('new plugin','previously-unknown')]
  f.moreSystem=true; f.persona='Actual assembled dynamic persona';f.toolSchemas=[{name:'scoped-tool'}]
  assert.deepEqual(await f.actors.decide(base),{action:'work',role:'develop'})
  assert.equal((await f.actors.work(base)).answer,'First draft.')
  assert.equal(f.nativeRequests.length,2)
  for(const [i,r] of f.nativeRequests.entries()) {
    assert.equal(r.messages[0].content[0].text,f.persona)
    assert.equal(r.messages[1].content[0].text,'extra native section')
    assert.deepEqual(r.messages.slice(2).map(m=>m.source.kind),['runtime-context','user','plugin:hindsight','previously-unknown'])
    assert.equal(inputOf(r).topic,base.workerContext);assert.deepEqual(names(r),['scoped-tool',...i ? workerTools : routerTools])
  }
})

for(const [problem,change] of [
  ['downstream rejection',f=>{f.preStepReject=true}],
  ['substituted task',f=>{f.replacePrompt=true}],
  ['additional actual user',f=>{f.additions=[ambient('manual','user')]}],
  ['queued actual user',f=>{f.inbox=[ambient('manual','user')]}],
  ['non-native request surface',f=>{f.fakeSurface=true}],
]) test('does not send '+problem+' to the model',async t=>{
  const f=await fixture(t);change(f)
  await assert.rejects(f.actors.decide(base),denied)
  assert.equal(f.nativeRequests.length,0);assert.equal(f.oneShots.length,0)
  assert.ok(f.registrations.every(r=>r.disposed))
})

test('a failed Router remains closed; retry opens a distinct Router and a first-time worker',async t=>{
  const f=await fixture(t)
  f.end='aborted'
  await assert.rejects(f.actors.decide(base),denied)
  const first=f.requested[0].sessionId
  f.end=undefined
  await assert.rejects(f.actors.decide(base),denied)
  const retry={...base,retries:1}
  assert.deepEqual(await f.actors.decide(retry),{action:'work',role:'develop'})
  const router=f.requested[1].sessionId
  assert.notEqual(router,first)
  assert.equal(f.nativeRequests[1].messages.some(m=>m.id==='u1'),false)
  const worker=await f.actors.work({...retry,continueWork:true})
  assert.ok(worker.answer);assert.notEqual(worker.sessionId,router)
  assert.equal(f.requested.length,3)
  assert.equal(Object.hasOwn(inputOf(f.nativeRequests.at(-1)),'continue'),false)
})

test('retry reopens the exact interrupted session; its new question yields a verifiable clarification receipt',async t=>{
  const f=await fixture(t)
  f.worker=answer('Recorded earlier work.');f.end='aborted'
  await assert.rejects(f.actors.work(base),denied)
  const id=f.requested[0].sessionId, prior=f.agents.get(id)
  f.agents.delete(id);f.existing={header:{...prior.session.header}}
  let woke=0
  f.services.sessionController.resolveAgent=sessionId=>{
    assert.equal(sessionId,id);woke++;f.agents.set(id,prior);return {agent:prior}
  }
  f.hooks.clear();f.actors=createActors(f.ctx,{workspacePath:f.workspace.path})
  f.end=undefined;f.worker=ask('Which month?')
  const asked=await f.actors.work({...base,retries:1,continueWork:true,team:{...base.team,develop:'new-team-preset'}})
  assert.equal(woke,1);assert.equal(asked.sessionId,id);assert.equal(asked.resolvedPresetId,'engineer')
  assert.equal(asked.question,'Which month?');assert.match(asked.workerProof,/^[a-f0-9]{64}$/)
  const req=f.nativeRequests.at(-1)
  assert.equal(req.model,'coder');assert.equal(inputOf(req).continue,true)
  assert.ok(req.messages.some(m=>m.role==='assistant' && m.content.some(b=>b.type==='tool-call' && b.arguments.includes('Recorded earlier work.'))))
  f.hooks.clear();f.actors=createActors(f.ctx,{workspacePath:f.workspace.path})
  const reply={...base,retries:1,...follow(asked),previousQuestion:asked.question,requesterReply:'October.'}
  await assert.rejects(f.actors.work({...reply,workerProof:'0'.repeat(64)}),denied)
  f.worker=answer('The October result.')
  const final=await f.actors.work(reply)
  assert.equal(final.answer,'The October result.');assert.equal(final.sessionId,id);assert.equal(f.requested.length,1)
  assert.notEqual(final.workerProof,asked.workerProof)
  const packet=inputOf(f.nativeRequests.at(-1))
  assert.equal(packet.requesterReply,'October.');assert.equal(Object.hasOwn(packet,'continue'),false)
})

test('a clarification reply can resume only the selected native worker and its actual question',async t=>{
  const f=await fixture(t)
  f.worker=ask('Which part of the function is needed?')
  const a=await f.actors.work(base)
  assert.equal(a.question,'Which part of the function is needed?');assert.equal(a.resolvedPresetId,'engineer')
  assert.equal(f.requested.length,1)
  assert.equal(f.requested[0].agentPreset,'engineer');assert.equal(f.nativeRequests[0].model,'coder')
  assert.equal(f.nativeRequests[0].messages[0].content[0].text,'Actual persona: engineer');assert.match(taskOf(f.nativeRequests[0]),/^SUPERAGENT_WORK/)
  const b={...base,...follow(a),previousQuestion:a.question,requesterReply:'Include the function body.'}
  await assert.rejects(f.actors.work({...b,previousSessionId:'some-other-session'}),denied)
  await assert.rejects(f.actors.work({...b,previousQuestion:'fake question'}),denied)
  await assert.rejects(f.actors.work({...b,attempt:2}),denied)
  f.worker=answer('The complete function.')
  const result=await f.actors.work(b)
  assert.equal(result.answer,'The complete function.');assert.equal(result.sessionId,a.sessionId)
  assert.match(result.workerProof,/^[a-f0-9]{64}$/);assert.notEqual(result.workerProof,a.workerProof)
  assert.equal(f.requested.length,1);assert.equal(f.lookups.length,1)
  assert.equal(inputOf(f.nativeRequests[1]).requesterReply,b.requesterReply)
  assert.equal(f.oneShots.length,0)
  await assert.rejects(f.actors.work(b),denied)
})

test('two clarifications and a final answer keep the actual native worker and every verified turn',async t=>{
  const f=await fixture(t)
  const asking=async(job,question)=>{f.worker=ask(question);const result=await f.actors.work(job)
    assert.equal(result.question,question);assert.ok(!('answer' in result));return result}
  const first=await asking(base,'Which format?')
  const reply={...base,...follow(first),previousQuestion:first.question,requesterReply:'Markdown.'}
  await assert.rejects(f.actors.work({...reply,workerProof:'0'.repeat(64)}),denied)
  await assert.rejects(f.actors.work({...reply,previousQuestion:'different question'}),denied)
  await assert.rejects(f.actors.work({...reply,previousWorkspaceId:'foreign'}),denied)
  const second=await asking(reply,'Which language?')
  assert.notEqual(first.workerProof,second.workerProof)
  await assert.rejects(f.actors.work(reply),denied)
  const last={...base,...follow(second),previousQuestion:second.question,requesterReply:'Chinese.',workerContext:base.workerContext+' UPDATED'}
  f.worker=answer('The final answer.')
  const result=await f.actors.work(last)
  assert.equal(result.answer,'The final answer.');assert.equal(f.requested.length,1)
  assert.ok([second,result].every(r=>r.sessionId===first.sessionId))
  // Each earlier turn keeps its request, the result tool call and its recorded result.
  assert.deepEqual(f.nativeRequests.map(r=>r.messages.length),[2,5,8])
  const context=f.nativeRequests.at(-1).messages
  assert.deepEqual(context.slice(1).map(m=>m.role),['user','assistant','tool','user','assistant','tool','user'])
  assert.ok(context[4].content[0].text.includes('Markdown.'));assert.deepEqual(inputOf(f.nativeRequests.at(-1)),{
    role:base.role,request:base.text,topic:last.workerContext,previousQuestion:second.question,requesterReply:last.requesterReply})
  assert.ok(f.nativeRequests.every(r=>r.sessionId===first.sessionId))
})

test('an otherwise valid clarification receipt cannot be moved to another requester',async t=>{
  const f=await fixture(t)
  f.worker=ask('Which version?')
  const first=await f.actors.work(base)
  await assert.rejects(f.actors.work({...base,...follow(first),requesterId:'ou_other',
    previousQuestion:first.question,requesterReply:'My version.'}),denied)
  assert.equal(f.nativeRequests.length,1)
})

for(const [label,step,setup,question,results] of [
  ['an ordinary tool the native policy denies after the question',[ask('Which month?'),call('fixture_stamp',{stamp:'late'})],
    f=>{f.nativeDeny=true},'Which month?',[[false,'Recorded.'],[true,'not run']]],
  ['other calls and a later question in the same step',
    [ask('Which month?'),call('fixture_stamp',{stamp:'late'}),ask('Which year?'),call('superagent_ask_requester',{question:''})],
    ()=>{},'Which year?',[[false,'Recorded.'],[false,'fixture stamp'],[false,'Recorded.'],[true,'Invalid arguments: follow the tool schema; text must be non-empty public text without credentials.']]],
]) test('a question resumes on the requester’s reply despite '+label,async t=>{
  const f=await fixture(t);setup(f)
  f.toolSchemas=[{name:'fixture_stamp'}];f.script=[step]
  const asked=await f.actors.work(base)
  assert.equal(asked.question,question)
  assert.deepEqual(resultsOf(f,asked.sessionId).map(m=>[m.isError,m.content[0].text]),results)
  f.hooks.clear();f.actors=createActors(f.ctx,{workspacePath:f.workspace.path}) // Fresh host registration; no in-process state.
  const reply={...base,...follow(asked),previousQuestion:question,requesterReply:'October.'}
  for(const other of ['late','Which month?','Which year?'].filter(q=>q!==question))
    await assert.rejects(f.actors.work({...reply,previousQuestion:other}),denied)
  f.worker=answer('The October report.')
  const final=await f.actors.work(reply)
  assert.equal(final.answer,'The October report.');assert.equal(final.sessionId,asked.sessionId)
  assert.equal(inputOf(f.nativeRequests.at(-1)).requesterReply,'October.')
})

for(const [label,patch] of [
  ['unknown original requester',{requesterId:undefined}],
  ['question for another participant',{output:call('superagent_ask_requester',{question:'Your timezone?',recipientId:'someone-else'})}],
  ['question and final answer mixed',{output:call('superagent_ask_requester',{question:'Which version?',answer:'Already done'})}],
  ['a credential in a question',{output:ask('Is this Bearer abcdefghijklmnopqrstuvwxyz correct?')}],
]) test('worker rejects '+label,async t=>{
  const f=await fixture(t),{output,...job}=patch
  f.worker=output ?? ask('Which version?')
  await assert.rejects(f.actors.work({...base,...job}),denied)
})

test('empty worker binding inherits workspace native preset, not lead, and leaves tool permission to DSH',async t=>{
  const f=await fixture(t)
  const a=await f.actors.work({...base,role:'answer',team:{lead:'not-this-one',answer:'',develop:''}})
  assert.equal(a.resolvedPresetId,'workspace-default')
  assert.ok(taskOf(f.nativeRequests[0]).startsWith('SUPERAGENT_WORK'))
  assert.ok(!('agentPreset' in f.requested[0]));assert.equal(f.nativeRequests[0].model,'native-default')
  const agent=f.agents.get(a.sessionId)
  assert.deepEqual(f.globalTools,[]);assert.ok(f.registrations.every(r=>r.disposed))
  assert.equal(f.hooks.get('tools/execute'),undefined)
  await assert.rejects(f.hooks.get('user-questions/request')[0]({agent},()=>assert.fail()))
  assert.equal(f.hooks.get('llm/stream')[0]({sessionId:'owner'},()=>3),3)
})

for(const [title,setup] of [
  ['accepted but no result',f=>{f.ackOnly=true}],
  ['incomplete turn',f=>{f.end='aborted'}],
  ['malformed tool call',f=>{f.toolSchemas=[{name:'shell'}];f.workerChunks=[{type:'block-start',index:0,blockType:'tool-call'},{type:'block-end',index:0,block:{type:'tool-call',name:'shell'}}]}],
  ['counterfeit final replacing model output',f=>{f.counterfeit=blocks=>blocks.map(b=>b.type==='tool-call' ? {...b,arguments:JSON.stringify({answer:'alternate data'})} : b)}],
  ['structured output with internal fields',f=>{f.worker=call('superagent_answer',{answer:'hi',thought:'secret'})}],
  ['candidate containing a credential',f=>{f.worker=answer('Bearer abcdefghijklmnopqrstuvwxyz')}],
  ['previously existing Session',f=>{f.existing={header:{}}}],
]) test('does not accept '+title,async t=>{
  const f=await fixture(t);setup(f)
  await assert.rejects(f.actors.work(base),f.ackOnly ? uncertain : denied)
  assert.ok(!f.toolRan);assert.ok(f.prompts.length <= 1,'no continuation')
  if(f.existing) assert.equal(f.nativeRequests.length,0)
  assert.ok(f.registrations.every(r=>r.disposed))
})

for(const problem of ['prior user text replaced under the same ID','prior question replaced under the same ID'])
test('rejects '+problem+' before sending any clarification reply',async t=>{
  const f=await fixture(t)
  f.worker=ask('Which example?')
  const a=await f.actors.work(base)
  f.replacePrior=problem.includes('user text')?'u1':'a1'
  await assert.rejects(f.actors.work({...base,...follow(a),previousQuestion:a.question,requesterReply:'A sorting function.'}),denied)
  assert.equal(f.nativeRequests.length,1)
})

test('compaction may call a different model and remove old messages without replacing or forking the worker',async t=>{
  const f=await fixture(t)
  f.sideCall=true;f.worker=ask('Which format?')
  const a=await f.actors.work(base)
  f.compact=true;f.persona='Edited deployment';f.additions=[ambient('summary','native-summary')]
  f.worker=answer('The Markdown version.')
  const b=await f.actors.work({...base,...follow(a),previousQuestion:a.question,requesterReply:'Markdown.'})
  assert.equal(b.answer,'The Markdown version.')
  assert.equal(f.sideCalls,2);assert.equal(b.sessionId,a.sessionId);assert.notEqual(b.workerProof,a.workerProof)
  assert.ok(!f.nativeRequests.at(-1).messages.some(m=>m.id==='a1'))
})

// Workers recorded before result tools finished their turn with JSON text. Today's host never accepts that
// text from a new turn, so the fixture records such a session and stops the run before it continues.
async function legacyWorker(f,persona) {
  f.persona=persona;f.worker=legacy({action:'clarify',question:'Which language?'});f.end='aborted'
  await assert.rejects(f.actors.work(base),denied)
  f.end=undefined
  const sessionId=f.requested.at(-1).sessionId, session=f.agents.get(sessionId).session
  const events=session.snapshotEvents()
  const turns=[events.find(e=>e.type==='user/message').data,events.find(e=>e.type==='assistant/message').data.message]
  assert.deepEqual(turns.map(m=>m.role),['user','assistant'])
  return {sessionId,workspaceId:f.workspace.id,resolvedPresetId:'engineer',question:'Which language?',turns}
}

test('a stored legacy worker whose last message is the old JSON clarification still resumes',async t=>{
  const f=await fixture(t)
  const old=await legacyWorker(f,'Actual persona: engineer')
  const seat=[old.sessionId,old.workspaceId,old.resolvedPresetId,base.role,base.text,base.requesterId,'offline','coder',undefined]
  const workerProof=old.turns.reduce(prove,sha(['native-v2',...seat]))
  const prior=f.agents.get(old.sessionId)
  f.agents.delete(old.sessionId);f.existing={header:{...prior.session.header}}
  f.services.sessionController.resolveAgent=sessionId=>{assert.equal(sessionId,old.sessionId);f.agents.set(sessionId,prior);return {agent:prior}}
  f.hooks.clear();f.actors=createActors(f.ctx,{workspacePath:f.workspace.path})
  const reply={...base,...follow({...old,workerProof}),previousQuestion:old.question,requesterReply:'Chinese.'}
  await assert.rejects(f.actors.work({...reply,previousQuestion:'Which format?'}),denied)
  f.worker=answer('The Chinese text.')
  const out=await f.actors.work(reply)
  assert.equal(out.answer,'The Chinese text.');assert.equal(out.sessionId,old.sessionId);assert.notEqual(out.workerProof,workerProof)
  assert.equal(f.requested.length,1)
  assert.deepEqual(f.nativeRequests.at(-1).messages.slice(1,3),old.turns)
})

test('a restored v1 worker receipt upgrades from the original native system event despite persona changes and compaction',async t=>{
  const f=await fixture(t)
  const old=await legacyWorker(f,'Old static worker system')
  const v1=old.turns.reduce((prev,m)=>sha([prev,m.id,m.role,m.source.kind,
    m.source.rpcId,m.source.provider,m.source.model,m.content]),sha([old.sessionId,old.workspaceId,old.resolvedPresetId,
    base.role,base.text,base.requesterId,'offline','coder',undefined,f.persona]))
  f.hooks.clear();f.actors=createActors(f.ctx,{workspacePath:f.workspace.path}) // Fresh host registration; no in-process receipt cache.
  f.persona='New runtime persona';f.compact=true;f.worker=ask('Which format?')
  const reply={...base,...follow(old),previousQuestion:old.question,requesterReply:'Chinese.'}
  await assert.rejects(f.actors.work({...reply,workerProof:'0'.repeat(64)}),denied)
  const b=await f.actors.work({...reply,workerProof:v1})
  assert.equal(b.sessionId,old.sessionId);assert.notEqual(b.workerProof,v1);assert.equal(b.question,'Which format?')
  f.worker=answer('The final text.')
  const c=await f.actors.work({...base,...follow(b),previousQuestion:b.question,requesterReply:'Markdown.'})
  assert.equal(c.answer,'The final text.');assert.equal(c.sessionId,old.sessionId);assert.notEqual(c.workerProof,b.workerProof)
})

test('does not send to a missing or broken preset; masks ambiguous native acknowledgement failures',async t=>{
  const f=await fixture(t)
  await assert.rejects(f.actors.work({...base,team:{...base.team,develop:'broken'}}),denied)
  assert.equal(f.requested.length,0)
  f.failPrompt=true
  await assert.rejects(f.actors.work(base),{code:'WORK_UNCERTAIN',message:'WORK_UNCERTAIN'})
  assert.ok(f.registrations.length && f.registrations.every(r=>r.disposed))
})

const testCall={id:'tc-stamp',name:'fixture_stamp',arguments:'{"stamp":"exact fixture"}'}
const toolJob=f=>{f.toolSchemas=[{name:testCall.name}];f.issueCalls=[testCall];return base}
const toolResult=r=>r.messages.find(m=>m.role==='tool' && m.toolCallId===testCall.id)

test('preset tools run under native DSH policy without a SuperAgent approval; a cold worker reuses the recorded result',async t=>{
  const f=await fixture(t)
  f.worker=ask('Include the fixture stamp?')
  const first=await f.actors.work(toolJob(f))
  assert.equal(first.question,'Include the fixture stamp?')
  assert.equal(f.toolRan,1);assert.equal(f.approved.length,0);assert.equal(f.nativeRequests.length,2)
  assert.equal(toolResult(f.nativeRequests[1]).content[0].text,'fixture stamp')
  f.issueCalls=undefined;f.hooks.clear()
  f.actors=createActors(f.ctx,{workspacePath:f.workspace.path}) // Fresh host registration; no in-process state.
  f.worker=answer('The fixture stamp.')
  const next=await f.actors.work({...base,...follow(first),previousQuestion:first.question,requesterReply:'Yes.'})
  assert.equal(next.answer,'The fixture stamp.')
  assert.equal(next.sessionId,first.sessionId);assert.notEqual(next.workerProof,first.workerProof)
  assert.equal(f.toolRan,1);assert.equal(toolResult(f.nativeRequests.at(-1)).content[0].text,'fixture stamp')
})

for(const [label,setup,ran,asked] of [
  ['an ask approved once',f=>{f.nativeAsk=true;f.localDecision=()=>'allowed-once'},1,1],
  ['an ask rejected',f=>{f.nativeAsk=true;f.localDecision=()=>'rejected'},0,1],
  ['an ask without an answerer',f=>{f.nativeAsk=true},0,1],
  ['a deny',f=>{f.nativeDeny=true},0,0],
]) test('native policy decides each call: '+label+'; the worker continues with the native result',async t=>{
  const f=await fixture(t);setup(f)
  const out=await f.actors.work(toolJob(f))
  assert.equal(out.answer,'First draft.');assert.equal(f.toolRan||0,ran);assert.equal(f.approved.length,asked)
  assert.equal(toolResult(f.nativeRequests.at(-1)).isError,!ran)
})

test('a tool call recorded differently from the model output is not accepted',async t=>{
  const f=await fixture(t);f.tamperCall=true
  await assert.rejects(f.actors.work(toolJob(f)),denied)
})

test('cancellation is bounded even if the native prompt admission stalls',async t=>{
  const f=await fixture(t), controller=new AbortController()
  f.stall=true
  const started=Promise.withResolvers(), orig=f.services.sessionController.prompt
  f.services.sessionController.prompt=(...args)=>{started.resolve();return orig(...args)}
  const pending=f.actors.work({...base,signal:controller.signal})
  await started.promise
  controller.abort()
  await assert.rejects(pending,{code:'WORK_UNCERTAIN'})
  assert.equal(f.cancelled,true)
  assert.equal(f.hooks.get('session/event').length,0)
  assert.equal(seatRows(f,f.requested[0].sessionId).length,workerTools.length)
  assert.ok(f.registrations.every(r=>r.disposed),'the result tools leave the session although the prompt never settles')
})

test('the Router sees the other registered DSH workspaces and may place the worker in one of them',async t=>{
  const f=await fixture(t), project=f.place('proj','Project'), docs=f.place('docs','Docs')
  f.control=call('superagent_route',{role:'develop',workspace:'proj'})
  assert.deepEqual(await f.actors.decide(base),{action:'work',role:'develop',workspaceId:'proj'})
  const [d]=f.nativeRequests
  assert.deepEqual(inputOf(d),{request:base.text,topic:base.workerContext,helpers,
    workspaces:[{id:'proj',title:'Project',path:project.path},{id:'docs',title:'Docs',path:docs.path}]})
  const schema=d.tools.find(x=>x.name==='superagent_route').parameters
  assert.deepEqual(schema.properties.workspace.enum,['proj','docs']);assert.deepEqual(schema.required,['role'])
  assert.equal(f.requested[0].workspaceId,'ws','the Router itself works in the SuperAgent workspace')
  assert.equal(f.agents.get(f.requested[0].sessionId).session.header.cwd,f.workspace.path)
  const out=await f.actors.work({...base,targetWorkspaceId:'proj'})
  assert.equal(out.workspaceId,'proj');assert.equal(f.requested[1].workspaceId,'proj')
  assert.equal(f.agents.get(out.sessionId).session.header.cwd,project.path)
  assert.deepEqual(project.sessionIds,[out.sessionId]);assert.ok(!f.workspace.sessionIds.includes(out.sessionId))
  assert.equal(await f.actors.workerWorkspace(out.sessionId),'proj');assert.equal(f.actors.workspaceTitle('proj'),'Project')
  // SuperAgent's own workspace is never offered; a later decision may leave the worker unplaced.
  f.control=route('answer')
  assert.deepEqual(await f.actors.decide({...base,retries:1}),{action:'work',role:'answer'})
  assert.deepEqual(inputOf(f.nativeRequests.at(-1)).workspaces.map(w=>w.id),['proj','docs'])
  const plain=await f.actors.work({...base,messageId:'om_plain',role:'answer'})
  assert.equal(plain.workspaceId,'ws');assert.equal(f.agents.get(plain.sessionId).session.header.cwd,f.workspace.path)
  assert.deepEqual(project.sessionIds,[out.sessionId])
})

test('a workspace outside the list is an argument error the Router can correct',async t=>{
  const f=await fixture(t)
  await f.actors.decide({...base,messageId:'om_first'}) // Registers SuperAgent's own workspace.
  f.place('proj','Project')
  f.script=[call('superagent_route',{role:'develop',workspace:'ws'}),call('superagent_route',{role:'develop',workspace:'elsewhere'}),
    call('superagent_route',{role:'develop',workspace:'proj'})]
  assert.deepEqual(await f.actors.decide(base),{action:'work',role:'develop',workspaceId:'proj'})
  assert.deepEqual(resultsOf(f,f.requested.at(-1).sessionId).map(m=>m.isError),[true,true,false])
  const lone=await fixture(t)
  lone.script=[call('superagent_route',{role:'develop',workspace:'ws'}),route('answer')]
  assert.deepEqual(await lone.actors.decide(base),{action:'work',role:'answer'})
  assert.equal(lone.nativeRequests[0].tools.find(x=>x.name==='superagent_route').parameters.properties.workspace,undefined)
  assert.ok(!('workspaces' in inputOf(lone.nativeRequests[0])))
  assert.deepEqual(resultsOf(lone,lone.requested[0].sessionId).map(m=>m.isError),[true,false])
})

test('a chosen workspace that is gone, missing or not absolute fails the worker before any session exists',async t=>{
  const f=await fixture(t), project=f.place('proj','Project')
  project.state='missing'
  await assert.rejects(f.actors.work({...base,targetWorkspaceId:'proj'}),denied)
  f.places.delete('proj')
  await assert.rejects(f.actors.work({...base,targetWorkspaceId:'proj'}),denied)
  f.place('rel','Relative').path='relative/path'
  await assert.rejects(f.actors.work({...base,targetWorkspaceId:'rel'}),denied)
  await assert.rejects(f.actors.work({...base,targetWorkspaceId:'unknown'}),denied)
  assert.equal(f.requested.length,0);assert.equal(f.nativeRequests.length,0);assert.equal(f.registrations.length,0)
})

test('resume, continue and takeover follow the workspace the worker session actually lives in',async t=>{
  const f=await fixture(t), project=f.place('proj','Project')
  await f.actors.decide(base)
  const router=f.requested[0].sessionId
  f.worker=ask('Which month?')
  const asked=await f.actors.work({...base,targetWorkspaceId:'proj'})
  assert.equal(asked.workspaceId,'proj')
  const reply={...base,targetWorkspaceId:'proj',...follow(asked),previousQuestion:asked.question,requesterReply:'October.'}
  await assert.rejects(f.actors.work({...reply,previousWorkspaceId:'ws'}),denied)
  project.state='missing'
  await assert.rejects(f.actors.work(reply),denied)
  project.state='ok'
  // A stored worker restores only from the chosen workspace's directory.
  const prior=f.agents.get(asked.sessionId)
  f.agents.delete(asked.sessionId);f.services.sessionController.resolveAgent=id=>{f.agents.set(id,prior);return {agent:prior}}
  f.hooks.clear();f.actors=createActors(f.ctx,{workspacePath:f.workspace.path})
  f.existing={header:{...prior.session.header,cwd:f.workspace.path}}
  await assert.rejects(f.actors.work(reply),denied)
  f.existing={header:{...prior.session.header}}
  f.worker=answer('The October report.')
  const done=await f.actors.work(reply)
  assert.deepEqual([done.answer,done.sessionId,done.workspaceId],['The October report.',asked.sessionId,'proj'])
  f.existing=undefined
  // An owner retry continues the session in its workspace; SuperAgent's own workspace does not hold it.
  f.end='aborted';f.worker=answer('Partial.')
  const job={...base,messageId:'om_retry',targetWorkspaceId:'proj'}
  await assert.rejects(f.actors.work(job),denied)
  f.end=undefined;f.worker=answer('Finished.')
  await assert.rejects(f.actors.work({...job,retries:1,continueWork:true,targetWorkspaceId:undefined}),denied)
  for(const placement of [{},{previousWorkspaceId:'proj'}]) {
    const out=await f.actors.work({...job,retries:1,continueWork:true,...placement})
    assert.deepEqual([out.answer,out.workspaceId],['Finished.','proj']);assert.equal(inputOf(f.nativeRequests.at(-1)).continue,true)
  }
  assert.equal(project.sessionIds.length,2);assert.deepEqual(f.workspace.sessionIds,[router])
  // Takeover names the workspace that holds each session.
  assert.equal(await f.actors.workerWorkspace(asked.sessionId),'proj')
  assert.equal(await f.actors.workerWorkspace(router),'ws')
  await assert.rejects(f.actors.workerWorkspace('superagent-auto-'+'0'.repeat(64)),denied)
})

test('SuperAgent’s own workspace is never offered, even when its directory is missing',async t=>{
  const f=await fixture(t)
  f.workspace.registered=true;f.place('proj','Project') // Registered earlier; the directory no longer exists.
  await f.actors.decide(base)
  assert.deepEqual(inputOf(f.nativeRequests[0]).workspaces.map(w=>w.id),['proj'])
})

test('the Router session is archived once it has decided; failed decisions are not, and a Router retry opens a fresh session',async t=>{
  const f=await fixture(t), archived=f.services.workspaceRegistry.archivedSessionIds
  await f.actors.decide(base)
  const router=f.requested[0].sessionId
  assert.deepEqual(f.archives,[[router,undefined]]);assert.deepEqual(archived,[router])
  f.control=ignore()
  await f.actors.decide({...base,messageId:'om_ignore'})
  assert.deepEqual(f.archives.map(([id])=>id),[router,f.requested[1].sessionId])
  f.end='aborted'
  await assert.rejects(f.actors.decide({...base,messageId:'om_aborted'}),denied)
  f.end=undefined;f.control=route('lead')
  await assert.rejects(f.actors.decide({...base,messageId:'om_invalid'}),denied)
  assert.equal(f.archives.length,2,'a failed decision keeps its session open')
  f.control=route('develop')
  await assert.rejects(f.actors.decide(base),denied)
  assert.deepEqual(await f.actors.decide({...base,retries:1}),{action:'work',role:'develop'})
  const retried=f.requested.at(-1).sessionId
  assert.notEqual(retried,router);assert.deepEqual(f.archives.at(-1),[retried,undefined])
  assert.deepEqual(await f.actors.seats({...base,retries:1}),{routerSessionId:retried})
  assert.equal((await f.actors.work(base)).answer,'First draft.','the worker is not affected')
  // A failed archive, or a registry without archiving, leaves the decision intact.
  f.failArchive=true
  assert.deepEqual(await f.actors.decide({...base,messageId:'om_offline'}),{action:'work',role:'develop'})
  assert.ok(!archived.includes(f.requested.at(-1).sessionId))
  delete f.services.workspaceRegistry.archiveSession
  assert.deepEqual(await f.actors.decide({...base,messageId:'om_plain'}),{action:'work',role:'develop'})
})

test('archiving a case’s seats archives the Router and worker with stopActivity, stops the running worker and never reopens it',async t=>{
  const f=await fixture(t)
  await f.actors.decide(base)
  const router=f.requested[0].sessionId, started=Promise.withResolvers()
  f.toolSchemas=[{name:testCall.name}];f.issueCalls=[testCall];f.toolGate=new Promise(()=>{});f.onTool=()=>started.resolve()
  const running=f.actors.work(base)
  await started.promise
  const worker=f.requested[1].sessionId
  await f.actors.archiveSeats(base)
  assert.deepEqual(f.archives,[[router,undefined],[router,{stopActivity:true}],[worker,{stopActivity:true}]])
  await assert.rejects(running,denied)
  assert.equal(f.cancelled,true);assert.equal(f.toolRan,undefined)
  assert.equal(f.agents.get(worker).session.snapshotEvents().filter(e=>e.type==='turn/end').at(-1).data.reason.kind,'aborted')
  assert.ok(f.registrations.every(r=>r.disposed))
  const sent=f.prompts.length;f.toolGate=undefined;f.issueCalls=undefined
  await assert.rejects(f.actors.work({...base,retries:1,continueWork:true}),denied)
  assert.equal(f.prompts.length,sent,'an archived worker is never prompted again')
  assert.deepEqual(await f.actors.decide({...base,retries:1}),{action:'work',role:'develop'})
  await f.actors.archiveSeats({...base,messageId:'om_none'}) // A job without sessions archives nothing.
  assert.equal(f.archives.length,4)
})

test('a case archived while its worker runs ends failed: the worker stops and nothing later overwrites or posts',async t=>{
  const f=await fixture(t), sent=[]
  let disk
  const open=()=>createLoop({load:async()=>structuredClone(disk),save:async s=>{disk=structuredClone(s)},
    decide:f.actors.decide,work:f.actors.work,deliver:j=>{sent.push(j);return null},isReleaseRequired:()=>false})
  const loop=open(), started=Promise.withResolvers()
  f.toolSchemas=[{name:testCall.name}];f.issueCalls=[testCall];f.toolGate=new Promise(()=>{});f.onTool=()=>started.resolve()
  await loop.enqueue({...base,workerContext:'Authorized thread',signal:undefined,role:undefined,attempt:undefined})
  const drained=loop.drain()
  await started.promise
  assert.equal((await loop.snapshot())[0].status,'working')
  // What archiving the case does for each of its jobs.
  for(const j of (await loop.jobInputs()).filter(j=>j.caseId===base.caseId)) await f.actors.archiveSeats(j)
  await drained
  const [row]=await loop.snapshot()
  assert.deepEqual([row.status,row.reason],['stopped','work-failed'])
  assert.deepEqual(sent,[]);assert.equal(f.toolRan,undefined)
  await loop.drain();await loop.dispose()
  const reopened=open();await reopened.drain()
  assert.deepEqual(await reopened.snapshot(),[row]);assert.deepEqual(sent,[])
  await reopened.dispose()
})

const mergeTools = ['superagent_route','superagent_merge','superagent_ignore']

test('the Router sees the conversation’s open work and gets the merge tool only when there is some',async t=>{
  const f=await fixture(t)
  const openWork=[{ref:'w1',request:'Earlier request',state:'in progress'},{ref:'w2',request:'Answered request',state:'replied',output:'The earlier reply.'}]
  f.control=call('superagent_merge',{target:'w2'})
  assert.deepEqual(await f.actors.decide({...base,openWork}),{action:'merge',target:'w2'})
  const [d]=f.nativeRequests
  assert.deepEqual(inputOf(d),{request:base.text,topic:base.workerContext,helpers,openWork})
  assert.deepEqual(names(d),mergeTools)
  assert.match(taskOf(d),/"openWork".*file, image or explanation between that question and this @.*superagent_merge with that ref/s)
  assert.match(taskOf(d),/do not guess between items/i)
  const schema=d.tools.find(x=>x.name==='superagent_merge').parameters
  assert.deepEqual([schema.properties.target.enum,schema.required,schema.additionalProperties],[['w1','w2'],['target'],false])
  assert.deepEqual(seatRows(f,d.sessionId).map(r=>r.name),mergeTools);assert.ok(f.registrations.every(r=>r.disposed))
  // A ref outside the list or extra arguments are argument errors the Router can correct.
  f.script=[call('superagent_merge',{target:'w3'}),call('superagent_merge',{target:'w1',why:'same topic'}),call('superagent_merge',{target:'w1'})]
  assert.deepEqual(await f.actors.decide({...base,messageId:'om_retarget',openWork}),{action:'merge',target:'w1'})
  assert.deepEqual(resultsOf(f,f.requested.at(-1).sessionId).map(m=>m.isError),[true,true,false])
  // Without open work there is no merge tool; calling it anyway is an unknown tool.
  for(const [n,none] of [undefined,[],'w1',[{ref:'w1',request:'x',state:'replied',key:'private'}]].entries()) {
    f.script=[call('superagent_merge',{target:'w1'}),route('answer')]
    assert.deepEqual(await f.actors.decide({...base,messageId:'om_alone'+n,openWork:none}),{action:'work',role:'answer'})
    const r=f.nativeRequests.at(-2)
    assert.deepEqual(names(r),routerTools);assert.ok(!('openWork' in inputOf(r)))
    assert.deepEqual(resultsOf(f,f.requested.at(-1).sessionId).map(m=>[m.isError,m.content[0].text]),
      [[true,'Unknown tool: superagent_merge'],[false,'Recorded.']])
  }
})

test('in a case that already has its worker the Router gets no route tool or helpers and hands the message to that worker',async t=>{
  const f=await fixture(t)
  const openWork=[{ref:'w1',request:'Earlier request',state:'replied',output:'The earlier reply.'}]
  f.script=[route('develop'),call('superagent_merge',{target:'w1'})]
  assert.deepEqual(await f.actors.decide({...base,openWork,routable:false}),{action:'merge',target:'w1'})
  const d=f.nativeRequests.at(-2)
  assert.deepEqual(names(d),['superagent_merge','superagent_ignore'])
  assert.deepEqual(inputOf(d),{request:base.text,topic:base.workerContext,openWork})
  assert.match(taskOf(d),/already has its worker, listed in "openWork"\. Hand any request, question, correction, follow-up or supplement in it to that worker with superagent_merge, even if it is a new request; do not start new work\./)
  assert.doesNotMatch(taskOf(d),/superagent_route|No helper is available/)
  assert.deepEqual(seatRows(f,d.sessionId).map(r=>r.name),['superagent_merge','superagent_ignore'])
  assert.deepEqual(resultsOf(f,f.requested.at(-1).sessionId).map(m=>[m.isError,m.content[0].text]),
    [[true,'Unknown tool: superagent_route'],[false,'Recorded.']])
  // It can still ignore what asks nothing of the worker.
  f.control=ignore()
  assert.deepEqual(await f.actors.decide({...base,messageId:'om_chatter',openWork,routable:false}),{action:'ignore'})
  assert.deepEqual(names(f.nativeRequests.at(-1)),['superagent_merge','superagent_ignore'])
})

test('malformed open work never reaches the Router, and it sees at most ten requests',async t=>{
  const f=await fixture(t)
  const valid=Array.from({length:12},(_,i)=>({ref:'w'+(i+3),request:'Request '+(i+3),state:'not started'}))
  const openWork=[{ref:'w1',request:'Leaks a key',state:'in progress',caseId:'case-private'},{ref:'w2',request:'',state:'replied'},
    {ref:'w99999999999999999',request:'Long ref',state:'replied'},{ref:'w0',request:'Too long output',state:'replied',output:'x'.repeat(16385)},...valid]
  f.script=[call('superagent_merge',{target:'w13'}),call('superagent_merge',{target:'w12'})]
  assert.deepEqual(await f.actors.decide({...base,openWork}),{action:'merge',target:'w12'})
  const [d]=f.nativeRequests
  assert.deepEqual(inputOf(d).openWork,valid.slice(0,10))
  assert.deepEqual(d.tools.find(x=>x.name==='superagent_merge').parameters.properties.target.enum,valid.slice(0,10).map(w=>w.ref))
  assert.doesNotMatch(JSON.stringify(f.nativeRequests),/case-private|Leaks a key/)
  assert.deepEqual(resultsOf(f,d.sessionId).map(m=>m.isError),[true,false])
})

test('merged messages reach the worker as supplements; it continues its own session after the interrupted run winds down',async t=>{
  const f=await fixture(t), started=Promise.withResolvers(), controller=new AbortController()
  f.toolSchemas=[{name:testCall.name}];f.issueCalls=[testCall];f.toolGate=new Promise(()=>{});f.onTool=()=>started.resolve()
  const interrupted=f.actors.work({...base,signal:controller.signal})
  await started.promise
  const id=f.requested[0].sessionId, agent=f.agents.get(id), native=agent.whenIdle, idle=Promise.withResolvers(), waiting=Promise.withResolvers()
  // The merge aborts this run; the native session is still winding down when the worker continues.
  agent.status='running'
  agent.whenIdle=()=>{waiting.resolve();return idle.promise.then(()=>{agent.status='idle';agent.whenIdle=native;return native()})}
  controller.abort()
  await assert.rejects(interrupted,uncertain)
  f.toolGate=undefined;f.issueCalls=undefined;f.worker=answer('Revised with the newer messages.')
  const supplements=[{from:'requester',text:'Also cover the empty input.'},{from:'participant',text:'Please use TypeScript.'}]
  const sent=f.prompts.length
  const continuing=f.actors.work({...base,continueWork:true,previousWorkspaceId:f.workspace.id,supplements})
  await waiting.promise
  assert.equal(f.prompts.length,sent,'nothing is sent while the earlier run is still active')
  idle.resolve()
  const out=await continuing
  assert.deepEqual([out.answer,out.sessionId,out.workspaceId],['Revised with the newer messages.',id,f.workspace.id])
  assert.equal(f.requested.length,1,'no new session')
  const last=f.nativeRequests.at(-1)
  assert.deepEqual(inputOf(last),{role:base.role,request:base.text,topic:base.workerContext,supplements,continue:true})
  assert.match(taskOf(last),/"supplements".*superseded/s)
  assert.ok(last.messages.some(m=>m.role==='assistant' && m.content.some(b=>b.type==='tool-call' && b.id===testCall.id)),'the model sees its interrupted work')
  assert.ok(f.registrations.every(r=>r.disposed))
})

test('worker supplements must be well-formed, from the requester or a participant, and at most twenty',async t=>{
  const f=await fixture(t)
  const one={from:'requester',text:'A newer message.'}
  for(const [n,supplements] of [[],Array(21).fill(one),[{...one,from:'owner'}],[{...one,senderId:'ou_x'}],[{from:'participant',text:' '}],
    [{from:'participant',text:'x'.repeat(65537)}],'A newer message.'].entries())
    await assert.rejects(f.actors.work({...base,messageId:'om_bad'+n,supplements}),denied)
  assert.equal(f.requested.length,0);assert.equal(f.nativeRequests.length,0)
  const out=await f.actors.work({...base,supplements:Array(20).fill(one)})
  assert.equal(out.answer,'First draft.');assert.equal(inputOf(f.nativeRequests[0]).supplements.length,20)
})

// Images of the conversation: each one follows the seat's text under its marker, as DSH stores it.
const marker = key => '[图片 #'+createHash('sha256').update(key).digest('hex').slice(0,6)+']'
const png = name => Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from(name)])
const jpeg = name => Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),Buffer.from(name)])
const gif = name => Buffer.from('GIF89a'+name,'latin1')
const webp = name => Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WEBP'+name)])
const shot = (n,at=n) => ({messageId:'om_s'+n,key:'img_'+n,at})
// A job whose conversation shows these images; the loader records which ones each seat asked for.
const showing = (f,refs,bytes=r=>png(r.key)) => ({...base,workerImages:refs,loadImages:async wanted=>{f.loaded.push(wanted.map(r=>r.key));return wanted.map(bytes)}})
// What a prompt carried after its text: [marker, media type, bytes] per image.
const attached = p => p.content.slice(1).reduce((out,b,i,all)=>i % 2 ? out : [...out,[b.text,all[i+1].mediaType,Buffer.from(all[i+1].data,'base64')]],[])

test('the Router and the worker get the conversation’s images after their text, under the images’ markers',async t=>{
  const f=await fixture(t);f.loaded=[]
  const job=showing(f,[shot(1),shot(2)])
  assert.deepEqual(await f.actors.decide(job),{action:'work',role:'develop'})
  assert.equal((await f.actors.work(job)).answer,'First draft.')
  assert.deepEqual(f.modelInfo,[['offline','director'],['offline','coder']])
  assert.deepEqual(f.loaded,[['img_2','img_1'],['img_2','img_1']],'newest first')
  assert.equal(f.prompts.length,2)
  for(const p of f.prompts) {
    assert.match(p.text,/A marker such as \[图片 #[0-9a-f]{6}\] stands for an image/)
    assert.deepEqual(attached(p),[[marker('img_1'),'image/png',png('img_1')],[marker('img_2'),'image/png',png('img_2')]])
  }
  // The model sees DSH's stored message: the same texts, each image as an attachment.
  for(const r of f.nativeRequests) {
    const asked=r.messages.findLast(m=>m.role==='user' && m.source.kind==='user').content
    assert.deepEqual(asked.slice(1).map(b=>b.type==='image' ? typeof b.attachment.attachmentId : b.text),[marker('img_1'),'string',marker('img_2'),'string'])
  }
  // A recorded message that is not DSH's stored form of the prompt is not this seat's request.
  f.rawImages=true
  await assert.rejects(f.actors.work({...job,messageId:'om_raw'}),denied)
  assert.equal(f.nativeRequests.length,2)
})

test('a model without image input, a missing attachment service or a missing loader leave the text alone',async t=>{
  const f=await fixture(t);f.loaded=[]
  const job=showing(f,[shot(1)])
  f.modalities=['text']
  await f.actors.decide(job)
  f.modalities=['text','image']
  await f.actors.work(job)
  f.modalities=undefined
  const {attachments}=f.services
  delete f.services.attachments
  await f.actors.work({...job,messageId:'om_no_service'})
  f.services.attachments=attachments
  await f.actors.work({...job,messageId:'om_no_loader',loadImages:undefined})
  assert.deepEqual(f.prompts.map(p=>p.content.length),[1,3,1,1]);assert.deepEqual(f.loaded,[['img_1']])
})

test('only the newest images within DSH’s limits are sent; unreadable, unsupported or oversized ones keep just their marker',async t=>{
  const f=await fixture(t), limits=f.services.attachments.imageLimits;f.loaded=[]
  limits.maxImagesPerMessage=2
  await f.actors.work(showing(f,[1,2,3,4,5].map(n=>shot(n))))
  assert.deepEqual(f.loaded,[['img_5','img_4']]);assert.deepEqual(attached(f.prompts[0]).map(([m])=>m),[marker('img_4'),marker('img_5')])
  // Newest first: the corrupt image fails DSH validation, and the oldest no longer fits the message budget.
  Object.assign(limits,{maxImagesPerMessage:10,maxImageBytes:30,maxMessageImageBytes:40,mediaTypes:['image/png','image/jpeg','image/webp']})
  const bytes={img_8:png('CORRUPT'),img_7:webp('img_7'),img_6:null,img_5:Buffer.from('not an image'),img_4:gif('img_4'),
    img_3:png('img_3'+'x'.repeat(30)),img_2:jpeg('img_2'),img_1:png('img_1xx')}
  f.loaded=[]
  await f.actors.work({...showing(f,[1,2,3,4,5,6,7,8].map(n=>shot(n)),r=>bytes[r.key]),messageId:'om_limits'})
  assert.deepEqual(f.loaded,[['img_8','img_7','img_6','img_5','img_4','img_3','img_2','img_1']])
  assert.deepEqual(attached(f.prompts[1]),[[marker('img_2'),'image/jpeg',bytes.img_2],[marker('img_7'),'image/webp',bytes.img_7]])
  // A loader that does not answer for each requested image fails the seat.
  await assert.rejects(f.actors.work({...showing(f,[shot(1)]),messageId:'om_short',loadImages:async()=>[]}),denied)
})

test('a continuing worker is sent only images its session has not received; an offloaded image keeps its receipts valid',async t=>{
  const f=await fixture(t);f.loaded=[];f.offload=true
  f.worker=ask('Which screenshot?')
  const asked=await f.actors.work(showing(f,[shot(1)]))
  assert.equal(asked.question,'Which screenshot?')
  assert.ok(f.nativeRequests[0].messages.some(m=>m.content.some(b=>b.type==='image' && b.offloaded)),'the model saw a placeholder')
  f.hooks.clear();f.actors=createActors(f.ctx,{workspacePath:f.workspace.path}) // Only the session log tells what was sent.
  f.worker=answer('The second one.')
  const done=await f.actors.work({...showing(f,[shot(1),shot(2)]),...follow(asked),previousQuestion:asked.question,requesterReply:marker('img_2')})
  assert.deepEqual([done.answer,done.sessionId],['The second one.',asked.sessionId])
  // A merged message continues the same session; again only its new image is sent.
  f.worker=answer('Updated.')
  const more=await f.actors.work({...showing(f,[shot(1),shot(2),shot(3)]),continueWork:true,previousWorkspaceId:f.workspace.id,
    supplements:[{from:'requester',text:marker('img_3')}]})
  assert.deepEqual([more.answer,more.sessionId],['Updated.',asked.sessionId])
  assert.deepEqual(f.loaded,[['img_1'],['img_2'],['img_3']])
  assert.deepEqual(f.prompts.map(p=>attached(p).map(([m])=>m)),[[marker('img_1')],[marker('img_2')],[marker('img_3')]])
  assert.equal(f.requested.length,1)
})

// Files of the conversation: only the worker receives them, each staged on its own session under its marker.
const fileMark = (key,name) => '[文件 '+name+' #'+createHash('sha256').update(key).digest('hex').slice(0,6)+']'
const doc = (n,at=n) => ({messageId:'om_f'+n,key:'file_v3_'+n,name:'log-'+n+'.txt',at})
// A job whose conversation shows these files; the loader writes each one to disk only while `use` reads it.
async function sharing(t,f,refs,{missing=[]}={}) {
  const dir=await mkdtemp(join(await realpath(tmpdir()),'sa-files-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  return {...base,workerFiles:refs,loadFiles:async (wanted,use)=>{
    f.fileLoads=[...(f.fileLoads ?? []),wanted.map(r=>r.key)]
    const out=[]
    for(const [i,r] of wanted.entries()) {
      if(missing.includes(r.key)){out.push(null);continue}
      const path=join(dir,r.key);await writeFile(path,'contents of '+r.key)
      out.push(await use(i,path));await rm(path)
    }
    return out
  }}
}
const filesOf = p => p.content.slice(1).reduce((out,b,i,all)=>i % 2 ? out : [...out,[b.text,all[i+1].type]],[])

test('only the worker receives the conversation’s files, staged on its own session; the Router routes on their markers',async t=>{
  const f=await fixture(t)
  const job=await sharing(t,f,[doc(1),doc(2)])
  assert.deepEqual(await f.actors.decide(job),{action:'work',role:'develop'})
  assert.equal(f.fileLoads,undefined)
  assert.equal(filesOf(f.prompts[0]).length,0)
  assert.match(f.prompts[0].text,/A marker such as \[文件 report\.xlsx #1a2b3c\] stands for a file/)
  const done=await f.actors.work(job)
  assert.equal(done.answer,'First draft.')
  assert.deepEqual(f.fileLoads,[['file_v3_2','file_v3_1']],'newest first')
  assert.deepEqual(filesOf(f.prompts[1]),[[fileMark('file_v3_1','log-1.txt'),'file'],[fileMark('file_v3_2','log-2.txt'),'file']])
  assert.deepEqual(f.uploads.map(u=>[u.sessionId,u.name,u.text]),[[done.sessionId,'log-2.txt','contents of file_v3_2'],[done.sessionId,'log-1.txt','contents of file_v3_1']])
  // The model sees DSH's stored message: each file as its attachment, after its marker.
  const asked=f.nativeRequests.at(-1).messages.findLast(m=>m.role==='user' && m.source.kind==='user').content
  assert.deepEqual(asked.slice(1).map(b=>b.type==='file' ? b.attachment.name : b.text),[fileMark('file_v3_1','log-1.txt'),'log-1.txt',fileMark('file_v3_2','log-2.txt'),'log-2.txt'])
})

test('a continuing worker gets only files its session has not received; an unreadable or refused file keeps just its marker',async t=>{
  const f=await fixture(t)
  f.worker=ask('Which log?')
  const asked=await f.actors.work(await sharing(t,f,[doc(1)]))
  f.hooks.clear();f.actors=createActors(f.ctx,{workspacePath:f.workspace.path}) // Only the session log tells what was sent.
  f.worker=answer('Read it.')
  f.failUpload=name=>name==='log-4.txt'
  const more=await f.actors.work({...await sharing(t,f,[doc(1),doc(2),doc(3),doc(4)],{missing:['file_v3_3']}),
    continueWork:true,previousWorkspaceId:f.workspace.id,supplements:[{from:'requester',text:'@雷格'}]})
  assert.deepEqual([more.answer,more.sessionId],['Read it.',asked.sessionId])
  assert.deepEqual(f.fileLoads,[['file_v3_1'],['file_v3_4','file_v3_3','file_v3_2']])
  assert.deepEqual(f.prompts.map(filesOf),[[[fileMark('file_v3_1','log-1.txt'),'file']],[[fileMark('file_v3_2','log-2.txt'),'file']]])
  // A loader that does not answer for each requested file fails the seat.
  await assert.rejects(f.actors.work({...await sharing(t,f,[doc(9)]),messageId:'om_short',loadFiles:async()=>[]}),denied)
})

test('the Router routes only to the queued helpers; an owner-added helper learns its own responsibility',async t=>{
  const f=await fixture(t), ops={id:'helper-0a1b2c3d',name:'运维助手',description:'Server checks and alerts.'}
  const job={...base,helpers:[ops],team:{...base.team,[ops.id]:''},roleModels:{...base.roleModels,[ops.id]:{provider:'offline',model:'coder'}}}
  f.control=call('superagent_route',{role:ops.id})
  assert.deepEqual(await f.actors.decide(job),{action:'work',role:ops.id})
  const [d]=f.nativeRequests
  assert.deepEqual(inputOf(d).helpers,[ops])
  assert.deepEqual(d.tools.find(x=>x.name==='superagent_route').parameters.properties.role.enum,[ops.id])
  f.control=route('develop')
  await assert.rejects(f.actors.decide({...job,messageId:'om_built_in'}),denied)
  const out=await f.actors.work({...job,role:ops.id})
  assert.equal(out.answer,'First draft.')
  assert.match(taskOf(f.nativeRequests.at(-1)),/the team's helper "运维助手"\. Your responsibility: Server checks and alerts\./)
  await assert.rejects(f.actors.work({...job,messageId:'om_gone',role:'develop'}),denied)
  // With every helper disabled the Router has no route tool and is told to ignore new requests.
  f.control=ignore()
  assert.deepEqual(await f.actors.decide({...job,messageId:'om_none',helpers:[]}),{action:'ignore'})
  const none=f.nativeRequests.at(-1)
  assert.ok(!names(none).includes('superagent_route'))
  assert.match(taskOf(none),/No helper is available for new work: call superagent_ignore/)
})
