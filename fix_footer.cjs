const fs = require('fs');
const path = 'e:\\ANTIGRAVITY\\Eye\\src\\App.tsx';

try {
    const content = fs.readFileSync(path, 'utf8');
    const searchString = 'title="Settings"';

    if (content.includes(searchString)) {
        const settingsTitlePos = content.indexOf(searchString);
        const buttonStartPos = content.lastIndexOf('<button', settingsTitlePos);
        
        if (buttonStartPos !== -1) {
            const lineStart = content.lastIndexOf('\n', buttonStartPos) + 1;
            const indentation = content.slice(lineStart, buttonStartPos);
            
            const buttonHtml = `${indentation}<button
${indentation}    onClick={copyFullChat}
${indentation}    disabled={messages.length === 0}
${indentation}    className={cn(
${indentation}        "p-1.5 rounded-lg transition-all",
${indentation}        isCopyFullActive ? "text-emerald-400 bg-emerald-500/10" : "text-white/40 hover:bg-white/10"
${indentation}    )}
${indentation}    title="Copy Full Conversation"
${indentation}>
${indentation}    {isCopyFullActive ? <Check size={14} /> : <Copy size={14} />}
${indentation}</button>\n\n`;

            const newContent = content.slice(0, buttonStartPos) + buttonHtml + content.slice(buttonStartPos);
            fs.writeFileSync(path, newContent);
            console.log('Successfully injected Copy Full Chat button');
        } else {
            console.error('Found title but could not find button start');
            process.exit(1);
        }
    } else {
        console.error('Could not find Settings button title');
        process.exit(1);
    }
} catch (err) {
    console.error('Error:', err);
    process.exit(1);
}
