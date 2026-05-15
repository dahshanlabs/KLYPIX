const fs = require('fs');
const path = 'e:\\ANTIGRAVITY\\Eye\\src\\App.tsx';
try {
    let content = fs.readFileSync(path, 'utf8');
    const searchString = 'title="Settings"';

    const buttonHtml = `                        <button
                            onClick={copyFullChat}
                            disabled={messages.length === 0}
                            className={cn(
                                "p-1.5 rounded-lg transition-all",
                                isCopyFullActive ? "text-emerald-400 bg-emerald-500/10" : "text-white/40 hover:bg-white/10"
                            )}
                            title="Copy Full Conversation"
                        >
                            {isCopyFullActive ? <Check size={14} /> : <Copy size={14} />}
                        </button>\n\n`;

    if (content.includes(searchString)) {
        // Find the <button that contains title="Settings"
        const settingsTitlePos = content.indexOf(searchString);
        const buttonStartPos = content.lastIndexOf('<button', settingsTitlePos);
        
        if (buttonStartPos !== -1) {
            const newContent = content.slice(0, buttonStartPos) + buttonHtml + content.slice(buttonStartPos);
            fs.writeFileSync(path, newContent);
            console.log('Successfully injected Copy Full Chat button');
        } else {
            console.error('Found title but could not find button start');
            process.exit(1);
        }
    } else {
        console.error('Could not find Settings button title in App.tsx');
        process.exit(1);
    }
} catch (err) {
    console.error('FS Error:', err);
    process.exit(1);
}
