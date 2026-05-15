// Smart Prompt Enhancer — Detection Logic
// Classifies whether a prompt needs enhancement before sending to agent.
// Pure functions, no API calls, no React.

export type TaskType = 'chart' | 'analysis' | 'data_processing' | 'document' | 'general';

export interface EnhancementAnalysis {
  needsEnhancement: boolean;
  taskType: TaskType;
  confidence: number;
  missingFields: string[];
  detectedEntities: {
    format?: string;
    chartType?: string;
    columns?: string[];
    quantity?: number;
  };
  reason: string;
}

// ── Task type classification ─────────────────────────────────────────────────

const CHART_KEYWORDS = /\b(charts?|graphs?|plots?|visualize|visualizations?|dashboards?|pie|bar|line|scatter|heatmaps?|histograms?)\b/i;
const ANALYSIS_KEYWORDS = /\b(analyze|analysis|reports?|assessments?|comparisons?|review|summary|summarize|evaluate|insights?)\b/i;
const DATA_KEYWORDS = /\b(convert|transform|clean|merge|filter|extract|pivot|parse|process)\b/i;
const DOCUMENT_KEYWORDS = /\b(create|generate|draft|write|make|build)\b.*\b(reports?|documents?|memos?|proposals?|letters?|presentations?|slides?|decks?)\b/i;

function classifyTaskType(prompt: string): TaskType {
  if (CHART_KEYWORDS.test(prompt)) return 'chart';
  if (ANALYSIS_KEYWORDS.test(prompt)) return 'analysis';
  if (DATA_KEYWORDS.test(prompt)) return 'data_processing';
  if (DOCUMENT_KEYWORDS.test(prompt)) return 'document';
  return 'general';
}

// ── Entity detection ─────────────────────────────────────────────────────────

const CHART_TYPE_PATTERNS: Record<string, RegExp> = {
  bar: /\b(bar)\s*(chart|graph)?\b/i,
  line: /\b(line)\s*(chart|graph)?\b/i,
  pie: /\b(pie)\s*(chart|graph)?\b/i,
  scatter: /\b(scatter)\s*(plot|chart)?\b/i,
  area: /\b(area)\s*(chart|graph)?\b/i,
  heatmap: /\b(heatmap|heat\s*map)\b/i,
};

const FORMAT_PATTERNS: Record<string, RegExp> = {
  pptx: /\b(pptx|powerpoint|presentation|slide|deck)\b/i,
  docx: /\b(docx|word|document|report)\b/i,
  xlsx: /\b(xlsx|excel|spreadsheet)\b/i,
  pdf: /\b(pdf)\b/i,
  png: /\b(png|image|picture)\b/i,
  csv: /\b(csv)\b/i,
};

const QUANTITY_PATTERN = /(\d+)\s*(charts?|graphs?|slides?|pages?|sections?|reports?|visualizations?)/i;

function detectEntities(prompt: string): EnhancementAnalysis['detectedEntities'] {
  const entities: EnhancementAnalysis['detectedEntities'] = {};

  // Chart type
  for (const [type, pattern] of Object.entries(CHART_TYPE_PATTERNS)) {
    if (pattern.test(prompt)) { entities.chartType = type; break; }
  }

  // Format
  for (const [fmt, pattern] of Object.entries(FORMAT_PATTERNS)) {
    if (pattern.test(prompt)) { entities.format = fmt; break; }
  }

  // Quantity
  const qMatch = prompt.match(QUANTITY_PATTERN);
  if (qMatch) entities.quantity = parseInt(qMatch[1]);

  return entities;
}

// ── Vagueness scoring ────────────────────────────────────────────────────────

function scoreVagueness(prompt: string, taskType: TaskType, entities: EnhancementAnalysis['detectedEntities']): { score: number; missing: string[] } {
  let score = 0;
  const missing: string[] = [];
  const wordCount = prompt.trim().split(/\s+/).length;

  // Length penalty
  if (wordCount < 5) score += 0.4;
  else if (wordCount < 8) score += 0.25;
  else if (wordCount < 12) score += 0.1;

  // Task-specific missing fields
  if (taskType === 'chart') {
    if (!entities.chartType) { score += 0.2; missing.push('chart_type'); }
    if (!entities.format) { score += 0.1; missing.push('output_format'); }
    // No column references
    if (!/\b(column|field|row|data|by|using|from)\b/i.test(prompt)) { score += 0.15; missing.push('data_columns'); }
  }

  if (taskType === 'analysis') {
    if (!entities.format) { score += 0.1; missing.push('output_format'); }
    if (!/\b(focus|about|on|specific|deep|thorough|brief|quick)\b/i.test(prompt)) { score += 0.15; missing.push('depth'); }
  }

  if (taskType === 'document') {
    if (!entities.format) { score += 0.15; missing.push('output_format'); }
    if (!/\b(formal|casual|professional|academic)\b/i.test(prompt)) { score += 0.1; missing.push('tone'); }
  }

  // Quantity without detail (e.g. "3 charts" but no specifics)
  if (entities.quantity && entities.quantity > 1 && wordCount < 15) {
    score += 0.2;
    missing.push('details_per_item');
  }

  return { score: Math.min(1, score), missing };
}

// ── Main analysis function ───────────────────────────────────────────────────

export function analyzePromptForEnhancement(
  prompt: string,
  hasContextInsight: boolean,
  screenContext: string,
): EnhancementAnalysis {
  const trimmed = prompt.trim();

  // Skip conditions — never show enhancer
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount > 50) {
    return { needsEnhancement: false, taskType: 'general', confidence: 0, missingFields: [], detectedEntities: {}, reason: 'Prompt is detailed enough' };
  }

  const taskType = classifyTaskType(trimmed);
  const entities = detectEntities(trimmed);
  const { score, missing } = scoreVagueness(trimmed, taskType, entities);

  // Context availability bonus — if we have screen data, enhancement is more valuable
  const contextBonus = hasContextInsight ? 0.1 : 0;
  const adjustedScore = Math.min(1, score + contextBonus);

  // Threshold
  const threshold = taskType === 'general' ? 0.5 : 0.4;
  const needsEnhancement = adjustedScore >= threshold && missing.length > 0;

  return {
    needsEnhancement,
    taskType,
    confidence: adjustedScore,
    missingFields: missing,
    detectedEntities: entities,
    reason: needsEnhancement
      ? `Missing: ${missing.join(', ')}`
      : 'Prompt is specific enough',
  };
}
