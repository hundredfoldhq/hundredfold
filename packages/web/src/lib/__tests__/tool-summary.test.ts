import { describe, expect, it } from 'vitest'
import { diffStats, editDiff, hasOwnLineNumbers, identifyTool, lineDiff, readStartLine, readableOutput, summarizeTool, toolDetailFromWire, toolDetailOf, withFullDetail, withToolDetail, writtenLines } from '../tool-summary'

describe('toolDetailOf', () => {
  it('reads the detail a tool row carries, and nothing from a row without one', () => {
    expect(toolDetailOf({ meta: { tool: { input: { command: 'ls' }, output: 'a', isError: true, outputChars: 9000, inputTruncated: true } } }))
      .toEqual({ input: { command: 'ls' }, output: 'a', isError: true, outputChars: 9000, inputTruncated: true })
    expect(toolDetailOf({})).toBeUndefined()
    expect(toolDetailOf({ meta: { agentId: 'a1' } })).toBeUndefined()
  })

  it('refuses a shape the wire should never carry', () => {
    expect(toolDetailOf({ meta: { tool: 'oops' } })).toBeUndefined()
    expect(toolDetailOf({ meta: { tool: { input: 'x', output: 5 } } })).toBeUndefined()
    expect(toolDetailOf({ meta: { tool: { input: {} } } })).toBeUndefined()
  })
})

describe('identifyTool', () => {
  it('splits a Claude MCP call into its server and tool', () => {
    expect(identifyTool('mcp__hundredfold__get_work_item')).toEqual({ kind: 'mcp', server: 'hundredfold', name: 'get_work_item' })
  })

  it('knows the builtins of both engines by kind', () => {
    for (const [name, kind] of [['Bash', 'bash'], ['bash', 'bash'], ['Read', 'read'], ['Write', 'write'], ['Edit', 'edit'], ['MultiEdit', 'edit'], ['Grep', 'search'],
      ['Glob', 'search'], ['WebFetch', 'web'], ['webfetch', 'web'], ['Agent', 'agent'], ['task', 'agent'], ['TodoWrite', 'todo']] as const) {
      expect(identifyTool(name).kind).toBe(kind)
    }
  })

  it('leaves any other name whole', () => {
    expect(identifyTool('example_lookup')).toEqual({ kind: 'generic', name: 'example_lookup' })
  })
})

