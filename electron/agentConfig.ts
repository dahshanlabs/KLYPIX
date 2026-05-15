import fs from 'fs';
import path from 'path';
import { app } from 'electron';

interface AgentConfigFile {
  budget: number;
  enabled: boolean;
  [dateKey: string]: number | boolean;
}

const CONFIG_FILE = path.join(app.getPath('userData'), 'agent-config.json');

function loadConfig(): AgentConfigFile {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      const defaults: AgentConfigFile = { budget: 5.0, enabled: true };
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2), 'utf-8');
      return defaults;
    }
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as AgentConfigFile;
  } catch (err) {
    console.error('[agentConfig] Failed to load:', err);
    return { budget: 5.0, enabled: true };
  }
}

function saveConfig(cfg: AgentConfigFile): void {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (err) {
    console.error('[agentConfig] Failed to save:', err);
  }
}

export function getConfig(key: string, defaultValue?: any): any {
  const cfg = loadConfig();
  return cfg[key] !== undefined ? cfg[key] : defaultValue;
}

export function setConfig(key: string, value: any): void {
  const cfg = loadConfig();
  cfg[key] = value;
  saveConfig(cfg);
}

export function getTodaySpend(): number {
  const today = new Date().toISOString().split('T')[0];
  return getConfig(today, 0);
}

export function addTodaySpend(dollars: number): void {
  const today = new Date().toISOString().split('T')[0];
  const current = getTodaySpend();
  setConfig(today, current + dollars);
}

export function getSpendHistory(): number[] {
  const cfg = loadConfig();
  const history: number[] = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const key = date.toISOString().split('T')[0];
    history.push((cfg[key] as number) ?? 0);
  }
  return history.reverse();
}
