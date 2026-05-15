import type { FlashToolSchema, FlashToolParam } from './types';

// ── Flash-optimized tool schema builder ──────────────────────────────────────
// Flash performs much better with explicit tool definitions.
// Rules: verb_noun names, one-sentence descriptions, examples for every param,
// enums where possible, no nested objects, return type described.

export function buildFlashToolSchema(def: FlashToolSchema): object {
  return {
    type: 'function',
    function: {
      name: def.name,
      description: [
        def.description,
        `USE WHEN: ${def.whenToUse}`,
        `DO NOT USE WHEN: ${def.whenNotToUse}`,
        `RETURNS: ${def.returnDescription}`,
        `EXAMPLE CALL: ${JSON.stringify(def.exampleCall)}`,
        `EXAMPLE RETURN: ${def.exampleReturn.substring(0, 200)}`,
      ].join('\n'),
      parameters: {
        type: 'object',
        required: def.params.filter(p => p.required).map(p => p.name),
        properties: Object.fromEntries(
          def.params.map(p => [p.name, {
            type: p.type,
            description: `${p.description} Example: ${p.example}`,
            ...(p.enum ? { enum: p.enum } : {}),
            ...(p.default !== undefined ? { default: p.default } : {}),
          }]),
        ),
      },
    },
  };
}

// ── Tool filtering by task category ──────────────────────────────────────────
// Flash performs significantly better with fewer tools (5-8 vs 20+).
// Classify the task first, then only send relevant tools.

const CORE_TOOLS = ['capture_screenshot', 'read_file', 'write_file', 'clipboard_read'];

const CATEGORY_TOOLS: Record<string, string[]> = {
  research: ['read_web_content', 'read_file', 'clipboard_read', 'capture_screenshot', 'read_active_file'],
  file_ops: ['read_file', 'write_file', 'edit_file', 'list_directory', 'file_move', 'file_delete'],
  data: ['read_file', 'read_active_file', 'write_file', 'generate_document', 'clipboard_read'],
  analysis: ['read_file', 'read_web_content', 'read_active_file', 'capture_screenshot', 'clipboard_read'],
  translation: ['read_file', 'write_file', 'clipboard_read', 'clipboard_write'],
  simple_qa: ['capture_screenshot', 'clipboard_read', 'read_web_content'],
  general: CORE_TOOLS,
};

export function selectToolsForTask(
  taskCategory: string,
  allToolNames: string[],
): string[] {
  const selectedNames = CATEGORY_TOOLS[taskCategory] || CORE_TOOLS;
  // Return intersection: only tools that actually exist
  return selectedNames.filter(name => allToolNames.includes(name));
}

// ── Convert existing KLYPIX tools to Flash-optimized format ──────────────────
// This wraps the existing ToolDefinition (from toolRegistry) into Flash format.

export function convertToFlashSchema(
  tool: { name: string; description: string; input_schema: Record<string, any> },
): FlashToolSchema {
  const params: FlashToolParam[] = [];
  const props = tool.input_schema.properties || {};
  const required = new Set(tool.input_schema.required || []);

  for (const [name, schema] of Object.entries(props) as [string, any][]) {
    params.push({
      name,
      type: schema.type || 'string',
      description: schema.description || name,
      example: schema.example || `<${name}>`,
      required: required.has(name),
      ...(schema.enum ? { enum: schema.enum } : {}),
      ...(schema.default !== undefined ? { default: schema.default } : {}),
    });
  }

  return {
    name: tool.name,
    description: tool.description,
    whenToUse: `When you need to ${tool.description.toLowerCase().replace(/\.$/, '')}`,
    whenNotToUse: 'When a simpler approach would work',
    params,
    returnDescription: 'JSON result object',
    exampleCall: Object.fromEntries(params.filter(p => p.required).map(p => [p.name, p.example])),
    exampleReturn: '{ "success": true }',
  };
}
