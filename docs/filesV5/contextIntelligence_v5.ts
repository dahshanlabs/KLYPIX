// contextIntelligence_v5.ts
// 
// HYBRID ARCHITECTURE:
//
// Gemini ALREADY generates good insights and actions (e.g., "Compare 2025 vs 2024",
// "Unsubscribe from emails"). We don't replace this. We ENHANCE it.
//
// 1. detectContext() — classifies the active window into a context category (LOCAL)
// 2. getContextFocus() — returns a short focus instruction to inject into the existing prompt
//    - Makes Gemini's analysis sharper for the detected context
//    - Does NOT replace the existing CONTEXT_INTELLIGENCE_PROMPT
// 3. getContextActions() — returns HARDCODED actions as OFFLINE FALLBACK ONLY
//    - Used when Gemini is unavailable
//    - Also used as reference list for Gemini to reorder
// 4. Caching — avoids duplicate Gemini calls on repeated Alt+Space toggles
// 5. Context override — user can correct wrong auto-detection
//
// ONLINE (normal): Gemini generates insight + metadata + actions → we enforce action types
// OFFLINE (fallback): Hardcoded actions from this file → no insight, just buttons
//
// ACTION TYPES (enforced on Gemini's response OR hardcoded):
//   "chat"      → Screenshot → Gemini → text response in chat
//   "document"  → Screenshot → Gemini → generate file (.docx/.xlsx/.pptx/.pdf)
//   "clipboard" → Screenshot → Gemini → extract text → copy to clipboard

// ============================================
// TYPES
// ============================================

export type ScreenContext =
  | 'spreadsheet' | 'word-processor' | 'presentation' | 'pdf-viewer'
  | 'code-editor' | 'terminal' | 'email-desktop' | 'video-call'
  | 'messaging' | 'image-editor' | 'notepad' | 'file-explorer'
  | 'task-manager' | 'settings' | 'calculator' | 'trading'
  | 'media-player' | 'design-tool' | 'database-tool'
  | 'project-management' | 'erp' | 'crm' | 'hr-system'
  | 'marketing-analytics' | 'finance-accounting'
  | 'supply-chain' | 'engineering-cad' | 'ai-ml-tool'
  | 'devops-cloud' | 'collaboration-docs'
  | 'browser-shopping' | 'browser-email' | 'browser-youtube'
  | 'browser-social' | 'browser-news' | 'browser-dev'
  | 'browser-maps' | 'browser-search' | 'browser-banking'
  | 'browser-jobs' | 'browser-learning' | 'browser-gov-sa'
  | 'browser-payment-sa' | 'browser-food-sa' | 'browser-travel'
  | 'browser-realestate' | 'browser-admin-portal'
  | 'browser-general' | 'unknown';

export interface ContextAction {
  label: string;
  prompt: string;
  type: 'chat' | 'document' | 'clipboard';
  documentFormat?: 'docx' | 'xlsx' | 'pptx' | 'pdf';
}

interface WindowContext {
  process: string;
  title: string;
}

// ============================================
// 1. CONTEXT DETECTION (Flaw 1 fix — fallback chain)
// ============================================

