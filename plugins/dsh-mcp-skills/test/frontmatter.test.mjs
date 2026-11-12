import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  inspectSkill, parseFrontmatter, quoteYaml, serializeSkill, splitDocument, updateSkillText,
} from '../host/frontmatter.js'

function entries(yaml) {
  const parsed = parseFrontmatter(yaml.split('\n'))
  assert.deepEqual(parsed.errors, [])
  return Object.fromEntries(parsed.entries.map(entry => [entry.key, entry]))
}

describe('parseFrontmatter', () => {
  it('reads plain scalars with the YAML 1.2 core schema', () => {
    const data = entries([
      'name: my-skill # comment',
      'url: http://example.com/a#b',
      'flag: TRUE',
      'yes-string: yes',
      'empty:',
      'tilde: ~',
      'int: 012',
      'hex: 0x1f',
      'float: 1e3',
      'folded: first',
      '  second',
      '',
      '  third',
    ].join('\n'))
    assert.deepEqual(data.name.value, 'my-skill')
    assert.equal(data.url.value, 'http://example.com/a#b')
    assert.equal(data.flag.value, true)
    assert.equal(data['yes-string'].value, 'yes')
    assert.equal(data.empty.type, 'null')
    assert.equal(data.tilde.type, 'null')
    assert.equal(data.int.value, 12)
    assert.equal(data.hex.value, 31)
    assert.equal(data.float.value, 1000)
    assert.equal(data.folded.value, 'first second\nthird')
  })

  it('reads single- and double-quoted scalars with escapes and folding', () => {
    const data = entries([
      'single: \'it\'\'s # not a comment\'',
      'double: "tab\\there \\u00e9\\x41 \\"q\\" \\\\"',
      'multi: "first',
      '  second',
      '',
      '  third\\',
      '  joined"  # trailing comment',
      '"quoted key": value',
      'forced: !!str 123',
    ].join('\n'))
    assert.equal(data.single.value, "it's # not a comment")
    assert.equal(data.double.value, 'tab\there éA "q" \\')
    assert.equal(data.multi.value, 'first second\nthirdjoined')
    assert.equal(data['quoted key'].value, 'value')
    assert.equal(data.forced.value, '123')
  })

  it('reads block scalars with chomping and indentation indicators', () => {
    const data = entries([
      'literal: |',
      '  line one',
      '    indented',
      '',
      'folded: >',
      '  a',
      '  b',
      '',
      '  c',
      '    spaced',
      '  d',
      'strip: >-',
      '  x',
      '  y',
      '',
      'keep: |+',
      '  kept',
      '',
      '',
      'explicit: |2',
      '    two extra',
      'after: done',
    ].join('\n'))
    assert.equal(data.literal.value, 'line one\n  indented\n')
    assert.equal(data.folded.value, 'a b\nc\n  spaced\nd\n')
    assert.equal(data.strip.value, 'x y')
    assert.equal(data.keep.value, 'kept\n\n\n')
    assert.equal(data.explicit.value, '  two extra\n')
    assert.equal(data.after.value, 'done')
  })

  it('recognizes nested maps, lists, and flow collections without interpreting them', () => {
    const lines = [
      'metadata:',
      '  author: someone',
      '  nested:',
      '    deep: [1, 2]',
      '# a comment inside the map',
      '  more: x',
      'allowed-tools:',
      '- Read',
      '- Bash(git:*)',
      'tags: [a, "b, c", {d: e}]',
      'name: x',
    ]
    const parsed = parseFrontmatter(lines)
    assert.deepEqual(parsed.errors, [])
    assert.deepEqual(parsed.entries.map(entry => [entry.key, entry.type, entry.start, entry.end]), [
      ['metadata', 'map', 0, 6],
      ['allowed-tools', 'seq', 6, 9],
      ['tags', 'seq', 9, 10],
      ['name', 'string', 10, 11],
    ])
  })

  it('reports the constructs YAML rejects', () => {
    const cases = [
      ['description: Use when: anything', 1],
      ['a: x\nb: y\na: z', 3],
      ['a: "unterminated\nb: 1', 1],
      ['a: |\n  x\n y', 3],
      ['a: @at', 1],
      ['a: - item', 1],
      ['a: x\n\tb: 1', 2],
      ['a: [1, 2', 1],
      ['plain line without a colon', 1],
      ['a: "x" trailing', 1],
      ['a: "\\q"', 1],
    ]
    for (const [yaml, line] of cases) {
      const { errors } = parseFrontmatter(yaml.split('\n'))
      assert.ok(errors.length > 0, `expected an error for ${JSON.stringify(yaml)}`)
      assert.equal(errors[0].line, line, JSON.stringify(yaml))
    }
  })
})

