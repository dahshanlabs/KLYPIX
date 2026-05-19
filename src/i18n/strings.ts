// Minimal translation + locale layer. Not a full i18n framework — keeps
// the surface tiny enough that adding a string is one entry here plus the
// call site, and switching languages at runtime is a single setLocale call.
//
// Usage:
//   import { t, useLocale, setLocale } from '@/i18n/strings';
//   t('common.save')                       // plain function, fine in non-React code
//   const [locale, setLocale] = useLocale()  // hook — re-renders on toggle
//
// Adding a string: add the key to `strings` with one translation per
// supported locale. Existing callers stay unchanged.

import { useEffect, useState } from 'react';

export type Locale = 'en' | 'ar';

type Strings = Record<string, Record<Locale, string>>;

const strings: Strings = {
    // ── common ──────────────────────────────────────────────────────────
    'common.save': { en: 'Save', ar: 'حفظ' },
    'common.cancel': { en: 'Cancel', ar: 'إلغاء' },
    'common.delete': { en: 'Delete', ar: 'حذف' },
    'common.copy': { en: 'Copy', ar: 'نسخ' },
    'common.open': { en: 'Open', ar: 'فتح' },
    'common.close': { en: 'Close', ar: 'إغلاق' },
    'common.back': { en: 'Back', ar: 'رجوع' },
    'common.clear': { en: 'Clear', ar: 'مسح' },
    'common.dismiss': { en: 'Dismiss', ar: 'تجاهل' },
    'common.history': { en: 'History', ar: 'السجل' },
    'common.home': { en: 'Home', ar: 'الرئيسية' },
    'common.search': { en: 'Search', ar: 'بحث' },
    'common.later': { en: 'Later', ar: 'لاحقًا' },
    'common.enabled': { en: 'Enabled', ar: 'مفعّل' },
    'common.disabled': { en: 'Disabled', ar: 'معطّل' },
    'common.or': { en: 'or', ar: 'أو' },

    // ── settings panel ─────────────────────────────────────────────────
    'settings.language.label': { en: 'Language', ar: 'اللغة' },
    // Language toggle buttons are self-labelled — each language shows in
    // its own script regardless of the active locale. Lets a user who only
    // reads one language still find their button. Matches the convention
    // already used for the Arabic entry.
    'settings.language.english': { en: 'English', ar: 'English' },
    'settings.language.arabic': { en: 'العربية', ar: 'العربية' },
    'settings.power_user': { en: 'Power User Mode', ar: 'وضع المستخدم المتقدم' },
    'settings.power_user.hint': { en: 'Show advanced banners (WSL2 sandbox setup, etc.)', ar: 'إظهار اللوحات المتقدمة (إعداد WSL2 ونحوه)' },
    'settings.account': { en: 'Account', ar: 'الحساب' },
    'settings.signout': { en: 'Sign Out', ar: 'تسجيل الخروج' },
    'settings.shortcut': { en: 'Global Shortcut', ar: 'الاختصار العام' },
    'settings.shortcut.hint': { en: 'Use at least 2 keys (Modifier + Key)', ar: 'استخدم مفتاحين على الأقل (مفتاح تعديل + مفتاح)' },
    'settings.shortcut.activate': { en: 'Activate Assistant', ar: 'تفعيل المساعد' },
    'settings.shortcut.press': { en: 'Press Keys Now...', ar: 'اضغط المفاتيح الآن...' },
    'settings.voice_dictation': { en: 'Voice Dictation', ar: 'الإملاء الصوتي' },
    'settings.voice_dictation.hint': { en: 'Speak instead of typing', ar: 'تحدّث بدلًا من الكتابة' },
    'settings.speak_responses': { en: 'Speak Responses', ar: 'قراءة الردود صوتيًا' },
    'settings.speak_responses.hint': { en: 'AI reads answers aloud', ar: 'الذكاء الاصطناعي يقرأ الردود بصوتٍ مسموع' },
    'settings.privacy_mode': { en: 'Privacy Mode', ar: 'وضع الخصوصية' },
    'settings.privacy_mode.hint': { en: 'Masking window titles / High context mode', ar: 'إخفاء عناوين النوافذ / وضع السياق العالي' },
    'settings.download_memory': { en: 'Download Memory', ar: 'تنزيل الذاكرة' },
    'settings.download_memory.hint': { en: 'Export profile & history', ar: 'تصدير الملف الشخصي والسجل' },
    'settings.clear_memory': { en: 'Clear Memory', ar: 'مسح الذاكرة' },
    'settings.clear_memory.hint': { en: 'Reset history & persona', ar: 'إعادة تعيين السجل والشخصية' },
    'settings.doc_reading': { en: 'Document Reading', ar: 'قراءة المستندات' },
    'settings.gemini_vision': { en: 'Gemini Vision', ar: 'رؤية Gemini' },
    'settings.gemini_vision.hint': { en: 'Cloud AI reads scanned PDFs. Fast & accurate. Uses API tokens.', ar: 'الذكاء الاصطناعي السحابي يقرأ ملفات PDF الممسوحة. سريع ودقيق. يستهلك رموز API.' },
    'settings.local_ocr': { en: 'Local OCR', ar: 'تعرّف ضوئي محلي' },
    'settings.local_ocr.hint': { en: 'Tesseract reads locally. Slower but free, fully private.', ar: 'Tesseract يقرأ محليًا. أبطأ لكنه مجاني وخاص بالكامل.' },
    'settings.power_button': { en: 'Power Button', ar: 'زر الطاقة' },
    'settings.power_button.label': { en: 'Label — e.g. Translate', ar: 'التسمية — مثلًا: ترجم' },
    'settings.power_button.prompt': { en: 'Prompt — e.g. Translate the above to Arabic', ar: 'الموجّه — مثلًا: ترجم ما سبق إلى العربية' },
    'settings.power_button.hint': { en: 'Shows a ⚡ quick-action button after every AI response.', ar: 'يعرض زر إجراء سريع ⚡ بعد كل ردّ من الذكاء الاصطناعي.' },
    'settings.agent_engine': { en: 'Agent Engine', ar: 'محرك الوكيل' },
    'settings.back_to_chat': { en: 'Back to Chat', ar: 'العودة إلى المحادثة' },

    // ── AgentSettings ──────────────────────────────────────────────────
    'agent_settings.ai_provider': { en: 'AI Provider', ar: 'مزوّد الذكاء الاصطناعي' },
    'agent_settings.deepseek_model': { en: 'DeepSeek Model', ar: 'نموذج DeepSeek' },
    'agent_settings.api_key': { en: 'API Key', ar: 'مفتاح API' },
    'agent_settings.api_key_placeholder': { en: 'API key...', ar: 'مفتاح API...' },
    'agent_settings.daily_budget': { en: 'Daily Budget', ar: 'الميزانية اليومية' },
    'agent_settings.today': { en: 'Today', ar: 'اليوم' },
    'agent_settings.budget': { en: 'Budget', ar: 'الميزانية' },
    'agent_settings.last_7_days': { en: 'Last 7 Days', ar: 'آخر 7 أيام' },
    'agent_settings.eval_harness': { en: 'Eval Harness (Dev) — measure model swaps before you ship them', ar: 'منصة التقييم (تطوير) — قِس استبدالات النماذج قبل النشر' },
    'agent_settings.switched_to': { en: 'Switched to', ar: 'تم التبديل إلى' },
    'agent_settings.model': { en: 'Model', ar: 'النموذج' },
    'agent_settings.title': { en: 'Agent Settings', ar: 'إعدادات الوكيل' },
    'agent_settings.key_saved': { en: 'Key saved', ar: 'تم حفظ المفتاح' },
    'agent_settings.key_cleared': { en: 'Key cleared', ar: 'تم مسح المفتاح' },
    'agent_settings.stored': { en: 'Stored', ar: 'محفوظ' },
    'agent_settings.key_suffix': { en: 'Key', ar: 'المفتاح' },

    // ── chat overlay shell ─────────────────────────────────────────────
    'chat.copy_prompt': { en: 'Copy prompt', ar: 'نسخ الموجّه' },
    'chat.add_to_canvas': { en: 'Add to canvas', ar: 'إضافة إلى اللوحة' },
    'chat.copy_response': { en: 'Copy Response', ar: 'نسخ الرد' },
    'chat.drop_files': { en: 'Drop files here', ar: 'أفلِت الملفات هنا' },
    'chat.fullscreen': { en: 'Full Screen', ar: 'شاشة كاملة' },
    'chat.screen_capture': { en: 'Screen Capture', ar: 'التقاط الشاشة' },
    'chat.pinned_conversations': { en: 'Pinned Conversations', ar: 'المحادثات المثبّتة' },
    'chat.no_pinned': { en: 'No pinned chats', ar: 'لا توجد محادثات مثبّتة' },
    'chat.minimize_tray': { en: 'Minimize to Tray', ar: 'تصغير إلى شريط المهام' },
    'chat.capture_another': { en: 'Capture another screenshot', ar: 'التقاط لقطة شاشة أخرى' },
    'chat.capture_full': { en: 'Capture Screen', ar: 'التقاط الشاشة' },
    'chat.snip_region': { en: 'Snip Region', ar: 'اقتصاص منطقة' },
    'chat.scan_files': { en: 'Scan Files', ar: 'مسح الملفات' },
    'chat.attach_files': { en: 'Attach files', ar: 'إرفاق ملفات' },
    'chat.voice_input': { en: 'Voice input (Arabic/English)', ar: 'الإدخال الصوتي (عربي/إنجليزي)' },
    'chat.stop_recording': { en: 'Click to stop recording', ar: 'انقر لإيقاف التسجيل' },
    'chat.stop_generation': { en: 'Stop Generation', ar: 'إيقاف الإنشاء' },
    'chat.attached': { en: 'Attached:', ar: 'مرفق:' },
    'chat.no_sources': { en: 'No background sources found', ar: 'لا توجد مصادر في الخلفية' },
    'chat.keep_chat': { en: 'Keep Chat', ar: 'الاحتفاظ بالمحادثة' },
    'chat.view_history': { en: 'View Pinned History', ar: 'عرض السجل المثبّت' },
    'chat.history': { en: 'History', ar: 'السجل' },
    'chat.clear_chat': { en: 'Clear Chat', ar: 'مسح المحادثة' },
    'chat.clear_chat_blocked': { en: 'Stop the agent first to clear the chat', ar: 'أوقف الوكيل أولاً لمسح المحادثة' },
    'chat.view_screen': { en: 'View Screen', ar: 'عرض الشاشة' },
    'chat.screen_n': { en: 'Screen {n}', ar: 'شاشة {n}' },
    'onscreen.paused': { en: 'On Screen paused', ar: 'تم إيقاف "على الشاشة"' },
    'onscreen.sleeping': { en: 'klypix sleeping', ar: 'klypix نائم' },
    'onscreen.seeing': { en: 'Seeing your screen', ar: 'يشاهد شاشتك' },
    'onscreen.active_label': { en: 'klypix on screen', ar: 'klypix على الشاشة' },
    'onscreen.minimized_label': { en: 'On Screen', ar: 'على الشاشة' },
    'chat.search_conversation': { en: 'Search Conversation', ar: 'البحث في المحادثة' },
    'chat.smart_suggestions': { en: 'Smart suggestions', ar: 'اقتراحات ذكية' },
    'chat.stopped': { en: 'Stopped', ar: 'متوقف' },
    'chat.analyze_link': { en: 'Analyze this link', ar: 'حلّل هذا الرابط' },
    'chat.rewrite': { en: 'Rewrite this', ar: 'أعد صياغة هذا' },
    'chat.scan_doc': { en: 'Scan a document', ar: 'مسح مستند' },
    'chat.gen_doc': { en: 'Generate another document', ar: 'إنشاء مستند آخر' },
    'chat.capture_my_screen': { en: 'Capture my screen', ar: 'التقاط شاشتي' },
    'chat.scan_a_file': { en: 'Scan a file', ar: 'مسح ملف' },
    'chat.show_in_folder': { en: 'Show in Folder', ar: 'عرض في المجلد' },
    'chat.klypix_agent': { en: 'KLYPIX Agent', ar: 'وكيل KLYPIX' },
    'chat.working': { en: 'Working...', ar: 'جارٍ العمل...' },
    'chat.type_answer': { en: 'Type your answer...', ar: 'اكتب إجابتك...' },
    'chat.agent_stopped': { en: 'Agent Stopped', ar: 'تم إيقاف الوكيل' },
    'chat.processing_files': { en: 'Processing files...', ar: 'جارٍ معالجة الملفات...' },
    'chat.pdf_processing_hint': { en: 'Large or scanned PDFs may take longer', ar: 'قد تستغرق ملفات PDF الكبيرة أو الممسوحة وقتًا أطول' },
    'chat.save_excel': { en: 'Save as Excel', ar: 'حفظ كـ Excel' },
    'chat.save_code': { en: 'Save code', ar: 'حفظ الكود' },
    'chat.save_pdf': { en: 'Save as PDF', ar: 'حفظ كـ PDF' },
    'chat.save_text': { en: 'Save as text', ar: 'حفظ كنص' },
    'chat.doc_remembered': { en: 'Document remembered', ar: 'تم حفظ المستند في الذاكرة' },
    'chat.remember_this': { en: 'Remember this', ar: 'احفظ هذا' },

    // ── agent / workflow / permissions ─────────────────────────────────
    'agent.working': { en: 'Agent Working', ar: 'الوكيل يعمل' },
    'agent.stopped': { en: 'Agent Stopped', ar: 'تم إيقاف الوكيل' },
    'agent.complete': { en: 'Agent Complete', ar: 'اكتمل عمل الوكيل' },
    'agent.trust': { en: 'Trust', ar: 'ثقة' },
    'permission.required': { en: 'Permission Required', ar: 'مطلوب إذن' },
    'permission.high_risk': { en: 'High Risk', ar: 'خطر عالٍ' },
    'permission.medium_risk': { en: 'Medium Risk', ar: 'خطر متوسط' },
    'permission.view_input': { en: 'View input', ar: 'عرض المدخلات' },
    'permission.allow': { en: 'Allow', ar: 'السماح' },
    'permission.allow_session': { en: 'Allow Session', ar: 'السماح للجلسة' },
    'permission.deny': { en: 'Deny', ar: 'الرفض' },
    'permission.trust_mode': { en: 'Trust mode', ar: 'وضع الثقة' },
    'permission.auto_approve': { en: 'Auto-approving (trust mode)...', ar: 'الموافقة التلقائية (وضع الثقة)...' },
    'agent.stop': { en: 'Stop', ar: 'إيقاف' },
    'agent.send': { en: 'Send', ar: 'إرسال' },
    'agent.tell_agent': { en: 'Tell agent something...', ar: 'أخبر الوكيل بشيء...' },
    'agent.collapse_console': { en: 'Collapse console', ar: 'طيّ وحدة التحكم' },
    'agent.expand_console': { en: 'Expand console', ar: 'توسيع وحدة التحكم' },

    // ── auth ───────────────────────────────────────────────────────────
    'auth.email': { en: 'Email', ar: 'البريد الإلكتروني' },
    'auth.password': { en: 'Password', ar: 'كلمة المرور' },

    // ── dialogs ────────────────────────────────────────────────────────
    'dialog.memory.title': { en: 'Enable Agent Memory?', ar: 'تفعيل ذاكرة الوكيل؟' },
    'dialog.memory.desc': { en: 'KLYPIX will remember things about you to give better help over time.', ar: 'سيتذكر KLYPIX معلومات عنك لتقديم مساعدة أفضل مع مرور الوقت.' },
    'dialog.memory.we_remember': { en: 'What we remember', ar: 'ما نتذكره' },
    'dialog.memory.we_never_remember': { en: 'What we NEVER remember', ar: 'ما لا نتذكره أبدًا' },
    'dialog.memory.local_only': { en: 'All memory is stored locally on your machine only.', ar: 'تُحفظ جميع البيانات محليًا على جهازك فقط.' },
    'dialog.memory.not_now': { en: 'Not Now', ar: 'ليس الآن' },
    'dialog.memory.enable': { en: 'Enable Memory', ar: 'تفعيل الذاكرة' },

    'dialog.pdf.title': { en: 'Password Required', ar: 'كلمة المرور مطلوبة' },
    'dialog.pdf.is_protected': { en: 'is password-protected.', ar: 'محمي بكلمة مرور.' },
    'dialog.pdf.placeholder': { en: 'Enter PDF password...', ar: 'أدخل كلمة مرور PDF...' },
    'dialog.pdf.unlock': { en: 'Unlock', ar: 'فتح' },
    'dialog.pdf.wrong_password': { en: 'Incorrect password. Try again.', ar: 'كلمة المرور غير صحيحة. حاول مرة أخرى.' },
    'dialog.pdf.drag_drop_hint': { en: 'Or drag & drop the file as an attachment instead.', ar: 'أو اسحب الملف وأفلته كمرفق بدلًا من ذلك.' },

    'dialog.format.title': { en: 'What format?', ar: 'ما الصيغة؟' },

    'onboarding.capture.title': { en: 'Capture & analyze screens', ar: 'التقط الشاشات وحلّلها' },
    'onboarding.capture.desc': { en: 'Full screen or crop — capture one or compare multiple screenshots in a couple of clicks', ar: 'شاشة كاملة أو مقتطعة — التقط واحدة أو قارن عدة لقطات بنقرتين' },
    'onboarding.deepmode.title': { en: 'Read all your open files', ar: 'اقرأ جميع ملفاتك المفتوحة' },
    'onboarding.deepmode.desc': { en: 'I see every open file, tab, and PDF — select any to analyze, compare, or extract data', ar: 'أرى كل ملف وعلامة تبويب و PDF مفتوح — اختر أيًا منها للتحليل أو المقارنة أو استخراج البيانات' },
    'onboarding.command.title': { en: 'Execute commands & create docs', ar: 'نفّذ الأوامر وأنشئ المستندات' },
    'onboarding.command.desc': { en: '"open notepad" · "create a PDF report" · "export to Excel" · "go to google.com"', ar: '"افتح المفكرة" · "أنشئ تقرير PDF" · "صدّر إلى Excel" · "اذهب إلى google.com"' },
    'onboarding.clipboard.title': { en: 'Smart clipboard detection', ar: 'الكشف الذكي عن الحافظة' },
    'onboarding.clipboard.desc': { en: 'Copy anything — tables, code, emails, text — I detect it and offer to transform or rewrite', ar: 'انسخ أي شيء — جداول أو كود أو بريد أو نص — أكتشفه وأعرض تحويله أو إعادة صياغته' },

    'update.downloading': { en: 'Downloading Update', ar: 'جارٍ تنزيل التحديث' },
    'update.ready': { en: 'Update Ready', ar: 'التحديث جاهز' },
    'update.available': { en: 'Update Available', ar: 'يتوفر تحديث' },
    'update.required': { en: 'Required update', ar: 'تحديث مطلوب' },
    'update.restart_now': { en: 'Restart Now', ar: 'إعادة التشغيل الآن' },
    'update.downloading_progress': { en: 'Downloading...', ar: 'جارٍ التنزيل...' },

    'cdp.integration_done': { en: 'Browser integration enabled. Your tabs are being restored. This is a one-time setup.', ar: 'تم تفعيل تكامل المتصفح. يجري استعادة علامات التبويب. هذا إعداد لمرة واحدة.' },
    'cdp.title': { en: 'Enable full browser integration', ar: 'تفعيل التكامل الكامل مع المتصفح' },
    'cdp.desc': { en: 'KLYPIX can read web pages directly. Restart each browser once to enable. Your tabs will be restored automatically.', ar: 'يستطيع KLYPIX قراءة صفحات الويب مباشرةً. أعد تشغيل كل متصفح مرة واحدة للتفعيل. ستُستعاد علامات التبويب تلقائيًا.' },
    'cdp.restart': { en: 'Restart', ar: 'إعادة التشغيل' },
    'cdp.done': { en: 'Done', ar: 'تم' },
    'cdp.not_now': { en: 'Not now', ar: 'ليس الآن' },
    'cdp.collapsed_tooltip': { en: 'Browser integration needed — click to set up', ar: 'يلزم تفعيل تكامل المتصفح — انقر للإعداد' },

    'sandbox.title': { en: 'Enable WSL2 for full agent capabilities', ar: 'تفعيل WSL2 لقدرات الوكيل الكاملة' },
    'sandbox.desc': { en: 'The agent can use Python, pandas, and matplotlib for data analysis and chart generation in a sandboxed Linux environment.', ar: 'يستطيع الوكيل استخدام Python و pandas و matplotlib لتحليل البيانات وإنشاء الرسوم البيانية في بيئة Linux معزولة.' },
    'sandbox.install': { en: 'Install WSL2', ar: 'تثبيت WSL2' },
    'sandbox.command_label': { en: 'Sandbox Command', ar: 'أمر العزل' },
    'sandbox.running': { en: 'Running…', ar: 'جارٍ التنفيذ…' },
    'sandbox.output': { en: 'Output', ar: 'المخرجات' },
    'sandbox.risk.safe': { en: 'safe', ar: 'آمن' },
    'sandbox.risk.moderate': { en: 'moderate', ar: 'متوسط' },
    'sandbox.risk.dangerous': { en: 'dangerous', ar: 'خطر' },
    'sandbox.risk.blocked': { en: 'blocked', ar: 'محظور' },

    'generated_doc.reading': { en: 'Reading context', ar: 'قراءة السياق' },
    'generated_doc.analyzing': { en: 'Analyzing content', ar: 'تحليل المحتوى' },
    'generated_doc.structuring': { en: 'Structuring document', ar: 'هيكلة المستند' },
    'generated_doc.rendering': { en: 'Rendering output', ar: 'إنشاء المخرجات' },
    'generated_doc.saved': { en: 'Saved', ar: 'تم الحفظ' },
    'generated_doc.download': { en: 'Download', ar: 'تنزيل' },
    'generated_doc.revise': { en: 'Revise', ar: 'مراجعة' },
    'generated_doc.go': { en: 'Go', ar: 'انطلق' },
    'generated_doc.what_to_change': { en: 'What to change...', ar: 'ما الذي تريد تغييره...' },
    'generated_doc.convert_to': { en: 'Convert to', ar: 'تحويل إلى' },
    'generated_doc.stop': { en: 'Stop Generation', ar: 'إيقاف الإنشاء' },

    // ── canvas chrome ──────────────────────────────────────────────────
    'zoom.expand.tooltip': { en: 'Zoom in to expand', ar: 'كبّر لعرض المحتوى' },
    'canvas.your_canvases': { en: 'Your canvases', ar: 'لوحاتك' },
    'canvas.empty': { en: 'No canvases yet. Create one or open an existing .klypix file.', ar: 'لا توجد لوحات بعد. أنشئ واحدة أو افتح ملف .klypix موجودًا.' },
    'canvas.new': { en: 'New canvas', ar: 'لوحة جديدة' },
    'canvas.open_file': { en: 'Open file...', ar: 'فتح ملف...' },
    'canvas.recent': { en: 'Recent', ar: 'الأخيرة' },
    'canvas.shared_with_you': { en: 'Shared with you', ar: 'مشاركة معك' },
    'canvas.loading': { en: 'Loading…', ar: 'جارٍ التحميل…' },
    'canvas.close_esc': { en: 'Close (Esc)', ar: 'إغلاق (Esc)' },
    'canvas.close_dashboard': { en: 'Close dashboard', ar: 'إغلاق لوحة التحكم' },
    'canvas.remove_shared': { en: 'Remove from shared list (unlink yourself — owner is not notified)', ar: 'إزالة من قائمة المشاركة (إلغاء الربط — لن يُخطر المالك)' },
    'canvas.remove_recent': { en: 'Remove from recent (file on disk is untouched)', ar: 'إزالة من الأخيرة (لن يُحذف الملف من القرص)' },
    'share.title': { en: 'Share canvas', ar: 'مشاركة اللوحة' },
    'share.copy_link': { en: 'Copy link', ar: 'نسخ الرابط' },
    'share.copied': { en: 'Copied', ar: 'تم النسخ' },
    'share.invite': { en: 'Invite collaborators', ar: 'دعوة متعاونين' },
    'share.add_collaborator': { en: 'Add collaborator', ar: 'إضافة متعاون' },
    'share.read_only': { en: 'Read-only link', ar: 'رابط للقراءة فقط' },
    'share.revoke': { en: 'Revoke', ar: 'إلغاء' },
    'share.you': { en: 'You', ar: 'أنت' },
    'share.owner': { en: 'Owner', ar: 'المالك' },
    'share.editor': { en: 'Editor', ar: 'محرر' },
    'share.viewer': { en: 'Viewer', ar: 'مشاهد' },
    'share.expires_in_days': { en: 'Expires in {n} days', ar: 'تنتهي في {n} يوم' },
    'share.e2e': { en: 'End-to-end encrypted — server cannot read your canvas', ar: 'مشفّر طرفًا إلى طرف — لا يستطيع الخادم قراءة لوحتك' },
    'share.invite_section': { en: 'Invite collaborators (Editor access)', ar: 'دعوة متعاونين (صلاحية تحرير)' },
    'share.invite_desc': { en: 'Share-by-URL above is read-only. Invitations grant edit access — recipients sign in, accept the invite, and the canvas appears in their library.', ar: 'الرابط أعلاه للقراءة فقط. تمنح الدعوات صلاحية التحرير — يسجّل المستلمون الدخول، يقبلون الدعوة، وتظهر اللوحة في مكتبتهم.' },
    'share.email_placeholder': { en: 'Email (optional, for your records)', ar: 'البريد الإلكتروني (اختياري، للسجلات)' },
    'share.creating': { en: 'Creating…', ar: 'جارٍ الإنشاء…' },
    'share.get_invite_link': { en: 'Get invite link', ar: 'احصل على رابط دعوة' },
    'share.close_dialog': { en: 'Close share dialog', ar: 'إغلاق نافذة المشاركة' },
    'share.create_invite_failed': { en: 'Failed to create invite', ar: 'تعذّر إنشاء الدعوة' },
    'context_menu.copy': { en: 'Copy', ar: 'نسخ' },
    'context_menu.cut': { en: 'Cut', ar: 'قص' },
    'context_menu.paste': { en: 'Paste', ar: 'لصق' },
    'context_menu.duplicate': { en: 'Duplicate', ar: 'تكرار' },
    'context_menu.delete': { en: 'Delete', ar: 'حذف' },
    'context_menu.group': { en: 'Group', ar: 'تجميع' },
    'context_menu.ungroup': { en: 'Ungroup', ar: 'إلغاء التجميع' },
    'context_menu.bring_forward': { en: 'Bring forward', ar: 'إلى الأمام' },
    'context_menu.send_back': { en: 'Send back', ar: 'إلى الخلف' },

    // ── canvas toolbar (left rail) ─────────────────────────────────────
    'toolbar.text': { en: 'Text (T)', ar: 'نص (T)' },
    'toolbar.select': { en: 'Select (V)', ar: 'تحديد (V)' },
    'toolbar.shapes': { en: 'Shapes (S)', ar: 'أشكال (S)' },
    'toolbar.pen': { en: 'Pen (P)', ar: 'قلم (P)' },
    'toolbar.connect': { en: 'Connect (C)', ar: 'ربط (C)' },
    'toolbar.eraser': { en: 'Eraser (E)', ar: 'ممحاة (E)' },
    'toolbar.camera': { en: 'Capture full screen', ar: 'التقاط الشاشة كاملة' },
    'toolbar.camera_busy': { en: 'Capturing…', ar: 'جارٍ الالتقاط…' },
    'toolbar.snip': { en: 'Snip area', ar: 'اقتصاص منطقة' },
    'toolbar.snip_busy': { en: 'Snipping…', ar: 'جارٍ الاقتصاص…' },
    'toolbar.type': { en: 'Type (T)', ar: 'كتابة (T)' },
    'toolbar.fill_disabled': { en: 'Fill (disabled for stroke-only tools)', ar: 'تعبئة (معطّلة لأدوات الإطار فقط)' },
    'toolbar.scale_no_sel': { en: 'Scale (select something first)', ar: 'تكبير (حدّد عنصرًا أولًا)' },
    'toolbar.fill': { en: 'Fill', ar: 'تعبئة' },
    'toolbar.stroke': { en: 'Stroke', ar: 'إطار' },
    'toolbar.text_panel': { en: 'Text style', ar: 'نمط النص' },
    'toolbar.scale': { en: 'Scale', ar: 'تكبير' },
    'toolbar.undo': { en: 'Undo (Ctrl+Z)', ar: 'تراجع (Ctrl+Z)' },
    'toolbar.redo': { en: 'Redo (Ctrl+Y)', ar: 'إعادة (Ctrl+Y)' },
    'toolbar.shape.rectangle': { en: 'Rectangle', ar: 'مستطيل' },
    'toolbar.shape.circle': { en: 'Circle', ar: 'دائرة' },
    'toolbar.shape.triangle': { en: 'Triangle', ar: 'مثلث' },
    'toolbar.shape.diamond': { en: 'Diamond', ar: 'معيّن' },
    'toolbar.shape.line': { en: 'Line', ar: 'خط' },

    // ── canvas style panels ─────────────────────────────────────────────
    'panel.stroke': { en: 'Stroke', ar: 'الإطار' },
    'panel.no_stroke': { en: 'No stroke', ar: 'بدون إطار' },
    'panel.fill': { en: 'Fill', ar: 'التعبئة' },
    'panel.no_fill': { en: 'No fill', ar: 'بدون تعبئة' },
    'panel.palette': { en: 'Palette', ar: 'لوحة الألوان' },
    'panel.width': { en: 'Width', ar: 'العرض' },
    'panel.line_style': { en: 'Line style', ar: 'نمط الخط' },
    'panel.dotted': { en: 'dotted', ar: 'منقّط' },
    'panel.dashed': { en: 'dashed', ar: 'متقطّع' },
    'panel.solid': { en: 'solid', ar: 'متّصل' },
    'panel.background': { en: 'Background', ar: 'الخلفية' },
    'panel.grid': { en: 'Grid', ar: 'الشبكة' },
    'panel.grid_off': { en: 'Off', ar: 'إيقاف' },
    'panel.grid_lines': { en: 'Lines', ar: 'خطوط' },
    'panel.grid_dots': { en: 'Dots', ar: 'نقاط' },
    'panel.grid_color': { en: 'Grid color', ar: 'لون الشبكة' },
    'panel.recent': { en: 'Recent', ar: 'الأخيرة' },
    'panel.mixed': { en: 'Mixed', ar: 'مختلط' },
    'panel.opacity': { en: 'Opacity', ar: 'الشفافية' },
    'panel.font': { en: 'Font', ar: 'الخط' },
    'panel.size': { en: 'Size', ar: 'الحجم' },
    'panel.style': { en: 'Style', ar: 'النمط' },
    'panel.color': { en: 'Color', ar: 'اللون' },
    'panel.alignment': { en: 'Alignment', ar: 'المحاذاة' },
    'panel.hex': { en: 'Hex', ar: 'هكس' },
    'panel.bold': { en: 'Bold', ar: 'عريض' },
    'panel.italic': { en: 'Italic', ar: 'مائل' },
    'panel.underline': { en: 'Underline', ar: 'تحته خط' },
    'panel.strikethrough': { en: 'Strikethrough', ar: 'مشطوب' },

    // ── canvas top toolbar + version history ───────────────────────────
    'canvas_top.settings': { en: 'Settings', ar: 'الإعدادات' },
    'canvas_top.new': { en: 'New canvas', ar: 'لوحة جديدة' },
    'canvas_top.export': { en: 'Export', ar: 'تصدير' },
    'canvas_top.save': { en: 'Save', ar: 'حفظ' },
    'canvas_top.save_as': { en: 'Save as', ar: 'حفظ باسم' },
    'canvas_top.open': { en: 'Open', ar: 'فتح' },
    'canvas_top.history': { en: 'Version history', ar: 'سجل الإصدارات' },
    'canvas_top.run': { en: 'Run', ar: 'تشغيل' },
    'canvas_top.layers': { en: 'Layers', ar: 'الطبقات' },
    'canvas_top.outline': { en: 'Outline', ar: 'المخطط' },
    'canvas_top.search': { en: 'Search', ar: 'بحث' },
    'canvas_top.share': { en: 'Share', ar: 'مشاركة' },
    'canvas_top.home': { en: 'Home (Recent + Shared)', ar: 'الرئيسية (الأخيرة + المشاركة)' },
    'canvas_top.new_short': { en: 'New (Ctrl+N)', ar: 'جديد (Ctrl+N)' },
    'canvas_top.open_short': { en: 'Open (Ctrl+O)', ar: 'فتح (Ctrl+O)' },
    'canvas_top.save_short': { en: 'Save (Ctrl+S)', ar: 'حفظ (Ctrl+S)' },
    'canvas_top.save_as_short': { en: 'Save as… (Ctrl+Shift+S)', ar: 'حفظ باسم… (Ctrl+Shift+S)' },
    'canvas_top.close_canvas': { en: 'Close canvas (Ctrl+W)', ar: 'إغلاق اللوحة (Ctrl+W)' },
    'canvas_top.share_canvas': { en: 'Share canvas', ar: 'مشاركة اللوحة' },
    'canvas_top.shared_by': { en: 'Shared by', ar: 'مشاركة من' },
    'canvas_top.save_first_share': { en: 'Save first, then share', ar: 'احفظ أولًا ثم شارك' },
    'canvas_top.search_short': { en: 'Search (Ctrl+F)', ar: 'بحث (Ctrl+F)' },
    'canvas_top.present': { en: 'Present', ar: 'عرض' },
    'canvas_top.templates': { en: 'Templates', ar: 'قوالب' },
    'canvas_top.smart_collections': { en: 'Smart collections', ar: 'المجموعات الذكية' },
    // Canvas empty-state hint
    'canvas.empty_click': { en: 'click anywhere to start typing', ar: 'انقر في أي مكان لبدء الكتابة' },
    'canvas.empty_shortcuts': { en: 'T V B L P C · DROP FILES · / FOR AGENT · CTRL+0 FIT', ar: 'T V B L P C · أفلِت الملفات · / للوكيل · CTRL+0 احتواء' },
    'canvas.filter': { en: 'Filter', ar: 'تصفية' },
    'canvas.items_count': { en: '{n} items', ar: '{n} عنصر' },
    'canvas.item_count_one': { en: '1 item', ar: 'عنصر واحد' },
    'canvas.outline_empty': { en: 'empty canvas', ar: 'لوحة فارغة' },
    'canvas.empty_short': { en: 'EMPTY', ar: 'فارغ' },
    // Group container — header chrome + breadcrumb. The default group title
    // ('Group {n}') is baked into the canvas file at creation time using the
    // user's CURRENT locale, then never mutated. So a group created in Arabic
    // stays "مجموعة 1" forever, even if the user switches the UI back to
    // English — matches the user's expectation that their authored content
    // doesn't change under them.
    'canvas.group_default_name': { en: 'Group {n}', ar: 'مجموعة {n}' },
    'canvas.group_items': { en: 'items', ar: 'عناصر' },
    'canvas.group_item_one': { en: 'item', ar: 'عنصر' },
    'canvas.group_lock_scope': { en: 'Lock scope', ar: 'قفل النطاق' },
    'canvas.group_scope_locked': { en: 'Scope locked — agent outside cannot see inside', ar: 'النطاق مقفل — لا يستطيع الوكيل من الخارج رؤية المحتوى' },
    'canvas.group_enter': { en: 'Enter group', ar: 'دخول المجموعة' },
    'canvas.group_exit_esc': { en: 'Exit group (Esc)', ar: 'الخروج من المجموعة (Esc)' },
    'canvas.group_dblclick_rename': { en: 'Double-click to rename', ar: 'انقر مرتين لإعادة التسمية' },
    'canvas.group_untitled': { en: '(untitled)', ar: '(بدون عنوان)' },
    'canvas.breadcrumb_root': { en: 'Root', ar: 'الجذر' },
    'canvas.breadcrumb_exit_root': { en: 'Exit to root', ar: 'الخروج إلى الجذر' },
    'canvas.breadcrumb_you_are_here': { en: 'You are here', ar: 'أنت هنا' },
    'canvas.breadcrumb_focus_into': { en: 'Focus into "{name}"', ar: 'الدخول إلى "{name}"' },
    'canvas.folder_open_embedded': { en: 'Open the embedded folder (Explorer compressed-folder view)', ar: 'فتح المجلد المضمّن (عرض المستكشف للمجلد المضغوط)' },
    'canvas.folder_extract_open': { en: 'Extract & open', ar: 'استخراج وفتح' },
    'canvas.folder_empty': { en: 'empty folder', ar: 'مجلد فارغ' },
    'canvas.folder_skipped_label': { en: 'skipped:', ar: 'تم التخطي:' },
    'canvas.folder_skipped_more': { en: '… +{n} more', ar: '… +{n} أكثر' },
    'canvas.recently_closed': { en: 'Recently closed', ar: 'المُغلقة مؤخرًا' },
    'canvas.folder_preview_on': { en: 'Turn on hover preview', ar: 'تفعيل المعاينة عند التمرير' },
    'canvas.folder_preview_off': { en: 'Turn off hover preview', ar: 'إيقاف المعاينة عند التمرير' },
    'canvas.folder_preview_loading': { en: 'Loading preview…', ar: 'جارٍ تحميل المعاينة…' },
    'canvas.folder_preview_unavailable': { en: 'No preview available for this file type', ar: 'لا توجد معاينة متاحة لهذا النوع' },
    'canvas.folder_preview_too_large': { en: 'File too large to preview', ar: 'الملف كبير جدًا للمعاينة' },
    'canvas.folder_sort_by': { en: 'Sort by…', ar: 'ترتيب حسب…' },
    'canvas.folder_sort_name': { en: 'Name', ar: 'الاسم' },
    'canvas.folder_sort_size': { en: 'Size', ar: 'الحجم' },
    'canvas.folder_sort_type': { en: 'Type', ar: 'النوع' },
    'canvas.folder_sort_ascending': { en: 'Ascending', ar: 'تصاعدي' },
    'canvas.folder_sort_descending': { en: 'Descending', ar: 'تنازلي' },
    // Card metadata footers — short uppercase labels rendered under the
    // primary title. Each `meta_*` value is a complete localized fragment
    // (not a template) because the calling site already composes the full
    // line; this lets translators reorder phrases naturally for RTL.
    'canvas.meta_folder': { en: 'Folder', ar: 'مجلد' },
    'canvas.meta_files_count': { en: '{n} files', ar: '{n} ملفات' },
    'canvas.meta_file_count_one': { en: '1 file', ar: 'ملف واحد' },
    'canvas.meta_zip': { en: 'zip', ar: 'مضغوط' },
    'canvas.meta_audio': { en: 'Audio', ar: 'صوت' },
    'canvas.meta_canvas_link': { en: 'Canvas', ar: 'لوحة' },
    'canvas.meta_pages': { en: '{n} pages', ar: '{n} صفحات' },
    'canvas.meta_page_one': { en: '1 page', ar: 'صفحة واحدة' },
    'canvas.meta_words': { en: '{n} words', ar: '{n} كلمة' },
    'canvas.meta_rows': { en: '{n} rows', ar: '{n} صفوف' },
    'canvas.meta_row_one': { en: '1 row', ar: 'صف واحد' },
    'canvas.meta_sheets': { en: '{n} sheets', ar: '{n} أوراق' },
    'canvas.meta_text': { en: 'Text', ar: 'نص' },
    // Live collaboration
    'canvas.collab_n_here': { en: '{n} people here', ar: '{n} أشخاص هنا' },
    'canvas.collab_more_count': { en: '+{n} more', ar: '+{n} آخرون' },
    'canvas.collab_disconnected': { en: 'Reconnecting…', ar: 'إعادة الاتصال…' },
    'canvas.collab_disconnected_toast': { en: 'Live collab disconnected — edits will not sync until you reconnect', ar: 'انقطع التعاون المباشر — لن تتزامن التعديلات حتى تعيد الاتصال' },
    'canvas.collab_reconnected_toast': { en: 'Live collab reconnected', ar: 'تم استعادة التعاون المباشر' },
    'canvas.collab_conflict_overwritten': { en: 'A collaborator just edited the same item — your change may have been overwritten', ar: 'قام متعاون بتعديل نفس العنصر للتو — قد تكون تعديلاتك تم استبدالها' },
    'canvas.collab_conflict_deleted': { en: 'A collaborator just deleted an item you were editing', ar: 'قام متعاون بحذف عنصر كنت تعدّله للتو' },
    'canvas.collab_peer.online_now': { en: 'Online now', ar: 'متصل الآن' },
    'canvas.collab_peer.last_seen_secs': { en: 'Seen {n}s ago', ar: 'آخر ظهور قبل {n} ث' },
    'canvas.collab_peer.status': { en: 'Status', ar: 'الحالة' },
    'canvas.collab_peer.device': { en: 'Device', ar: 'الجهاز' },
    'canvas.collab_peer.unknown': { en: 'Unknown user', ar: 'مستخدم غير معروف' },
    // Layers panel
    'canvas.layer_content': { en: 'content', ar: 'المحتوى' },
    'canvas.layer_agent': { en: 'agent', ar: 'الوكيل' },
    'canvas.layer_drawings': { en: 'drawings', ar: 'الرسومات' },
    // Templates panel
    'canvas.template_sample_badge': { en: 'Sample', ar: 'عيّنة' },
    'canvas.template_sticky_note': { en: 'Sticky note', ar: 'ملاحظة لاصقة' },
    'canvas.template_pros_cons': { en: 'Pros & Cons', ar: 'إيجابيات وسلبيات' },
    'canvas.template_kanban': { en: 'Kanban board', ar: 'لوحة كانبان' },
    'canvas.arrows_count': { en: '{n} arrows', ar: '{n} أسهم' },
    'canvas.arrow_count_one': { en: '1 arrow', ar: 'سهم واحد' },
    // Right-click context menu
    'menu.ask_agent': { en: 'Ask agent', ar: 'اسأل الوكيل' },
    'menu.open_chat_thread': { en: 'Open chat thread', ar: 'فتح محادثة الدردشة' },
    'menu.enter_group': { en: 'Enter group', ar: 'دخول المجموعة' },
    'menu.exit_group': { en: 'Exit group', ar: 'الخروج من المجموعة' },
    'menu.fit_to_contents': { en: 'Fit to contents', ar: 'احتواء المحتوى' },
    'menu.save_as_template': { en: 'Save as template…', ar: 'حفظ كقالب…' },
    'menu.convert_to_link': { en: 'Convert to link preview', ar: 'تحويل إلى معاينة رابط' },
    'menu.convert_to_text': { en: 'Convert to text', ar: 'تحويل إلى نص' },
    'menu.duplicate': { en: 'Duplicate', ar: 'تكرار' },
    'menu.add_border': { en: 'Add border', ar: 'إضافة حد' },
    'menu.remove_border': { en: 'Remove border', ar: 'إزالة الحد' },
    'menu.group': { en: 'Group', ar: 'تجميع' },
    'menu.ungroup': { en: 'Ungroup', ar: 'إلغاء التجميع' },
    'menu.arrange': { en: 'Arrange ▸', ar: '◂ ترتيب' },
    'menu.arrange_front': { en: 'Bring to Front', ar: 'إلى الواجهة' },
    'menu.arrange_forward': { en: 'Bring Forward', ar: 'تقديم خطوة' },
    'menu.arrange_backward': { en: 'Send Backward', ar: 'إرسال خطوة للخلف' },
    'menu.arrange_back': { en: 'Send to Back', ar: 'إلى الخلف' },
    'menu.align_items': { en: 'Align items ▸', ar: '◂ محاذاة العناصر' },
    'menu.scale': { en: 'Scale ▸', ar: '◂ تحجيم' },
    'menu.text_align': { en: 'Align ▸', ar: '◂ محاذاة' },
    'menu.add_tag': { en: 'Add tag…', ar: 'إضافة وسم…' },
    'menu.set_status': { en: 'Set status ▸', ar: '◂ تعيين الحالة' },
    'menu.add_comment': { en: 'Add comment…', ar: 'إضافة تعليق…' },
    'menu.delete': { en: 'Delete', ar: 'حذف' },
    'menu.extract_text': { en: 'Extract text (OCR)', ar: 'استخراج النص (OCR)' },
    'menu.extracting_text': { en: 'Extracting text…', ar: 'يستخرج النص…' },
    'menu.custom_placeholder': { en: 'custom', ar: 'مخصص' },
    'menu.go': { en: 'Go', ar: 'تطبيق' },
    'menu.font': { en: 'Font', ar: 'الخط' },
    'menu.font_mixed': { en: 'Font (mixed)', ar: 'الخط (مختلط)' },
    'menu.mixed': { en: 'Mixed', ar: 'مختلط' },
    'menu.bold': { en: 'Bold', ar: 'عريض' },
    'menu.italic': { en: 'Italic', ar: 'مائل' },
    'menu.underline': { en: 'Underline', ar: 'تحته خط' },
    'menu.strikethrough': { en: 'Strikethrough', ar: 'يتوسطه خط' },
    'menu.clear_formatting': { en: 'Clear formatting', ar: 'إزالة التنسيق' },
    'menu.custom_color': { en: 'Custom color', ar: 'لون مخصص' },
    // Status submenu values
    'status.none': { en: 'None', ar: 'لا شيء' },
    'status.todo': { en: 'To do', ar: 'للقيام به' },
    'status.in_progress': { en: 'In progress', ar: 'قيد التنفيذ' },
    'status.in_review': { en: 'In review', ar: 'قيد المراجعة' },
    'status.done': { en: 'Done', ar: 'مكتمل' },
    'status.blocked': { en: 'Blocked', ar: 'محظور' },
    'status.waiting': { en: 'Waiting', ar: 'انتظار' },
    // Scale panel (left toolbar)
    'scale.title': { en: 'Scale', ar: 'تحجيم' },
    'scale.select_first': { en: 'Select something first.', ar: 'اختر شيئًا أولاً.' },
    'scale.custom': { en: 'Custom', ar: 'مخصص' },
    'scale.eg_placeholder': { en: 'e.g. 1.25', ar: 'مثال: 1.25' },
    'scale.apply': { en: 'Apply', ar: 'تطبيق' },
    'scale.hint': { en: 'Each apply multiplies. Center stays the selection’s center.', ar: 'كل تطبيق يضرب القيمة. يبقى المركز هو مركز التحديد.' },
    // Settings overlay — section headers + tier badge + usage line
    'settings.section_accessibility_voice': { en: 'Accessibility & Voice', ar: 'إمكانية الوصول والصوت' },
    'settings.section_privacy_memory': { en: 'Privacy & Memory', ar: 'الخصوصية والذاكرة' },
    'settings.tier_free': { en: 'free', ar: 'مجاني' },
    'settings.tier_pro': { en: 'pro', ar: 'احترافي' },
    'settings.tier_admin': { en: 'admin', ar: 'مسؤول' },
    'settings.queries_count': { en: 'Queries: {today} today / {total} total', ar: 'الاستعلامات: {today} اليوم / {total} الإجمالي' },
    // Canvas dashboard
    'canvas.worked_on_count': { en: '{n} canvases you have worked on.', ar: 'لقد عملت على {n} لوحة.' },
    'canvas.worked_on_count_one': { en: '1 canvas you have worked on.', ar: 'لقد عملت على لوحة واحدة.' },
    'canvas.untitled_canvas': { en: 'Untitled', ar: 'بدون عنوان' },
    // Relative time — used in dashboard recent-canvases list
    'time.just_now': { en: 'just now', ar: 'الآن' },
    'time.minutes_ago': { en: '{n}m ago', ar: 'قبل {n} د' },
    'time.hours_ago': { en: '{n}h ago', ar: 'قبل {n} س' },
    'time.days_ago': { en: '{n}d ago', ar: 'قبل {n} ي' },
    'time.weeks_ago': { en: '{n}w ago', ar: 'قبل {n} أ' },
    // Chat toolbar tooltip
    'chat.copy_full_conversation': { en: 'Copy Full Conversation', ar: 'نسخ المحادثة كاملة' },
    // Memory panel
    'memory.title': { en: 'Memory', ar: 'الذاكرة' },
    'memory.total': { en: '{n} total', ar: '{n} الإجمالي' },
    'memory.on': { en: 'Memory is ON', ar: 'الذاكرة مُفعّلة' },
    'memory.off': { en: 'Memory is OFF', ar: 'الذاكرة مُعطّلة' },
    'memory.on_hint': { en: 'The agent remembers facts across sessions', ar: 'يتذكّر الوكيل المعلومات عبر الجلسات' },
    'memory.off_hint': { en: 'Turn on to let the agent learn from conversations', ar: 'فعّلها ليتعلّم الوكيل من المحادثات' },
    'memory.filter_all': { en: 'All ({n})', ar: 'الكل ({n})' },
    'memory.filter_facts': { en: 'Facts {n}', ar: 'حقائق {n}' },
    'memory.filter_prefs': { en: 'Prefs {n}', ar: 'تفضيلات {n}' },
    'memory.filter_history': { en: 'History {n}', ar: 'السجل {n}' },
    'memory.badge_fact': { en: 'fact', ar: 'حقيقة' },
    'memory.badge_pref': { en: 'pref', ar: 'تفضيل' },
    'memory.badge_history': { en: 'hist', ar: 'سجل' },
    'memory.review_extracted': { en: 'Review ({n} extracted)', ar: 'مراجعة ({n} مستخرج)' },
    'memory.save_all': { en: 'Save all', ar: 'حفظ الكل' },
    'memory.discard_all': { en: 'Discard all', ar: 'تجاهل الكل' },
    'memory.empty_none': { en: 'No memories yet. Say "remember that..." or let the agent learn from sessions.', ar: 'لا توجد ذكريات بعد. قل "تذكّر أن..." أو دع الوكيل يتعلّم من الجلسات.' },
    'memory.empty_filter': { en: 'No memories in this filter.', ar: 'لا توجد ذكريات في هذه التصفية.' },
    'memory.action_pin': { en: 'Pin', ar: 'تثبيت' },
    'memory.action_unpin': { en: 'Unpin', ar: 'إلغاء التثبيت' },
    'memory.action_delete': { en: 'Delete', ar: 'حذف' },
    'memory.action_save': { en: 'Save', ar: 'حفظ' },
    'memory.action_discard': { en: 'Discard', ar: 'تجاهل' },
    'memory.footer_local': { en: 'Stored locally. Never sent to the cloud.', ar: 'مُخزّنة محليًا. لا تُرسل إلى السحابة أبدًا.' },
    'memory.clear_all': { en: 'Clear all', ar: 'مسح الكل' },
    // AI Provider section in Settings (Gemini API key)
    'settings.section_ai_provider': { en: 'AI Provider', ar: 'مزود الذكاء الاصطناعي' },
    'settings.gemini_key_label': { en: 'Gemini API Key', ar: 'مفتاح Gemini API' },
    'settings.gemini_key_hint': { en: 'Required for chat. Stored locally on this device — never sent anywhere except Google.', ar: 'مطلوب للمحادثة. يُخزّن محليًا على هذا الجهاز — لا يُرسل إلى أي جهة سوى Google.' },
    'settings.gemini_key_placeholder': { en: 'AIza…', ar: 'AIza…' },
    'settings.gemini_key_save': { en: 'Save', ar: 'حفظ' },
    'settings.gemini_key_saved': { en: 'Saved', ar: 'تم الحفظ' },
    'settings.gemini_key_clear': { en: 'Clear', ar: 'مسح' },
    'settings.gemini_key_show': { en: 'Show key', ar: 'إظهار المفتاح' },
    'settings.gemini_key_hide': { en: 'Hide key', ar: 'إخفاء المفتاح' },
    'settings.gemini_key_get': { en: 'Get a free key at aistudio.google.com', ar: 'احصل على مفتاح مجاني من aistudio.google.com' },
    'settings.gemini_key_missing': { en: 'No key set — chat won’t work until you add one.', ar: 'لم يتم تعيين مفتاح — لن تعمل المحادثة حتى تضيف واحدًا.' },
    // Smart collections panel
    'canvas.sc_status': { en: 'Status', ar: 'الحالة' },
    'canvas.sc_tags': { en: 'Tags', ar: 'الوسوم' },
    'canvas.sc_no_status': { en: 'No statuses set yet. Right-click any item → Set status.', ar: 'لم يتم تعيين أي حالة بعد. انقر بزر الفأرة الأيمن على أي عنصر ← تعيين الحالة.' },
    'canvas.sc_no_tags': { en: 'No tags yet. Drop a file — auto-tagger fills these in.', ar: 'لا توجد وسوم بعد. أفلِت ملفًا — سيقوم الموسِّم التلقائي بتعبئتها.' },
    // Chat suggestions / thinking
    'chat.thinking': { en: 'Thinking...', ar: 'يفكّر...' },
    'chat.smart_suggestions_caption': { en: 'smart suggestions', ar: 'اقتراحات ذكية' },
    'chat.stop_suggestions': { en: 'Stop loading suggestions', ar: 'إيقاف تحميل الاقتراحات' },
    'chat.items_found_n': { en: '({n} Items Found)', ar: '({n} عنصر تم العثور عليه)' },
    // Compare / clear-all in screenshot stack
    'screenshot.compare': { en: 'Compare', ar: 'قارن' },
    'screenshot.clear_all': { en: 'Clear all', ar: 'مسح الكل' },
    // RespondingKlypix subtitle
    'responding.klypix_responding': { en: 'klypix responding', ar: 'klypix يردّ' },
    // RespondingKlypix rotating phrases — chat mode
    'responding.chat.0': { en: 'Klypixing your answer...', ar: 'يُكلبِكس إجابتك...' },
    'responding.chat.1': { en: 'Crafting something smart...', ar: 'يصوغ شيئًا ذكيًا...' },
    'responding.chat.2': { en: 'Connecting the dots...', ar: 'يربط النقاط...' },
    'responding.chat.3': { en: 'Neurons firing...', ar: 'الخلايا العصبية تشتعل...' },
    'responding.chat.4': { en: 'Cooking up a response...', ar: 'يطبخ ردًا...' },
    'responding.chat.5': { en: 'Putting words together...', ar: 'يجمع الكلمات...' },
    'responding.chat.6': { en: 'Composing brilliance...', ar: 'يؤلّف عبقرية...' },
    'responding.chat.7': { en: 'Thinking out loud...', ar: 'يفكّر بصوت عالٍ...' },
    // RespondingKlypix rotating phrases — document mode
    'responding.document.0': { en: 'Reading between the lines...', ar: 'يقرأ ما بين السطور...' },
    'responding.document.1': { en: 'Digesting your document...', ar: 'يستوعب مستندك...' },
    'responding.document.2': { en: 'Deep in the text...', ar: 'غارق في النص...' },
    'responding.document.3': { en: 'Finding the good parts...', ar: 'يبحث عن الأجزاء المهمة...' },
    'responding.document.4': { en: 'Scanning the pages...', ar: 'يمسح الصفحات...' },
    'responding.document.5': { en: 'Extracting insights...', ar: 'يستخرج الرؤى...' },
    // RespondingKlypix rotating phrases — screen mode
    'responding.screen.0': { en: 'Analyzing what you see...', ar: 'يحلّل ما تراه...' },
    'responding.screen.1': { en: 'Making sense of your screen...', ar: 'يفهم شاشتك...' },
    'responding.screen.2': { en: 'Examining the pixels...', ar: 'يفحص البكسلات...' },
    'responding.screen.3': { en: 'Decoding your display...', ar: 'يفكّ شفرة شاشتك...' },
    'responding.screen.4': { en: 'Processing the view...', ar: 'يعالج المنظر...' },
    'canvas_top.link_to_canvas': { en: 'Link to canvas', ar: 'رابط إلى لوحة' },
    'canvas.fit_all': { en: 'Fit all (Ctrl+0)', ar: 'احتواء الكل (Ctrl+0)' },
    'canvas.set_zoom': { en: 'Click to set zoom (2–400%)', ar: 'انقر لضبط التكبير (2–400%)' },
    'canvas.reset_zoom': { en: 'Reset zoom (100%)', ar: 'إعادة ضبط التكبير (100%)' },
    'canvas.copy': { en: 'Copy', ar: 'نسخ' },
    'canvas.pin_to_canvas': { en: 'Pin to canvas', ar: 'تثبيت على اللوحة' },
    'canvas.dismiss': { en: 'Dismiss', ar: 'تجاهل' },
    'canvas.discard_tab': { en: 'Unsaved changes will be lost.', ar: 'سيتم فقد التغييرات غير المحفوظة.' },
    'canvas.close_tab_q': { en: 'Close tab?', ar: 'إغلاق التبويب؟' },
    'canvas.voice_error': { en: 'Voice error', ar: 'خطأ في الصوت' },
    'canvas.transcription_failed': { en: 'Transcription failed', ar: 'فشل التحويل النصي' },
    'canvas.mic_denied': { en: 'Microphone access denied. Please allow microphone access in system settings.', ar: 'تم رفض الوصول إلى الميكروفون. يُرجى السماح بالوصول إلى الميكروفون من إعدادات النظام.' },
    'canvas.save_failed': { en: 'Save failed', ar: 'فشل الحفظ' },
    'version_history.title': { en: 'Version history', ar: 'سجل الإصدارات' },
    'version_history.save_first': { en: 'Save the canvas first to start tracking versions.', ar: 'احفظ اللوحة أولًا لبدء تتبّع الإصدارات.' },
    'version_history.loading': { en: 'Loading…', ar: 'جارٍ التحميل…' },
    'version_history.empty': { en: 'No versions yet. Save the canvas to start the history.', ar: 'لا توجد إصدارات بعد. احفظ اللوحة لبدء السجل.' },
    'version_history.restore': { en: 'Restore this version', ar: 'استعادة هذا الإصدار' },
    'version_history.latest': { en: 'latest', ar: 'الأحدث' },
    'version_history.restore_failed': { en: 'Failed to restore', ar: 'فشل الاستعادة' },

    // ── canvas bottom status bar ───────────────────────────────────────
    'status.item': { en: 'item', ar: 'عنصر' },
    'status.items': { en: 'items', ar: 'عناصر' },
    'status.untitled': { en: 'untitled', ar: 'بدون عنوان' },
    'status.select_tool': { en: 'select', ar: 'تحديد' },
    'status.pen_tool': { en: 'pen', ar: 'قلم' },
    'status.text_tool': { en: 'text', ar: 'نص' },
    'status.box_tool': { en: 'shapes', ar: 'أشكال' },
    'status.line_tool': { en: 'line', ar: 'خط' },
    'status.eraser_tool': { en: 'eraser', ar: 'ممحاة' },
    'status.connect_tool': { en: 'connect', ar: 'ربط' },

    // ── chat shell — strings missed in first pass ──────────────────────
    'chat.input_placeholder': { en: 'Ask about this screen or directly press send', ar: 'اسأل عن هذه الشاشة أو اضغط إرسال مباشرة' },
    'chat.tell_klypix': { en: 'Tell KLYPIX what to do...', ar: 'أخبر KLYPIX بما يجب فعله...' },
    'chat.tab.canvas': { en: 'CANVAS', ar: 'اللوحة' },
    'chat.tab.chat': { en: 'CHAT', ar: 'محادثة' },
    'chat.pin': { en: 'Pin', ar: 'تثبيت' },
    'chat.unpin': { en: 'Unpin', ar: 'إلغاء التثبيت' },
    'chat.pin_conversation': { en: 'Pin Conversation', ar: 'تثبيت المحادثة' },
    'chat.unpin_delete': { en: 'Unpin & Delete', ar: 'إلغاء التثبيت والحذف' },

    // ── action chip labels (suggestion/insight buttons) ────────────────
    // These cover the most common static fallback labels from
    // contextIntelligence.ts. Gemini-generated chips arrive pre-translated
    // because the suggestions prompt has locale awareness; this map only
    // handles the static fallbacks the model never touched.
    'action.summarize': { en: 'Summarize', ar: 'تلخيص' },
    'action.rewrite': { en: 'Rewrite', ar: 'إعادة صياغة' },
    'action.translate': { en: 'Translate', ar: 'ترجم' },
    'action.extract': { en: 'Extract', ar: 'استخرج' },
    'action.clarify': { en: 'Clarify', ar: 'وضّح' },
    'action.actions': { en: 'Actions', ar: 'إجراءات' },
    'action.risk': { en: 'Risk', ar: 'المخاطر' },
    'action.trading': { en: 'Trading', ar: 'التداول' },
    'action.explain': { en: 'Explain', ar: 'اشرح' },
    'action.compare': { en: 'Compare', ar: 'قارن' },
    'action.diagnose': { en: 'Diagnose', ar: 'شخّص' },
    'action.fix': { en: 'Fix', ar: 'أصلح' },
    'action.improve': { en: 'Improve', ar: 'حسّن' },
    'action.review': { en: 'Review', ar: 'راجع' },
    'action.expand': { en: 'Expand', ar: 'وسّع' },
    'action.shorten': { en: 'Shorten', ar: 'اختصر' },
    'action.proofread': { en: 'Proofread', ar: 'دقّق' },
    'action.analyze': { en: 'Analyze', ar: 'حلّل' },
    'action.refactor': { en: 'Refactor', ar: 'أعد الهيكلة' },
    'action.test': { en: 'Test', ar: 'اختبر' },
    'action.document': { en: 'Document', ar: 'وثّق' },
    'action.reply': { en: 'Reply', ar: 'رُد' },
    'action.draft': { en: 'Draft', ar: 'صياغة' },
    'action.professional': { en: 'Professional', ar: 'احترافي' },
    'action.shorter': { en: 'Shorter', ar: 'أقصر' },
    'action.clearer': { en: 'Clearer', ar: 'أوضح' },
    'chat.compare_documents': { en: 'Compare Documents', ar: 'قارن المستندات' },
    'chat.select_2_files': { en: 'Please select or attach at least 2 files to compare.', ar: 'يُرجى اختيار أو إرفاق ملفين على الأقل للمقارنة.' },
    'chat.toggle_hint': { en: 'to toggle', ar: 'للتبديل' },
    'chat.made_by': { en: 'by', ar: 'بواسطة' },

    // ── canvas discard dialog (replacement for native confirm) ─────────
    'canvas.discard.title': { en: 'Unsaved changes', ar: 'تغييرات غير محفوظة' },
    'canvas.discard.open_another': { en: 'Discard unsaved changes and open another canvas?', ar: 'تجاهل التغييرات غير المحفوظة وفتح لوحة أخرى؟' },
    'canvas.discard.new': { en: 'Discard unsaved changes and start a new canvas?', ar: 'تجاهل التغييرات غير المحفوظة وبدء لوحة جديدة؟' },
    'canvas.discard.open_requested': { en: 'Open the requested canvas? Unsaved changes will be lost.', ar: 'فتح اللوحة المطلوبة؟ ستُفقد التغييرات غير المحفوظة.' },
    'canvas.discard.restore_session': { en: 'Unsaved canvas found from a previous session. Restore?', ar: 'تم العثور على لوحة غير محفوظة من جلسة سابقة. هل تريد استعادتها؟' },
    'canvas.thread.clear_q': { en: 'Clear this thread? Messages are saved in the file.', ar: 'مسح هذا الموضوع؟ الرسائل محفوظة داخل الملف.' },
    'canvas.template.delete_q': { en: 'Delete template', ar: 'حذف القالب' },
    'canvas.version.restore_q': { en: 'Restore this version?', ar: 'استعادة هذا الإصدار؟' },
    'canvas.version.restore_warn': { en: 'The current canvas will be replaced. (You can save again afterwards to create a new version.)', ar: 'ستُستبدل اللوحة الحالية. (يمكنك الحفظ مرة أخرى لاحقًا لإنشاء إصدار جديد.)' },
    'canvas.leave_shared_q': { en: 'Remove from your shared list?', ar: 'إزالة من قائمة المشاركة؟' },
    'canvas.leave_shared_warn': { en: "You won't be able to open it again unless the owner re-invites you. Your local downloaded copy (if any) is not affected.", ar: 'لن تتمكن من فتحها مرة أخرى ما لم يُعِد المالك دعوتك. لن تتأثر نسختك المحلية (إن وُجدت).' },
    'canvas.this_canvas': { en: 'this canvas', ar: 'هذه اللوحة' },
};