export function detectContext(ctx: WindowContext): ScreenContext {
  const p = ctx.process.toLowerCase();
  const t = ctx.title.toLowerCase();

  // --- DESKTOP APPS (detect by process name first, then title) ---

  // Spreadsheets
  if (p.includes('excel') || p.includes('scalc'))
    return 'spreadsheet';
  if (t.includes('.xlsx') || t.includes('.xls') || t.includes('.csv'))
    return 'spreadsheet';

  // Word processors
  if (p.includes('winword') || p.includes('swriter'))
    return 'word-processor';
  if (t.includes('.docx') || t.includes('.doc'))
    return 'word-processor';

  // Presentations
  if (p.includes('powerpnt') || p.includes('simpress'))
    return 'presentation';
  if (t.includes('.pptx') || t.includes('.ppt'))
    return 'presentation';

  // PDF viewers
  if (p.includes('acrobat') || p.includes('acrord') || p.includes('foxitreader') || p.includes('sumatrapdf'))
    return 'pdf-viewer';
  if (t.includes('.pdf'))
    return 'pdf-viewer';

  // Code editors (process name is most reliable)
  if (['code', 'devenv', 'rider', 'idea64', 'idea', 'pycharm64', 'pycharm',
       'webstorm64', 'webstorm', 'sublime_text', 'notepad++', 'atom', 'cursor', 'windsurf'
      ].some(s => p.includes(s)))
    return 'code-editor';
  if (['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.cpp', '.cs',
       '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.vue', '.svelte'
      ].some(s => t.includes(s)))
    return 'code-editor';

  // Terminal
  if (['cmd', 'powershell', 'windowsterminal', 'wt', 'conhost', 'gitbash'].some(s => p.includes(s)))
    return 'terminal';
  if (['command prompt', 'powershell', 'terminal', 'bash', 'ubuntu', 'wsl'].some(s => t.includes(s)))
    return 'terminal';

  // Email desktop
  if (['outlook', 'thunderbird', 'mailbird', 'emclient'].some(s => p.includes(s)))
    return 'email-desktop';

  // Video conferencing
  if (['zoom', 'teams'].some(s => p.includes(s)))
    return 'video-call';
  if (['zoom meeting', 'microsoft teams'].some(s => t.includes(s)))
    return 'video-call';

  // Messaging
  if (['whatsapp', 'telegram', 'slack', 'discord', 'signal'].some(s => p.includes(s)))
    return 'messaging';

  // Image editors
  if (['mspaint', 'photoshop', 'gimp', 'irfanview', 'xnview', 'snagit', 'sharex'].some(s => p.includes(s)))
    return 'image-editor';
  if (['photos'].some(s => p.includes(s)) && ['.png', '.jpg', '.jpeg', '.bmp', '.webp'].some(s => t.includes(s)))
    return 'image-editor';

  // Notepad (simple text)
  if (p === 'notepad' || p.includes('wordpad'))
    return 'notepad';

  // File explorer
  if (p.includes('explorer') && !t.includes('http'))
    return 'file-explorer';

  // Task manager
  if (p.includes('taskmgr') || t.includes('task manager'))
    return 'task-manager';

  // Settings
  if (p.includes('systemsettings') || t.includes('control panel'))
    return 'settings';

  // Calculator
  if (p.includes('calculator') || (p.includes('calc') && !p.includes('scalc')))
    return 'calculator';

  // Trading (desktop apps)
  if (['metatrader', 'thinkorswim'].some(s => p.includes(s)))
    return 'trading';

  // Media players
  if (['vlc', 'wmplayer', 'spotify', 'itunes', 'groove', 'foobar'].some(s => p.includes(s)))
    return 'media-player';

  // Design tools
  if (['figma', 'illustrator', 'xd', 'sketch', 'inkscape'].some(s => p.includes(s)))
    return 'design-tool';

  // Database tools
  if (['ssms', 'mysql', 'pgadmin', 'dbeaver', 'datagrip', 'mongocompass', 'azuredatastudio'].some(s => p.includes(s)))
    return 'database-tool';

  // Engineering / CAD
  if (['autocad', 'solidworks', 'fusion', 'matlab', 'labview', 'catia', 'revit', 'inventor', 'blender'].some(s => p.includes(s)))
    return 'engineering-cad';

  // AI / ML tools (desktop)
  if (['jupyter', 'comfyui', 'stable-diffusion'].some(s => p.includes(s)))
    return 'ai-ml-tool';

  // Docker
  if (p.includes('docker'))
    return 'devops-cloud';

  // SAP
  if (p.includes('saplogon') || p.includes('sap'))
    return 'erp';

  // Kubernetes desktop tools
  if (['lens', 'k9s'].some(s => p.includes(s)))
    return 'devops-cloud';

  // --- BROWSER DETECTION (title-based) ---
  if (isBrowser(p)) {
    return detectBrowserContext(t);
  }

  // --- TITLE-BASED FALLBACK (for apps not caught by process name) ---
  // This catches cases where process name is generic but title reveals the app

  if (t.includes('google sheets') || t.includes('sheets.google'))
    return 'spreadsheet';
  if (t.includes('docs.google'))
    return 'word-processor';
  if (t.includes('slides.google'))
    return 'presentation';
  if (['tradingview', 'binance', 'webull', 'etoro', 'coinbase', 'plus500',
       'ig.com', 'saxo', 'capital.com', 'mt4', 'mt5'
      ].some(s => t.includes(s)))
    return 'trading';
  if (['jira', 'asana', 'trello', 'notion', 'monday.com', 'clickup',
       'linear', 'basecamp', 'wrike', 'smartsheet'
      ].some(s => t.includes(s)))
    return 'project-management';
  if (['sap', 'oracle erp', 'dynamics 365', 'netsuite', 'odoo',
       'd365', 'business central', 'oracle cloud'
      ].some(s => t.includes(s)))
    return 'erp';
  if (['salesforce', 'hubspot', 'zoho crm', 'pipedrive', 'freshsales',
       'dynamics crm', 'sugar crm', 'insightly'
      ].some(s => t.includes(s)))
    return 'crm';
  if (['workday', 'bamboohr', 'successfactors', 'jisr', 'zenhr',
       'mudad', 'gusto', 'adp', 'deel', 'remote.com'
      ].some(s => t.includes(s)))
    return 'hr-system';
  if (['google ads', 'meta ads', 'facebook ads', 'ads manager',
       'mailchimp', 'hootsuite', 'buffer', 'semrush', 'ahrefs', 'moz',
       'google analytics', 'analytics.google', 'search console',
       'mixpanel', 'amplitude', 'hotjar'
      ].some(s => t.includes(s)))
    return 'marketing-analytics';
  if (['quickbooks', 'xero', 'zoho books', 'freshbooks', 'qoyod',
       'wafeq', 'sage', 'wave accounting', 'myob'
      ].some(s => t.includes(s)))
    return 'finance-accounting';
  if (['sap scm', 'oracle scm', 'shipstation', 'shippo',
       'salla', 'zid', 'shopify', 'woocommerce', 'magento',
       'aramex', 'smsa', 'dhl', 'fedex', 'ups'
      ].some(s => t.includes(s)))
    return 'supply-chain';
  if (['notion.so', 'confluence', 'miro.com', 'figjam', 'loom',
       'coda.io', 'airtable'
      ].some(s => t.includes(s)))
    return 'collaboration-docs';
  if (['aws', 'amazon web services', 'azure portal', 'google cloud', 'gcp',
       'vercel', 'netlify', 'heroku', 'digitalocean', 'cloudflare',
       'grafana', 'datadog', 'kibana', 'prometheus', 'kubernetes',
       'k8s', 'rancher', 'argocd', 'jenkins', 'circleci',
       'github actions', 'gitlab ci'
      ].some(s => t.includes(s)))
    return 'devops-cloud';
  if (['jupyter', 'colab', 'hugging face', 'chatgpt', 'claude',
       'midjourney', 'openai', 'kaggle', '.ipynb',
       'stable diffusion', 'comfyui', 'automatic1111', 'invoke ai', 'fooocus'
      ].some(s => t.includes(s)))
    return 'ai-ml-tool';
  if (t.includes('zoom meeting') || t.includes('meet.google') || t.includes('zoom.us') || t.includes('teams.microsoft'))
    return 'video-call';
  if (['whatsapp', 'telegram', 'slack', 'discord', 'web.whatsapp'].some(s => t.includes(s)))
    return 'messaging';
  if (['netflix', 'shahid', 'disney+', 'prime video'].some(s => t.includes(s)))
    return 'media-player';
  if (t.includes('figma') || t.includes('canva'))
    return 'design-tool';

  return 'unknown';
}


function detectBrowserContext(title: string): ScreenContext {
  const t = title;

  // Admin portals (check early — before generic Microsoft/Google matches)
  if (['admin.microsoft', 'portal.office', 'admin.google', 'workspace.google',
       'entra.microsoft', 'security.microsoft', 'compliance.microsoft',
       'exchange.microsoft', 'sharepoint.com/admin', 'teams.microsoft.com/admin',
       'admin.microsoft.com', 'aad.portal.azure'
      ].some(s => t.includes(s)))
    return 'browser-admin-portal';

  // Saudi government
  if (['absher', 'tawakkalna', 'nafath', 'qiwa', 'muqeem',
       'mol.gov.sa', 'moi.gov.sa', 'mc.gov.sa', 'hrsd.gov.sa',
       'etamm', 'balady', 'rega.gov.sa', 'zatca', 'gazt',
       'mcs.gov.sa', 'my.gov.sa', 'iam.gov.sa'
      ].some(s => t.includes(s)))
    return 'browser-gov-sa';

  // Saudi payment
  if (['stcpay', 'mada', 'sadad', 'tamara', 'tabby', 'urpay'].some(s => t.includes(s)))
    return 'browser-payment-sa';

  // Saudi food delivery
  if (['hungerstation', 'jahez', 'toyou', 'careem.com', 'talabat', 'mrsool', 'the chefz'].some(s => t.includes(s)))
    return 'browser-food-sa';

  // Banking (check before shopping — some banks have "shop" in features)
  if (['alrajhi', 'alinma', 'snb', 'sab', 'riyad bank', 'bsf',
       'paypal', 'wise', 'revolut', 'stcpay', 'banking'
      ].some(s => t.includes(s)))
    return 'browser-banking';

  // Shopping
  if (['amazon', 'noon', 'jarir', 'ebay', 'aliexpress', 'extra.com',
       'namshi', 'shein', 'temu', 'walmart', 'costco', 'ikea',
       'hm.com', 'zara.com', 'asos', 'etsy', 'newegg', 'bestbuy',
       'cart', 'checkout', 'add to bag'
      ].some(s => t.includes(s)))
    return 'browser-shopping';

  // Email
  if (['gmail', 'outlook.live', 'outlook.office', 'yahoo mail',
       'protonmail', 'mail.google', 'mail.yahoo', 'zoho mail'
      ].some(s => t.includes(s)))
    return 'browser-email';

  // YouTube
  if (t.includes('youtube') || t.includes('youtu.be'))
    return 'browser-youtube';

  // Social media
  if (['twitter', 'x.com', 'linkedin', 'instagram', 'facebook',
       'reddit', 'tiktok', 'threads', 'snapchat'
      ].some(s => t.includes(s)))
    return 'browser-social';

  // News
  if (['bbc', 'cnn', 'reuters', 'aljazeera', 'alarabiya', 'arab news',
       'bloomberg', 'cnbc', 'wsj', 'nytimes', 'guardian', 'washingtonpost',
       'sabq', 'okaz', 'riyadh daily', 'argaam', 'maaal',
       'sky news', 'france24', 'dw.com'
      ].some(s => t.includes(s)))
    return 'browser-news';

  // Developer sites
  if (['stackoverflow', 'github', 'gitlab', 'bitbucket',
       'dev.to', 'medium.com', 'hackernews', 'codepen',
       'npmjs.com', 'pypi.org', 'docs.', 'developer.'
      ].some(s => t.includes(s)))
    return 'browser-dev';

  // Maps
  if (t.includes('google maps') || t.includes('maps.google') || t.includes('waze'))
    return 'browser-maps';

  // Search results
  if ((t.includes('google') && (t.includes('search') || t.includes('بحث'))) ||
      t.includes('bing') || t.includes('duckduckgo'))
    return 'browser-search';

  // Job sites
  if (['linkedin.com/jobs', 'indeed', 'glassdoor', 'bayt', 'naukrigulf',
       'gulftalent', 'monster', 'jadarat', 'tamheer', 'hrdf'
      ].some(s => t.includes(s)))
    return 'browser-jobs';

  // Learning
  if (['udemy', 'coursera', 'edx', 'skillshare', 'pluralsight',
       'khanacademy', 'codecademy', 'rwaq', 'doroob', 'edraak',
       'linkedin.com/learning', 'masterclass'
      ].some(s => t.includes(s)))
    return 'browser-learning';

  // Travel
  if (['booking.com', 'airbnb', 'expedia', 'almosafer', 'flyin',
       'saudia', 'flynas', 'emirates', 'agoda', 'trivago',
       'kayak', 'skyscanner', 'wego'
      ].some(s => t.includes(s)))
    return 'browser-travel';

  // Real estate
  if (['aqar.fm', 'bayut', 'property finder', 'haraj', 'olx', 'opensooq', 'wasalt'].some(s => t.includes(s)))
    return 'browser-realestate';

  return 'browser-general';
}


