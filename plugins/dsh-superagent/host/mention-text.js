// Display only: never use a name or an @_user_N placeholder as evidence of a real mention.
const nameOf = value => typeof value==='string' && value.trim() ? value : undefined
const token=/^@_user_[0-9]+$/
function display(key,mentions,scope,inline) {
  const m=mentions.get(key), name=nameOf(m?.name) ?? nameOf(inline)
  if (name) return '@'+name
  const self=m?.id_type==='open_id' && m.id===scope.recipientId && m.tenant_key===scope.tenantId
  return self ? '@'+(nameOf(scope.recipientName) ?? '你') : key
}
function byKey(mentions,onlyTokens=true) {
  const keys=new Map()
  for (const m of Array.isArray(mentions) ? mentions : []) {
    if (typeof m?.key!=='string' || !m.key || onlyTokens && !token.test(m.key)) continue
    keys.set(m.key,keys.has(m.key) ? null : m)
  }
  return keys
}
export function renderTextMentions(text,mentions,scope) {
  if (typeof text!=='string' || !text.includes('@_user_')) return text
  const keys=byKey(mentions)
  // Consume all digits; a prefix of a different key is not a match. A callback keeps $ and @ in
  // display names literal and never treats replacement text as another placeholder.
  return text.replace(/@_user_[0-9]+(?![A-Za-z0-9_])/g,key=>display(key,keys,scope))
}
function paragraphs(body,at) {
  if (!Array.isArray(body?.content)) return null
  const lines=typeof body.title==='string' && body.title ? [body.title] : []
  for (const line of body.content) {
    if (!Array.isArray(line)) return null
    const text=line.map(node=>{
      if (['text','code_block'].includes(node?.tag) && typeof node.text==='string') return node.text
      if (node?.tag==='a') {
        const label=typeof node.text==='string' ? node.text : '', href=typeof node.href==='string' ? node.href : ''
        return label && href && label!==href ? '['+label+']('+href+')' : label || href
      }
      return node?.tag==='at' && typeof node.user_id==='string' ? at(node) : ''
    }).join('')
    if (text) lines.push(text)
  }
  return lines.join('\n')
}
export function postText(body,mentions,scope) {
  const keys=byKey(mentions,false)
  return paragraphs(body,n=>display(n.user_id,keys,scope,n.user_name))
}
// Exact historical rendering for a previously archived, unedited post. Never shown on a normal read.
export function legacyPostText(body,mentions) {
  return paragraphs(body,n=>{
    const name=n.user_name || mentions.find(m=>m?.key===n.user_id)?.name
    return typeof name==='string' && name ? '@'+name : n.user_id
  })
}
