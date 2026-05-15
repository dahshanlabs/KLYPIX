import { callGeminiFlash } from '../../api/gemini';
import type { ClassificationResult, RouterConfig, RouterMessage } from './types';

// ── Fast-path heuristics (skip classifier call) ─────────────────────────────

const GREETING_PATTERNS = /^(hi|hello|hey|yo|sup|good\s*(morning|afternoon|evening)|what'?s\s*up|howdy)\b/i;
const AGENT_MODE_PATTERNS = /\b(agent|research|analyze\s*deeply|compare|investigate|multi-?step|plan\s*and\s*execute)\b/i;
const SIMPLE_PATTERNS = /^(translate|summarize|rewrite|rephrase|what\s*(is|are|was|does)|who\s*(is|was)|when\s*(is|was|did)|where\s*(is|was))\b/i;

function isSimpleGreeting(message: string): boolean {
  return GREETING_PATTERNS.test(message.trim()) && message.trim().length < 40;
}

function isAgentModeExplicitlyRequested(message: string): boolean {
  return AGENT_MODE_PATTERNS.test(message);
}

// ── Classifier system prompt ─────────────────────────────────────────────────

const CLASSIFIER_SYSTEM_PROMPT = `You are a task complexity classifier for an AI assistant.
Given a user message and conversation context, classify the task complexity.

Output ONLY valid JSON, nothing else:
{
  "complexity": "simple" or "complex",
  "confidence": 0.0 to 1.0,
  "reason": "one sentence why",
  "taskCategory": "research" or "file_ops" or "data" or "analysis" or "translation" or "simple_qa" or "general"
}

SIMPLE tasks (use cheap model):
- Direct questions with clear answers
- Simple summarization of provided text
- Translation requests
- Basic formatting or rewriting
- Single-step tool calls (open URL, read file, basic search)
- Casual conversation, greetings
- Short factual lookups

COMPLEX tasks (use powerful model):
- Multi-step planning or research
- Tasks requiring judgment, comparison, or analysis
- Chained tool usage (search then read then analyze then write)
- Code generation or debugging
- Document analysis with reasoning
- Tasks where user says "agent", "research", "analyze deeply", "compare"
- Ambiguous requests that need clarification strategy
- Tasks that previously failed on the cheap model (retry escalation)
- Any task involving 3+ sequential steps to complete

CONTEXT SIGNALS that indicate complexity:
- User explicitly invokes "agent mode"
- Conversation has multiple failed tool calls
- User expresses frustration with previous response
- Task references multiple files or data sources
- User asks for "thorough", "detailed", "comprehensive" work`;

// ── Build classifier input ───────────────────────────────────────────────────

function buildClassifierInput(
  userMessage: string,
  conversationHistory: RouterMessage[],
): string {
  // Keep it minimal — classifier only needs enough context to decide
  const recentContext = conversationHistory
    .slice(-4) // last 2 exchanges
    .map(m => `${m.role}: ${m.content.substring(0, 200)}`)
    .join('\n');

  return `RECENT CONTEXT:\n${recentContext}\n\nCURRENT USER MESSAGE:\n${userMessage}`;
}

// ── Main classifier ──────────────────────────────────────────────────────────

export async function classifyTask(
  userMessage: string,
  conversationHistory: RouterMessage[],
  previousFailures: number,
  config: RouterConfig,
): Promise<ClassificationResult> {
  // FAST PATH: Agent mode explicitly requested
  if (isAgentModeExplicitlyRequested(userMessage)) {
    return {
      complexity: 'complex',
      confidence: 1.0,
      reason: 'Agent mode keywords detected',
      suggestedModel: 'claude',
      taskCategory: 'general',
    };
  }

  // FAST PATH: Simple greeting
  if (isSimpleGreeting(userMessage)) {
    return {
      complexity: 'simple',
      confidence: 1.0,
      reason: 'Greeting',
      suggestedModel: 'flash',
      taskCategory: 'simple_qa',
    };
  }

  // FAST PATH: Previous turn(s) failed — auto-escalate
  if (previousFailures >= config.maxFlashRetries) {
    return {
      complexity: 'complex',
      confidence: 0.9,
      reason: 'Previous Flash attempt(s) failed',
      suggestedModel: 'claude',
      taskCategory: 'general',
    };
  }

  // FAST PATH: Very short simple question
  if (SIMPLE_PATTERNS.test(userMessage) && userMessage.length < 100) {
    return {
      complexity: 'simple',
      confidence: 0.85,
      reason: 'Simple question pattern',
      suggestedModel: 'flash',
      taskCategory: 'simple_qa',
    };
  }

  // FAST PATH: Report/PDF generation — detect early so we tag the right category.
  // Without this, "generate executive PDF" matches multiple complex indicators below
  // and gets routed as 'general', missing the report_generation prompt injection.
  const isReportGeneration =
    /\b(executive|exec)\b.*\b(report|summary|review|brief|deck|presentation)\b/i.test(userMessage) ||
    /\b(report|summary|brief|deck|presentation)\b.*\b(pdf|docx|pptx|word|powerpoint)\b/i.test(userMessage) ||
    /\b(generate|create|produce|build|make)\b.*\b(pdf|report|executive\s+summary|exec\s+summary)\b/i.test(userMessage);
  if (isReportGeneration) {
    return {
      complexity: 'complex',
      confidence: 0.85,
      reason: 'Report/PDF generation task detected',
      suggestedModel: 'claude', // first turn = Claude (planning); router fast-path will hand off to Flash for tool turns
      taskCategory: 'report_generation',
    };
  }

  // HEURISTIC CLASSIFIER: fast, no API call, handles most cases
  // Multi-step / complex indicators
  const complexIndicators = [
    /\b(and then|after that|next|finally|step\s*\d)\b/i,   // sequential steps
    /\b(compare|analyze|research|investigate|evaluate)\b/i, // deep reasoning
    /\b(create|write|generate|build)\b.*\b(report|document|file|summary)\b/i, // creation tasks
    /\b(multiple|several|all|every)\b.*\b(files?|pages?|sources?)\b/i, // multi-target
  ];
  const complexScore = complexIndicators.filter(p => p.test(userMessage)).length;

  if (complexScore >= 2) {
    // If the task involves data analysis, tag it so the data prompt loads
    const isDataAnalysis = /\b(spreadsheet|excel|csv|xlsx|data|column|row|sheet|workbook)\b/i.test(userMessage);
    return {
      complexity: 'complex',
      confidence: 0.75,
      reason: `${complexScore} complexity signals detected`,
      suggestedModel: 'claude',
      taskCategory: isDataAnalysis ? 'data' : 'general',
    };
  }

  // Single-step tool tasks → flash
  const simpleToolPatterns = /\b(open|find|list|check|count|show|read|search|look)\b/i;
  if (simpleToolPatterns.test(userMessage) && userMessage.length < 200) {
    const category = /\b(search|look|find)\b/i.test(userMessage) ? 'research'
      : /\b(read|list|check|count|show)\b/i.test(userMessage) ? 'file_ops'
      : 'general';
    return {
      complexity: 'simple',
      confidence: 0.8,
      reason: 'Single-step tool task',
      suggestedModel: 'flash',
      taskCategory: category,
    };
  }

  // Default: try flash (cheaper to try and fail)
  return {
    complexity: 'uncertain',
    confidence: 0.5,
    reason: 'Defaulting to flash',
    suggestedModel: 'flash',
    taskCategory: 'general',
  };
}

// ── Parse classifier JSON response ───────────────────────────────────────────

function parseClassifierResponse(raw: string): ClassificationResult | null {
  try {
    // Strip markdown fences if present
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]);
    if (!parsed.complexity || typeof parsed.confidence !== 'number') return null;

    return {
      complexity: parsed.complexity === 'complex' ? 'complex' : 'simple',
      confidence: Math.max(0, Math.min(1, parsed.confidence)),
      reason: parsed.reason || 'No reason provided',
      suggestedModel: parsed.complexity === 'complex' ? 'claude' : 'flash',
      taskCategory: parsed.taskCategory || 'general',
    };
  } catch {
    return null;
  }
}
