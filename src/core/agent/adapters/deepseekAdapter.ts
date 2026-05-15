import type { ModelAdapter, MessageComplete } from '../modelAdapter';

/**
 * DeepSeek adapter — talks to api.deepseek.com using their OpenAI-compatible
 * Chat Completions API. Surfaces prompt-cache hit/miss tokens in usage so we
 * can verify caching is firing on repeated calls (visible via the agent's
 * cost telemetry and DevTools).
 *
 * Supported model IDs:
 *  - deepseek-chat     (V4-Flash, fast/cheap)
 *  - deepseek-reasoner (V4-Pro, reasoning mode — emits hidden reasoning_content
 *    deltas which we drop; only final content is surfaced to the loop)
 */
export function createDeepseekAdapter(apiKey: string, modelId: string, baseUrl?: string): ModelAdapter {
  const endpoint = baseUrl || 'https://api.deepseek.com/v1';

  return {
    provider: 'deepseek',
    modelId,

    stream(opts) {
      let textCallback: ((delta: string) => void) | null = null;

      const streamPromise = (async () => {
        const messages: any[] = [{ role: 'system', content: opts.system }];

        // Anthropic-shape → OpenAI-shape conversion.
        // Assistant turns with N tool_use blocks must collapse into ONE assistant
        // message carrying a tool_calls[] array; DeepSeek 400s otherwise.
        for (const msg of opts.messages) {
          if (typeof msg.content === 'string') {
            messages.push({ role: msg.role, content: msg.content });
            continue;
          }
          if (!Array.isArray(msg.content)) continue;

          if (msg.role === 'assistant') {
            const textParts: string[] = [];
            const toolCalls: any[] = [];
            for (const c of msg.content) {
              if (c.type === 'text') textParts.push(c.text);
              else if (c.type === 'tool_use') {
                toolCalls.push({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: JSON.stringify(c.input) },
                });
              }
            }
            const text = textParts.join('').trim();
            const out: any = { role: 'assistant', content: text || null };
            if (toolCalls.length > 0) out.tool_calls = toolCalls;
            // V4-Pro thinking mode: echo reasoning_content from the prior turn or the API 400s.
            if ((msg as any).reasoningContent) {
              out.reasoning_content = (msg as any).reasoningContent;
            }
            messages.push(out);
          } else {
            // user role: tool_results become 'tool' messages (must precede any other
            // user content so they answer the previous assistant's tool_calls);
            // text/image collapse into a single user message.
            const parts: any[] = [];
            const toolResults: any[] = [];
            for (const c of msg.content) {
              if (c.type === 'text') parts.push({ type: 'text', text: c.text });
              else if (c.type === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${c.source?.media_type || 'image/jpeg'};base64,${c.source?.data}` } });
              else if (c.type === 'tool_result') {
                toolResults.push({
                  role: 'tool',
                  tool_call_id: c.tool_use_id,
                  content: typeof c.content === 'string' ? c.content : JSON.stringify(c.content),
                });
              }
            }
            for (const tr of toolResults) messages.push(tr);
            if (parts.length > 0) {
              messages.push({
                role: 'user',
                content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
              });
            }
          }
        }

        const tools = opts.tools.map(t => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        }));

        // V4-Pro reasoning model does not accept tool_choice='required'; keep config minimal.
        // Covers both V4-Pro IDs (new and legacy) so we don't accidentally force tool use on a reasoner.
        const isReasoner = modelId === 'deepseek-v4-pro' || modelId === 'deepseek-reasoner';

        const response = await fetch(`${endpoint}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: modelId,
            messages,
            tools: tools.length > 0 ? tools : undefined,
            max_tokens: opts.maxTokens || 4096,
            stream: true,
            stream_options: { include_usage: true },
            ...(opts.forceToolUse && tools.length > 0 && !isReasoner ? { tool_choice: 'required' } : {}),
          }),
        });

        if (!response.ok) {
          const err = await response.text();
          throw new Error(`DeepSeek API error ${response.status}: ${err}`);
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        let reasoningText = '';
        const toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
        let inputTokens = 0, outputTokens = 0;
        let cacheHitTokens: number | undefined;
        let cacheMissTokens: number | undefined;
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const raw of lines) {
            const line = raw.trim();
            if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;

            try {
              const data = JSON.parse(line.slice(6));
              const delta = data.choices?.[0]?.delta;

              if (delta) {
                if (delta.content) {
                  fullText += delta.content;
                  if (textCallback) textCallback(delta.content);
                }
                // V4-Pro emits reasoning_content (hidden chain-of-thought).
                // Don't surface to UI, but DO accumulate — the API requires it to be
                // passed back on subsequent turns or the next call 400s.
                if (typeof delta.reasoning_content === 'string') {
                  reasoningText += delta.reasoning_content;
                }

                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolCalls.has(idx)) {
                      toolCalls.set(idx, { id: tc.id || `call_${idx}`, name: tc.function?.name || '', args: '' });
                    }
                    const existing = toolCalls.get(idx)!;
                    if (tc.id) existing.id = tc.id;
                    if (tc.function?.name) existing.name = tc.function.name;
                    if (tc.function?.arguments) existing.args += tc.function.arguments;
                  }
                }
              }

              if (data.usage) {
                inputTokens = data.usage.prompt_tokens || 0;
                outputTokens = data.usage.completion_tokens || 0;
                if (typeof data.usage.prompt_cache_hit_tokens === 'number') {
                  cacheHitTokens = data.usage.prompt_cache_hit_tokens;
                }
                if (typeof data.usage.prompt_cache_miss_tokens === 'number') {
                  cacheMissTokens = data.usage.prompt_cache_miss_tokens;
                }
              }
            } catch {}
          }
        }

        const content: MessageComplete['content'] = [];
        if (fullText) content.push({ type: 'text', text: fullText });
        for (const [, tc] of toolCalls) {
          try {
            content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: JSON.parse(tc.args) });
          } catch {
            content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: {} });
          }
        }

        if (cacheHitTokens !== undefined || cacheMissTokens !== undefined) {
          const hit = cacheHitTokens ?? 0;
          const miss = cacheMissTokens ?? 0;
          const total = hit + miss;
          const pct = total > 0 ? Math.round((hit / total) * 100) : 0;
          console.log(`[DeepSeek] cache: ${hit}/${total} hit (${pct}%) · in=${inputTokens} out=${outputTokens}`);
        }

        return {
          content,
          stopReason: toolCalls.size > 0 ? 'tool_use' : 'end_turn',
          reasoningContent: reasoningText || undefined,
          usage: { inputTokens, outputTokens, cacheHitTokens, cacheMissTokens },
        } as MessageComplete;
      })();

      return {
        onText: (cb) => { textCallback = cb; },
        finalMessage: () => streamPromise,
      };
    },
  };
}