function isBrowser(processName: string): boolean {
  return ['chrome', 'firefox', 'edge', 'msedge', 'brave',
    'opera', 'vivaldi', 'arc', 'chromium'
  ].some(b => processName.toLowerCase().includes(b));
}


function detectArabicContent(title: string): boolean {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(title);
}


// ============================================
// 2. CONTEXT FOCUS AREA (enhances existing prompt, does NOT replace it)
// ============================================
// Returns a short focus instruction to inject into the existing CONTEXT_INTELLIGENCE_PROMPT.
// Gemini still generates insight + metadata + actions (it's already good at this).
// The focus area just makes it sharper for the detected context.

export function getContextFocus(context: ScreenContext): string {
  return CONTEXT_FOCUS[context] || CONTEXT_FOCUS['unknown'];
}

// Also export the prompt builder for the enhanced version
export function getContextPrompt(context: ScreenContext, windowTitle: string): string {
  const hasArabic = detectArabicContent(windowTitle);
  const arabicNote = hasArabic
    ? ' If content is in Arabic, provide insight in both Arabic and English.'
    : '';

  const focusArea = CONTEXT_FOCUS[context] || 'Describe what is visible on screen.';

  // Get action labels for this context (used as fallback reference for Gemini)
  const actions = CONTEXT_ACTIONS[context] || CONTEXT_ACTIONS['unknown'];
  const actionLabels = actions.map(a => a.label).join(', ');

  return `Analyze this screenshot. ${focusArea}${arabicNote}

Available actions for reference: [${actionLabels}]

Respond with ONLY a JSON object:
{"insight": "1-2 sentence specific observation", "firstAction": "most relevant action label from the list above"}

Be specific: "Sales spreadsheet with Q3 data, 47 rows, column D has #REF! errors" NOT "A spreadsheet is open."`;
}

// Short focus instructions per context — keeps token cost low
const CONTEXT_FOCUS: Record<ScreenContext, string> = {
  'spreadsheet': 'Focus on: data patterns, formula errors, missing values, what the data represents.',
  'word-processor': 'Focus on: document type, writing quality, grammar issues, formatting, key content.',
  'presentation': 'Focus on: slide layout, text readability, design quality, content clarity.',
  'pdf-viewer': 'Focus on: document type, key content on this page, tables or extractable data.',
  'code-editor': 'Focus on: programming language, visible errors/warnings, what the code does, bugs.',
  'terminal': 'Focus on: last command, output or error messages, what the user is trying to do.',
  'email-desktop': 'Focus on: sender, intent, key info (dates/amounts/deadlines), action items, urgency.',
  'video-call': 'Focus on: meeting topic, participants, shared content visible.',
  'messaging': 'Focus on: who is messaging, what they want, conversation topic.',
  'image-editor': 'Focus on: image content, text in image, quality, composition.',
  'notepad': 'Focus on: content type (notes/code/data/config), structure, errors.',
  'file-explorer': 'Focus on: current folder, file types, organization, clutter.',
  'task-manager': 'Focus on: CPU/memory/disk usage, high-resource processes, system health.',
  'settings': 'Focus on: which setting category, current configuration, warnings.',
  'calculator': 'Focus on: the calculation visible and the result.',
  'trading': 'Focus on: asset/ticker, chart timeframe, indicators, price action, trend.',
  'media-player': 'Focus on: what is playing (title/artist/show), playback state.',
  'design-tool': 'Focus on: design type, layout, colors, typography, alignment.',
  'database-tool': 'Focus on: query visible, table structure, results, errors.',
  'project-management': 'Focus on: board/project name, tasks, statuses, deadlines, blocked items.',
  'erp': 'Focus on: which module/screen, transaction data, status, errors.',
  'crm': 'Focus on: deal/contact/pipeline view, deal stage, key metrics.',
  'hr-system': 'Focus on: which section (employee/payroll/leave/recruitment), pending actions.',
  'marketing-analytics': 'Focus on: campaign metrics (CTR/CPC/ROAS), trends, anomalies.',
  'finance-accounting': 'Focus on: report type (P&L/balance sheet/invoices), amounts, discrepancies. Do NOT read account numbers.',
  'supply-chain': 'Focus on: orders, inventory, shipping status, tracking, fulfillment.',
  'engineering-cad': 'Focus on: drawing/model type, dimensions, annotations, errors.',
  'ai-ml-tool': 'Focus on: notebook cells, model output, training metrics, errors.',
  'devops-cloud': 'Focus on: service/dashboard, resource status, metrics, alerts, costs.',
  'collaboration-docs': 'Focus on: content type (wiki/board/database), structure, key info.',
  'browser-shopping': 'Focus on: product name, brand, price (SAR if applicable), specs, reviews.',
  'browser-email': 'Focus on: sender, intent, key info, action items, urgency, possible phishing.',
  'browser-youtube': 'Focus on: video title, creator, topic.',
  'browser-social': 'Focus on: post content, author, engagement.',
  'browser-news': 'Focus on: headline, key facts, source, date.',
  'browser-dev': 'Focus on: question/issue, code snippets, answers, repo structure.',
  'browser-maps': 'Focus on: location, directions, distance, points of interest.',
  'browser-search': 'Focus on: search query, top results, relevance.',
  'browser-banking': 'Focus on: page type (without reading sensitive data). Do NOT mention account numbers or balances.',
  'browser-jobs': 'Focus on: job title, company, location, requirements, salary.',
  'browser-learning': 'Focus on: course/lesson title, topic, content being taught.',
  'browser-gov-sa': 'Focus on: which service, forms, status, error messages.',
  'browser-payment-sa': 'Focus on: page type, payment options. Do NOT mention amounts or card numbers.',
  'browser-food-sa': 'Focus on: restaurant, menu items, prices, delivery time.',
  'browser-travel': 'Focus on: destination, dates, prices, options.',
  'browser-realestate': 'Focus on: property type, price, location, features.',
  'browser-admin-portal': 'Focus on: admin section (users/security/billing), settings, alerts, license usage.',
  'browser-general': 'Focus on: main content, purpose, key information.',
  'unknown': 'Describe what is visible on screen.',
};


