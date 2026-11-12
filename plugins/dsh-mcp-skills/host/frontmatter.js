/**
 * SKILL.md frontmatter support without a YAML dependency.
 *
 * - `splitDocument` finds the frontmatter block exactly as DSH's skill-filesystem provider does: the first
 *   line is `---` and a later line is `---` (a trailing CR is ignored on both). A leading BOM is tolerated
 *   here but reported as invalid, because DSH does not strip it.
 * - `parseFrontmatter` reads top-level `key: value` entries of the YAML subset skill files use: plain,
 *   single-quoted, double-quoted, and block (`|`, `>`) scalars, plus nested maps, lists, and flow collections
 *   that are recognized and kept verbatim but not interpreted. Plain scalars resolve with the YAML 1.2 core
 *   schema, which is what DSH's `yaml` parser uses. Constructs that YAML rejects are reported as errors.
 * - `inspectSkill` mirrors the DSH validation rules and returns the reason DSH would ignore a skill.
 * - `updateSkillText` rewrites only the five managed keys and the body; `serializeSkill` writes a new file.
 */

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Maximum skill name length accepted for skills created or saved here. */
export const MAX_SKILL_NAME_LENGTH = 64

/** Keys this plugin owns, in the order new keys are written. */
const MANAGED_KEYS = ['name', 'description', 'whenToUse', 'disable-model-invocation', 'user-invocable']

/** Keys DSH rejects, with the canonical key that replaces each. */
const LEGACY_KEYS = [
  ['disableModelInvocation', 'disable-model-invocation'],
  ['modelInvocable', 'disable-model-invocation'],
  ['userInvocable', 'user-invocable'],
]

const BLANK = /^[ \t]*$/
const COMMENT = /^[ \t]*#/

/**
 * Test the DSH skill-name grammar (`^[a-z0-9]+(-[a-z0-9]+)*$`).
 * @param {unknown} name - candidate name.
 * @returns {boolean} whether DSH accepts the name.
 */
export function isSkillName(name) {
  return typeof name === 'string' && SKILL_NAME.test(name)
}

/**
 * Split a SKILL.md text into frontmatter lines and body.
 * @param {string} raw - complete file text.
 * @returns {{ bom: boolean, eol: string, lines?: string[], body: string }} `lines` (without line
 *   terminators) is absent when the file has no closed frontmatter block; `body` is the text after the
 *   closing fence, or the whole text (without BOM) when there is no block.
 */
export function splitDocument(raw) {
  const bom = raw.startsWith('\uFEFF')
  const text = bom ? raw.slice(1) : raw
  const firstEnd = text.indexOf('\n')
  const eol = firstEnd > 0 && text[firstEnd - 1] === '\r' ? '\r\n' : '\n'
  if (firstEnd < 0 || text.slice(0, firstEnd).replace(/\r$/, '') !== '---') return { bom, eol, body: text }
  const lines = []
  let start = firstEnd + 1
  for (;;) {
    const next = text.indexOf('\n', start)
    const end = next < 0 ? text.length : next
    const line = text.slice(start, end).replace(/\r$/, '')
    if (line === '---') return { bom, eol, lines, body: next < 0 ? '' : text.slice(next + 1) }
    if (next < 0) return { bom, eol, body: text }
    lines.push(line)
    start = next + 1
  }
}

/**
 * Parse frontmatter lines into top-level entries.
 * @param {string[]} lines - frontmatter lines between the fences.
 * @returns {{ entries: Entry[], errors: { line: number, message: string }[] }} entries in file order;
 *   `line` numbers in errors are 1-based within the frontmatter block.
 *
 * @typedef {{ key: string, start: number, end: number, type: string, value?: unknown, error?: string }} Entry
 *   `start`/`end` delimit the entry's lines (end exclusive, trailing blank lines excluded). `type` is one of
 *   `null`, `string`, `boolean`, `number`, `map`, `seq`, `alias`, `invalid`.
 */