const LS_KEY = 'klypix:locale';
const CHANGE_EVENT = 'klypix:locale:change';

function readStoredLocale(): Locale | null {
    try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null;
        if (raw === 'en' || raw === 'ar') return raw;
    } catch { /* ignore */ }
    return null;
}

function detectLocale(): Locale {
    const stored = readStoredLocale();
    if (stored) return stored;
    if (typeof navigator === 'undefined' || !navigator.language) return 'en';
    const tag = navigator.language.toLowerCase();
    if (tag.startsWith('ar')) return 'ar';
    return 'en';
}

// Module-level mutable cache. Updated by setLocale, read by t() and getLocale().
let currentLocale: Locale = detectLocale();

function applyLocaleToDom(loc: Locale) {
    if (typeof document === 'undefined') return;
    document.documentElement.dir = loc === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = loc;
}

// Sync the document dir/lang on first import so initial render is correct.
applyLocaleToDom(currentLocale);

export function getLocale(): Locale {
    return currentLocale;
}

export function setLocale(loc: Locale): void {
    if (loc === currentLocale) return;
    currentLocale = loc;
    try { localStorage.setItem(LS_KEY, loc); } catch { /* ignore */ }
    applyLocaleToDom(loc);
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event(CHANGE_EVENT));
    }
}

export function t(key: keyof typeof strings): string {
    const entry = strings[key];
    if (!entry) return key;
    return entry[currentLocale] ?? entry.en ?? key;
}

// Translate a free-form action-chip label (from contextIntelligence.ts
// static fallbacks) by looking it up in the action.* namespace. Falls
// through to the original label if no translation exists — so unknown
// or model-generated labels render unchanged.
export function translateActionLabel(label: string): string {
    if (currentLocale === 'en') return label;
    const key = `action.${label.toLowerCase().replace(/\s+/g, '_')}` as keyof typeof strings;
    const entry = strings[key];
    if (entry) return entry[currentLocale] ?? label;
    return label;
}

// React hook — components that need to re-render on locale switch subscribe
// via this. Non-React callers can keep using getLocale() / t() directly.
export function useLocale(): [Locale, (l: Locale) => void] {
    const [loc, setLoc] = useState<Locale>(currentLocale);
    useEffect(() => {
        const handler = () => setLoc(currentLocale);
        window.addEventListener(CHANGE_EVENT, handler);
        return () => window.removeEventListener(CHANGE_EVENT, handler);
    }, []);
    return [loc, setLocale];
}
