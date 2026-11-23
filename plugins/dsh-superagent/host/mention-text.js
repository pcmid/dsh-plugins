import { createHash } from 'node:crypto'

// Display only: never use a name or an @_user_N placeholder as evidence of a real mention.
const nameOf = value => typeof value==='string' && value.trim() ? value : undefined
export const imageKey = key => typeof key==='string' && /^img_[\w-]{1,256}$/.test(key)
// The same image always gets the same marker, in every message and round that mentions it.
export const imageMarker = key => '[图片 #'+createHash('sha256').update(key).digest('hex').slice(0,6)+']'
export const fileKey = key => typeof key==='string' && /^file_[\w-]{1,256}$/.test(key)
// A file reads as its name and a stable tag; brackets and line breaks in the name cannot fake another marker.
export const fileName = name => typeof name==='string' ? name.replace(/[\u0000-\u001f\u007f[\]#]/g,' ').replace(/\s+/g,' ').trim().slice(0,120) : ''
export const fileMarker = (key,name) => '[文件 '+(fileName(name) || '未命名')+' #'+createHash('sha256').update(key).digest('hex').slice(0,6)+']'
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
function paragraphs(body,at,image=()=>'') {
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
      if (node?.tag==='img') return imageKey(node.image_key) ? image(node.image_key) : ''
      return node?.tag==='at' && typeof node.user_id==='string' ? at(node) : ''
    }).join('')
    if (text) lines.push(text)
  }
  return lines.join('\n')
}
// An image in a rich-text message becomes its marker; the image itself travels separately.
export function postText(body,mentions,scope) {
  const keys=byKey(mentions,false)
  return paragraphs(body,n=>display(n.user_id,keys,scope,n.user_name),imageMarker)
}
// The image keys of a rich-text message, in reading order.
export function postImages(body) {
  if (!Array.isArray(body?.content)) return []
  return body.content.flatMap(line=>Array.isArray(line) ? line.filter(n=>n?.tag==='img' && imageKey(n.image_key)).map(n=>n.image_key) : [])
}
// Exact historical rendering for a previously archived, unedited post. Never shown on a normal read.
export function legacyPostText(body,mentions) {
  return paragraphs(body,n=>{
    const name=n.user_name || mentions.find(m=>m?.key===n.user_id)?.name
    return typeof name==='string' && name ? '@'+name : n.user_id
  })
}