export function parseFrontmatter(lines) {
  const entries = []
  const errors = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (BLANK.test(line) || COMMENT.test(line)) {
      i++
      continue
    }
    if (/^[ \t]/.test(line)) {
      errors.push({ line: i + 1, message: line.startsWith('\t') ? 'tabs are not allowed as indentation' : 'unexpected indentation' })
      i++
      continue
    }
    const key = readKey(line)
    if (key.error !== undefined) {
      errors.push({ line: i + 1, message: key.error })
      i++
      continue
    }
    const emptyValue = BLANK.test(key.rest) || /^[ \t]+#/.test(key.rest)
    let end = i + 1
    let scan = i + 1
    while (scan < lines.length) {
      const next = lines[scan]
      if (/^[ \t]/.test(next) && !BLANK.test(next)) end = scan + 1
      else if (emptyValue && /^-(?:[ \t]|$)/.test(next)) end = scan + 1
      else if (!BLANK.test(next) && !next.startsWith('#')) break
      scan++
    }
    let blockEnd = end
    while (blockEnd < lines.length && BLANK.test(lines[blockEnd])) blockEnd++
    const parsed = parseValue(key.rest, lines.slice(i + 1, end), lines.slice(i + 1, blockEnd), i + 1)
    const entry = { key: key.key, start: i, end, type: parsed.type }
    if ('value' in parsed) entry.value = parsed.value
    if (parsed.error !== undefined) {
      entry.type = 'invalid'
      entry.error = parsed.error
      errors.push({ line: parsed.line ?? i + 1, message: parsed.error })
    }
    entries.push(entry)
    i = end
  }
  const seen = new Set()
  for (const entry of entries) {
    if (seen.has(entry.key)) errors.push({ line: entry.start + 1, message: `duplicate key "${entry.key}"` })
    seen.add(entry.key)
  }
  errors.sort((a, b) => a.line - b.line)
  return { entries, errors }
}

