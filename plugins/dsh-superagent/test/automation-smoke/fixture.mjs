import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { addonContext,addonKind,installed,legacyPrompt,mergeTool,Offline,ownerAsk,probes,privateMemory,resultNames,retiredTool,runtimeContext,systemSection } from './provider.mjs'
import { verify } from './scenario.mjs'
import { calls as presetToolCalls } from './preset-tool.mjs'
import { ordinaryIssued,workerPreset,workerTool } from './worker-tool.mjs'

const { HostConnectionService } = await installed('client-connection')
const version = JSON.parse(readFileSync(process.env.SMOKE_INSTALL)).version
assert.ok(['0.2.2-rc.3','0.2.2-rc.5'].includes(version), version)

export const inject = ['llm','appReady','appExit']
export function apply(ctx) {
  new HostConnectionService(ctx, [], new Proxy({}, {get() {throw Error('No browser access in automation smoke')}}))
  const provider = new Offline()
  ctx.llm.registerAdapter(['offline'],provider)
  ctx.inject(['sessionController','sessionPersistence','storageDomain','workspaceRegistry','agentDefaultModel','agentPresets','agents','systemPrompt'], ready => {
    ready.systemPrompt.section({name:'fixture:normal-system',order:0,text:systemSection})
    ready.systemPrompt.context({name:'fixture:normal-runtime',order:0,text:runtimeContext})
    ready.on('tools/pre-execute',(exec,next)=>{
      const p=[ownerAsk,...probes].find(p=>p.callId===exec.callId)
      if(exec.name===workerTool && p) {
        assert.equal(exec.agent.id,provider.proposed.get(p.callId))
        assert.deepEqual(exec.arguments,{label:p.label})
        return p.outcome==='deny'?{kind:'deny',reason:'Fixture native tool policy declined this exact call.'}:{kind:'ask'}
      }
      return next()
    })
    const injections=[]
    // Same native prepend hook and recall message shape as Hindsight, without loading it or accessing memory.
    ready.on('agent/pre-step',async({agent,signal},next)=>{
      const decision=await next()
      if(decision.kind!=='enter' || signal.aborted || !decision.messages.some(m=>m.source?.kind==='user' && m.source.rpcId))return decision
      if(agent.id.startsWith('superagent-auto-')) {
        const request=decision.messages.find(m=>m.source?.kind==='user' && m.source.rpcId)
        const stage=/^SUPERAGENT_(\w+)/.exec(request?.content[0]?.text)?.[1]
        if(stage && request.content[0].text!==legacyPrompt)injections.push(stage) // Ordinary owner turns keep the former worker's id.
      }
      const recall={id:randomUUID(),role:'user',source:{kind:'plugin:hindsight',form:'recall'},content:[{type:'text',text:privateMemory}]}
      return {kind:'enter',messages:[...decision.messages,recall]}
    },{prepend:true})
    // This independently registered, newly named plugin prepends, while Hindsight appends.
    ready.on('agent/pre-step',async({signal},next)=>{
      const decision=await next()
      if(decision.kind!=='enter' || signal.aborted || !decision.messages.some(m=>m.source?.kind==='user' && m.source.rpcId))return decision
      const extra={id:randomUUID(),role:'user',source:{kind:addonKind},content:[{type:'text',text:addonContext}]}
      return {...decision,messages:[extra,...decision.messages]}
    },{prepend:true})
    ready.effect(() => ready.appReady.onReady(() => {
      const guard = setTimeout(() => {console.error('Automation smoke timed out'); ready.appExit(1)}, 20_000)
      async function check() {
        assert.equal(ready.get('webServer'), undefined)
        assert.equal(ready.get('credentials'), undefined)
        if(process.env.SMOKE_PHASE==='prepare') assert.deepEqual(await ready.sessionPersistence.list(), [])
        assert.equal(ready.agentDefaultModel.currentSelection().model, 'global')
        // Match model inputs against the actual persona text shipped by this package.
        const {load,Type,DEFAULT_SCHEMA}=createRequire(process.env.SMOKE_INSTALL)('js-yaml')
        // The Loader evaluates `!!js` expressions; here they only need to parse.
        const schema=DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js',{kind:'scalar',construct:source=>({__jsExpr:source})})])
        const rows=load(readFileSync(new URL('../../cordis.patch.yml',import.meta.url),'utf8'),{schema}).flatMap(op=>op.insert || [])
        for(const role of ['lead','develop','answer']) {
          const row=rows.find(r=>r.name==='@deepseek-ai/dsh-agent-preset' && r.config?.id==='superagent-'+role)
          assert.ok(row,'missing shipped preset: '+role)
          const persona=row.config.plugins.find(p=>p.name==='@deepseek-ai/dsh-persona')?.config?.prefix
          assert.ok(persona?.trim(),'missing shipped persona: '+role)
          provider.personas[role]=persona.trim()
          assert.equal((await ready.agentPresets.resolve(row.config.id)).broken,undefined)
        }
        if(process.env.SMOKE_PHASE==='prepare') {
          // Control before the actor exists: prove the selected preset and native executor really work.
          const ws=await ready.workspaceRegistry.create(process.cwd(),'Fixture native tool control')
          const {sessionId}=await ready.sessionController.create({sessionId:'smoke-manual-tool-control',workspaceId:ws.id,agentPreset:workerPreset})
          const r=await ready.sessionController.prompt({sessionId,requestId:randomUUID(),mode:'queue',content:[{type:'text',text:'Run the inert fixture tool.'}]},AbortSignal.timeout(5000))
          assert.ok(r.accepted)
          await ready.agents.get(sessionId).whenIdle()
          assert.ifError(provider.error)
          assert.ok(provider.manualSeal)
          assert.deepEqual(ordinaryIssued,[provider.manualSeal])
          console.log('PASS native preset control: ordinary DSH session executed the selected local tool exactly once and consumed its random result in the next model step')
        }
        await verify(ready, provider, join(process.cwd(), 'Superagent'))
        assert.deepEqual(injections,provider.calls,'the recall injector actually ran on every native automation turn')
        // Non-automation sessions must still receive normal Hindsight recalls.
        const ws=await ready.workspaceRegistry.create(process.cwd(),'Fixture manual control')
        const {sessionId}=await ready.sessionController.create({sessionId:'smoke-manual-'+process.env.SMOKE_PHASE,workspaceId:ws.id})
        const accepted=await ready.sessionController.prompt({sessionId,requestId:randomUUID(),mode:'queue',content:[{type:'text',text:'Local control.'}]},AbortSignal.timeout(5000))
        assert.ok(accepted.accepted)
        await ready.agents.get(sessionId).whenIdle()
        assert.equal(provider.manualSawRecall,true)
        await ready.sessionPersistence.flush()
        for(const {header:{id}} of await ready.sessionPersistence.list()) {
          const normal=id===sessionId
          if(!normal && !id.startsWith('superagent-auto-'))continue
          const agent=ready.agents.get(id)
          if(agent)for(const name of [...resultNames.DECIDE,mergeTool,...resultNames.WORK,retiredTool])assert.ok(!agent.ctx.tools.get(name,agent),
            'a concluded or cancelled native seat must withdraw '+name)
          const log=await ready.sessionPersistence.open(id,'read')
          try {
            const {events}=await log.read()
            const toolSteps=events.filter(e=>e.type==='tool/result' && JSON.stringify(e.data).includes('SEAL:'))
            assert.equal(toolSteps.length,provider.workSessions.includes(id)?2:id===provider.retryWorkerId || id===provider.proposed.get('fixture-asked-once')?1:0,'only the active developer worker has a successful seal')
            const all=events.filter(e=>e.type==='user/message').map(e=>e.data)
            const turns=events.filter(e=>e.type==='turn/end').length
            assert.ok(turns>0)
            assert.equal(all.filter(m=>m.source?.kind==='plugin:hindsight' && m.source.form==='recall' && m.content[0].text.startsWith('Fixture recall ')).length,turns)
            assert.equal(all.filter(m=>m.source?.kind.startsWith('plugin:fixture-addon-') && m.content[0].text.startsWith('Fixture context from the new plugin ')).length,turns)
          } finally {await log.close()}
        }
        assert.equal(presetToolCalls,0,'the default Router did not call its unrelated tool')
        console.log('PASS native context: all seats and the ordinary control kept runtime, system section and both plugin messages; native logs retained both user messages across restarts')
        assert.equal(ready.agentPresets.defaultId, 'default-fixture')
        assert.equal(ready.agentDefaultModel.currentSelection().model, 'global')
      }
      check().then(() => ready.appExit(0), error => {console.error(error);ready.appExit(1)}).finally(() => clearTimeout(guard))
    }))
  })
}
