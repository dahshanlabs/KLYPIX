import type { ModelAdapter, MessageComplete, ToolDefinition, ModelMessage } from '../modelAdapter';

// Phase 22.5: lazy-load the Anthropic SDK. The static `import Anthropic from
// '@anthropic-ai/sdk'` used to pull ~150KB into the main bundle even for chat-only
// sessions that never invoke agent mode. Dynamic import keeps it as its own
// Vite chunk that only downloads when stream() is first called.
export function createClaudeAdapter(apiKey: string, modelId: string): ModelAdapter {
  let clientPromise: Promise<any> | null = null;
  const getClient = () => {
    if (!clientPromise) {
      clientPromise = import('@anthropic-ai/sdk').then((mod) => {
        const Anthropic = mod.default;
        return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
      });
    }
    return clientPromise;
  };

  return {
    provider: 'claude',
    modelId,

    stream(opts) {
      let textCallback: ((delta: string) => void) | null = null;

      const streamPromise = (async () => {
        const client = await getClient();
        const stream = client.messages.stream({
          model: modelId,
          max_tokens: opts.maxTokens || 4096,
          system: opts.system,
          tools: opts.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })) as any,
          messages: opts.messages as any,
        });

        stream.on('text', (delta: string) => {
          if (textCallback) textCallback(delta);
        });

        const msg = await stream.finalMessage();

        // Anthropic reports cache hit/miss separately from base input_tokens:
        //   input_tokens                  = uncached input (full price)
        //   cache_creation_input_tokens   = tokens written to cache (~1.25x price; "miss")
        //   cache_read_input_tokens       = tokens read from cache (~0.1x price; "hit")
        // We surface the raw fields so the cost tracker + eval harness can compute
        // hit-rate; the totalled inputTokens captures everything processed.
        const baseInput = msg.usage?.input_tokens || 0;
        const cacheCreation = (msg.usage as any)?.cache_creation_input_tokens || 0;
        const cacheRead = (msg.usage as any)?.cache_read_input_tokens || 0;

        return {
          content: msg.content.map((block: any) => {
            if (block.type === 'text') return { type: 'text' as const, text: block.text };
            if (block.type === 'tool_use') return { type: 'tool_use' as const, id: block.id, name: block.name, input: block.input as Record<string, any> };
            return block;
          }),
          stopReason: msg.stop_reason || 'end_turn',
          usage: {
            inputTokens: baseInput + cacheCreation + cacheRead,
            outputTokens: msg.usage?.output_tokens || 0,
            cacheHitTokens: cacheRead || undefined,
            cacheMissTokens: cacheCreation || undefined,
          },
        } as MessageComplete;
      })();

      return {
        onText: (cb) => { textCallback = cb; },
        finalMessage: () => streamPromise,
      };
    },
  };
}
