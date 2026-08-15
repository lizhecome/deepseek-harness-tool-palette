import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { CallId } from '@deepseek-ai/dsh-llm'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import * as ToolPalette from '../src/index.ts'
import type { Config } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

class FakeCodeRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fake'
  behavior: (request: CodeRunRequest) => Promise<CodeRunResult> = () => Promise.resolve({ logs: [] })

  run(request: CodeRunRequest): Promise<CodeRunResult> {
    return this.behavior(request)
  }
}

/** Mount the published Harness services the plugin consumes. */
async function harness(mode: 'native' | 'code' = 'native'): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime, { mode })
  if (mode === 'code') await ctx.plugin(FakeCodeRuntime)
  return ctx
}

/** Register one deterministic global capability fixture. */
function registerTool(ctx: Context, name: string, description: string): void {
  ctx.tools.register(defineTool({
    name,
    description,
    parameters: {
      value: { type: 'string', description: `Optional ${name} input.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.name }],
    },
    execute: () => Promise.resolve({ name }),
  }))
}

interface PublishedAgent {
  agent: Agent
  scope: Scope
  unregister: () => void
}

/** Publish a structural Agent with the same scoped ownership used in production. */
async function publishAgent(ctx: Context, id: string, owner?: Agent): Promise<PublishedAgent> {
  const agent = { id: SessionId(id) } as Agent
  if (owner !== undefined) bindScopeParent(agent, owner)
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => {
    scope = createScope(inner, agent)
  }, { inject: ['agents', 'systemPrompt', 'tools'] }))
  scope = { ...scope, ctx: scope.ctx.extend({ agent }) }
  Object.assign(agent as unknown as Record<string, unknown>, {
    ctx: scope.ctx,
    session: {
      id: agent.id,
      header: { id: agent.id, version: 0, createdAt: 0 },
      events: [],
      append: () => undefined,
    },
    status: 'idle',
    options: {},
  })
  const unregister = (owner?.ctx ?? ctx).agents.register(agent)
  return { agent, scope, unregister }
}

/** Run the discovery tool through the real guarded ToolRuntime. */
async function search(ctx: Context, agent: Agent | undefined, args: Record<string, unknown>) {
  return await ctx.tools.execute({
    callId: CallId(crypto.randomUUID()),
    name: ToolPalette.TOOL_SEARCH_NAME,
    arguments: args,
    ...agent === undefined ? {} : { agent },
    signal: new AbortController().signal,
  })
}

describe('tool_search', () => {
  it('starts with a compact palette and unlocks ranked matches for only the calling Agent', async () => {
    const ctx = await harness()
    registerTool(ctx, 'read', 'Read a file from the workspace.')
    registerTool(ctx, 'bash', 'Execute a shell command.')
    registerTool(ctx, 'web_search', 'Search the public web.')
    await ctx.plugin(ToolPalette, { alwaysVisible: ['read'] })
    const first = await publishAgent(ctx, 'first')
    const second = await publishAgent(ctx, 'second')

    expect(ctx.tools.schemas(first.agent).map(tool => tool.name).sort())
      .toEqual(['read', 'tool_search'])
    expect(ctx.tools.schemas(second.agent).map(tool => tool.name).sort())
      .toEqual(['read', 'tool_search'])

    const result = await search(ctx, first.agent, { query: 'bash' })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value).toMatchObject({
      query: 'bash',
      newlyUnlocked: ['bash'],
      matches: [{ name: 'bash', enabled: true, newlyUnlocked: true }],
      visibleGlobalCount: 2,
      hiddenGlobalCount: 1,
    })
    expect(ctx.tools.schemas(first.agent).map(tool => tool.name).sort())
      .toEqual(['bash', 'read', 'tool_search'])
    expect(ctx.tools.schemas(second.agent).map(tool => tool.name).sort())
      .toEqual(['read', 'tool_search'])
  })

  it('supports read-only previews, deterministic ranking, limits, and description caps', async () => {
    const ctx = await harness()
    registerTool(ctx, 'bash', 'Execute a shell command with a deliberately long description.')
    registerTool(ctx, 'shell_help', 'Explain how to use bash and shell commands.')
    registerTool(ctx, 'unrelated', 'Read an unrelated value.')
    await ctx.plugin(ToolPalette, {
      maxResults: 1,
      descriptionMaxChars: 12,
    })
    const { agent } = await publishAgent(ctx, 'preview')

    const result = await search(ctx, agent, { query: 'bash', unlock: false })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value).toMatchObject({
      newlyUnlocked: [],
      matches: [{ name: 'bash', enabled: false, newlyUnlocked: false }],
      visibleGlobalCount: 0,
      hiddenGlobalCount: 3,
    })
    expect((result.value as { matches: { description: string }[] }).matches[0]?.description)
      .toMatch(/^Execute a sh… \(\+\d+ chars\)$/)
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).toEqual(['tool_search'])
  })

  it('widens the runtime-owner lineage while sibling palettes stay isolated', async () => {
    const ctx = await harness()
    registerTool(ctx, 'read', 'Read a file.')
    registerTool(ctx, 'bash', 'Execute a shell command.')
    await ctx.plugin(ToolPalette, { alwaysVisible: ['read'] })
    const parent = await publishAgent(ctx, 'parent')
    const child = await publishAgent(ctx, 'child', parent.agent)
    const sibling = await publishAgent(ctx, 'sibling', parent.agent)
    expect(ctx.agents.isOwnedBy(child.agent.id, parent.agent)).toBe(true)
    expect(ctx.agents.isOwnedBy(sibling.agent.id, parent.agent)).toBe(true)
    child.scope.ctx.tools.register(defineTool({
      name: 'report',
      description: 'Report child progress.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => Promise.resolve('reported'),
    }))

    expect(ctx.tools.schemas(child.agent).map(tool => tool.name).sort())
      .toEqual(['read', 'report', 'tool_search'])
    const result = await search(ctx, child.agent, { query: 'shell command' })

    expect(result.isError).toBe(false)
    expect(ctx.tools.schemas(parent.agent).map(tool => tool.name).sort())
      .toEqual(['bash', 'read', 'tool_search'])
    expect(ctx.tools.schemas(child.agent).map(tool => tool.name).sort())
      .toEqual(['bash', 'read', 'report', 'tool_search'])
    expect(ctx.tools.schemas(sibling.agent).map(tool => tool.name).sort())
      .toEqual(['read', 'tool_search'])
  })

  it('discovers tools registered after an Agent palette was installed', async () => {
    const ctx = await harness()
    registerTool(ctx, 'read', 'Read a file.')
    await ctx.plugin(ToolPalette, { alwaysVisible: ['read'] })
    const { agent } = await publishAgent(ctx, 'dynamic')
    registerTool(ctx, 'late_diagram', 'Generate a diagram after startup.')

    expect(ctx.tools.get('late_diagram', agent)).toBeUndefined()
    const result = await search(ctx, agent, { query: 'diagram' })

    expect(result.isError).toBe(false)
    expect(ctx.tools.get('late_diagram', agent)).toBeDefined()
  })

  it('returns a bounded empty result and validates query input', async () => {
    const ctx = await harness()
    registerTool(ctx, 'read', 'Read a file.')
    await ctx.plugin(ToolPalette, { maxQueryChars: 4 })
    const { agent } = await publishAgent(ctx, 'bounds')

    const empty = await search(ctx, agent, { query: 'zzzz' })
    expect(empty).toMatchObject({ isError: false, value: { matches: [], newlyUnlocked: [] } })

    const blank = await search(ctx, agent, { query: '   ' })
    expect(blank).toMatchObject({ isError: true, error: { message: 'query must not be blank' } })

    const punctuation = await search(ctx, agent, { query: '___' })
    expect(punctuation).toMatchObject({
      isError: true,
      error: { message: 'query must contain at least one letter or number' },
    })

    const long = await search(ctx, agent, { query: '12345' })
    expect(long).toMatchObject({
      isError: true,
      error: { message: 'query exceeds the configured 4-character limit' },
    })
  })

  it('requires a managed live Agent', async () => {
    const ctx = await harness()
    await ctx.plugin(ToolPalette, {})

    const result = await search(ctx, undefined, { query: 'read' })

    expect(result).toMatchObject({
      isError: true,
      error: { message: 'tool_search requires a live Agent' },
    })
  })
})

describe('palette lifecycle and presentation', () => {
  it('adopts existing Agents on load and restores their full surface on plugin disposal', async () => {
    const ctx = await harness()
    registerTool(ctx, 'read', 'Read a file.')
    registerTool(ctx, 'bash', 'Execute a shell command.')
    const { agent } = await publishAgent(ctx, 'existing')
    const mounted = await ctx.plugin(ToolPalette, { alwaysVisible: ['read'] })

    expect(ctx.tools.schemas(agent).map(tool => tool.name).sort())
      .toEqual(['read', 'tool_search'])

    await mounted.dispose()

    expect(ctx.tools.schemas(agent).map(tool => tool.name).sort())
      .toEqual(['bash', 'read'])
  })

  it('keeps Code Mode transport visible and updates its generated SDK after unlock', async () => {
    const ctx = await harness('code')
    registerTool(ctx, 'read', 'Read a file.')
    registerTool(ctx, 'bash', 'Execute a shell command.')
    await ctx.plugin(ToolPalette, { alwaysVisible: ['read'] })
    const { agent } = await publishAgent(ctx, 'code')

    const before = await ctx.systemPrompt.assemble({ scope: agent })
    expect(before.tools.map(tool => tool.name)).toEqual([RUN_CODE_NAME])
    const beforeSdk = before.sections.find(section => section.name === 'tools:sdk')?.text
    expect(beforeSdk).toContain('read: {')
    expect(beforeSdk).toContain('tool_search: {')
    expect(beforeSdk).not.toContain('bash: {')

    const runtime = ctx.codeRuntime as FakeCodeRuntime
    runtime.behavior = async (request) => ({
      logs: [],
      value: await request.bindings[0]!.functions.tool_search!({ query: 'bash' }),
    })
    const result = await ctx.tools.execute({
      callId: CallId('code-search'),
      name: RUN_CODE_NAME,
      arguments: { code: 'return await tools.tool_search({ query: "bash" })', description: 'Unlock the bash tool' },
      agent,
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    const after = await ctx.systemPrompt.assemble({ scope: agent })
    const afterSdk = after.sections.find(section => section.name === 'tools:sdk')?.text
    expect(after.tools.map(tool => tool.name)).toEqual([RUN_CODE_NAME])
    expect(afterSdk).toContain('bash: {')
  })

  it('fails loudly when a configured baseline tool is absent', async () => {
    const ctx = await harness()
    await publishAgent(ctx, 'existing-invalid')

    await expect(ctx.plugin(ToolPalette, { alwaysVisible: ['missing'] }))
      .rejects.toThrow('unknown `alwaysVisible` tool "missing"')
    expect(ctx.tools.get(ToolPalette.TOOL_SEARCH_NAME)).toBeUndefined()
  })

  it('rejects duplicate or redundant baseline configuration', async () => {
    const ctx = await harness()

    await expect(ctx.plugin(ToolPalette, { alwaysVisible: ['read', 'read'] }))
      .rejects.toThrow('duplicate `alwaysVisible` tool "read"')
    await expect(ctx.plugin(ToolPalette, { alwaysVisible: [ToolPalette.TOOL_SEARCH_NAME] }))
      .rejects.toThrow('is always visible')
  })

  it('provides pure generic presentation metadata', async () => {
    const ctx = await harness()
    await ctx.plugin(ToolPalette, {})
    const definition = ctx.tools.get(ToolPalette.TOOL_SEARCH_NAME)

    expect(definition?.presentCall?.({ query: 'web', unlock: false })).toEqual({
      card: 'generic',
      title: 'Search tools: web',
      kind: 'search',
      rawInput: { unlock: false },
    })
    expect(definition?.presentResult?.({ query: 'web' }, {
      isError: true,
      error: { message: 'failed' },
      content: [{ type: 'text', text: 'Error: failed' }],
    })).toEqual({ card: 'generic', title: 'Tool search failed: web' })
  })
})
