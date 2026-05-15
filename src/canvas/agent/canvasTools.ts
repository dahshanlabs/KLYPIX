import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';

// Gemini function declarations for the canvas agent. Covers the core subset
// from docs/CLAUDE-KLYPIX-CANVAS.md §9: read items, create text/card, connect,
// update, delete, add border, create toast. Containers + file/chart pinning
// come after containers land. Intentionally no tool for pen/line drawing —
// the agent reasons in items+connections, not freehand strokes.

export const CANVAS_TOOLS: FunctionDeclaration[] = [
    {
        name: 'canvas_get_items',
        description: 'List all items in the current scope. Returns an id and a short summary per item. Call this first before deciding what to create or modify.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {},
            required: [],
        },
    },
    {
        name: 'canvas_read_item',
        description: 'Return the full content of one item (text content, file metadata, image caption).',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                item_id: { type: SchemaType.STRING, description: 'The id of the item to read.' },
            },
            required: ['item_id'],
        },
    },
    {
        name: 'canvas_search',
        description: 'Full-text search across all canvas text items. Returns matching ids with context.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                query: { type: SchemaType.STRING, description: 'Search text.' },
            },
            required: ['query'],
        },
    },
    {
        name: 'canvas_create_text',
        description: 'Create a plain text note on the canvas at the given world coordinates.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                content: { type: SchemaType.STRING },
                x: { type: SchemaType.NUMBER, description: 'World x-coord (not screen). Use values relative to existing items.' },
                y: { type: SchemaType.NUMBER, description: 'World y-coord.' },
                heading: { type: SchemaType.BOOLEAN, description: 'Render as a heading (larger, bolder).' },
            },
            required: ['content', 'x', 'y'],
        },
    },
    {
        name: 'canvas_create_card',
        description: 'Create a bordered card with a short title and body. Use for summaries, comparisons, analyses — anything that should look like an agent-authored artifact.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                title: { type: SchemaType.STRING },
                body: { type: SchemaType.STRING },
                x: { type: SchemaType.NUMBER },
                y: { type: SchemaType.NUMBER },
            },
            required: ['title', 'body', 'x', 'y'],
        },
    },
    {
        name: 'canvas_connect_items',
        description: 'Draw a labeled arrow from one item to another to show a relationship.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                from_id: { type: SchemaType.STRING },
                to_id: { type: SchemaType.STRING },
                label: { type: SchemaType.STRING, description: 'Short label (optional).' },
            },
            required: ['from_id', 'to_id'],
        },
    },
    {
        name: 'canvas_update_item',
        description: 'Update the text content or position of an existing item.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                item_id: { type: SchemaType.STRING },
                content: { type: SchemaType.STRING, description: 'New text content (only valid for text items).' },
                x: { type: SchemaType.NUMBER },
                y: { type: SchemaType.NUMBER },
            },
            required: ['item_id'],
        },
    },
    {
        name: 'canvas_delete_item',
        description: 'Delete an item the user or agent previously created. Use sparingly — the user can always undo.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                item_id: { type: SchemaType.STRING },
            },
            required: ['item_id'],
        },
    },
    {
        name: 'canvas_add_border',
        description: 'Add or remove a visible border on a text item, turning it into a card visually.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                item_id: { type: SchemaType.STRING },
                border: { type: SchemaType.BOOLEAN, description: 'true = show border, false = hide.' },
            },
            required: ['item_id', 'border'],
        },
    },
    {
        name: 'canvas_create_toast',
        description: 'Show a short floating message to the user (auto-dismisses). Use for quick factual answers the user doesn\'t need to keep on the canvas.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                message: { type: SchemaType.STRING },
            },
            required: ['message'],
        },
    },
    {
        name: 'canvas_get_connections',
        description: 'List all connections (arrows) on the canvas with their source and target ids and any label.',
        parameters: { type: SchemaType.OBJECT, properties: {}, required: [] },
    },
    {
        name: 'canvas_read_file',
        description: 'Read the text content of a file item. Returns extracted text for PDFs, raw text for code/markdown/csv/json/txt. Returns metadata + error for binary or un-extractable formats.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                item_id: { type: SchemaType.STRING },
            },
            required: ['item_id'],
        },
    },
    {
        name: 'canvas_arrange_items',
        description: 'Auto-arrange given items into a layout.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                item_ids: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                layout: { type: SchemaType.STRING, description: "'grid' | 'horizontal' | 'vertical'" },
                origin_x: { type: SchemaType.NUMBER, description: 'World x for top-left of the arranged group.' },
                origin_y: { type: SchemaType.NUMBER },
                gap: { type: SchemaType.NUMBER, description: 'Pixels between items (default 24).' },
            },
            required: ['item_ids', 'layout', 'origin_x', 'origin_y'],
        },
    },
    {
        name: 'canvas_create_container',
        description: 'Create a container (titled frame) at the given world coords. Other items can be placed inside by calling canvas_update_item with parent_id. Use to group related artifacts visually.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                title: { type: SchemaType.STRING },
                x: { type: SchemaType.NUMBER },
                y: { type: SchemaType.NUMBER },
                w: { type: SchemaType.NUMBER, description: 'Width (min 200).' },
                h: { type: SchemaType.NUMBER, description: 'Height (min 120).' },
            },
            required: ['title', 'x', 'y', 'w', 'h'],
        },
    },
    {
        name: 'canvas_group_into_container',
        description: 'Wrap existing items in a new container. Computes a bounding rect around the given ids and creates a container around them, assigning parent.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                item_ids: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                title: { type: SchemaType.STRING },
            },
            required: ['item_ids', 'title'],
        },
    },
    {
        name: 'canvas_pin_chart',
        description: 'Render a bar or line chart from provided data and pin it to the canvas as an image. Use when the user asks for a chart.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                chart_type: { type: SchemaType.STRING, description: "'bar' | 'line' | 'pie'" },
                title: { type: SchemaType.STRING },
                labels: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                values: { type: SchemaType.ARRAY, items: { type: SchemaType.NUMBER } },
                x: { type: SchemaType.NUMBER },
                y: { type: SchemaType.NUMBER },
            },
            required: ['chart_type', 'labels', 'values', 'x', 'y'],
        },
    },
    {
        name: 'canvas_set_tags',
        description: "Replace an item's tag list. Tags are short lowercase labels used for filtering and smart collections.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                item_id: { type: SchemaType.STRING },
                tags: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
            },
            required: ['item_id', 'tags'],
        },
    },
    {
        name: 'canvas_set_status',
        description: "Set an item's status badge. One of: none, todo, in_progress, in_review, done, blocked, waiting.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                item_id: { type: SchemaType.STRING },
                status: { type: SchemaType.STRING },
            },
            required: ['item_id', 'status'],
        },
    },
    {
        name: 'canvas_set_relationship',
        description: 'Set the typed meaning of an existing connection arrow (leads_to, depends_on, relates_to, conflicts_with, supports, questions, costs, blocks).',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                connection_id: { type: SchemaType.STRING },
                relationship: { type: SchemaType.STRING },
            },
            required: ['connection_id', 'relationship'],
        },
    },
    {
        name: 'canvas_run_code',
        description: 'Execute a short snippet of code in the WSL2 sandbox and pin the output as a text card on the canvas. Use for data analysis, quick scripts, and file generation. Any files written under data/ are accessible via canvas_pin_file / canvas_pin_image using the returned "sandbox_cwd" prefix.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                language: { type: SchemaType.STRING, description: "'python' | 'bash' | 'node'. Defaults to python." },
                code: { type: SchemaType.STRING, description: 'Source code to run. Kept short (no multi-file projects).' },
                x: { type: SchemaType.NUMBER, description: 'World x-coord for the output card.' },
                y: { type: SchemaType.NUMBER, description: 'World y-coord for the output card.' },
                title: { type: SchemaType.STRING, description: 'Optional short heading for the card.' },
            },
            required: ['code', 'x', 'y'],
        },
    },
    {
        name: 'canvas_pin_file',
        description: 'Pin a file from the sandbox workspace onto the canvas as a FileItem (with rich preview for PDF/XLSX/DOCX). Use this after canvas_run_code produces a file. Path is relative to the sandbox workspace root (e.g. "data/report.pdf").',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                sandbox_path: { type: SchemaType.STRING, description: 'Path inside the sandbox workspace, e.g. "data/output.pdf".' },
                x: { type: SchemaType.NUMBER },
                y: { type: SchemaType.NUMBER },
            },
            required: ['sandbox_path', 'x', 'y'],
        },
    },
    {
        name: 'canvas_pin_image',
        description: 'Pin an image from the sandbox workspace onto the canvas as an inline ImageItem. Use for charts and visuals generated by canvas_run_code.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                sandbox_path: { type: SchemaType.STRING, description: 'Path inside the sandbox workspace to an image file (png/jpg/webp/gif).' },
                x: { type: SchemaType.NUMBER },
                y: { type: SchemaType.NUMBER },
            },
            required: ['sandbox_path', 'x', 'y'],
        },
    },
    {
        name: 'canvas_create_approval',
        description: 'Pin an approval card on the canvas and WAIT for the user to click one of the given options. Use this before any action that might destroy data, cost money, or is otherwise irreversible. Returns the picked option as `decision`. Card stays on the canvas after the user decides.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                question: { type: SchemaType.STRING, description: 'Short one-line question the user must answer.' },
                details: { type: SchemaType.STRING, description: 'Optional longer explanation of the consequences.' },
                options: {
                    type: SchemaType.ARRAY,
                    description: "Option labels (2-4). Defaults to ['Approve', 'Deny']. Use plain words like 'Approve'/'Deny'/'Yes'/'No' so the UI picks the right tone.",
                    items: { type: SchemaType.STRING },
                },
                x: { type: SchemaType.NUMBER },
                y: { type: SchemaType.NUMBER },
                timeout_seconds: { type: SchemaType.NUMBER, description: 'Max seconds to wait for a click before giving up. Defaults to 180.' },
            },
            required: ['question', 'x', 'y'],
        },
    },
    {
        name: 'canvas_organize',
        description: 'Cluster canvas items by a criterion, wrap each cluster in a titled container, and lay containers out in a grid. Use for "organize these by type / by tag / by status / by date / by connection". Preserves existing items and connections; just moves them and adds containers.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                by: { type: SchemaType.STRING, description: "Criterion: 'type' | 'tag' | 'status' | 'date' | 'connection'." },
                item_ids: {
                    type: SchemaType.ARRAY,
                    description: 'Subset of items to organize. Omit to organize all items currently in scope.',
                    items: { type: SchemaType.STRING },
                },
                origin_x: { type: SchemaType.NUMBER, description: 'World x for the top-left of the arranged layout.' },
                origin_y: { type: SchemaType.NUMBER },
            },
            required: ['by', 'origin_x', 'origin_y'],
        },
    },
    {
        name: 'canvas_find_issues',
        description: 'Surface structural issues on the canvas without changing anything: orphaned items (no connections, no container), untagged items, near-duplicate text, and near-aligned but not snapped items. Returns a report the agent can summarize to the user (/cleanup, /find orphans, /find untagged workflows).',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                kinds: {
                    type: SchemaType.ARRAY,
                    description: "Subset of ['orphans', 'untagged', 'duplicates', 'near_aligned']. Defaults to all four.",
                    items: { type: SchemaType.STRING },
                },
                item_ids: {
                    type: SchemaType.ARRAY,
                    description: 'Optional scope; defaults to every item.',
                    items: { type: SchemaType.STRING },
                },
            },
            required: [],
        },
    },
    {
        name: 'canvas_compile',
        description: 'Compile selected canvas items into a single deliverable file (PDF, DOCX, PPTX, or ZIP). Items are collected in spatial order (top-to-bottom, left-to-right) and converted to the requested format. The result is pinned on the canvas as a FileItem. Use when the user says "compile these into a report / slide deck / archive / doc".',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                format: { type: SchemaType.STRING, description: "'pdf' | 'docx' | 'pptx' | 'zip'." },
                title: { type: SchemaType.STRING, description: 'Document title, becomes the file name stem.' },
                item_ids: {
                    type: SchemaType.ARRAY,
                    description: 'Item ids to include. Omit to include all items currently in scope.',
                    items: { type: SchemaType.STRING },
                },
                x: { type: SchemaType.NUMBER, description: 'World x-coord for the resulting FileItem card.' },
                y: { type: SchemaType.NUMBER, description: 'World y-coord for the resulting FileItem card.' },
            },
            required: ['format', 'title', 'x', 'y'],
        },
    },
    {
        name: 'canvas_done',
        description: 'Call this when you are finished. Pass a short final message for the user. After calling, do not call any more tools.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                message: { type: SchemaType.STRING, description: 'Short final message (optional).' },
            },
            required: [],
        },
    },
];