// ============================================
// 3. HARDCODED ACTIONS PER CONTEXT (Flaw 5 fix — deterministic)
// ============================================
// Actions are NOT chosen by Gemini. They are fixed per context.
// The prompt field is sent to Gemini ONLY when the user clicks the button.

export function getContextActions(context: ScreenContext): ContextAction[] {
  const actions = CONTEXT_ACTIONS[context];
  if (!actions) return CONTEXT_ACTIONS['unknown'];
  return actions;
}

// Helper: get actions with optional Translate appended for Arabic content
export function getContextActionsWithTranslate(context: ScreenContext, windowTitle: string): ContextAction[] {
  const actions = [...getContextActions(context)];
  const hasArabic = detectArabicContent(windowTitle);

  if (hasArabic && !actions.some(a => a.label === 'Translate')) {
    actions.push({
      label: 'Translate',
      prompt: 'Translate all visible Arabic content to English. If content is mixed, translate only the Arabic parts.',
      type: 'chat',
    });
  }

  return actions;
}

// ============================================
// ACTION REORDERING (v3 Flaw 1 fix)
// ============================================
// Gemini returns a "firstAction" label. Move that action to position 0.
// If Gemini returns an invalid label, keep original order.

export function reorderActions(actions: ContextAction[], firstActionLabel?: string): ContextAction[] {
  if (!firstActionLabel) return actions;

  const idx = actions.findIndex(a => a.label === firstActionLabel);
  if (idx <= 0) return actions; // already first or not found

  const reordered = [...actions];
  const [moved] = reordered.splice(idx, 1);
  reordered.unshift(moved);
  return reordered;
}

// ============================================
// CONTEXT OVERRIDE (v3 Flaw 2 fix)
// ============================================
// User can manually override auto-detected context.
// Returns all available contexts with display labels for the override dropdown.

export function getContextDisplayLabel(context: ScreenContext): string {
  return CONTEXT_LABELS[context] || 'Unknown';
}

export function getAllContextOptions(): { value: ScreenContext; label: string }[] {
  return Object.entries(CONTEXT_LABELS).map(([value, label]) => ({
    value: value as ScreenContext,
    label,
  }));
}

const CONTEXT_LABELS: Record<ScreenContext, string> = {
  'spreadsheet': '📊 Spreadsheet',
  'word-processor': '📝 Document',
  'presentation': '📽️ Presentation',
  'pdf-viewer': '📄 PDF',
  'code-editor': '💻 Code Editor',
  'terminal': '⬛ Terminal',
  'email-desktop': '📧 Email',
  'video-call': '📹 Video Call',
  'messaging': '💬 Chat/Messaging',
  'image-editor': '🖼️ Image',
  'notepad': '📋 Text Editor',
  'file-explorer': '📁 File Explorer',
  'task-manager': '📊 Task Manager',
  'settings': '⚙️ Settings',
  'calculator': '🔢 Calculator',
  'trading': '📈 Trading',
  'media-player': '🎵 Media Player',
  'design-tool': '🎨 Design Tool',
  'database-tool': '🗃️ Database',
  'project-management': '📋 Project Management',
  'erp': '🏢 ERP System',
  'crm': '🤝 CRM / Sales',
  'hr-system': '👥 HR System',
  'marketing-analytics': '📊 Marketing / Analytics',
  'finance-accounting': '💰 Finance / Accounting',
  'supply-chain': '🚚 Supply Chain',
  'engineering-cad': '⚙️ Engineering / CAD',
  'ai-ml-tool': '🤖 AI / ML Tool',
  'devops-cloud': '☁️ DevOps / Cloud',
  'collaboration-docs': '📎 Collaboration',
  'browser-shopping': '🛒 Shopping',
  'browser-email': '📧 Email (Web)',
  'browser-youtube': '▶️ YouTube',
  'browser-social': '📱 Social Media',
  'browser-news': '📰 News',
  'browser-dev': '👨‍💻 Developer Site',
  'browser-maps': '🗺️ Maps',
  'browser-search': '🔍 Search Results',
  'browser-banking': '🏦 Banking',
  'browser-jobs': '💼 Job Search',
  'browser-learning': '📚 Learning',
  'browser-gov-sa': '🏛️ Saudi Gov Services',
  'browser-payment-sa': '💳 Saudi Payment',
  'browser-food-sa': '🍔 Food Delivery',
  'browser-travel': '✈️ Travel / Booking',
  'browser-realestate': '🏠 Real Estate',
  'browser-admin-portal': '🔧 Admin Portal',
  'browser-general': '🌐 Web Page',
  'unknown': '❓ Unknown',
};

// ============================================
// INSIGHT CACHING (v3 Flaw 11 fix)
// ============================================
// Generate a cache key from context + window title.
// If same key is requested within CACHE_TTL_MS, reuse cached insight.

const CACHE_TTL_MS = 30000; // 30 seconds

interface InsightCache {
  key: string;
  insight: string;
  firstAction: string | undefined;
  timestamp: number;
}

let insightCache: InsightCache | null = null;

export function getInsightCacheKey(context: ScreenContext, windowTitle: string): string {
  // Normalize: remove dynamic parts like timestamps, unsaved indicators
  const normalized = windowTitle
    .replace(/\s*[-–—]\s*\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?/gi, '') // timestamps
    .replace(/\s*\*\s*$/, '')  // unsaved indicator
    .trim()
    .toLowerCase();
  return `${context}::${normalized}`;
}

export function getCachedInsight(cacheKey: string): { insight: string; firstAction?: string } | null {
  if (!insightCache) return null;
  if (insightCache.key !== cacheKey) return null;
  if (Date.now() - insightCache.timestamp > CACHE_TTL_MS) {
    insightCache = null;
    return null;
  }
  return { insight: insightCache.insight, firstAction: insightCache.firstAction };
}

