import { GoogleGenerativeAI, type FunctionDeclaration } from '@google/generative-ai';
import type { ModelAdapter, MessageComplete, ToolDefinition, ModelMessage } from '../modelAdapter';

export function createGeminiAdapter(apiKey: string, modelId: string): ModelAdapter {
  const genAI = new GoogleGenerativeAI(apiKey);

  return {
    provider: 'gemini',
    modelId,

    stream(opts) {
      let textCallback: ((delta: string) => void) | null = null;

      const streamPromise = (async () => {
        // Track tool_use names for functionResponse mapping
        const toolUseNames = new Map<string, string>();
        for (const msg of opts.messages) {
          if (Array.isArray(msg.content)) {
            for (const c of msg.content) {
              if (c.type === 'tool_use') toolUseNames.set(c.id, c.name);
            }
          }
        }

        const model = genAI.getGenerativeModel({
          model: modelId,
          systemInstruction: opts.system,
          tools: [{
            functionDeclarations: opts.tools.map(t => ({
              name: t.name,
              description: t.description,
              parameters: t.input_schema,
            } as FunctionDeclaration)),
          }],
          ...(opts.forceToolUse ? {
            toolConfig: { functionCallingConfig: { mode: 'ANY' as any } },
          } : {}),
        });

        // Build full contents array (not using chat API — gives us full control over roles)
        const contents: Array<{ role: 'user' | 'model'; parts: any[] }> = [];

        for (const msg of opts.messages) {
          const role = msg.role === 'assistant' ? 'model' as const : 'user' as const;

          if (typeof msg.content === 'string') {
            contents.push({ role, parts: [{ text: msg.content }] });
            continue;
          }

          if (!Array.isArray(msg.content)) {
            contents.push({ role, parts: [{ text: JSON.stringify(msg.content) }] });
            continue;
          }

          // Separate content types — they may need different messages
          const textParts: any[] = [];
          const functionCalls: any[] = [];
          const functionResponses: any[] = [];

          for (const c of msg.content) {
            if (c.type === 'text') {
              textParts.push({ text: c.text });
            } else if (c.type === 'image') {
              textParts.push({
                inlineData: {
                  mimeType: c.source?.media_type || 'image/jpeg',
                  data: c.source?.data || '',
                },
              });
            } else if (c.type === 'tool_use') {
              functionCalls.push({
                functionCall: { name: c.name, args: c.input || {} },
              });
            } else if (c.type === 'tool_result') {
              const toolName = toolUseNames.get(c.tool_use_id) || 'unknown_tool';
              const resultContent = typeof c.content === 'string'
                ? c.content
                : Array.isArray(c.content)
                  ? JSON.stringify(c.content)
                  : JSON.stringify(c.content);
              functionResponses.push({
                functionResponse: {
                  name: toolName,
                  response: { result: resultContent },
                },
              });
            }
          }

          // Model messages: text + functionCalls together (Gemini expects this)
          if (role === 'model') {
            const parts = [...textParts, ...functionCalls];
            if (parts.length > 0) contents.push({ role: 'model', parts });
          } else {
            // User messages: functionResponses MUST be separate from text/images
            if (functionResponses.length > 0) {
              contents.push({ role: 'user', parts: functionResponses });
            }
            if (textParts.length > 0) {
              contents.push({ role: 'user', parts: textParts });
            }
          }
        }

        // Merge consecutive same-role messages (Gemini requires alternating user/model)
        const merged: typeof contents = [];
        for (const entry of contents) {
          const prev = merged[merged.length - 1];
          if (prev && prev.role === entry.role) {
            prev.parts.push(...entry.parts);
          } else {
            merged.push({ role: entry.role, parts: [...entry.parts] });
          }
        }

        // Use generateContentStream directly (not chat API) for full control
        const result = await model.generateContentStream({ contents: merged });

        let fullText = '';
        for await (const chunk of result.stream) {
          // chunk.text() THROWS when the chunk contains only functionCall parts.
          // Guard by reading parts directly and extracting text safely.
          try {
            const parts = chunk.candidates?.[0]?.content?.parts;
            if (parts) {
              for (const part of parts) {
                if (typeof (part as any).text === 'string') {
                  const partText = (part as any).text;
                  if (partText && textCallback) textCallback(partText);
                  fullText += partText;
                }
                // functionCall parts are ignored in the stream — collected via response.functionCalls() after
              }
            }
          } catch (chunkErr) {
            // Don't let a single bad chunk kill the stream
            console.warn('[Gemini] Chunk parse issue (ignored):', chunkErr);
          }
        }

        const response = await result.response;
        const content: MessageComplete['content'] = [];

        const calls = response.functionCalls();
        if (calls && calls.length > 0) {
          if (fullText) content.push({ type: 'text', text: fullText });
          for (const call of calls) {
            content.push({
              type: 'tool_use',
              id: `gemini_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              name: call.name,
              input: call.args as Record<string, any>,
            });
          }
        } else {
          content.push({ type: 'text', text: fullText });
        }

        const usage = response.usageMetadata;
        return {
          content,
          stopReason: calls && calls.length > 0 ? 'tool_use' : 'end_turn',
          usage: {
            inputTokens: usage?.promptTokenCount || 0,
            outputTokens: usage?.candidatesTokenCount || 0,
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