/** Read the key of a top-level `key: value` line; `rest` is the text after the colon. */
function readKey(line) {
  if (line.startsWith('"') || line.startsWith("'")) {
    const quoted = scanQuoted(line, 0)
    if (quoted.error !== undefined || quoted.endLine !== 0) return { error: 'unterminated quoted key' }
    const after = line.slice(quoted.endColumn)
    const colon = /^[ \t]*:(?=[ \t]|$)/.exec(after)
    if (colon === null) return { error: 'expected ":" after the key' }
    return { key: quoted.value, rest: after.slice(colon[0].length) }
  }
  if (/^\?(?:[ \t]|$)/.test(line)) return { error: 'complex mapping keys are not supported' }
  if (/^-(?:[ \t]|$)/.test(line)) return { error: 'expected "key: value", found a list item' }
  if (/^[[{]/.test(line)) return { error: 'flow-style mappings are not supported; write one "key: value" per line' }
  if (/^[,\]}&*!|>%@`]/.test(line)) return { error: `unexpected character "${line[0]}" at the start of a line` }
  const match = /^(.*?)[ \t]*:(?=[ \t]|$)/.exec(line)
  if (match === null || match[1] === '') return { error: 'expected "key: value"' }
  if (/[ \t]#/.test(match[1])) return { error: 'expected "key: value"' }
  return { key: match[1], rest: line.slice(match[0].length) }
}

/**
 * Parse one entry value. Helpers receive the 1-based frontmatter line number of their first input line
 * (`keyLine` for inputs that start on the key line, `keyLine + 1` for continuation lines).
 * @param {string} rest - text after `key:` on the key line.
 * @param {string[]} cont - continuation lines of the entry.
 * @param {string[]} blockCont - continuation lines plus trailing blank lines (block scalar content).
 * @param {number} keyLine - 1-based number of the key line.
 */
function parseValue(rest, cont, blockCont, keyLine) {
  let text = rest.replace(/^[ \t]+/, '')
  let forceString = false
  // Node properties: an anchor is irrelevant to the value; `!!str` forces a string; other tags are ignored
  // the way the `yaml` package ignores unresolved tags.
  for (;;) {
    const property = /^([&!][^ \t]*)(?:[ \t]+|$)/.exec(text)
    if (property === null) break
    if (property[1] === '!!str') forceString = true
    text = text.slice(property[0].length)
  }
  if (text.startsWith('*')) return { type: 'alias' }
  let result
  if (text === '' || text.startsWith('#')) result = parseNextLineValue(cont, blockCont, keyLine + 1)
  else if (text[0] === '|' || text[0] === '>') result = parseBlockScalar(text, blockCont, keyLine + 1)
  else if (text[0] === '"' || text[0] === "'") result = parseQuoted([text, ...cont], keyLine)
  else if (text[0] === '[' || text[0] === '{') result = parseFlow([text, ...cont], keyLine)
  else result = parsePlain(text, cont, keyLine + 1)
  if (forceString && result.error === undefined && result.raw !== undefined) return { type: 'string', value: result.raw }
  return result
}

/** A value that starts on the line after its key: nested map, list, or a scalar. */
function parseNextLineValue(cont, blockCont, lineNo) {
  const index = cont.findIndex(line => !BLANK.test(line) && !COMMENT.test(line))
  if (index < 0) return { type: 'null', value: null }
  const first = cont[index].replace(/^[ \t]+/, '')
  const firstLine = lineNo + index
  if (/^-(?:[ \t]|$)/.test(first)) return { type: 'seq' }
  if (first[0] === '"' || first[0] === "'") {
    const quoted = parseQuoted([first, ...cont.slice(index + 1)], firstLine)
    if (quoted.error === undefined || readKey(first).error !== undefined) return quoted
  }
  if (first[0] === '|' || first[0] === '>') return parseBlockScalar(first, blockCont.slice(index + 1), firstLine + 1)
  if (first[0] === '[' || first[0] === '{') return parseFlow([first, ...cont.slice(index + 1)], firstLine)
  if (readKey(first).error === undefined) return { type: 'map' }
  return parsePlain(first, cont.slice(index + 1), firstLine + 1)
}

/** Plain (unquoted) scalar, possibly folded over continuation lines. */
function parsePlain(first, cont, lineNo) {
  const startError = plainStartError(first)
  if (startError !== undefined) return { error: startError, line: lineNo - 1 }
  const parts = []
  let terminated = false
  const take = (text, line) => {
    const comment = /[ \t]#/.exec(text)
    const value = (comment === null ? text : text.slice(0, comment.index)).trim()
    if (/:(?:[ \t]|$)/.test(value)) {
      return { error: 'a ": " inside an unquoted value starts a nested mapping; quote the value', line }
    }
    if (comment !== null) terminated = true
    parts.push(value)
    return undefined
  }
  const firstError = take(first, lineNo - 1)
  if (firstError !== undefined) return firstError
  for (let i = 0; i < cont.length; i++) {
    const line = cont[i]
    if (BLANK.test(line)) {
      parts.push('')
      continue
    }
    if (COMMENT.test(line)) {
      terminated = true
      continue
    }
    if (terminated) return { error: 'unexpected text after a comment', line: lineNo + i }
    if (line.startsWith('\t')) return { error: 'tabs are not allowed as indentation', line: lineNo + i }
    const error = take(line, lineNo + i)
    if (error !== undefined) return error
  }
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  const raw = foldFlowLines(parts)
  return { ...resolvePlain(raw), raw }
}

function plainStartError(text) {
  if (/^[@`]/.test(text)) return `an unquoted value cannot start with "${text[0]}"; quote the value`
  if (text.startsWith('%')) return 'an unquoted value cannot start with "%"; quote the value'
  if (/^[,\]}]/.test(text)) return `an unquoted value cannot start with "${text[0]}"; quote the value`
  if (/^-(?:[ \t]|$)/.test(text)) return 'a list cannot start on the same line as its key'
  if (/^[?:](?:[ \t]|$)/.test(text)) return `an unquoted value cannot start with "${text[0]} "; quote the value`
  return undefined
}