describe('splitDocument', () => {
  it('finds the frontmatter with CRLF line endings and a BOM', () => {
    const doc = splitDocument('\uFEFF---\r\nname: x\r\n---\r\nbody\r\n')
    assert.equal(doc.bom, true)
    assert.equal(doc.eol, '\r\n')
    assert.deepEqual(doc.lines, ['name: x'])
    assert.equal(doc.body, 'body\r\n')
  })

  it('requires an opening and a closing fence', () => {
    assert.equal(splitDocument('name: x\n---\n').lines, undefined)
    assert.equal(splitDocument('---\nname: x\n').lines, undefined)
    assert.deepEqual(splitDocument('---\n---').lines, [])
  })
})

describe('inspectSkill', () => {
  it('returns fields and the body without one leading empty line', () => {
    const info = inspectSkill('---\nname: pdf\ndescription: "Read PDFs"\nwhenToUse: >\n  When a PDF\n  is attached\n---\n\n\nBody\n')
    assert.equal(info.invalid, undefined)
    assert.equal(info.name, 'pdf')
    assert.equal(info.description, 'Read PDFs')
    assert.equal(info.whenToUse, 'When a PDF is attached\n')
    assert.equal(info.body, '\nBody\n')
    assert.equal(info.modelInvocable, true)
    assert.equal(info.userInvocable, true)
  })

  it('accepts the DSH invocation boolean forms', () => {
    const forms = [['true', true], ['TRUE', true], ['yes', true], ['On', true], ['1', true], ['"0"', false], ['off', false], ['No', false], ['1.0', true]]
    for (const [text, value] of forms) {
      const info = inspectSkill(`---\nname: a\ndescription: b\ndisable-model-invocation: ${text}\nuser-invocable: ${text}\n---\n`)
      assert.equal(info.invalid, undefined, text)
      assert.equal(info.modelInvocable, !value, text)
      assert.equal(info.userInvocable, value, text)
    }
  })

  it('rejects invalid booleans, names, legacy keys, and missing fields', () => {
    const cases = [
      ['name: a\ndescription: b\ndisable-model-invocation: maybe', /"disable-model-invocation" must be a boolean/],
      ['name: a\ndescription: b\nuser-invocable:', /"user-invocable" must be a boolean/],
      ['name: a\ndescription: b\nuser-invocable: 2', /"user-invocable" must be a boolean/],
      ['name: My_Skill\ndescription: b', /Invalid skill name "My_Skill"/],
      ['name: 123\ndescription: b', /"name" is missing or is not text/],
      ['name: a', /"description" is missing/],
      ['name: a\ndescription: b\nmodelInvocable: false', /"modelInvocable" is unsupported; use "disable-model-invocation"/],
      ['name: a\ndescription: Use when: x', /Invalid YAML frontmatter at line 3: .*nested mapping/],
      ['# only a comment', /frontmatter is empty/],
    ]
    for (const [yaml, pattern] of cases) {
      const info = inspectSkill(`---\n${yaml}\n---\nbody\n`)
      assert.match(info.invalid ?? '', pattern, yaml)
    }
    assert.match(inspectSkill('# no frontmatter\n').invalid, /Missing YAML frontmatter/)
    const bom = inspectSkill('\uFEFF---\nname: a\ndescription: b\n---\n')
    assert.match(bom.invalid, /byte order mark/)
    assert.equal(bom.name, 'a')
  })
})

