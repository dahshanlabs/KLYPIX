import { TOOL_REGISTRY } from './toolRegistry';
import { shellGuard } from './shellGuard';
import { isMCPTool, executeMCPTool } from './mcpBridge';

const electron = (window as any).electron;

/**
 * Executes a tool by name and input. Routes to IPC handlers.
 * Returns a string result (JSON or text) for Claude.
 */
export async function executeTool(
  name: string,
  input: Record<string, any>,
): Promise<string> {
  // Route MCP tools through the MCP bridge (prefixed with "servername__")
  if (isMCPTool(name)) {
    return executeMCPTool(name, input);
  }

  // Route sandbox tools through the sandbox IPC bridge
  if (name.startsWith('sandbox_')) {
    return executeSandboxTool(name, input);
  }

  const toolDef = TOOL_REGISTRY[name];
  if (!toolDef) throw new Error(`Unknown tool: ${name}`);
  if (!electron) throw new Error('Electron API not available');

  try {
    switch (name) {
      // -- Screen Layer --
      case 'capture_screenshot': {
        const img = await electron.captureScreen();
        return JSON.stringify({ image: img, type: 'screenshot' });
      }
      case 'get_active_window': {
        return JSON.stringify(await electron.getActiveWindowContext());
      }
      case 'read_active_file': {
        return JSON.stringify(await electron.readActiveFile());
      }
      case 'get_all_open_files': {
        return JSON.stringify(await electron.getAllOpenFiles());
      }
      case 'read_file_by_title': {
        return JSON.stringify(await electron.readFileByTitle(input.title));
      }

      // -- File System Layer (new IPC handlers) --
      case 'read_file': {
        return JSON.stringify(await electron.agent.readFile({
          filePath: input.file_path, maxChars: input.max_chars,
        }));
      }
      case 'write_file': {
        return JSON.stringify(await electron.agent.writeFile({
          filePath: input.file_path, content: input.content,
        }));
      }
      case 'edit_file': {
        return JSON.stringify(await electron.agent.editFile({
          filePath: input.file_path, oldText: input.old_text, newText: input.new_text,
        }));
      }
      case 'list_directory': {
        return JSON.stringify(await electron.agent.listDir({ dirPath: input.dir_path }));
      }

      // -- File actions via existing executeAction --
      case 'file_move': {
        return JSON.stringify(await electron.executeAction({
          type: 'file_move',
          parameters: { sourcePath: input.source_path, destinationPath: input.dest_path },
        }));
      }
      case 'file_delete': {
        return JSON.stringify(await electron.executeAction({
          type: 'file_delete',
          parameters: { sourcePath: input.file_path },
        }));
      }

      // -- Terminal Layer --
      case 'run_shell': {
        const guardResult = shellGuard.guard(input.command);
        if (!guardResult.allowed) {
          return JSON.stringify({ success: false, error: guardResult.reason, blocked: true });
        }
        return JSON.stringify(await electron.agent.runShell({
          command: input.command, timeout: input.timeout,
        }));
      }

      // -- Browser Layer via existing executeAction --
      case 'browser_navigate': {
        return JSON.stringify(await electron.executeAction({
          type: 'browser_navigate', parameters: { url: input.url },
        }));
      }
      case 'browser_click': {
        return JSON.stringify(await electron.executeAction({
          type: 'browser_click',
          parameters: { selector: input.selector, targetDescription: input.target_description },
        }));
      }
      case 'browser_fill': {
        return JSON.stringify(await electron.executeAction({
          type: 'browser_fill',
          parameters: { selector: input.selector, value: input.value, targetDescription: input.target_description },
        }));
      }
      case 'read_web_content': {
        return JSON.stringify(await electron.readWebContent({ url: input.url, title: input.title || '' }));
      }

      // -- System Layer via existing executeAction --
      case 'system_open': {
        return JSON.stringify(await electron.executeAction({
          type: 'system_open', parameters: { appName: input.target },
        }));
      }
      case 'system_type': {
        return JSON.stringify(await electron.executeAction({
          type: 'system_type', parameters: { text: input.text },
        }));
      }

      // -- Clipboard --
      case 'clipboard_read': {
        return JSON.stringify({ text: await electron.readClipboard() });
      }
      case 'clipboard_write': {
        return JSON.stringify(await electron.executeAction({
          type: 'clipboard_copy', parameters: { text: input.text },
        }));
      }

      // -- Document Generation --
      case 'generate_document': {
        return JSON.stringify(await electron.generateFile({
          format: input.format, spec: input.spec, content: input.content,
        }));
      }

      default:
        throw new Error(`No handler for tool: ${name}`);
    }
  } catch (error: any) {
    throw new Error(`Tool execution failed (${name}): ${error.message}`);
  }
}

/**
 * Execute a sandbox tool via the sandbox IPC bridge.
 */
async function executeSandboxTool(name: string, input: Record<string, any>): Promise<string> {
  if (!electron?.sandbox) throw new Error('Sandbox not available');

  switch (name) {
    case 'sandbox_execute':
      return JSON.stringify(await electron.sandbox.execute({
        command: input.command,
        description: input.description || 'Agent command',
        workingDirectory: input.working_directory,
        requiresApproval: false,
        stream: false,
      }));

    case 'sandbox_read_file':
      return JSON.stringify(await electron.sandbox.readFile(input.path));

    case 'sandbox_write_file':
      return JSON.stringify(await electron.sandbox.writeFile(input.path, input.content));

    case 'sandbox_list_dir':
      return JSON.stringify(await electron.sandbox.listDir(input.path || ''));

    case 'sandbox_run_python': {
      const args = input.args ? ` ${input.args}` : '';
      return JSON.stringify(await electron.sandbox.execute({
        command: `python3 ${input.script_path}${args}`,
        description: `Running Python script: ${input.script_path}`,
        requiresApproval: false,
        stream: false,
      }));
    }

    case 'sandbox_copy_from_shared':
      return JSON.stringify(await electron.sandbox.copyFromShared(input.filename, input.destination));

    case 'sandbox_save_to_shared':
      return JSON.stringify(await electron.sandbox.saveToShared(input.source_path, input.filename));

    default:
      throw new Error(`Unknown sandbox tool: ${name}`);
  }
}

/**
 * Execute multiple independent tools in parallel.
 * Used when plan step has multiple tools with no dependencies.
 * Each call gets its own timeout. Returns results in same order as input.
 */
export async function executeToolsParallel(
  calls: Array<{ name: string; input: Record<string, any>; id: string }>,
  timeoutMs: number = 30000,
): Promise<Array<{ id: string; name: string; result: string; error?: string }>> {
  return Promise.all(
    calls.map(async (call) => {
      try {
        const result = await Promise.race([
          executeTool(call.name, call.input),
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout after ${timeoutMs / 1000}s`)), timeoutMs)
          ),
        ]);
        return { id: call.id, name: call.name, result };
      } catch (err: any) {
        return { id: call.id, name: call.name, result: '', error: err.message };
      }
    })
  );
}
