import { exec } from 'child_process';
import { promisify } from 'util';
import { WSLBridge } from './wslBridge';

const execAsync = promisify(exec);

export interface SetupResult {
  method: 'wsl2' | 'fallback' | 'skipped';
  ready: boolean;
  message: string;
}

/**
 * Detects WSL2 availability and guides setup.
 * Called on first launch or when sandbox is enabled.
 */
export async function runSetupWizard(): Promise<SetupResult> {
  // Step 1: Check WSL
  const bridge = new WSLBridge();
  const status = await bridge.checkWSLAvailable();

  if (status.available) {
    return { method: 'wsl2', ready: true, message: 'WSL2 is ready. Sandbox enabled.' };
  }

  // Step 2: Check if WSL exists but missing distro
  try {
    await execAsync('wsl --version', { timeout: 5000, windowsHide: true });
    return {
      method: 'wsl2',
      ready: false,
      message: 'WSL2 is installed but no Ubuntu distro found. Run: wsl --install -d Ubuntu',
    };
  } catch {
    // WSL not installed
  }

  // Step 3: Fallback
  return {
    method: 'fallback',
    ready: false,
    message: 'WSL2 is not available. Agent will use limited Windows-native execution.',
  };
}
