import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { toolName } from './preset-tool.mjs'
import { gates,workerPersona,workerTool } from './worker-tool.mjs'

const load = createRequire(process.env.SMOKE_INSTALL)
export const installed = pkg => import(pathToFileURL(load.resolve('@deepseek-ai/dsh-' + pkg)))
const { LlmAdapter } = await installed('llm')
export const privateMemory='Fixture recall '+randomUUID(),systemSection='Fixture system '+randomUUID(),runtimeContext='Fixture runtime '+randomUUID()
export const addonKind='plugin:fixture-addon-'+randomUUID(),addonContext='Fixture context from the new plugin '+randomUUID()
export const unselected = 'Fixture first mention: read only, not selected.'
export const rootText='原根代号 MAPLE-17'
export const laterLine='Later reply before admission.\n消息正文里的第二行，不是另一个人。'
export const oldLines=Array.from({length:14},(_,i)=>'历史样例 ORANGE-'+String(i+1).padStart(2,'0'))
export const sibling='旁支代号 COBALT-91'
export const request='Fixture: write a two-line usage example.'
export const ignored='Fixture acknowledgement only.'
export const declineRequest='Fixture: ask me which edition I mean.'
export const noteRequest='@测试用户 ping'
export const privateRequest='Fixture private conversation: explain configuration.'
export const quietRequest='Fixture quiet group: answer once the ignore was undone.'
// One allowed member's requests: before the restart (shipped Router), and after it (default Router).
export const memberRequest='Fixture member: summarize this topic for me.'
export const memberColdRequest='Fixture member: one more after the restart.'
export const forbiddenRequest='Fixture: try an unavailable developer-only tool from this answer seat.'
export const probes=[
  {id:'om_native_deny',request:'Fixture: request a seal blocked by this local policy.',callId:'fixture-native-deny',label:'native deny example',outcome:'deny'},
  {id:'om_approved_call',request:'Fixture: request a seal after the local policy asks.',callId:'fixture-asked-once',label:'allowed ask example',outcome:'allowed-once'},
  {id:'om_declined_call',request:'Fixture: request a seal for the declined example.',callId:'fixture-declined-call',label:'declined example',outcome:'rejected'},
  {id:'om_no_answerer',request:'Fixture: request a seal without an operator.',callId:'fixture-no-answerer',label:'unattended example',outcome:'unavailable'},
]
export const ownerAsk={callId:'fixture-owner-ask',label:'local takeover check',outcome:'rejected',prompt:'Local owner: test the ordinary tool approval.'}
export const retryRoute={id:'om_route_retry',text:'Fixture: route this request again after a model failure.'}
export const retryWorker={id:'om_work_retry',text:'Fixture: preserve a seal across an interrupted turn.',callId:'fixture-retry-seal'}
export const archiveActive={id:'om_archive_active',text:'Fixture: wait until the owner archives this case.'}
export const held={id:'om_takeover_active',text:'Fixture: pause this answer until the owner takes over.'}
export const manualPrompt=phase=>'Local owner continues the same conversation: '+phase
export const question='Which language should the example use?'
export const declinedQuestion='Which edition do you mean?'
export const supersededQuestion='Which environment is this?',supersededAnswer='Superseded answer: do not send.'
export const clarification='Please use TypeScript. 原请求人回复 OAK-22'
export const answer='Fixture usage example:\nconst smoke: boolean = true;'
export const noteAnswer='Fixture explanation retained for approval.'
export const sealId='fixture-developer-call', sealRE=/^SEAL:[a-f0-9-]{36}$/
export const resultNames={DECIDE:['superagent_ignore','superagent_route'],WORK:['superagent_answer','superagent_ask_requester']}
// Offered to the Router only while the conversation has earlier open work; workers no longer have a stop result.
export const mergeTool='superagent_merge',retiredTool='superagent_stop'
export const forbiddenAnswer='Fixture: the developer-only tool is not available to this seat.'
// One native thread whose later mentions are merged into earlier work, plus an open request in another group.
export const mergeCase={
  root:'Fixture merge topic root.',gate:'merge widget build',gatedCall:'fixture-merge-gated',
  work:{id:'om_merge_work',text:'Fixture: build the merge widget.'},
  add:{id:'om_merge_add',text:'Fixture: also support dark mode for that widget.',from:'participant'},
  more:{id:'om_merge_more',text:'Fixture: and keep its public API unchanged.',from:'requester'},
  own:{id:'om_merge_own',text:'Fixture: separately, list the release dates.'},
  late:{id:'om_merge_late',text:'Fixture: one more thing for the widget, add an example.',from:'participant'},
  final:{id:'om_merge_final',text:'Fixture: final widget follow-up before the restart.',from:'requester'},
  other:{id:'om_other_request',text:'Fixture: an open request in another group.'},
  answers:{add:'Widget with dark mode.',more:'Widget with dark mode and an unchanged API.',own:'Release dates: none scheduled.',
    late:'Widget with dark mode, an unchanged API and an example.',final:'Widget follow-up handled after the restart.',other:'Other group answer.'},
}
const merges=['add','more','late','final']
const open=(request,state,output)=>({request,state,...output!==undefined && {output}})
export const legacy={request:'Fixture carried over from the JSON-result release.',question:'Which edition was selected?',reply:'The second edition.'}
export const legacyPrompt='SUPERAGENT_WORK\nReturn {"action":"clarify","question":"one concrete question"} as JSON text.\n'+JSON.stringify({request:legacy.request,role:'answer'})
export const softStops=[
  {id:'om_text_only',request:'Fixture: draft before routing and answering.',routerDraft:'I will route this.',workerDraft:'{"action":"answer","answer":"Unsubmitted draft."}',finish:'stop',answer:'Final submitted answer.'},
  {id:'om_max_tokens',request:'Fixture: finish the answer after the output limit.',workerDraft:'Partial output at the limit',finish:'max-tokens',answer:'Completed after the output limit.'},
]
function* batch(...calls) {
  for(const [index,[id,name,input]] of calls.entries()){
    const args=JSON.stringify(input)
    yield {type:'block-start',index,blockType:'tool-call'}
    yield {type:'tool-call-delta',index,id,name,argumentsDelta:args}
    yield {type:'block-end',index,block:{type:'tool-call',id,name,arguments:args}}
  }
  yield {type:'finish',reason:{kind:'tool-calls'}}
}
const tool=(id,name,input)=>batch([id,name,input])
const callTool=(id,label)=>tool(id,workerTool,{label})
const models=['global','director','worker']
function* result(text,kind='stop') {
  yield {type:'block-start',index:0,blockType:'text'}
  yield {type:'text-delta',index:0,text}
  yield {type:'block-end',index:0,block:{type:'text',text}}
  yield {type:'finish',reason:{kind}}
}