describe('serializeSkill and updateSkillText', () => {
  it('serializes a new skill', () => {
    const text = serializeSkill({
      name: 'my-skill', description: 'Says "hi"\nand more', whenToUse: '', modelInvocable: false, userInvocable: true, body: '# Title',
    })
    assert.equal(text, '---\nname: my-skill\ndescription: "Says \\"hi\\"\\nand more"\ndisable-model-invocation: true\n---\n\n# Title\n')
    assert.equal(inspectSkill(text).description, 'Says "hi"\nand more')
    assert.equal(serializeSkill({ name: 'true', description: 'x', modelInvocable: true, userInvocable: true, body: '' }),
      '---\nname: "true"\ndescription: "x"\n---\n')
    assert.equal(quoteYaml('a\u0085b\u007f'), '"a\\u0085b\\u007f"')
  })

  it('updates only the managed keys and keeps everything else', () => {
    const original = [
      '---',
      '# header comment',
      'name: editor',
      'description: >-',
      '  Old folded',
      '  description.',
      'metadata:',
      '  author: someone',
      '  tags: [a, b]',
      'allowed-tools:',
      '  - Read',
      'license: MIT # trailing comment',
      '---',
      '',
      'Old body.',
      '',
    ].join('\n')
    const fields = { name: 'editor', description: 'New description', whenToUse: 'When editing', modelInvocable: false, userInvocable: false, body: 'New body.' }
    const updated = updateSkillText(original, fields)
    assert.equal(updated, [
      '---',
      '# header comment',
      'name: editor',
      'description: "New description"',
      'whenToUse: "When editing"',
      'disable-model-invocation: true',
      'user-invocable: false',
      'metadata:',
      '  author: someone',
      '  tags: [a, b]',
      'allowed-tools:',
      '  - Read',
      'license: MIT # trailing comment',
      '---',
      '',
      'New body.',
      '',
    ].join('\n'))
    const reverted = updateSkillText(updated, { ...fields, whenToUse: '', modelInvocable: true, userInvocable: true })
    assert.equal(reverted, updated.replace('whenToUse: "When editing"\ndisable-model-invocation: true\nuser-invocable: false\n', ''))
  })

  it('keeps unchanged values verbatim, drops duplicates and legacy keys, and keeps CRLF', () => {
    const original = '\uFEFF---\r\nname: x\r\ndescription: |\r\n  Same text\r\nuser-invocable: no\r\nuserInvocable: false\r\nname: x\r\n---\r\nbody'
    const updated = updateSkillText(original, { name: 'x', description: 'Same text', modelInvocable: true, userInvocable: false, body: 'line 1\nline 2' })
    assert.equal(updated, '---\r\nname: x\r\ndescription: |\r\n  Same text\r\nuser-invocable: no\r\n---\r\nline 1\r\nline 2\r\n')
    assert.equal(inspectSkill(updated).invalid, undefined)
  })

  it('inserts missing keys in canonical order and rebuilds a file without frontmatter', () => {
    const updated = updateSkillText('---\n# only a comment\nother: 1\n---\nbody\n', {
      name: 'n', description: 'd', whenToUse: 'w', modelInvocable: true, userInvocable: false, body: 'body\n',
    })
    assert.equal(updated, '---\n# only a comment\nname: n\ndescription: "d"\nwhenToUse: "w"\nuser-invocable: false\nother: 1\n---\nbody\n')
    assert.equal(updateSkillText('plain markdown\n', { name: 'n', description: 'd', modelInvocable: true, userInvocable: true, body: 'B' }),
      '---\nname: n\ndescription: "d"\n---\n\nB\n')
  })
})
