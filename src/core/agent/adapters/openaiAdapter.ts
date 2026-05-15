import type { ModelAdapter, MessageComplete, ToolDefinition, ModelMessage } from '../modelAdapter';

/**
 * OpenAI-compatible adapter — works with OpenAI, Azure OpenAI, and any
 * provider that implements the OpenAI chat completions API (e.g., Together, Groq).
 */
export function createOpenAIAdapter(apiKey: string, modelId: string, baseUrl?: string): ModelAdapter {
  const endpoint = baseUrl || 'https://api.openai.com/v1';

  return {
    provider: 'openai',
    modelId,

    stream(opts) {
      let textCallback: ((delta: string) => void) | null = null;

      const streamPromise = (async () => {
        // Convert messages to OpenAI format
        const messages: any[] = [{ role: 'system', content: opts.system }];

        for (const msg of opts.messages) {
          if (typeof msg.content === 'string') {
            messages.push({ role: msg.role, content: msg.content });
          } else if (Array.isArray(msg.content)) {
            const parts: any[] = [];
            const toolResults: any[] = [];
            for (const c of msg.content) {
              if (c.type === 'text') parts.push({ type: 'text', text: c.text });
              else if (c.type === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${c.source?.media_type || 'image/jpeg'};base64,${c.source?.data}` } });
              else if (c.type === 'tool_use') {
                // Assistant tool_use → OpenAI tool_calls
                messages.push({
                  role: 'assistant',
                  content: parts.length > 0 ? parts.map((p: any) => p.text || '').join('') : null,
                  tool_calls: [{ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } }],
                });
                parts.length = 0;
              } else if (c.type === 'tool_result') {
                toolResults.push({ role: 'tool', tool_call_id: c.tool_use_id, content: typeof c.content === 'string' ? c.content : JSON.stringify(c.content) });
              }
            }
            if (parts.length > 0) messages.push({ role: msg.role, content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
            for (const tr of toolResults) messages.push(tr);
          }
        }

        // Convert tools to OpenAI function format
        const tools = opts.tools.map(t => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        }));

        const response = await fetch(`${endpoint}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: modelId,
            messages,
            tools: tools.length > 0 ? tools : undefined,
            max_tokens: opts.maxTokens || 4096,
            stream: true,
            ...(opts.forceToolUse && tools.length > 0 ? { tool_choice: 'required' } : {}),
          }),
        });

        if (!response.ok) {
          const err = await response.text();
          throw new Error(`OpenAI API error ${response.status}: ${err}`);
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        const toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
        let inputTokens = 0, outputTokens = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]');

          for (const line of lines) {
            try {
              const data = JSON.parse(line.slice(6));
              const delta = data.choices?.[0]?.delta;
              if (!delta) continue;

              if (delta.content) {
                fullText += delta.content;
                if (textCallback) textCallback(delta.content);
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

              if (data.usage) {
                inputTokens = data.usage.prompt_tokens || 0;
                outputTokens = data.usage.completion_tokens || 0;
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

        return {
          content,
          stopReason: toolCalls.size > 0 ? 'tool_use' : 'end_turn',
          usage: { inputTokens, outputTokens },
        } as MessageComplete;
      })();

      return {
        onText: (cb) => { textCallback = cb; },
        finalMessage: () => streamPromise,
      };
    },
  };
}