/** Join flow-scalar lines: adjacent lines fold into one space, each empty line becomes a line feed. */
function foldFlowLines(parts) {
  let out = ''
  let pendingEmpty = 0
  let started = false
  for (const part of parts) {
    if (part === '') {
      if (started) pendingEmpty++
      continue
    }
    if (started) out += pendingEmpty > 0 ? '\n'.repeat(pendingEmpty) : ' '
    out += part
    started = true
    pendingEmpty = 0
  }
  return out
}

/** Resolve a plain scalar with the YAML 1.2 core schema. */
function resolvePlain(text) {
  if (/^(?:~|null|Null|NULL)?$/.test(text)) return { type: 'null', value: null }
  if (/^(?:true|True|TRUE)$/.test(text)) return { type: 'boolean', value: true }
  if (/^(?:false|False|FALSE)$/.test(text)) return { type: 'boolean', value: false }
  if (/^[-+]?[0-9]+$/.test(text)) return { type: 'number', value: Number(text) }
  if (/^0o[0-7]+$/.test(text)) return { type: 'number', value: Number.parseInt(text.slice(2), 8) }
  if (/^0x[0-9a-fA-F]+$/.test(text)) return { type: 'number', value: Number.parseInt(text.slice(2), 16) }
  if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(text)) return { type: 'number', value: Number(text) }
  if (/^[-+]?\.(?:inf|Inf|INF)$/.test(text)) return { type: 'number', value: text.startsWith('-') ? -Infinity : Infinity }
  if (/^\.(?:nan|NaN|NAN)$/.test(text)) return { type: 'number', value: Number.NaN }
  return { type: 'string', value: text }
}

const DOUBLE_ESCAPES = {
  0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ',
  '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029',
}
const HEX_ESCAPES = { x: 2, u: 4, U: 8 }

/**
 * Scan a quoted scalar starting at `lines[0][column]`.
 * @returns {{ value: string, endLine: number, endColumn: number } | { error: string, line: number }}
 */
function scanQuoted(lines, column) {
  const source = typeof lines === 'string' ? [lines] : lines
  const quote = source[0][column]
  let out = ''
  let spaces = ''
  let lineIndex = 0
  let col = column + 1
  for (;;) {
    const line = source[lineIndex]
    if (col >= line.length) {
      // Line break inside the scalar: trailing white space is dropped, the break folds to one space or to
      // one line feed per following empty line, and leading white space of the next line is dropped.
      spaces = ''
      let empty = 0
      lineIndex++
      while (lineIndex < source.length && BLANK.test(source[lineIndex])) {
        empty++
        lineIndex++
      }
      if (lineIndex >= source.length) return { error: `missing closing ${quote} quote`, line: 0 }
      if (!/^[ \t]/.test(source[lineIndex])) return { error: 'continuation lines of a quoted value must be indented', line: lineIndex }
      out += empty > 0 ? '\n'.repeat(empty) : ' '
      col = /^[ \t]*/.exec(source[lineIndex])[0].length
      continue
    }
    const ch = line[col]
    if (ch === quote) {
      if (quote === "'" && line[col + 1] === "'") {
        out += spaces + "'"
        spaces = ''
        col += 2
        continue
      }
      return { value: out + spaces, endLine: lineIndex, endColumn: col + 1 }
    }
    if (ch === ' ' || ch === '\t') {
      spaces += ch
      col++
      continue
    }
    out += spaces
    spaces = ''
    if (quote === '"' && ch === '\\') {
      const next = line[col + 1]
      if (next === undefined) {
        // Escaped line break: join with the next line without a space.
        lineIndex++
        if (lineIndex >= source.length) return { error: 'missing closing " quote', line: 0 }
        col = /^[ \t]*/.exec(source[lineIndex])[0].length
        continue
      }
      if (Object.hasOwn(DOUBLE_ESCAPES, next)) {
        out += DOUBLE_ESCAPES[next]
        col += 2
        continue
      }
      const width = HEX_ESCAPES[next]
      const hex = width === undefined ? '' : line.slice(col + 2, col + 2 + width)
      if (width === undefined || !new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) {
        return { error: `invalid escape sequence \\${next}`, line: lineIndex }
      }
      const code = Number.parseInt(hex, 16)
      if (code > 0x10ffff) return { error: `invalid escape sequence \\${next}${hex}`, line: lineIndex }
      out += String.fromCodePoint(code)
      col += 2 + width
      continue
    }
    out += ch
    col++
  }
}

