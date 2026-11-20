// Registered only inside the temporary default fixture preset; never installed in the user's profile.
export const toolName='fixture_noop'
export let calls=0
export const inject=['tools']
export function apply(ctx) {
  const schema={name:toolName,description:'A harmless local fixture tool.',parameters:{type:'object',properties:{},additionalProperties:false}}
  ctx.tools.register({...schema,
    output:{schema:{type:'boolean'},render:()=>[]},
    async execute(){calls++;return true}})
}
