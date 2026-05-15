$content = Get-Content "e:\ANTIGRAVITY\Eye\src\App.tsx" -Raw
$old = '                        <button
                            onClick={() => setShowSettings(!showSettings)}'

$new = '                        <button
                            onClick={copyFullChat}
                            disabled={messages.length === 0}
                            className={cn(
                                "p-1.5 rounded-lg transition-all",
                                isCopyFullActive ? "text-emerald-400 bg-emerald-500/10" : "text-white/40 hover:bg-white/10"
                            )}
                            title="Copy Full Conversation"
                        >
                            {isCopyFullActive ? <Check size={14} /> : <Copy size={14} />}
                        </button>

                        <button
                            onClick={() => setShowSettings(!showSettings)}'

if ($content.Contains($old)) {
    $content = $content.Replace($old, $new)
    $content | Set-Content "e:\ANTIGRAVITY\Eye\src\App.tsx" -NoNewline
    Write-Host "Success"
} else {
    Write-Host "Failure: Match not found"
    exit 1
}