/** Quoted scalar spanning `lines`; `lineOffset` maps index 0 to its 1-based frontmatter line. */
function parseQuoted(lines, lineOffset) {
  const scanned = scanQuoted(lines, 0)
  if (scanned.error !== undefined) return { error: scanned.error, line: lineOffset + scanned.line }
  const after = lines[scanned.endLine].slice(scanned.endColumn)
  if (!/^(?:[ \t]*|[ \t]+#.*)$/.test(after)) {
    return { error: 'unexpected text after the closing quote', line: lineOffset + scanned.endLine }
  }
  for (let i = scanned.endLine + 1; i < lines.length; i++) {
    if (!BLANK.test(lines[i]) && !COMMENT.test(lines[i])) {
      return { error: 'unexpected text after the closing quote', line: lineOffset + i }
    }
  }
  return { type: 'string', value: scanned.value, raw: scanned.value }
}

/**
 * Flow collection (`[...]` / `{...}`) whose first line is `lines[0]` at frontmatter line `lineOffset`:
 * brackets must balance and nothing but comments may follow; the content is not interpreted.
 */
function parseFlow(lines, lineOffset) {
  const stack = []
  let quote
  let closed = false
  // A quote opens a quoted scalar only where a scalar starts: after `[`, `{`, `,`, or `:`.
  let scalarStart = true
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (let col = 0; col < line.length; col++) {
      const ch = line[col]
      if (closed) {
        if (/^[ \t]*(?:#.*)?$/.test(line.slice(col))) break
        return { error: 'unexpected text after a flow collection', line: lineOffset + i }
      }
      if (quote !== undefined) {
        if (quote === '"' && ch === '\\') col++
        else if (ch === quote && quote === "'" && line[col + 1] === "'") col++
        else if (ch === quote) quote = undefined
        continue
      }
      if (ch === ' ' || ch === '\t') continue
      if (ch === '#' && col > 0 && /[ \t]/.test(line[col - 1])) break
      if ((ch === '"' || ch === "'") && scalarStart) quote = ch
      else if (ch === '[' || ch === '{') stack.push(ch === '[' ? ']' : '}')
      else if (ch === ']' || ch === '}') {
        if (stack.pop() !== ch) return { error: `unexpected "${ch}"`, line: lineOffset + i }
        if (stack.length === 0) closed = true
      }
      scalarStart = ch === '[' || ch === '{' || ch === ',' || ch === ':'
    }
  }
  if (!closed) return { error: 'unterminated flow collection', line: lineOffset }
  return { type: lines[0][0] === '[' ? 'seq' : 'map' }
}

/** Block scalar (`|` literal or `>` folded) with optional indentation and chomping indicators. */
function parseBlockScalar(header, lines, lineNo) {
  const match = /^([|>])(?:([1-9])([+-])?|([+-])([1-9])?)?(?:[ \t]+#.*)?[ \t]*$/.exec(header)
  if (match === null) return { error: 'invalid block scalar header', line: lineNo - 1 }
  const literal = match[1] === '|'
  const explicit = match[2] ?? match[5]
  const chomp = match[3] ?? match[4] ?? ''
  let indent
  if (explicit !== undefined) indent = Number(explicit)
  else {
    const first = lines.findIndex(line => !BLANK.test(line))
    if (first >= 0) {
      indent = /^ */.exec(lines[first])[0].length
      if (indent === 0) return { error: 'block scalar content must be indented', line: lineNo + first }
      for (let i = 0; i < first; i++) {
        if (lines[i].length > indent) return { error: 'leading empty lines are more indented than the content', line: lineNo + i }
      }
    } else indent = 0
  }
  const content = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (BLANK.test(line)) {
      content.push(line.length > indent ? line.slice(indent) : '')
      continue
    }
    const leading = /^ */.exec(line)[0].length
    if (leading < indent) {
      if (line[leading] === '\t') return { error: 'tabs are not allowed as indentation', line: lineNo + i }
      return { error: 'line is less indented than the block scalar content', line: lineNo + i }
    }
    content.push(line.slice(indent))
  }
  let last = content.length - 1
  while (last >= 0 && content[last] === '') last--
  if (last < 0) {
    const value = chomp === '+' && content.length > 0 ? '\n'.repeat(content.length) : ''
    return { type: 'string', value, raw: value }
  }
  const body = content.slice(0, last + 1)
  const trailing = content.length - 1 - last
  let value
  if (literal) value = body.join('\n')
  else {
    value = ''
    let previous
    let pendingEmpty = 0
    for (const line of body) {
      if (line === '') {
        pendingEmpty++
        continue
      }
      const kind = /^[ \t]/.test(line) ? 'spaced' : 'text'
      if (previous === undefined) value += '\n'.repeat(pendingEmpty)
      else if (previous === 'text' && kind === 'text') value += pendingEmpty > 0 ? '\n'.repeat(pendingEmpty) : ' '
      else value += '\n'.repeat(pendingEmpty + 1)
      value += line
      previous = kind
      pendingEmpty = 0
    }
  }
  if (chomp === '') value += '\n'
  else if (chomp === '+') value += '\n' + '\n'.repeat(trailing)
  return { type: 'string', value, raw: value }
}

/**
 * Read a DSH invocation boolean: YAML booleans, the numbers 1 and 0, or a case-insensitive
 * `true/false/yes/no/on/off/1/0` string.
 * @returns {boolean | undefined} `undefined` when the key is absent.
 * @throws {TypeError} when the value is present but not one of those forms.
 */
function readInvocationBoolean(entry, key) {
  if (entry === undefined) return undefined
  if (entry.type === 'boolean') return entry.value
  if (entry.type === 'number' && (entry.value === 1 || entry.value === 0)) return entry.value === 1
  if (entry.type === 'string') {
    switch (entry.value.toLowerCase()) {
      case 'true': case 'yes': case 'on': case '1': return true
      case 'false': case 'no': case 'off': case '0': return false
    }
  }
  throw new TypeError(`Frontmatter field "${key}" must be a boolean (true or false)`)
}

/**
 * Parse and validate a SKILL.md text the way DSH's skill-filesystem provider does.
 * @param {string} raw - complete file text.
 * @returns {{ name?: string, description?: string, whenToUse?: string, modelInvocable: boolean,
 *   userInvocable: boolean, body: string, invalid?: string }} best-effort fields; `invalid` is the reason
 *   DSH ignores the skill. `body` is the text after the frontmatter with one leading empty line removed.
 */
export function inspectSkill(raw) {
  const doc = splitDocument(raw)
  const body = doc.lines === undefined ? doc.body : doc.body.replace(/^\r?\n/, '')
  const result = { modelInvocable: true, userInvocable: true, body }
  if (doc.lines === undefined) {
    result.invalid = 'Missing YAML frontmatter: the file must start with a "---" line, and another "---" line must close the block'
    return result
  }
  const { entries, errors } = parseFrontmatter(doc.lines)
  const byKey = new Map()
  for (const entry of entries) if (!byKey.has(entry.key)) byKey.set(entry.key, entry)
  const text = key => {
    const entry = byKey.get(key)
    return entry?.type === 'string' && entry.value.length > 0 ? entry.value : undefined
  }
  const name = text('name')
  const description = text('description')
  const whenToUse = text('whenToUse')
  if (name !== undefined) result.name = name
  if (description !== undefined) result.description = description
  if (whenToUse !== undefined) result.whenToUse = whenToUse
  let invocationError
  for (const [key, field] of [['disable-model-invocation', 'modelInvocable'], ['user-invocable', 'userInvocable']]) {
    try {
      const value = readInvocationBoolean(byKey.get(key), key)
      if (value !== undefined) result[field] = key === 'disable-model-invocation' ? !value : value
    } catch (error) {
      invocationError ??= error.message
    }
  }
  const legacy = LEGACY_KEYS.find(([key]) => byKey.has(key))
  if (doc.bom) result.invalid = 'The file starts with a byte order mark (BOM), so DSH cannot find its frontmatter'
  else if (errors.length > 0) {
    // Line numbers are reported for the whole file: the opening fence is line 1.
    result.invalid = `Invalid YAML frontmatter at line ${errors[0].line + 1}: ${errors[0].message}`
  } else if (entries.length === 0) result.invalid = 'The YAML frontmatter is empty; it needs "name" and "description"'
  else if (name === undefined) result.invalid = 'Frontmatter field "name" is missing or is not text'
  else if (description === undefined) result.invalid = 'Frontmatter field "description" is missing or is not text'
  else if (!isSkillName(name)) {
    result.invalid = `Invalid skill name "${name}": use lowercase letters, digits, and single hyphens, such as "my-skill"`
  } else if (legacy !== undefined) result.invalid = `Frontmatter field "${legacy[0]}" is unsupported; use "${legacy[1]}"`
  else if (invocationError !== undefined) result.invalid = invocationError
  return result
}

/**
 * Quote a string as a YAML double-quoted scalar: JSON escaping plus escapes for characters YAML does not
 * allow unescaped.
 * @param {string} value - text to quote.
 * @returns {string} a single-line YAML scalar.
 */
export function quoteYaml(value) {
  return JSON.stringify(value).replace(/[\u007f-\u009f\ufffe\uffff]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** Write a kebab-case name plainly unless YAML would read it as another type (for example `true`, `123`). */
function formatName(name) {
  return resolvePlain(name).type === 'string' ? name : quoteYaml(name)
}

/** The managed key lines for a set of fields; `null` removes a key, `undefined` leaves it unchanged. */
function managedLines(fields) {
  const whenToUse = typeof fields.whenToUse === 'string' ? fields.whenToUse.trim() : undefined
  // Text that differs only in surrounding white space (for example the line feed a block scalar ends with)
  // keeps its original lines.
  const sameText = value => entry => entry.type === 'string' && entry.value.trim() === value.trim()
  return new Map([
    ['name', { line: `name: ${formatName(fields.name)}`, matches: e => e.type === 'string' && e.value === fields.name }],
    ['description', { line: `description: ${quoteYaml(fields.description)}`, matches: sameText(fields.description) }],
    ['whenToUse', whenToUse === undefined
      ? undefined
      : whenToUse === ''
        ? null
        : { line: `whenToUse: ${quoteYaml(whenToUse)}`, matches: sameText(whenToUse) }],
    ['disable-model-invocation', fields.modelInvocable
      ? null
      : { line: 'disable-model-invocation: true', matches: e => safeBoolean(e) === true }],
    ['user-invocable', fields.userInvocable
      ? null
      : { line: 'user-invocable: false', matches: e => safeBoolean(e) === false }],
  ])
}

function safeBoolean(entry) {
  try {
    return readInvocationBoolean(entry, '')
  } catch {
    // An unreadable value never matches the desired boolean, so the line is rewritten.
    return undefined
  }
}

/** Normalize body line endings to `eol` and end a non-empty body with one line terminator. */
function formatBody(body, eol) {
  if (body === '') return ''
  const normalized = body.replace(/\r?\n/g, eol)
  return normalized.endsWith(eol) ? normalized : normalized + eol
}

/**
 * Serialize a new SKILL.md file.
 * @param {{ name: string, description: string, whenToUse?: string, modelInvocable: boolean,
 *   userInvocable: boolean, body: string }} fields - validated skill fields.
 * @param {string} [eol] - line terminator.
 * @returns {string} file text: frontmatter, an empty line, then the body.
 */
export function serializeSkill(fields, eol = '\n') {
  const lines = ['---']
  for (const spec of managedLines({ ...fields, whenToUse: fields.whenToUse ?? '' }).values()) {
    if (spec) lines.push(spec.line)
  }
  lines.push('---')
  const body = formatBody(fields.body, eol)
  return lines.join(eol) + eol + (body === '' ? '' : eol + body)
}

/**
 * Rewrite a SKILL.md text with new managed fields and body. Other keys, comments, blank lines, and key
 * order are preserved; a managed key whose current value already equals the new value keeps its original
 * line. Duplicate managed keys and the legacy keys DSH rejects are removed. Missing keys are inserted next
 * to the managed key that precedes them in `name, description, whenToUse, disable-model-invocation,
 * user-invocable` order. A BOM is dropped; the original line terminator is kept.
 * @param {string} raw - current file text.
 * @param {{ name: string, description: string, whenToUse?: string, modelInvocable: boolean,
 *   userInvocable: boolean, body: string }} fields - `whenToUse` `''` removes the key, `undefined` keeps it.
 * @returns {string} the new file text.
 */
export function updateSkillText(raw, fields) {
  const doc = splitDocument(raw)
  if (doc.lines === undefined) return serializeSkill(fields, doc.eol)
  const { entries } = parseFrontmatter(doc.lines)
  const items = []
  let cursor = 0
  for (const entry of entries) {
    for (; cursor < entry.start; cursor++) items.push({ text: [doc.lines[cursor]] })
    items.push({ key: entry.key, entry, text: doc.lines.slice(entry.start, entry.end) })
    cursor = entry.end
  }
  for (; cursor < doc.lines.length; cursor++) items.push({ text: [doc.lines[cursor]] })

  const legacy = new Set(LEGACY_KEYS.map(([key]) => key))
  let list = items.filter(item => !legacy.has(item.key))
  const specs = managedLines(fields)
  MANAGED_KEYS.forEach((key, index) => {
    const spec = specs.get(key)
    if (spec === undefined) return
    const first = list.findIndex(item => item.key === key)
    list = list.filter((item, i) => item.key !== key || (spec !== null && i === first))
    if (spec === null) return
    if (first >= 0) {
      const item = list.find(candidate => candidate.key === key)
      if (!spec.matches(item.entry)) {
        item.text = [spec.line]
        item.entry = undefined
      }
      return
    }
    const line = { key, text: [spec.line] }
    const before = MANAGED_KEYS.slice(0, index).reverse()
      .map(previous => list.findLastIndex(item => item.key === previous)).find(i => i >= 0)
    if (before !== undefined) {
      list.splice(before + 1, 0, line)
      return
    }
    const after = MANAGED_KEYS.slice(index + 1)
      .map(next => list.findIndex(item => item.key === next)).find(i => i >= 0)
    if (after !== undefined) {
      list.splice(after, 0, line)
      return
    }
    const firstEntry = list.findIndex(item => item.key !== undefined)
    if (index <= 1 && firstEntry >= 0) list.splice(firstEntry, 0, line)
    else {
      let last = list.length
      while (last > 0 && list[last - 1].key === undefined && BLANK.test(list[last - 1].text[0])) last--
      list.splice(last, 0, line)
    }
  })

  const lines = list.flatMap(item => item.text)
  const eol = doc.eol
  const head = ['---', ...lines, '---'].join(eol) + eol
  const body = formatBody(fields.body, eol)
  if (body === '') return head
  const separate = doc.body === '' || /^\r?\n/.test(doc.body)
  return head + (separate ? eol : '') + body
}