export class Offline extends LlmAdapter {
  calls=[]; controls=[]; workSessions=[]; personas={}; proposed=new Map(); probeAnswers=new Map()
  heldTurn=Promise.withResolvers(); archiveTurn=Promise.withResolvers(); manualTurns=[]
  mergeFinalTurn=Promise.withResolvers()
  // The earlier requests of this same conversation that a Router may merge into, oldest first.
  expectedOpenWork(text) {
    const declined=open(declineRequest,'question drafted',declinedQuestion), work=mergeCase.work.text, a=mergeCase.answers
    if(text===ignored)return [open(request,'question drafted',this.firstDraft)]
    if([held.text,archiveActive.text].includes(text) || process.env.SMOKE_PHASE==='prepare' && text===noteRequest)return [declined]
    if(text===softStops[1].request)return [open(softStops[0].request,'reply drafted',softStops[0].answer)]
    return {[mergeCase.add.text]:[open(work,'in progress')],[mergeCase.more.text]:[open(work,'reply drafted',a.add)],
      [mergeCase.own.text]:[open(work,'reply drafted',a.more)],[mergeCase.late.text]:[open(work,'replied',a.more)],
      [mergeCase.final.text]:[open(work,'replied',a.late)]}[text] ?? []
  }
  async listModels(provider){return models.map(id=>({provider,id,name:id}))}
  async resolveModel(provider,id){assert.ok(models.includes(id));return {provider,id,name:id}}
  async *stream(options) {
    try {
      const messages=options.messages,data=JSON.stringify(messages)
      const systems=messages.filter(m=>m.role==='system').map(m=>m.content.map(b=>b.text ?? '').join('')).join('\n')
      assert.ok(systems.includes(systemSection),'every seat receives the native system section')
      assert.ok(data.includes(runtimeContext),'every seat receives the native runtime context')
      const userIndex=messages.findLastIndex(m=>m.role==='user' && m.source?.kind==='user' && m.source.rpcId)
      const prefix=messages.findLastIndex(m=>m.role==='user' && m.source?.kind===addonKind && m.content[0].text===addonContext)
      const suffix=messages.findLastIndex(m=>m.role==='user' && m.source?.kind==='plugin:hindsight' &&
        m.source.form==='recall' && m.content[0].text===privateMemory)
      assert.ok(prefix>=0 && prefix<userIndex && userIndex<suffix,'the native request carries both plugin messages around the canonical user message')
      if(options.sessionId==='smoke-manual-tool-control') {
        assert.deepEqual(options.tools?.map(t=>t.name),[workerTool])
        const response=messages.find(m=>m.role==='tool' && m.source?.callId==='manual-tool-check')
        if(!response){yield* callTool('manual-tool-check','ordinary local control');return}
        const token=response.content.find(b=>b.type==='text')?.text
        assert.ok(!response.isError && sealRE.test(token),'ordinary session must receive a genuine result from this harmless registered tool')
        this.manualSeal=token
        yield* result('Ordinary two-step result: '+token)
        return
      }
      if(options.sessionId==='smoke-manual-'+process.env.SMOKE_PHASE) {
        assert.deepEqual(options.tools?.map(t=>t.name),[toolName],'the ordinary default fixture preset really contributes a native tool')
        assert.equal(options.model,'global')
        this.manualSawRecall=true
        yield* result('Local control completed.')
        return
      }
      const prompt=messages[userIndex].content[0].text
      if(prompt===legacyPrompt) {
        assert.equal(process.env.SMOKE_PHASE,'prepare');assert.deepEqual(options.tools ?? [],[])
        yield* result(JSON.stringify({action:'clarify',question:legacy.question}));return
      }
      if(prompt===ownerAsk.prompt || prompt===manualPrompt(process.env.SMOKE_PHASE))assert.deepEqual(options.tools.map(t=>t.name),[workerTool],
        'the handed-over seat no longer has any SuperAgent result tools')
      if(prompt===ownerAsk.prompt) {
        assert.equal(options.sessionId,this.manualSession)
        const reply=messages.slice(userIndex).find(m=>m.role==='tool' && m.source?.callId===ownerAsk.callId)
        if(!reply){
          this.proposed.set(ownerAsk.callId,options.sessionId)
          yield* callTool(ownerAsk.callId,ownerAsk.label);return
        }
        assert.equal(reply.isError,true)
        this.ownerAskSettled=true
        yield* result('The local owner declined the tool.');return
      }
      if(prompt===manualPrompt(process.env.SMOKE_PHASE)) {
        assert.equal(options.sessionId,this.manualSession)
        assert.ok(messages.some(m=>m.role==='user' && m.source?.kind==='user' && m.content[0].text.startsWith('SUPERAGENT_WORK\n')),
          'manual takeover keeps the original native task history')
        this.manualTurns.push(options.sessionId)
        yield* result('Local owner reply: '+process.env.SMOKE_PHASE)
        return
      }
      const nudged=prompt.startsWith('SUPERAGENT_CONTINUE\n')
      const original=nudged?messages.slice(0,userIndex).findLast(m=>m.role==='user' && m.source?.kind==='user' &&
        /^SUPERAGENT_(DECIDE|WORK)\n/.test(m.content[0].text))?.content[0].text:prompt
      const stage=/^SUPERAGENT_(DECIDE|WORK)\b/.exec(original)?.[1]
      const input=JSON.parse(original.slice(original.lastIndexOf('\n')+1))
      const soft=softStops.find(p=>p.request===input.request)
      if(nudged) {
        assert.ok(soft,'unexpected automatic continuation')
        const previous=messages.slice(0,userIndex).findLast(m=>m.role==='assistant')
        assert.deepEqual(previous?.content,[{type:'text',text:stage==='DECIDE'?soft.routerDraft:soft.workerDraft}])
      }
      const probe=probes.find(p=>p.request===input.request)
      const worker=[request,retryWorker.text,held.text,mergeCase.work.text].includes(input.request) || probe?'develop':'answer'
      const role=stage==='DECIDE'?'lead':worker
      const current=messages.slice(userIndex)
      const expected=stage==='DECIDE'?this.expectedOpenWork(input.request).map((w,i)=>({ref:'w'+(i+1),...w})):[]
      const results=[...resultNames[stage],...expected.length?[mergeTool]:[]]
      const submissions=current.flatMap(m=>m.role==='assistant'?m.content.filter(b=>b.type==='tool-call' && results.includes(b.name)).map(b=>b.id):[])
      assert.ok(!current.some(m=>m.role==='tool' && !m.isError && submissions.includes(m.toolCallId)),
        'DSH must conclude the turn on a successful result without asking the model again')
      const afterTool=current.some(m=>m.role==='tool')
      if(!afterTool)this.calls.push(nudged?'CONTINUE':stage)
      assert.ok(stage && options.sessionId,'only Router and worker model calls are expected')
      if(stage==='WORK')assert.match(original.split('\n').slice(0,-1).join('\n'),/check your own result against the request/i)
      assert.equal(options.model,stage==='DECIDE'?'director':'worker','only dispatch runs on the lead model')
      const emptyRouter=stage==='DECIDE' && (probe || soft || [privateRequest,forbiddenRequest,quietRequest,memberColdRequest].includes(input.request))
      const presetNames=emptyRouter?[toolName]:role==='develop'?[workerTool]:[]
      assert.deepEqual(options.tools.map(t=>t.name).sort(),[...presetNames,...results].sort(),
        'only this seat’s result tools and its selected ordinary preset tools are callable')
      if(stage==='WORK')assert.ok(!options.tools.some(t=>t.name===retiredTool),'a worker has no stop result')
      if(emptyRouter)this.emptyRouter=options.sessionId
      else assert.ok(systems.includes(role==='develop'?workerPersona:this.personas[role]),'normal preset persona is assembled by DSH: '+role)
      assert.ok(!data.includes(sibling),'an unrelated Feishu thread is not admitted')
      if(input.request===request)assert.ok(!data.includes('Edited after display.'),'the selected request uses its admitted, not edited version')
      if(stage==='DECIDE' && !nudged && !afterTool) {
        assert.equal(messages.filter(m=>m.role==='user' && m.source?.kind==='user').length,1,'a fresh control conversation contains only its one canonical request')
        this.controls.push({id:options.sessionId,role})
      }
      let body
      if(stage==='DECIDE') {
        assert.ok(Object.keys(input).every(k=>['request','topic','workspaces','openWork'].includes(k)),'routing does not invent criteria')
        // Only earlier open or replied requests of this native thread are candidates; other threads and chats never are.
        assert.deepEqual(input.openWork ?? [],expected,'open work of this conversation only: '+input.request)
        const merge=options.tools.find(t=>t.name===mergeTool)
        if(expected.length) {
          assert.deepEqual(merge.parameters.properties.target.enum,expected.map(w=>w.ref))
          assert.deepEqual(merge.parameters.required,['target'])
        }
        assert.deepEqual(input.workspaces.find(w=>w.id===this.project.id),this.project)
        assert.ok(!input.workspaces.some(w=>w.path===this.ownPath),'SuperAgent itself is not a candidate')
        const route=options.tools.find(t=>t.name==='superagent_route')
        assert.deepEqual([...route.parameters.properties.workspace.enum].sort(),input.workspaces.map(w=>w.id).sort())
        assert.deepEqual(route.parameters.required,['role'])
        if(input.request===request) {
          assert.deepEqual(JSON.parse(input.topic).map(m=>m.text),[rootText,...oldLines,unselected,request,laterLine])
          this.routedTopic=input.topic
        }
        if(input.request===retryRoute.text) {
          this.retryRouterId=options.sessionId
          if(process.env.SMOKE_PHASE==='prepare'){yield {type:'finish',reason:{kind:'error'}};return}
        }
        assert.ok(probe || soft || [ignored,request,declineRequest,noteRequest,privateRequest,quietRequest,memberRequest,memberColdRequest,forbiddenRequest,retryWorker.text,retryRoute.text,held.text,archiveActive.text,
          mergeCase.work.text,mergeCase.own.text,mergeCase.other.text,...merges.map(k=>mergeCase[k].text)].includes(input.request))
        if(soft?.routerDraft && !nudged){yield* result(soft.routerDraft);return}
        if(input.request===held.text) {
          if(!afterTool){yield* tool('fixture-bad-workspace','superagent_route',{role:worker,workspace:'missing-fixture-project'});return}
          assert.equal(current.find(m=>m.role==='tool' && m.toolCallId==='fixture-bad-workspace')?.isError,true)
        }
        const placed=input.request===request || input.request===held.text
        if(input.request===mergeCase.add.text) {
          const gate=gates.get(mergeCase.gate)
          assert.ok(gate?.running && !gate.aborted,'the Router decides while the earlier worker’s native tool is still executing')
          this.mergeRoutedWhileTool=true
        }
        body=input.request===ignored?{action:'ignore'}:merges.some(k=>mergeCase[k].text===input.request)?{action:'merge',target:'w1'}:
          {action:'work',role:worker,...placed && {workspace:this.project.id}}
      } else if(input.request===request) {
        const topic=JSON.parse(input.topic),turns=messages.slice(0,userIndex).filter(m=>m.role==='assistant' &&
          m.content.some(b=>b.type==='tool-call' && b.name==='superagent_ask_requester'))
        const toolResult=messages.find(m=>m.role==='tool' && m.source?.callId===sealId)
        const seal=toolResult?.content.find(b=>b.type==='text')?.text
        assert.deepEqual(topic.slice(0,18).map(m=>m.text),[rootText,...oldLines,unselected,request,laterLine],
          'complete root, 14 old messages, prior mention, selected original and later multiline reply preserve order and boundaries')
        assert.deepEqual(topic.filter(m=>m.request).map(m=>[m.text,m.speaker]),[[request,'requester']])
        assert.equal(new Set(topic.slice(0,16).map(m=>m.speaker)).size,1)
        assert.match(topic[0].speaker,/^participant-\d+$/)
        assert.notEqual(topic[0].speaker,topic[17].speaker)
        assert.ok(topic.every((m,i)=>Number.isSafeInteger(m.at) && (!i || m.at>=topic[i-1].at)))
        if(!afterTool)this.workSessions.push(options.sessionId)
        if(!turns.length && !afterTool) {
          this.proposed.set(sealId,options.sessionId)
          yield* callTool(sealId,'original selected request');return
        }
        assert.ok(toolResult && !toolResult.isError && sealRE.test(seal),'expected the actual native tool result: '+JSON.stringify(toolResult?.content))
        if(!turns.length) {
          assert.equal(input.topic,this.routedTopic,'Router and worker see the identical approved conversation')
          this.firstDraft=question+' '+seal
          body={action:'clarify',question:this.firstDraft}
        }
        else {
          assert.ok(data.includes(question) && data.includes(clarification),'the same worker sees the sent question and the original requester reply')
          assert.equal(turns.length,1,'both submitted questions belong to the same previous assistant step')
          assert.deepEqual(turns[0].content.filter(b=>b.name==='superagent_ask_requester').map(b=>JSON.parse(b.arguments).question),[supersededQuestion,question+' '+seal])
          assert.ok(topic.some(m=>m.text===clarification && m.speaker==='requester'),'a confirmed reply refreshes the worker’s complete native thread')
          assert.ok(topic.some(m=>m.text.includes('WRONG-REPLY: somebody else.')),'other participants remain context, not the answer')
          assert.equal(input.requesterReply,clarification,'only the addressed reply from the original requester answers the question')
          assert.equal(input.previousQuestion,question+' '+seal)
          body={action:'answer',answer:answer+' '+seal}
        }
      } else if(input.request===legacy.request) {
        assert.equal(stage,'WORK');assert.equal(process.env.SMOKE_PHASE,'release')
        const prior=messages.slice(0,userIndex).filter(m=>m.role==='assistant')
        assert.deepEqual(prior.map(m=>m.content),[[{type:'text',text:JSON.stringify({action:'clarify',question:legacy.question})}]])
        assert.deepEqual([input.previousQuestion,input.requesterReply],[legacy.question,legacy.reply])
        body={action:'answer',answer:'Confirmed: '+legacy.reply}
      } else if(soft) {
        if(!nudged){yield* result(soft.workerDraft,soft.finish);return}
        body={action:'answer',answer:soft.answer}
      } else if(input.request===held.text || input.request===archiveActive.text) {
        assert.equal(stage,'WORK');assert.ok(!options.signal.aborted)
        const latch=input.request===held.text?this.heldTurn:this.archiveTurn
        latch.resolve(options.sessionId)
        await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}))
        this.cancelledSession=options.sessionId
        return
      } else if(input.request===retryWorker.text) {
        this.retryWorkerId=options.sessionId
        const prior=messages.find(m=>m.role==='tool' && m.source?.callId===retryWorker.callId)
        if(process.env.SMOKE_PHASE==='prepare' && !afterTool) {
          assert.equal(input.continue,undefined);assert.ok(!prior)
          yield* callTool(retryWorker.callId,'keep across retry');return
        }
        assert.ok(prior && !prior.isError)
        this.retrySeal=prior.content.find(b=>b.type==='text')?.text
        assert.match(this.retrySeal,sealRE)
        if(process.env.SMOKE_PHASE==='prepare') {
          yield {type:'finish',reason:{kind:'error'}};return
        }
        assert.equal(input.continue,true)
        const requests=messages.filter(m=>m.role==='user' && m.source?.kind==='user' && m.source.rpcId)
          .map(m=>JSON.parse(m.content[0].text.split('\n').at(-1)))
        assert.deepEqual(requests.map(m=>[m.request,m.continue]),[[retryWorker.text,undefined],[retryWorker.text,true]])
        assert.ok(messages.indexOf(prior)<userIndex,'result belongs to the previous native turn')
        body={action:'answer',answer:'Recovered '+this.retrySeal}
      } else if(probe || input.request===forbiddenRequest) {
        assert.equal(stage,'WORK')
        const callId=probe?.callId ?? 'forbidden-attempt'
        if(probe)await this.observeToolStep() // Before native ask, and after the result but before a final answer.
        if(!afterTool){
          this.proposed.set(callId,options.sessionId)
          yield* callTool(callId,probe?.label ?? 'unconfigured preset');return
        }
        const response=messages.find(m=>m.role==='tool' && m.source?.callId===callId)
        assert.ok(response,'the next model step receives the actual native outcome')
        const ok=probe?.outcome==='allowed-once'
        assert.equal(!!response.isError,!ok)
        const text=response.content.find(b=>b.type==='text')?.text
        if(ok)assert.match(text,sealRE)
        if(callId==='fixture-native-deny')assert.ok(text.includes('Fixture native tool policy declined this exact call.'))
        if(probe) {
          const answer=ok?'The fixture returned '+text:'No seal was issued.'
          this.probeAnswers.set(callId,answer)
          body={action:'answer',answer}
        } else {
          // The removed stop result is now an unknown tool; the worker still has to answer.
          const stop=current.find(m=>m.role==='tool' && m.toolCallId==='fixture-stop-attempt')
          if(!stop){yield* tool('fixture-stop-attempt',retiredTool,{});return}
          assert.equal(stop.isError,true,'superagent_stop is no longer a worker result')
          assert.match(stop.content.find(b=>b.type==='text')?.text ?? '',/unknown tool/i)
          this.stopRefused=options.sessionId
          body={action:'answer',answer:forbiddenAnswer}
        }
      } else if(input.request===mergeCase.work.text) {
        assert.equal(stage,'WORK')
        assert.ok(!data.includes(rootText) && !data.includes(mergeCase.other.text),'only this thread reaches its worker')
        const prompts=messages.slice(0,userIndex).filter(m=>m.role==='user' && m.source?.kind==='user' && m.source.rpcId)
          .map(m=>JSON.parse(m.content[0].text.split('\n').at(-1)))
        if(!input.supplements) {
          assert.ok(!afterTool && !prompts.length && input.continue===undefined,'the gated native tool never returns')
          this.mergeWorker=options.sessionId
          yield* callTool(mergeCase.gatedCall,mergeCase.gate);return
        }
        // Each merge continues this same native session; earlier supplements stay in its history.
        const key=merges.find(k=>mergeCase[k].text===input.supplements[0]?.text)
        assert.ok(key,'unexpected supplements: '+JSON.stringify(input.supplements))
        assert.equal(input.continue,true)
        assert.deepEqual(input.supplements,[{from:mergeCase[key].from,text:mergeCase[key].text}])
        const earlier=merges.slice(0,merges.indexOf(key)+(process.env.SMOKE_PHASE==='release'?1:0))
        assert.deepEqual(prompts.map(p=>p.supplements?.map(x=>x.text)),[undefined,...earlier.map(k=>[mergeCase[k].text])])
        assert.ok(prompts.every(p=>p.request===mergeCase.work.text))
        if(key==='add') {
          const aborted=messages.slice(0,userIndex).find(m=>m.role==='tool' && m.toolCallId===mergeCase.gatedCall)
          assert.equal(aborted?.isError,true,'the interrupted native tool call kept its aborted result')
        }
        if(key==='final' && process.env.SMOKE_PHASE==='prepare') {
          this.mergeFinalTurn.resolve(options.sessionId)
          await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}))
          this.mergeCancelled=options.sessionId
          return
        }
        this.mergeTurns=(this.mergeTurns ?? 0)+1
        body={action:'answer',answer:mergeCase.answers[key]}
      } else if(input.request===mergeCase.own.text || input.request===mergeCase.other.text) {
        assert.ok(stage==='WORK' && input.supplements===undefined && input.continue===undefined)
        const own=input.request===mergeCase.own.text
        assert.ok(!data.includes(own?mergeCase.other.text:mergeCase.root),'other conversations never reach this worker')
        body={action:'answer',answer:own?mergeCase.answers.own:mergeCase.answers.other}
      } else {
        assert.ok(!data.includes(rootText),'other cases never receive this thread')
        if(input.request===declineRequest) body={action:'clarify',question:declinedQuestion}
        else {
          assert.ok([noteRequest,privateRequest,quietRequest,memberRequest,memberColdRequest,retryRoute.text].includes(input.request))
          if(input.request===retryRoute.text) {
            assert.equal(messages.filter(m=>m.role==='user' && m.source?.kind==='user').length,1)
            assert.equal(input.continue,undefined,'a Router-only retry must not tell a brand-new worker it previously failed')
            if(!afterTool){yield* tool('fixture-invalid-answer','superagent_answer',{answer:''});return}
            const invalid=messages.slice(userIndex).find(m=>m.role==='tool' && m.toolCallId==='fixture-invalid-answer')
            assert.equal(invalid?.isError,true,'only a failed validation receipt allows this correction')
          }
          body={action:'answer',answer:noteAnswer}
        }
      }
      const {action,...args}=body
      const name={work:'superagent_route',ignore:'superagent_ignore',merge:mergeTool,answer:'superagent_answer',clarify:'superagent_ask_requester'}[action]
      if(input.request===request && action==='clarify') {
        yield* batch([randomUUID(),name,{question:supersededQuestion}],[randomUUID(),name,args],['fixture-after-submit',workerTool,{label:'ordinary tail call'}]);return
      }
      if(input.request===request && action==='answer') {
        yield* batch([randomUUID(),name,{answer:supersededAnswer}],[randomUUID(),name,args]);return
      }
      yield* tool(randomUUID(),name,args)
    } catch(e){this.error=e;throw e}
  }
}