export function setCachedInsight(cacheKey: string, insight: string, firstAction?: string): void {
  insightCache = { key: cacheKey, insight, firstAction, timestamp: Date.now() };
}

export function clearInsightCache(): void {
  insightCache = null;
}

const CONTEXT_ACTIONS: Record<ScreenContext, ContextAction[]> = {

  // --- DESKTOP APPS ---

  'spreadsheet': [
    { label: 'Explain Sheet', prompt: 'Describe what this spreadsheet contains, its structure, and purpose.', type: 'chat' },
    { label: 'Find Errors', prompt: 'Identify formula errors, broken references, missing values, and data inconsistencies.', type: 'chat' },
    { label: 'Summarize Data', prompt: 'Provide key statistics, totals, and trends visible in this data.', type: 'chat' },
    { label: 'Copy Formula', prompt: 'Extract the most important formula visible. If it has errors, provide the corrected version. Return ONLY the formula.', type: 'clipboard' },
    { label: 'Export Report', prompt: 'Generate a structured summary report of this spreadsheet data with headings and key findings.', type: 'document', documentFormat: 'docx' },
  ],

  'word-processor': [
    { label: 'Fix Grammar', prompt: 'Identify all grammatical, spelling, and punctuation errors in the visible text. Explain each fix.', type: 'chat' },
    { label: 'Rewrite', prompt: 'Suggest an improved version of the visible text with better clarity and flow.', type: 'chat' },
    { label: 'Summarize', prompt: 'Provide a brief summary of the document content visible on screen.', type: 'chat' },
    { label: 'Check Tone', prompt: 'Assess the tone of this document. Is it appropriate for its apparent purpose? Suggest adjustments.', type: 'chat' },
    { label: 'Copy Corrected', prompt: 'Rewrite the visible text with all grammar and spelling fixed. Return ONLY the corrected text.', type: 'clipboard' },
  ],

  'presentation': [
    { label: 'Review Slide', prompt: 'Provide feedback on this slide: layout, readability, content clarity, and visual design.', type: 'chat' },
    { label: 'Reduce Text', prompt: 'The slide has too much text. Suggest a simplified version with only key bullet points.', type: 'chat' },
    { label: 'Speaker Notes', prompt: 'Generate speaker notes for this slide. Write what the presenter should say. Return ONLY the notes.', type: 'clipboard' },
    { label: 'Fix Layout', prompt: 'Suggest specific improvements to the arrangement, alignment, and visual hierarchy of this slide.', type: 'chat' },
    { label: 'Summarize Deck', prompt: 'Based on the visible slides, summarize the overall presentation topic and key messages.', type: 'chat' },
  ],

  'pdf-viewer': [
    { label: 'Summarize', prompt: 'Summarize the content visible on this PDF page.', type: 'chat' },
    { label: 'Key Points', prompt: 'List the most important information on this page.', type: 'chat' },
    { label: 'Extract Data', prompt: 'Extract all key data points (numbers, dates, names, amounts) visible. Return as clean text.', type: 'clipboard' },
    { label: 'Explain', prompt: 'Explain the content in simple, plain language.', type: 'chat' },
    { label: 'Export Summary', prompt: 'Generate a formatted summary document of the visible PDF content.', type: 'document', documentFormat: 'docx' },
  ],

  'code-editor': [
    { label: 'Explain Error', prompt: 'Explain any visible error, warning, or red underline. What causes it and how to fix it.', type: 'chat' },
    { label: 'Find Bugs', prompt: 'Review the visible code for potential bugs, logic errors, and bad practices.', type: 'chat' },
    { label: 'Explain Code', prompt: 'Describe what this code does in plain language. Explain the logic step by step.', type: 'chat' },
    { label: 'Refactor', prompt: 'Suggest a cleaner, more efficient way to write this code.', type: 'chat' },
    { label: 'Copy Fix', prompt: 'Provide the corrected version of the visible code. Return ONLY the code, no explanations.', type: 'clipboard' },
  ],

  'terminal': [
    { label: 'Explain Output', prompt: 'Explain what the terminal output means.', type: 'chat' },
    { label: 'Fix Error', prompt: 'Diagnose the visible error and explain how to fix it.', type: 'chat' },
    { label: 'Next Command', prompt: 'Based on what was just executed, suggest the logical next command. Return ONLY the command.', type: 'clipboard' },
    { label: 'Explain Command', prompt: 'Break down the last command into parts and explain what each part does.', type: 'chat' },
    { label: 'Copy Fix', prompt: 'Provide the corrected command that fixes the visible error. Return ONLY the command.', type: 'clipboard' },
  ],

  'email-desktop': [
    { label: 'Draft Reply', prompt: 'Compose an appropriate reply to this email. Match the tone and formality level.', type: 'chat' },
    { label: 'Extract Tasks', prompt: 'List all action items, requests, and deadlines from this email.', type: 'chat' },
    { label: 'Summarize', prompt: 'Provide a brief summary of this email: who sent it, what they want, and any deadlines.', type: 'chat' },
    { label: 'Copy Reply', prompt: 'Draft a professional reply. Return ONLY the reply text ready to paste.', type: 'clipboard' },
    { label: 'Detect Tone', prompt: 'Analyze the sender tone: formal, casual, urgent, passive-aggressive, etc. Suggest how to respond.', type: 'chat' },
  ],

  'video-call': [
    { label: 'Take Notes', prompt: 'Capture key points visible on screen: shared content, chat messages, meeting topic.', type: 'chat' },
    { label: 'Action Items', prompt: 'Extract any tasks, commitments, or action items visible in the meeting.', type: 'chat' },
    { label: 'Summarize', prompt: 'Summarize the visible meeting content: topic, shared materials, and key points.', type: 'chat' },
    { label: 'Draft Follow-up', prompt: 'Draft a meeting follow-up message. Return ONLY the message ready to paste.', type: 'clipboard' },
    { label: 'Export Notes', prompt: 'Generate structured meeting notes with attendees, topics discussed, and action items.', type: 'document', documentFormat: 'docx' },
  ],

  'messaging': [
    { label: 'Draft Reply', prompt: 'Compose an appropriate response to the latest message in this conversation.', type: 'chat' },
    { label: 'Summarize Chat', prompt: 'Summarize the recent conversation: topic, key points, and any pending questions.', type: 'chat' },
    { label: 'Copy Reply', prompt: 'Draft a short, appropriate reply. Return ONLY the reply text.', type: 'clipboard' },
    { label: 'Translate', prompt: 'Translate the visible messages to English (or Arabic if already in English).', type: 'chat' },
    { label: 'Extract Links', prompt: 'Extract all URLs shared in the visible conversation. Return ONLY the URLs.', type: 'clipboard' },
  ],

  'image-editor': [
    { label: 'Describe Image', prompt: 'Provide a detailed description of what is shown in this image.', type: 'chat' },
    { label: 'Extract Text', prompt: 'Extract all text visible in the image using OCR. Return ONLY the extracted text.', type: 'clipboard' },
    { label: 'Extract Colors', prompt: 'Identify the main colors used in the image. Return hex codes and color names.', type: 'clipboard' },
    { label: 'Suggest Edits', prompt: 'Recommend improvements to this image: composition, color balance, cropping.', type: 'chat' },
  ],

  'notepad': [
    { label: 'Format This', prompt: 'Clean up and structure this text. Return ONLY the formatted version.', type: 'clipboard' },
    { label: 'Fix Grammar', prompt: 'Identify and explain grammatical errors in this text.', type: 'chat' },
    { label: 'Convert Format', prompt: 'Convert this text to a structured format (JSON, CSV, or Markdown as appropriate). Return ONLY the converted text.', type: 'clipboard' },
    { label: 'Explain', prompt: 'Explain what this text content is about in plain language.', type: 'chat' },
  ],

  'file-explorer': [
    { label: 'Summarize Folder', prompt: 'Describe what types of files are in this folder and their likely purpose.', type: 'chat' },
    { label: 'Organize Plan', prompt: 'Suggest a better folder structure and organization for these files.', type: 'chat' },
    { label: 'Find Issues', prompt: 'Identify potential problems: clutter, naming inconsistencies, misplaced files.', type: 'chat' },
    { label: 'Export List', prompt: 'Generate a document listing all visible files with their types and organization.', type: 'document', documentFormat: 'docx' },
  ],

  'task-manager': [
    { label: 'Explain Usage', prompt: 'Explain what is causing the current CPU/memory/disk usage levels.', type: 'chat' },
    { label: 'Find Problem', prompt: 'Identify which process is using the most resources and whether it is normal.', type: 'chat' },
    { label: 'Explain Process', prompt: 'Explain what the highlighted or top process does and whether it is safe.', type: 'chat' },
    { label: 'Optimize Tips', prompt: 'Suggest ways to reduce resource usage and improve system performance.', type: 'chat' },
  ],

  'settings': [
    { label: 'Explain Setting', prompt: 'Describe what this setting does and what impact changing it would have.', type: 'chat' },
    { label: 'Recommend', prompt: 'Suggest the optimal configuration for this setting.', type: 'chat' },
    { label: 'Guide Me', prompt: 'Provide a step-by-step walkthrough of this settings page.', type: 'chat' },
  ],

  'calculator': [
    { label: 'Explain Calc', prompt: 'Break down the visible calculation step by step.', type: 'chat' },
    { label: 'Convert Units', prompt: 'Convert the visible result to common alternative units.', type: 'chat' },
    { label: 'Copy Result', prompt: 'Extract the calculation and result. Return as: "calculation = result"', type: 'clipboard' },
  ],

  'trading': [
    { label: 'Analyze Chart', prompt: 'Provide technical analysis: trend direction, support/resistance levels, pattern identification.', type: 'chat' },
    { label: 'Explain Indicator', prompt: 'Explain what each visible technical indicator (RSI, MACD, MA, etc.) is showing.', type: 'chat' },
    { label: 'Risk Assessment', prompt: 'Assess the risk level based on visible price action, volatility, and indicators.', type: 'chat' },
    { label: 'Pattern ID', prompt: 'Identify any chart patterns visible (head & shoulders, flags, triangles, etc.).', type: 'chat' },
    { label: 'Export Analysis', prompt: 'Generate a detailed technical analysis report of this chart.', type: 'document', documentFormat: 'docx' },
  ],

  'media-player': [
    { label: 'What\'s Playing', prompt: 'Identify the content being played: title, artist/creator, and type.', type: 'chat' },
    { label: 'Summarize', prompt: 'Brief description of the content being played.', type: 'chat' },
    { label: 'Copy Info', prompt: 'Extract title, artist/creator. Return ONLY: "Title — Artist"', type: 'clipboard' },
  ],

  'design-tool': [
    { label: 'Review Design', prompt: 'Provide design feedback: layout, visual hierarchy, spacing, color usage, typography.', type: 'chat' },
    { label: 'Fix Alignment', prompt: 'Identify misaligned elements and suggest corrections.', type: 'chat' },
    { label: 'Color Check', prompt: 'Assess the color palette: harmony, contrast, accessibility compliance.', type: 'chat' },
    { label: 'Extract Colors', prompt: 'List all colors used with hex codes. Return ONLY: "#hex - color name" per line.', type: 'clipboard' },
    { label: 'Extract CSS', prompt: 'Generate approximate CSS for the visible design elements. Return ONLY CSS code.', type: 'clipboard' },
  ],

  'database-tool': [
    { label: 'Explain Query', prompt: 'Break down the visible SQL/query in plain language.', type: 'chat' },
    { label: 'Fix Error', prompt: 'Diagnose the visible query error and explain the fix.', type: 'chat' },
    { label: 'Optimize', prompt: 'Suggest performance improvements for this query.', type: 'chat' },
    { label: 'Copy Fixed', prompt: 'Provide the corrected query. Return ONLY the query.', type: 'clipboard' },
    { label: 'Explain Schema', prompt: 'Describe the visible table structure and relationships.', type: 'chat' },
  ],

  'project-management': [
    { label: 'Summarize Board', prompt: 'Overview of project status: tasks by status, overdue items, workload.', type: 'chat' },
    { label: 'Find Overdue', prompt: 'Identify tasks that are past their deadline or appear blocked.', type: 'chat' },
    { label: 'Prioritize', prompt: 'Suggest task prioritization based on deadlines, dependencies, and importance.', type: 'chat' },
    { label: 'Draft Update', prompt: 'Write a project status update based on the board. Return ONLY the update text.', type: 'clipboard' },
    { label: 'Export Status', prompt: 'Generate a project status report with task breakdown and timeline.', type: 'document', documentFormat: 'docx' },
  ],

  'erp': [
    { label: 'Explain Screen', prompt: 'Describe what this ERP screen shows, which module it belongs to, and its purpose.', type: 'chat' },
    { label: 'Guide Steps', prompt: 'Provide step-by-step help for the current ERP transaction or process.', type: 'chat' },
    { label: 'Find Error', prompt: 'Explain any visible error messages or validation issues and how to resolve them.', type: 'chat' },
    { label: 'Extract Data', prompt: 'Extract key IDs, values, and reference numbers visible. Return ONLY the data.', type: 'clipboard' },
    { label: 'Translate', prompt: 'Translate all visible field labels and content.', type: 'chat' },
  ],

  'crm': [
    { label: 'Summarize Deal', prompt: 'Overview of the deal/opportunity: stage, value, contacts, next steps.', type: 'chat' },
    { label: 'Next Steps', prompt: 'Suggest follow-up actions based on the current deal stage and activity history.', type: 'chat' },
    { label: 'Draft Outreach', prompt: 'Draft a follow-up email for this deal/contact. Return ONLY the email text.', type: 'clipboard' },
    { label: 'Analyze Pipeline', prompt: 'Provide insights on the pipeline: conversion rates, bottlenecks, at-risk deals.', type: 'chat' },
    { label: 'Export Summary', prompt: 'Generate a deal summary report.', type: 'document', documentFormat: 'docx' },
  ],

  'hr-system': [
    { label: 'Explain Screen', prompt: 'Describe what this HR screen shows and its purpose.', type: 'chat' },
    { label: 'Guide Steps', prompt: 'Step-by-step help for the current HR task.', type: 'chat' },
    { label: 'Summarize', prompt: 'Summarize the visible employee/leave/payroll data.', type: 'chat' },
    { label: 'Draft Message', prompt: 'Draft an HR communication based on the visible context. Return ONLY the message.', type: 'clipboard' },
    { label: 'Translate', prompt: 'Translate the visible content.', type: 'chat' },
  ],

  'marketing-analytics': [
    { label: 'Analyze Metrics', prompt: 'Explain the visible performance data: what the metrics mean and whether they are good.', type: 'chat' },
    { label: 'Find Issues', prompt: 'Identify underperforming campaigns, anomalies, or concerning trends.', type: 'chat' },
    { label: 'Suggest Improve', prompt: 'Provide actionable suggestions to improve the visible metrics.', type: 'chat' },
    { label: 'Copy Metrics', prompt: 'Extract all key metrics and their values. Return as structured text.', type: 'clipboard' },
    { label: 'Export Report', prompt: 'Generate a marketing performance report with metrics, analysis, and recommendations.', type: 'document', documentFormat: 'docx' },
  ],

  'finance-accounting': [
    { label: 'Explain Report', prompt: 'Explain what this financial report shows in plain language.', type: 'chat' },
    { label: 'Find Issues', prompt: 'Identify discrepancies, unusual entries, or reconciliation problems.', type: 'chat' },
    { label: 'Summarize', prompt: 'Overview of the financial data visible (without mentioning sensitive account details).', type: 'chat' },
    { label: 'Copy Data', prompt: 'Extract key figures and totals. Return ONLY the numbers with labels.', type: 'clipboard' },
    { label: 'Export Summary', prompt: 'Generate a financial summary report.', type: 'document', documentFormat: 'docx' },
  ],

  'supply-chain': [
    { label: 'Summarize Orders', prompt: 'Overview of orders, shipments, or inventory visible.', type: 'chat' },
    { label: 'Find Issues', prompt: 'Identify delayed, stuck, or problematic orders/shipments.', type: 'chat' },
    { label: 'Explain Status', prompt: 'Explain the shipping/order/fulfillment statuses visible.', type: 'chat' },
    { label: 'Copy Tracking', prompt: 'Extract all tracking numbers and order IDs. Return ONLY the data.', type: 'clipboard' },
    { label: 'Export Report', prompt: 'Generate an order/inventory status report.', type: 'document', documentFormat: 'xlsx' },
  ],

  'engineering-cad': [
    { label: 'Explain Drawing', prompt: 'Describe what is shown in this CAD/engineering view.', type: 'chat' },
    { label: 'Check Issues', prompt: 'Identify visible problems, warnings, or design concerns.', type: 'chat' },
    { label: 'Extract Dimensions', prompt: 'List all visible dimensions and measurements. Return ONLY the data.', type: 'clipboard' },
    { label: 'Summarize', prompt: 'Overview of the design/model and its purpose.', type: 'chat' },
  ],

  'ai-ml-tool': [
    { label: 'Explain Output', prompt: 'Explain the model output, results, or training metrics visible.', type: 'chat' },
    { label: 'Explain Code', prompt: 'Describe what the visible notebook code does in plain language.', type: 'chat' },
    { label: 'Find Error', prompt: 'Diagnose any visible errors in the notebook or model output.', type: 'chat' },
    { label: 'Copy Code', prompt: 'Extract the most relevant code block. Return ONLY the code.', type: 'clipboard' },
    { label: 'Suggest Improve', prompt: 'Suggest improvements to the model, training, or code approach.', type: 'chat' },
  ],

  'devops-cloud': [
    { label: 'Explain Dashboard', prompt: 'Describe what the visible metrics, statuses, and alerts mean.', type: 'chat' },
    { label: 'Find Issues', prompt: 'Identify any alerts, errors, or abnormal metrics.', type: 'chat' },
    { label: 'Explain Error', prompt: 'Diagnose the visible error or alert and suggest resolution.', type: 'chat' },
    { label: 'Copy Config', prompt: 'Extract relevant configuration or settings. Return ONLY the config data.', type: 'clipboard' },
    { label: 'Summarize Status', prompt: 'Overview of system health across all visible services.', type: 'chat' },
  ],

  'collaboration-docs': [
    { label: 'Summarize', prompt: 'Summarize the visible content.', type: 'chat' },
    { label: 'Key Points', prompt: 'Extract the most important information.', type: 'chat' },
    { label: 'Draft Content', prompt: 'Draft additional content based on the context. Return ONLY the text.', type: 'clipboard' },
    { label: 'Improve Structure', prompt: 'Suggest better organization and structure for this content.', type: 'chat' },
  ],

  // --- BROWSER CONTEXTS ---

  'browser-shopping': [
    { label: 'Summarize Product', prompt: 'Overview: product name, brand, price, key specs, and availability.', type: 'chat' },
    { label: 'Extract Specs', prompt: 'List all product specifications. Return ONLY the specs as structured text.', type: 'clipboard' },
    { label: 'Check Reviews', prompt: 'Summarize customer reviews: overall sentiment, common pros and cons.', type: 'chat' },
    { label: 'Copy Details', prompt: 'Extract: product name, price, key specs. Return ONLY the data.', type: 'clipboard' },
  ],

  'browser-email': [
    { label: 'Draft Reply', prompt: 'Compose an appropriate reply to this email.', type: 'chat' },
    { label: 'Extract Tasks', prompt: 'List all action items, requests, and deadlines.', type: 'chat' },
    { label: 'Summarize', prompt: 'Brief summary: sender, subject, key points, urgency level.', type: 'chat' },
    { label: 'Copy Reply', prompt: 'Draft a professional reply. Return ONLY the reply text.', type: 'clipboard' },
    { label: 'Detect Tone', prompt: 'Analyze the sender tone and suggest the best response approach.', type: 'chat' },
  ],

  'browser-youtube': [
    { label: 'Summarize Video', prompt: 'Based on the title, description, and visible content, describe what this video is about.', type: 'chat' },
    { label: 'Key Points', prompt: 'Extract main takeaways from the visible video information.', type: 'chat' },
    { label: 'Copy Info', prompt: 'Extract video title and creator. Return ONLY: "Title — Creator"', type: 'clipboard' },
  ],

  'browser-social': [
    { label: 'Summarize Post', prompt: 'Summarize the key message of the visible post.', type: 'chat' },
    { label: 'Draft Comment', prompt: 'Compose a thoughtful reply or comment. Return ONLY the text.', type: 'clipboard' },
    { label: 'Draft Similar', prompt: 'Create a similar post for a different account. Return ONLY the post text.', type: 'clipboard' },
    { label: 'Translate', prompt: 'Translate the post content.', type: 'chat' },
  ],

  'browser-news': [
    { label: 'Summarize', prompt: 'Brief summary of the article: key facts and main argument.', type: 'chat' },
    { label: 'Key Facts', prompt: 'Extract the most important facts, figures, and quotes.', type: 'chat' },
    { label: 'Explain Context', prompt: 'Provide background context for this news story.', type: 'chat' },
    { label: 'Copy Summary', prompt: 'Write a 2-3 sentence summary. Return ONLY the summary.', type: 'clipboard' },
  ],

  'browser-dev': [
    { label: 'Explain Solution', prompt: 'Explain the answer/solution in simple terms.', type: 'chat' },
    { label: 'Copy Code', prompt: 'Extract the most relevant code snippet. Return ONLY the code.', type: 'clipboard' },
    { label: 'Improve Code', prompt: 'Suggest a better or more modern solution.', type: 'chat' },
    { label: 'Summarize Issue', prompt: 'Summarize the problem and the top solutions.', type: 'chat' },
  ],

  'browser-maps': [
    { label: 'Summarize Route', prompt: 'Describe the route, estimated time, and key landmarks.', type: 'chat' },
    { label: 'Copy Address', prompt: 'Extract the location address. Return ONLY the address.', type: 'clipboard' },
    { label: 'Area Info', prompt: 'Provide information about this area: nearby amenities, character, notable features.', type: 'chat' },
  ],

  'browser-search': [
    { label: 'Best Answer', prompt: 'Identify and explain the most relevant search result.', type: 'chat' },
    { label: 'Summarize Results', prompt: 'Overview of what the top results say about this query.', type: 'chat' },
    { label: 'Deeper Search', prompt: 'Suggest more specific search queries to find better results.', type: 'chat' },
  ],

  'browser-banking': [
    { label: 'Explain Page', prompt: 'Describe what this page is for and how to use it. Do NOT mention any account numbers, balances, or financial data.', type: 'chat' },
    { label: 'Guide Me', prompt: 'Step-by-step help for common tasks on this page. Do NOT reference any sensitive data.', type: 'chat' },
    { label: 'Translate', prompt: 'Translate the page content.', type: 'chat' },
  ],

  'browser-jobs': [
    { label: 'Summarize Job', prompt: 'Overview: role, company, requirements, salary range, location.', type: 'chat' },
    { label: 'Match Check', prompt: 'What qualifications and skills does this role typically require?', type: 'chat' },
    { label: 'Draft Cover Letter', prompt: 'Create a cover letter for this position. Return ONLY the letter text.', type: 'clipboard' },
    { label: 'Interview Prep', prompt: 'Suggest likely interview questions for this role and how to answer them.', type: 'chat' },
    { label: 'Copy Details', prompt: 'Extract: job title, company, location, key requirements. Return ONLY the data.', type: 'clipboard' },
  ],

  'browser-learning': [
    { label: 'Summarize Lesson', prompt: 'Summarize the current lesson content.', type: 'chat' },
    { label: 'Take Notes', prompt: 'Generate study notes from the visible content. Return ONLY the notes.', type: 'clipboard' },
    { label: 'Quiz Me', prompt: 'Create 5 practice questions based on this topic with answers.', type: 'chat' },
    { label: 'Explain Simply', prompt: 'Re-explain the concept in simpler terms with an analogy.', type: 'chat' },
  ],

  'browser-gov-sa': [
    { label: 'Explain Service', prompt: 'Describe what this government service does and who needs it.', type: 'chat' },
    { label: 'Guide Steps', prompt: 'Step-by-step walkthrough of this process.', type: 'chat' },
    { label: 'Fill Help', prompt: 'Explain what each visible form field requires.', type: 'chat' },
    { label: 'Translate', prompt: 'Translate the visible Arabic content to English.', type: 'chat' },
  ],

  'browser-payment-sa': [
    { label: 'Explain', prompt: 'Describe what this page or feature does. Do NOT mention any amounts or card numbers.', type: 'chat' },
    { label: 'Guide Me', prompt: 'Step-by-step help for the current task.', type: 'chat' },
    { label: 'Translate', prompt: 'Translate the content.', type: 'chat' },
  ],

  'browser-food-sa': [
    { label: 'Summarize Menu', prompt: 'Overview of the restaurant, available items, and prices.', type: 'chat' },
    { label: 'Best Value', prompt: 'Identify the best deals and value items on this menu.', type: 'chat' },
    { label: 'Translate Menu', prompt: 'Translate Arabic menu items to English with descriptions.', type: 'chat' },
    { label: 'Copy Order', prompt: 'Extract selected items and total price. Return ONLY the order details.', type: 'clipboard' },
  ],

  'browser-travel': [
    { label: 'Summarize Options', prompt: 'Overview of visible deals: destinations, dates, prices.', type: 'chat' },
    { label: 'Compare', prompt: 'Compare the visible options: price, features, ratings.', type: 'chat' },
    { label: 'Best Value', prompt: 'Identify the best deal among the visible options.', type: 'chat' },
    { label: 'Copy Details', prompt: 'Extract booking details: destination, dates, price. Return ONLY the data.', type: 'clipboard' },
  ],

  'browser-realestate': [
    { label: 'Summarize Listing', prompt: 'Overview: property type, price, location, size, key features.', type: 'chat' },
    { label: 'Copy Details', prompt: 'Extract property details. Return ONLY: type, price, location, size, features.', type: 'clipboard' },
    { label: 'Check Value', prompt: 'Assess if the price seems reasonable for this type of property and area.', type: 'chat' },
    { label: 'Translate', prompt: 'Translate the listing details.', type: 'chat' },
  ],

  'browser-admin-portal': [
    { label: 'Explain Screen', prompt: 'Describe what this admin page shows and its purpose.', type: 'chat' },
    { label: 'Guide Steps', prompt: 'Step-by-step help for the current admin task.', type: 'chat' },
    { label: 'Find Issues', prompt: 'Identify any alerts, warnings, or misconfigurations.', type: 'chat' },
    { label: 'Summarize', prompt: 'Overview of the admin data: users, licenses, policies visible.', type: 'chat' },
    { label: 'Export Report', prompt: 'Generate an admin summary report.', type: 'document', documentFormat: 'docx' },
  ],

  'browser-general': [
    { label: 'Summarize', prompt: 'Brief summary of the page content.', type: 'chat' },
    { label: 'Key Points', prompt: 'Extract the most important information.', type: 'chat' },
    { label: 'Copy Text', prompt: 'Extract key content from this page. Return ONLY the text.', type: 'clipboard' },
    { label: 'Explain', prompt: 'Explain the page content in simple terms.', type: 'chat' },
  ],

  'unknown': [
    { label: 'Explain', prompt: 'Describe what is visible on screen.', type: 'chat' },
    { label: 'Summarize', prompt: 'Summarize the content on screen.', type: 'chat' },
    { label: 'Extract Text', prompt: 'Extract all readable text from the screen. Return ONLY the text.', type: 'clipboard' },
  ],
};


// ============================================
// END OF FILE
// ============================================
// 
// Usage summary:
//   1. detectContext(windowContext) → ScreenContext
//   2. getInsightCacheKey(context, title) → cache key
//   3. getCachedInsight(cacheKey) → cached result or null
//   4. If no cache: getContextPrompt(context, title) → send to Gemini
//   5. setCachedInsight(cacheKey, insight, firstAction)
//   6. getContextActionsWithTranslate(context, title) → hardcoded actions
//   7. reorderActions(actions, firstAction) → reordered by Gemini recommendation
//   8. getContextDisplayLabel(context) → icon + label for context badge
//   9. getAllContextOptions() → all contexts for override dropdown
//  10. clearInsightCache() → reset cache (e.g., on context override)
