import type { ModelAdapter, MessageComplete, ToolDefinition, ModelMessage } from '../modelAdapter';

/**
 * GLM (ZhipuAI / Z.ai) adapter — uses OpenAI-compatible API format.
 * Supports GLM-5, GLM-5V-Turbo (vision), GLM-4.x models.
 * API docs: https://z.ai/guides
 */
export function createGLMAdapter(apiKey: string, modelId: string, baseUrl?: string): ModelAdapter {
  const endpoint = baseUrl || 'https://api.z.ai/api/paas/v4';

  return {
    provider: 'glm',
    modelId,

    stream(opts) {
      let textCallback: ((delta: string) => void) | null = null;

      const streamPromise = (async () => {
        const messages: any[] = [{ role: 'system', content: opts.system }];

        for (const msg of opts.messages) {
          if (typeof msg.content === 'string') {
            messages.push({ role: msg.role, content: msg.content });
          } else if (Array.isArray(msg.content)) {
            // FIX 1 & 3: Use mixed content array (any[]) to support images
            const parts: any[] = [];
            const toolResults: any[] = [];
            let hasImage = false;

            for (const c of msg.content) {
              if (c.type === 'text') {
                parts.push({ type: 'text', text: c.text });
              } else if (c.type === 'image') {
                // FIX 1: Convert images to OpenAI-compatible vision format (not [Image attached])
                hasImage = true;
                parts.push({
                  type: 'image_url',
                  image_url: {
                    url: `data:${c.source?.media_type || 'image/jpeg'};base64,${c.source?.data || ''}`,
                  },
                });
              } else if (c.type === 'tool_use') {
                // Flush text parts before tool_use
                if (parts.length > 0) {
                  messages.push({
                    role: 'assistant',
                    content: hasImage ? parts : parts.map((p: any) => p.text || '').join('\n') || null,
                  });
                  parts.length = 0;
                  hasImage = false;
                }
                messages.push({
                  role: 'assistant',
                  content: null,
                  tool_calls: [{ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } }],
                });
              } else if (c.type === 'tool_result') {
                toolResults.push({
                  role: 'tool',
                  tool_call_id: c.tool_use_id,
                  content: typeof c.content === 'string' ? c.content : JSON.stringify(c.content),
                });
              }
            }

            // FIX 3: Send as content array for multimodal, string for text-only
            if (parts.length > 0) {
              messages.push({
                role: msg.role,
                content: hasImage ? parts : parts.map((p: any) => p.text || '').join('\n'),
              });
            }
            for (const tr of toolResults) messages.push(tr);
          }
        }

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
            // FIX 2: Send tool_choice to force tool calling when orchestrator requests it
            ...(opts.forceToolUse ? { tool_choice: 'required' } : {}),
          }),
        });

        if (!response.ok) {
          const err = await response.text();
          console.error('[GLM Adapter] Error:', response.status, err);
          throw new Error(`GLM API error ${response.status}: ${err}`);
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

              // FIX 4: Handle GLM thinking mode tokens gracefully
              if (delta.reasoning_content) {
                // Skip thinking tokens — don't add to fullText
                continue;
              }

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
