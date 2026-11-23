// The two built-in helpers. The owner can disable them, not rename or remove them; owner-added
// helpers carry their own name and description. The Router assigns by these descriptions.
export const builtinHelpers = [
  {id:'develop',name:'开发助手',description:'Code and engineering tasks, including builds and deployment.'},
  {id:'answer',name:'答疑助手',description:'Other questions and text tasks.'},
]
export const builtinIds = builtinHelpers.map(h=>h.id)
export const maxHelpers = 20
export const helperId = v => typeof v === 'string' && /^(?:develop|answer|helper-[a-f0-9]{8})$/.test(v)
export const helperName = v => typeof v === 'string' && v === v.trim() && v.length > 0 && v.length <= 40 && !/[\u0000-\u001f\u007f]/u.test(v)
export const helperDescription = v => typeof v === 'string' && v === v.trim() && v.length > 0 && v.length <= 500 &&
  !/[\u0000-\u0009\u000b-\u001f\u007f]/u.test(v)
// The enabled helpers when a message was queued: whom its Router may assign and what each does.
export const helperListOK = v => Array.isArray(v) && v.length <= maxHelpers &&
  v.every(h => h !== null && typeof h === 'object' && Object.keys(h).length === 3 &&
    helperId(h.id) && helperName(h.name) && helperDescription(h.description)) && new Set(v.map(h => h.id)).size === v.length
// Jobs queued before helper lists existed keep the built-in pair.
export const jobHelpers = j => Array.isArray(j.helpers) ? j.helpers : builtinHelpers
// A new message's snapshot from the team settings view: the enabled helpers, built-ins with their fixed text.
export const assignable = view => (view ?? builtinIds.map(id => ({id,builtin:true}))).filter(h => !h.disabled)
  .map(h => h.builtin ? {...builtinHelpers.find(b => b.id === h.id)} : {id:h.id,name:h.name,description:h.description})