describe('summarizeTool', () => {
  it('says what each kind of call was about, in Claude and opencode spellings', () => {
    expect(summarizeTool('Bash', { command: 'git status\nmore', description: 'status' })).toBe('git status')
    expect(summarizeTool('Bash', { description: 'status' })).toBe('status')
    expect(summarizeTool('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(summarizeTool('read', { filePath: '/a/b.ts' })).toBe('/a/b.ts')
    expect(summarizeTool('Grep', { pattern: 'foo', path: 'src' })).toBe('foo  in src')
    expect(summarizeTool('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
    expect(summarizeTool('WebFetch', { url: 'https://example.com', prompt: 'x' })).toBe('https://example.com')
    expect(summarizeTool('WebSearch', { query: 'cats' })).toBe('cats')
    expect(summarizeTool('Agent', { description: 'scan', prompt: 'long prompt' })).toBe('scan')
    expect(summarizeTool('task', { prompt: 'first line\nsecond' })).toBe('first line')
    expect(summarizeTool('TodoWrite', { todos: [{}, {}] })).toBe('2 items')
  })

  it('shows an MCP or unknown call by its arguments', () => {
    expect(summarizeTool('mcp__s__t', { id: 'TASK-1', note: 'hi\nthere' })).toBe('id: TASK-1, note: hi')
  })

  it('is empty with no input', () => {
    expect(summarizeTool('Bash', undefined)).toBe('')
  })
})

describe('editDiff with a numbered patch result', () => {
  const patch = '@@ -10,4 +10,4 @@\n const a = 1\n-const b = 2\n+const b = 3\n const c = 4\n const d = 5\n@@ -40,2 +40,3 @@\n x\n+y\n z'
  it('draws the result hunks numbered as the file is, not the bare replacement', () => {
    expect(editDiff({ old_string: 'const b = 2', new_string: 'const b = 3' }, patch)).toEqual([
      { sign: ' ', text: 'const a = 1', line: 10 },
      { sign: '-', text: 'const b = 2', line: 11 },
      { sign: '+', text: 'const b = 3', line: 11 },
      { sign: ' ', text: 'const c = 4', line: 12 },
      { sign: ' ', text: 'const d = 5', line: 13 },
      { sign: '…', text: '' },
      { sign: ' ', text: 'x', line: 40 },
      { sign: '+', text: 'y', line: 41 },
      { sign: ' ', text: 'z', line: 42 },
    ])
  })
  it('skips an opencode diff header before the hunks', () => {
    const diff = 'Index: /w/a.ts\n===================================================================\n--- /w/a.ts\n+++ /w/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n'
    expect(editDiff({ filePath: '/w/a.ts', oldString: 'old', newString: 'new' }, diff)).toEqual([
      { sign: '-', text: 'old', line: 1 },
      { sign: '+', text: 'new', line: 1 },
    ])
  })
  it('falls back to the replacement when the result is not a numbered patch', () => {
    expect(editDiff({ old_string: 'x', new_string: 'y' }, 'Edit applied successfully.')).toEqual([{ sign: '-', text: 'x' }, { sign: '+', text: 'y' }])
    expect(editDiff({ old_string: 'x', new_string: 'y' }, '@@ -1,1 +1,1 @@\n same')).toEqual([{ sign: '-', text: 'x' }, { sign: '+', text: 'y' }])
  })
})

describe('editDiff and writtenLines', () => {
  it('keeps a side that is only whitespace', () => {
    expect(editDiff({ old_string: '  ', new_string: 'x' })).toEqual([
      { sign: '-', text: '  ' }, { sign: '+', text: 'x' },
    ])
  })

  it('marks only the lines that changed, keeping the rest as context, for either spelling', () => {
    expect(editDiff({ old_string: 'a\nb\nc', new_string: 'a\nB\nc' })).toEqual([
      { sign: ' ', text: 'a' }, { sign: '-', text: 'b' }, { sign: '+', text: 'B' }, { sign: ' ', text: 'c' },
    ])
    expect(editDiff({ oldString: 'x', newString: 'y' })).toEqual([{ sign: '-', text: 'x' }, { sign: '+', text: 'y' }])
  })

  it('shows a pure insertion or deletion without touching the lines around it', () => {
    expect(editDiff({ old_string: 'a\nc', new_string: 'a\nb\nc' })?.map((l) => l.sign)).toEqual([' ', '+', ' '])
    expect(editDiff({ old_string: 'a\nb', new_string: '' })?.map((l) => l.sign)).toEqual(['-', '-'])
  })

  it('shows every edit of a MultiEdit as its own hunk', () => {
    expect(editDiff({ edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] })).toEqual([
      { sign: '-', text: 'a' }, { sign: '+', text: 'b' }, { sign: '…', text: '' }, { sign: '-', text: 'c' }, { sign: '+', text: 'd' },
    ])
  })

  it('reads a unified patch, dropping its headers but not a removed line that starts with dashes', () => {
    const patch = ['--- a/x.sql', '+++ b/x.sql', '@@ -1,2 +1,2 @@', ' keep', '--- old comment', '+-- new comment', '@@ -9 +9 @@', '-z', '+Z'].join('\n')
    expect(editDiff({ patchText: patch })).toEqual([
      { sign: ' ', text: 'keep', line: 1 }, { sign: '-', text: '-- old comment', line: 2 }, { sign: '+', text: '-- new comment', line: 2 },
      { sign: '…', text: '' }, { sign: '-', text: 'z', line: 9 }, { sign: '+', text: 'Z', line: 9 },
    ])
  })

  it('falls back to old against new whole when the edit is too big to align', () => {
    const big = Array.from({ length: 600 }, (_, i) => `l${i}`)
    const lines = lineDiff(big, [...big].reverse())
    expect(lines.slice(0, 600).every((l) => l.sign === '-')).toBe(true)
    expect(lines.slice(600).every((l) => l.sign === '+')).toBe(true)
  })

  it('has no diff for an input that is not an edit', () => {
    expect(editDiff({ file_path: '/a' })).toBeUndefined()
    expect(editDiff(undefined)).toBeUndefined()
  })

  it('reads a written body as its lines, and counts what a diff adds and removes', () => {
    expect(writtenLines({ content: 'a\nb' })).toEqual(['a', 'b'])
    expect(writtenLines({ file_path: '/a' })).toBeUndefined()
    expect(diffStats([{ sign: '+', text: '' }, { sign: '-', text: '' }, { sign: '+', text: '' }, { sign: ' ', text: '' }])).toEqual({ added: 2, removed: 1 })
  })
})

describe('reading a result', () => {
  it('lays out a JSON result and leaves anything else alone', () => {
    expect(readableOutput('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', json: true })
    expect(readableOutput('{not json')).toEqual({ text: '{not json', json: false })
    expect(readableOutput('plain')).toEqual({ text: 'plain', json: false })
  })

  it('knows a result that numbers its own lines', () => {
    expect(hasOwnLineNumbers(['00001| a', '00002| b', '00003| c'])).toBe(true)
    expect(hasOwnLineNumbers(['     1→a', '     2→b'])).toBe(true)
    expect(hasOwnLineNumbers(['const a = 1', 'const b = 2'])).toBe(false)
  })

  it("starts a read's line numbers where the read did, in either engine's spelling", () => {
    expect(readStartLine('Read', { offset: 40 })).toBe(40)
    expect(readStartLine('read', { offset: 40 })).toBe(41)
    expect(readStartLine('Read', {})).toBe(1)
  })
})

describe('withToolDetail', () => {
  it('lays new detail over what the row held and keeps its other meta', () => {
    const row = { id: 'r', role: 'assistant' as const, content: 'Using Bash', timestamp: 1, meta: { sidechain: true, tool: { input: { command: 'ls' } } } }
    expect(withToolDetail(row, { output: 'a' }).meta).toEqual({ sidechain: true, tool: { input: { command: 'ls' }, output: 'a' } })
  })
})

describe('a tool-details payload', () => {
  it('carries only the keys it was sent', () => {
    expect(toolDetailFromWire({ input: { command: 'ls' } })).toStrictEqual({ input: { command: 'ls' } })
    expect(Object.keys(toolDetailFromWire({ output: 'x', isError: true, outputChars: 9 }))).toEqual(['output', 'isError', 'outputChars'])
  })
})

describe('the detail with what Load full fetched', () => {
  const runningCut = { input: { command: 'xx…' }, inputTruncated: true, full: true as const }

  it('takes the fetched input and keeps a result the fetch did not carry', () => {
    const merged = withFullDetail({ ...runningCut, output: 'done', isError: true }, toolDetailFromWire({ input: { command: 'x'.repeat(9) } }))
    expect(merged).toMatchObject({ input: { command: 'x'.repeat(9) }, output: 'done', isError: true })
    expect(merged.inputTruncated).toBeUndefined()
    expect(merged.full).toBeUndefined()
  })

  it('still offers Load full for a result that arrived cut after the input was loaded', () => {
    const merged = withFullDetail({ ...runningCut, output: 'part…', outputChars: 9_000 }, toolDetailFromWire({ input: { command: 'x'.repeat(9) } }))
    expect(merged).toMatchObject({ output: 'part…', outputChars: 9_000, full: true })
  })

  it('takes the fetched output, and says so when even that was cut at the store', () => {
    const merged = withFullDetail({ input: { command: 'cat' }, output: 'part…', outputChars: 2_000_000, full: true }, toolDetailFromWire({ input: { command: 'cat' }, output: 'y'.repeat(50), outputChars: 2_000_000 }))
    expect(merged).toMatchObject({ output: 'y'.repeat(50), outputChars: 2_000_000 })
    expect(merged.full).toBeUndefined()
  })
})

describe('a numbered patch', () => {
  it('reads an empty line inside a hunk as an empty context line, numbering on', () => {
    const lines = editDiff(undefined, '@@ -1,3 +1,3 @@\n a\n\n-b\n+B')!
    expect(lines.map((l) => `${l.sign}${l.line}`)).toEqual([' 1', ' 2', '-3', '+3'])
  })

  it("drops the next file's header after a hunk that has run its course", () => {
    const patch = '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+A\n keep\n--- a/y\n+++ b/y\n@@ -5 +5 @@\n-c\n+C\n'
    const lines = editDiff(undefined, patch)!
    expect(lines.map((l) => (l.sign === '…' ? '…' : `${l.sign}${l.text}@${l.line}`))).toEqual(['-a@1', '+A@1', ' keep@2', '…', '-c@5', '+C@5'])
  })
})
