/** Progressive tool discovery and per-agent unlocking for DeepSeek Harness. */
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
export const name = 'tool-palette';
export const inject = ['agents', 'tools'];
/** The discovery tool remains visible inside every palette. */
export const TOOL_SEARCH_NAME = 'tool_search';
export const Config = z.object({
    alwaysVisible: z.array(z.string()).default([]),
    maxResults: z.number().step(1).min(1).default(8),
    maxQueryChars: z.number().step(1).min(1).default(400),
    descriptionMaxChars: z.number().step(1).min(1).default(240),
});
/** Validate direct callers in addition to Loader schema validation. */
function resolveConfig(config) {
    const alwaysVisible = config.alwaysVisible ?? [];
    const maxResults = config.maxResults ?? 8;
    const maxQueryChars = config.maxQueryChars ?? 400;
    const descriptionMaxChars = config.descriptionMaxChars ?? 240;
    const seen = new Set();
    for (const toolName of alwaysVisible) {
        if (toolName.trim().length === 0 || toolName !== toolName.trim()) {
            throw new Error('tool-palette: every `alwaysVisible` entry must be a non-blank exact tool name without surrounding whitespace');
        }
        if (toolName === TOOL_SEARCH_NAME) {
            throw new Error(`tool-palette: ${TOOL_SEARCH_NAME} is always visible and must not appear in \`alwaysVisible\``);
        }
        if (seen.has(toolName)) {
            throw new Error(`tool-palette: duplicate \`alwaysVisible\` tool ${JSON.stringify(toolName)}`);
        }
        seen.add(toolName);
    }
    for (const [field, value] of Object.entries({ maxResults, maxQueryChars, descriptionMaxChars })) {
        if (!Number.isInteger(value) || value < 1) {
            throw new Error(`tool-palette: \`${field}\` must be a positive integer`);
        }
    }
    return { alwaysVisible: [...alwaysVisible], maxResults, maxQueryChars, descriptionMaxChars };
}
/** Normalize search text without changing the tool names returned to callers. */
function normalized(value) {
    return value.toLocaleLowerCase('en-US').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}
