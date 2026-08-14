import { Plugin } from 'siyuan';
import { settingdata } from '@/index';
import { getTldrawAgentTools } from '../tools';
import { isTldrawAgentActionEnabled } from '../tools/settings';
import { stringifyError, type AgentToolDefinition, type AgentToolResult } from '../tools/shared';
import { beginAgentActivityForArgs } from './activity';
import { getTldrawAgentActionMeta } from '../tools/metadata';

type AgentCapabilityEffects = {
    localRead?: boolean;
    localWrite?: boolean;
    dataEgress?: boolean;
    externalCost?: boolean;
};

type AddAgentCapability = (options: {
    name: string;
    title?: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    effects?: AgentCapabilityEffects;
    actionEffects?: Record<string, AgentCapabilityEffects>;
    handler: (args: Record<string, unknown>, app: unknown) => AgentToolResult;
}) => string;

const registeredActionNames = new Set<string>();

/**
 * Registers the tldraw tool layer with SiYuan's Agent API.
 * SiYuan 1.2.4 exposes tools through addAgentCapability.
 */
export function registerTldrawAgentActions(plugin: Plugin) {
    if (settingdata['tldraw-agent-actions-enable'] !== true) {
        return;
    }
    const addAgentCapability = plugin.addAgentCapability as AddAgentCapability | undefined;
    if (typeof addAgentCapability !== 'function') {
        console.info('SiYuan addAgentCapability API is unavailable; skip tldraw agent capabilities.');
        return;
    }

    for (const tool of getTldrawAgentTools(plugin).filter((tool) => isTldrawAgentActionEnabled(tool.name))) {
        if (registeredActionNames.has(tool.name)) {
            continue;
        }
        const metadata = getTldrawAgentActionMeta(tool.name);
        addAgentCapability.call(plugin, {
            name: tool.name,
            title: tool.title || metadata?.title || tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema || DEFAULT_AGENT_INPUT_SCHEMA,
            effects: getCapabilityEffects(metadata?.risk),
            handler: createSiyuanAgentHandler(tool),
        });
        registeredActionNames.add(tool.name);
    }
}

const DEFAULT_AGENT_INPUT_SCHEMA: Record<string, unknown> = {
    type: 'object',
    properties: {
        action: {
            type: 'string',
            description: 'Frontend action wrapper field. Leave unset when calling the capability directly.',
        },
        id: {
            type: 'string',
            description: 'Optional whiteboard or target ID. Individual capabilities may accept more direct named arguments.',
        },
        query: {
            type: 'string',
            description: 'Optional query or JSON payload accepted by the individual capability.',
        },
    },
    additionalProperties: true,
};

function getCapabilityEffects(risk?: 'read' | 'write' | 'danger'): AgentCapabilityEffects {
    if (risk === 'read') return { localRead: true };
    if (risk === 'write' || risk === 'danger') return { localRead: true, localWrite: true };
    return { localRead: true };
}

/**
 * Re-runs registration after settings change.
 * Already registered actions stay guarded by runtime enable checks.
 */
export function syncTldrawAgentActions(plugin: Plugin) {
    registerTldrawAgentActions(plugin);
}

/**
 * Wraps a tool handler with the small bits needed by the SiYuan Agent bridge:
 * setting checks, frontend arg cleanup, logs, and the activity indicator.
 */
function createSiyuanAgentHandler(tool: AgentToolDefinition) {
    return async (args: Record<string, unknown>, app: unknown) => {
        if (!isTldrawAgentActionEnabled(tool.name)) {
            return { error: `STtools tldraw agent action ${tool.name} is disabled in plugin settings.` };
        }
        const cleanedArgs = stripFrontendActionArgs(args);
        const callId = createAgentToolCallId(tool.name);
        const startedAt = Date.now();
        console.log('[tldraw agent action] call', {
            callId,
            name: tool.name,
            args: cleanedArgs,
            rawArgs: args,
        });
        const endAgentActivity = beginAgentActivityForArgs(cleanedArgs);
        try {
            const result = await tool.handler(cleanedArgs, app);
            console.log('[tldraw agent action] response', {
                callId,
                name: tool.name,
                durationMs: Date.now() - startedAt,
                status: result.error ? 'error' : 'ok',
                result: summarizeAgentToolResult(result),
            });
            return result;
        } catch (error) {
            console.log('[tldraw agent action] error', {
                callId,
                name: tool.name,
                durationMs: Date.now() - startedAt,
                error,
            });
            // addAgentCapability expects failures to be returned in its result
            // object. Throwing makes SiYuan treat the whole tool invocation as a
            // transport failure and hides the actionable message from the Agent.
            return { error: stringifyError(error) };
        } finally {
            endAgentActivity();
        }
    };
}

/**
 * Removes the frontend-only wrapper key that SiYuan may pass alongside tool args.
 * The tool layer should receive only semantic arguments.
 */
function stripFrontendActionArgs(args: Record<string, unknown>): Record<string, unknown> {
    if (!args || typeof args !== 'object') return {};
    const cleaned = { ...args };
    delete cleaned.action;
    return cleaned;
}

function createAgentToolCallId(name: string): string {
    return `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function summarizeAgentToolResult(result: Awaited<AgentToolResult>) {
    if (result.error) return { error: result.error };
    if (!result.result) return { empty: true };

    try {
        const parsed = JSON.parse(result.result) as Record<string, unknown>;
        const keys = Object.keys(parsed);
        return {
            keys,
            ok: parsed.ok,
            whiteboardId: parsed.whiteboardId,
            errorCount: Array.isArray(parsed.errors) ? parsed.errors.length : 0,
        };
    } catch {
        return {
            resultLength: result.result.length,
        };
    }
}
