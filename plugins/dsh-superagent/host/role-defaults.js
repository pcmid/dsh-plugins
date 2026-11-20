const initial = {
  lead: ['gpt-6.2-astra','high'],
  develop: ['gpt-6.2-astra','xhigh'],
  answer: ['gpt-6-luna','medium'],
}
const provider = 'codex-provider'

// One-time setup, never a model call. Don't introduce a new provider into someone else's profile.
export async function starterTeam(ctx, timeoutMs=5000) {
  const team=Object.fromEntries(Object.keys(initial).map(role=>[role,'superagent-'+role]))
  const roleModels={}
  if(ctx.get('agentDefaultModel')?.currentSelection()?.provider!==provider)return {team,roleModels}
  const llm=ctx.get('llm')
  const controller=new AbortController()
  let timer
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('directory-timeout'))},timeoutMs)})
  async function load(){
    const listed=await llm.listModels(provider)
    controller.signal.throwIfAborted()
    const names=new Map()
    for(const [role,[model,effort]] of Object.entries(initial)){
      if(!listed.some(row=>row.id===model))continue
      if(!names.has(model))names.set(model,await llm.resolveModelInfo(provider,model,controller.signal))
      controller.signal.throwIfAborted()
      const row=names.get(model)
      if(row.provider===provider && row.id===model && row.reasoning?.efforts?.some(e=>e.id===effort))
        roleModels[role]={provider,model,name:row.name,effort}
    }
  }
  try {await Promise.race([load(),timeout])}
  catch { /* Never guess a route or send a prompt because the catalog didn't answer. */ }
  finally {clearTimeout(timer)}
  if(Object.keys(roleModels).length!==Object.keys(initial).length)
    ctx.logger('superagent').warn('Some starter model selections are unavailable. Check Team roles.')
  return {team,roleModels}
}
