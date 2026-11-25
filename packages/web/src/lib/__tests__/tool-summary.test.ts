import { describe, expect, it } from 'vitest'
import { editDiff, identifyTool, summarizeTool, toolDetailOf, withToolDetail, writtenLines } from '../tool-summary'

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
    expect(summarizeTool('mcp__s__t', { id: 'MAR-1', note: 'hi\nthere' })).toBe('id: MAR-1, note: hi')
  })

  it('is empty with no input', () => {
    expect(summarizeTool('Bash', undefined)).toBe('')
  })
})

describe('editDiff and writtenLines', () => {
  it('shows an edit as its old lines removed and its new ones added, for either spelling', () => {
    expect(editDiff({ old_string: 'a\nb', new_string: 'c' })).toEqual([
      { sign: '-', text: 'a' }, { sign: '-', text: 'b' }, { sign: '+', text: 'c' },
    ])
    expect(editDiff({ oldString: 'x', newString: 'y' })).toEqual([{ sign: '-', text: 'x' }, { sign: '+', text: 'y' }])
  })

  it('shows every edit of a MultiEdit', () => {
    expect(editDiff({ edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] })?.map((l) => l.text)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('has no diff for an input that is not an edit', () => {
    expect(editDiff({ file_path: '/a' })).toBeUndefined()
    expect(editDiff(undefined)).toBeUndefined()
  })

  it('shows a written body as additions', () => {
    expect(writtenLines({ content: 'a\nb' })).toEqual([{ sign: '+', text: 'a' }, { sign: '+', text: 'b' }])
  })
})

describe('withToolDetail', () => {
  it('lays new detail over what the row held and keeps its other meta', () => {
    const row = { id: 'r', role: 'assistant' as const, content: 'Using Bash', timestamp: 1, meta: { sidechain: true, tool: { input: { command: 'ls' } } } }
    expect(withToolDetail(row, { output: 'a' }).meta).toEqual({ sidechain: true, tool: { input: { command: 'ls' }, output: 'a' } })
  })
})