/** Score one schema by exact name, name fragments, prose, and parameter text. */
function scoreTool(schema, query) {
    const name = normalized(schema.name);
    const description = normalized(schema.description);
    const parameters = normalized(JSON.stringify(schema.parameters));
    const tokens = query.split(' ').filter(Boolean);
    let score = 0;
    if (name === query)
        score += 1_000;
    else if (name.startsWith(query))
        score += 700;
    else if (name.includes(query))
        score += 500;
    if (description.includes(query))
        score += 300;
    if (parameters.includes(query))
        score += 120;
    for (const token of tokens) {
        if (name.split(' ').includes(token))
            score += 160;
        else if (name.includes(token))
            score += 100;
        if (description.includes(token))
            score += 35;
        if (parameters.includes(token))
            score += 15;
    }
    return score;
}
/** Return a Unicode-safe character cap with an explicit omission count. */
function truncate(value, maxChars) {
    const chars = [...value];
    if (chars.length <= maxChars)
        return value;
    return `${chars.slice(0, maxChars).join('')}… (+${chars.length - maxChars} chars)`;
}
/** Current global schemas excluding the discovery tool itself. */
function searchableCatalog(ctx) {
    return ctx.tools.schemas()
        .filter(schema => schema.name !== TOOL_SEARCH_NAME);
}
/** Ensure deployment-owned baseline names resolve before an Agent is published. */
function validateBaseline(ctx, config) {
    const known = new Set(ctx.tools.schemas().map(schema => schema.name));
    const missing = config.alwaysVisible.filter(toolName => !known.has(toolName));
    if (missing.length > 0) {
        throw new Error(`tool-palette: unknown \`alwaysVisible\` tool${missing.length === 1 ? '' : 's'} ${missing.map(value => JSON.stringify(value)).join(', ')}; known global tools: ${[...known].sort().join(', ') || '(none)'}`);
    }
}
/** Replace one state restriction while keeping vanished dynamic tools harmless. */
function refreshRestriction(ctx, state, config) {
    const known = new Set(ctx.tools.schemas().map(schema => schema.name));
    const allow = [
        TOOL_SEARCH_NAME,
        ...config.alwaysVisible.filter(toolName => known.has(toolName)),
        ...[...state.unlocked].filter(toolName => known.has(toolName)),
    ];
    const next = state.agent.ctx.tools.restrict({ allow: [...new Set(allow)] });
    const previous = state.liftRestriction;
    state.liftRestriction = next;
    previous?.();
}
/** State chain whose intersecting restrictions must admit a child unlock. */
function lineage(state) {
    const result = [];
    const seen = new Set();
    let current = state;
    while (current !== undefined && !seen.has(current)) {
        seen.add(current);
        if (!current.closed)
            result.unshift(current);
        current = current.owner;
    }
    return result;
}
/** Install a palette into one live Agent and bind it to both plugin and Agent teardown. */
function installAgent(ctx, agent, config, states, liveStates) {
    if (states.has(agent))
        return;
    validateBaseline(ctx, config);
    const runtimeOwner = ctx.agents.list().find(candidate => candidate !== agent && ctx.agents.isOwnedBy(agent.id, candidate));
    const state = {
        agent,
        owner: runtimeOwner === undefined ? undefined : states.get(runtimeOwner),
        unlocked: new Set(),
        closed: false,
    };
    states.set(agent, state);
    liveStates.add(state);
    try {
        state.dispose = agent.ctx.effect(() => {
            refreshRestriction(ctx, state, config);
            return () => {
                if (state.closed)
                    return;
                state.closed = true;
                state.liftRestriction?.();
                state.liftRestriction = undefined;
                states.delete(agent);
                liveStates.delete(state);
            };
        }, 'tool-palette.agent()');
    }
    catch (error) {
        states.delete(agent);
        liveStates.delete(state);
        throw error;
    }
}
/** Install progressive discovery and its per-Agent restriction lifecycle. */
export function apply(ctx, config) {
    const resolved = resolveConfig(config);
    const states = new WeakMap();
    const liveStates = new Set();
    ctx.tools.register(defineTool({
        name: TOOL_SEARCH_NAME,
        description: 'Search the complete installed DeepSeek Harness tool catalog. By default, the best matches are unlocked for this Agent and its required ancestor scopes, so they appear in the next model step. Use unlock=false to preview without changing visibility.',
        parameters: {
            query: {
                type: 'string',
                required: true,
                description: 'Capability, operation, tool name, or parameter to find, such as "write file", "web search", "bash", or "subagent".',
            },
            unlock: {
                type: 'boolean',
                description: 'Unlock returned matches for later calls. Defaults to true; false performs a read-only catalog search.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    query: { type: 'string', required: true },
                    matches: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                name: { type: 'string', required: true },
                                description: { type: 'string', required: true },
                                enabled: { type: 'boolean', required: true },
                                newlyUnlocked: { type: 'boolean', required: true },
                            },
                        },
                    },
                    newlyUnlocked: { type: 'array', required: true, items: { type: 'string' } },
                    visibleGlobalCount: { type: 'integer', required: true },
                    hiddenGlobalCount: { type: 'integer', required: true },
                },
            },
            render: (_args, value) => {
                if (value.matches.length === 0) {
                    return [{ type: 'text', text: `No installed tools matched ${JSON.stringify(value.query)}. ${value.hiddenGlobalCount} global tools remain hidden.` }];
                }
                const lines = value.matches.map(match => `- ${match.name}${match.newlyUnlocked ? ' [unlocked]' : match.enabled ? ' [visible]' : ''}: ${match.description}`);
                return [{
                        type: 'text',
                        text: [
                            `Tool matches for ${JSON.stringify(value.query)}:`,
                            ...lines,
                            `${value.visibleGlobalCount} global tools visible; ${value.hiddenGlobalCount} remain hidden.`,
                        ].join('\n'),
                    }];
            },
        },
        execute(args, exec) {
            if (exec.agent === undefined)
                throw new Error('tool_search requires a live Agent');
            const state = states.get(exec.agent);
            if (state === undefined || state.closed)
                throw new Error('tool_search is unavailable outside a managed live Agent');
            const query = args.query.trim();
            if (query.length === 0)
                throw new Error('query must not be blank');
            if ([...query].length > resolved.maxQueryChars) {
                throw new Error(`query exceeds the configured ${resolved.maxQueryChars}-character limit`);
            }
            const normalizedQuery = normalized(query);
            if (!/[\p{L}\p{N}]/u.test(normalizedQuery)) {
                throw new Error('query must contain at least one letter or number');
            }
            const catalog = searchableCatalog(ctx);
            const matches = catalog
                .map(schema => ({ schema, score: scoreTool(schema, normalizedQuery) }))
                .filter(match => match.score > 0)
                .sort((left, right) => right.score - left.score || left.schema.name.localeCompare(right.schema.name))
                .slice(0, resolved.maxResults);
            const visibleBefore = new Set(ctx.tools.schemas(exec.agent).map(schema => schema.name));
            const selectedHidden = matches
                .map(match => match.schema.name)
                .filter(toolName => !visibleBefore.has(toolName));
            const shouldUnlock = args.unlock ?? true;
            if (shouldUnlock && selectedHidden.length > 0) {
                for (const member of lineage(state)) {
                    for (const toolName of selectedHidden)
                        member.unlocked.add(toolName);
                    refreshRestriction(ctx, member, resolved);
                }
            }
            const visibleAfter = new Set(ctx.tools.schemas(exec.agent).map(schema => schema.name));
            const catalogNames = new Set(catalog.map(schema => schema.name));
            const visibleGlobalCount = [...catalogNames].filter(toolName => visibleAfter.has(toolName)).length;
            const newlyUnlocked = shouldUnlock
                ? selectedHidden.filter(toolName => visibleAfter.has(toolName))
                : [];
            return Promise.resolve({
                query,
                matches: matches.map(({ schema }) => ({
                    name: schema.name,
                    description: truncate(schema.description, resolved.descriptionMaxChars),
                    enabled: visibleAfter.has(schema.name),
                    newlyUnlocked: newlyUnlocked.includes(schema.name),
                })),
                newlyUnlocked,
                visibleGlobalCount,
                hiddenGlobalCount: catalogNames.size - visibleGlobalCount,
            });
        },
        presentCall(args) {
            return {
                card: 'generic',
                title: `Search tools: ${args.query}`,
                kind: 'search',
                rawInput: { unlock: args.unlock ?? true },
            };
        },
        presentResult(args, result) {
            return {
                card: 'generic',
                title: result.isError ? `Tool search failed: ${args.query}` : `Tool search: ${args.query}`,
            };
        },
    }));
    ctx.effect(() => {
        let stopping = false;
        for (const agent of ctx.agents.list())
            installAgent(ctx, agent, resolved, states, liveStates);
        const stopCreated = ctx.on('agent/created', ({ agent }) => {
            if (!stopping)
                installAgent(ctx, agent, resolved, states, liveStates);
        });
        return () => {
            stopping = true;
            stopCreated();
            for (const state of [...liveStates])
                state.dispose?.();
        };
    }, 'tool-palette.lifecycle()');
}
