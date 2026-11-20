import { randomUUID } from 'node:crypto'

export const workerPreset='fixture-developer',workerPersona='You are the fixture developer selected by its owner.'
export const workerTool='fixture_issue_seal'
export const issued=[], ordinaryIssued=[],toolCwds=new Map()
// A label registered here holds the native tool body open until DSH cancels it; it never issues a seal.
export const gates=new Map()
export const inject=['tools','workingDirectory']
export function apply(ctx) {
  ctx.tools.register({name:workerTool,description:'Return a fresh synthetic seal; no external actions.',
    parameters:{type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false},
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
    async execute(args,exec){
      toolCwds.set(exec.callId,ctx.workingDirectory.get(exec.agent.session))
      const gate=gates.get(args.label)
      if(gate) {
        gate.running=true
        gate.entered.resolve(exec.callId)
        await new Promise((_,reject)=>exec.signal.addEventListener('abort',()=>{
          gate.running=false;gate.aborted=true;reject(exec.signal.reason)
        },{once:true}))
      }
      const seal='SEAL:'+randomUUID()
      ;(exec.agent?.id==='smoke-manual-tool-control'?ordinaryIssued:issued).push(seal)
      return seal
    }})
}
