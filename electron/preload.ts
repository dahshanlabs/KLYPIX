import { contextBridge, ipcRenderer, webUtils } from 'electron';

// Expose environment values needed by renderer (Windows username for Desktop path, etc.)
const envInfo = {
    username: process.env.USERNAME || process.env.USER || 'user',
    userprofile: process.env.USERPROFILE || `C:\\Users\\${process.env.USERNAME || 'user'}`,
    desktop: `${process.env.USERPROFILE || `C:\\Users\\${process.env.USERNAME || 'user'}`}\\Desktop`,
};

contextBridge.exposeInMainWorld('klypixEnv', envInfo);

contextBridge.exposeInMainWorld('electron', {
    captureScreen: () => ipcRenderer.invoke('capture-screen'),
    captureScreenRaw: () => ipcRenderer.invoke('capture-screen-raw'),
    hideWindow: () => ipcRenderer.send('hide-window'),
    showWindow: () => ipcRenderer.send('show-window'),
    focusWindow: () => ipcRenderer.invoke('focus-window'),
    minimizeWindow: () => ipcRenderer.send('minimize-window'),
    toggleMaximize: () => ipcRenderer.invoke('toggle-maximize'),
    isMaximized: () => ipcRenderer.invoke('is-maximized'),
    windowDragStart: () => ipcRenderer.send('window:drag-start'),
    windowDragEnd: () => ipcRenderer.send('window:drag-end'),
    canvas: {
        setFullscreen: (enable: boolean) => ipcRenderer.invoke('canvas:set-fullscreen', enable),
        isFullscreen: () => ipcRenderer.invoke('canvas:is-fullscreen'),
        save: (args: { filePath: string; json: string; assets?: Array<{ path: string; base64: string }> }) => ipcRenderer.invoke('canvas:save', args),
        saveAs: (args: { json: string; defaultName?: string; assets?: Array<{ path: string; base64: string }> }) => ipcRenderer.invoke('canvas:save-as', args),
        // v4 .klypix save channels — separate from v3 because the payload shape
        // is fundamentally different (per-item JSON map vs single canvas.json).
        saveKlypix: (args: {
            filePath: string;
            manifestJson: string;
            canvasJson: string;
            items: Record<string, string>;
            assets?: Array<{ path: string; base64: string }>;
        }) => ipcRenderer.invoke('canvas:save-klypix', args),
        saveKlypixAs: (args: {
            defaultName?: string;
            manifestJson: string;
            canvasJson: string;
            items: Record<string, string>;
            assets?: Array<{ path: string; base64: string }>;
        }) => ipcRenderer.invoke('canvas:save-klypix-as', args),
        // Embed subsystem v0 — extract + launch + watch + re-pack.
        // Renderer calls openAndWatch with the bytes + the canvas's filePath;
        // main extracts to a canvas-scoped working dir, launches the OS app,
        // and starts a watcher that re-packs into the .klypix on save.
        embedOpenAndWatch: (args: {
            canvasFilePath: string;
            itemId: string;
            assetPath: string;
            fileName: string;
            base64: string;
        }) => ipcRenderer.invoke('canvas:embed:open-and-watch', args),
        embedStopWatching: (workingPath: string) => ipcRenderer.invoke('canvas:embed:stop-watching', { workingPath }),
        embedCleanupCanvas: (canvasFilePath: string, deleteWorkingDir = false) =>
            ipcRenderer.invoke('canvas:embed:cleanup-canvas', { canvasFilePath, deleteWorkingDir }),
        readRawBytes: (filePath: string) => ipcRenderer.invoke('canvas:read-raw-bytes', { filePath }),
        onEmbedSyncState: (cb: (evt: { itemId: string; canvasFilePath: string; kind: 'syncing' | 'synced' | 'error'; error?: string }) => void) => {
            const l = (_: any, evt: any) => cb(evt);
            ipcRenderer.on('canvas:embed:sync-state', l);
            return () => ipcRenderer.removeListener('canvas:embed:sync-state', l);
        },
        open: () => ipcRenderer.invoke('canvas:open'),
        openByPath: (filePath: string) => ipcRenderer.invoke('canvas:open-by-path', filePath),
        autosave: (args: { json: string; assets?: Array<{ path: string; base64: string }> }) => ipcRenderer.invoke('canvas:autosave', args),
        checkAutosave: () => ipcRenderer.invoke('canvas:check-autosave'),
        clearAutosave: () => ipcRenderer.invoke('canvas:clear-autosave'),
        openPath: (filePath: string) => ipcRenderer.invoke('canvas:open-path', filePath),
        openAssetBytes: (args: { fileName: string; base64: string }) => ipcRenderer.invoke('canvas:open-asset-bytes', args),
        readSandboxFileBytes: (sandboxPath: string) => ipcRenderer.invoke('canvas:read-sandbox-file-bytes', sandboxPath),
        compileBytes: (args: { format: 'pdf' | 'docx' | 'pptx' | 'xlsx'; spec?: any; content?: string; fileName?: string }) =>
            ipcRenderer.invoke('canvas:compile-bytes', args),
        fetchLinkMetadata: (url: string) => ipcRenderer.invoke('canvas:fetch-link-metadata', url),
        listVersions: (filePath: string) => ipcRenderer.invoke('canvas:list-versions', filePath),
        loadVersion: (args: { filePath: string; versionPath: string }) => ipcRenderer.invoke('canvas:load-version', args),
        claimClipboard: (willWriteText: boolean) => ipcRenderer.invoke('canvas:claim-clipboard', willWriteText),
        readAsset: (args: { filePath: string; assetPath: string }) => ipcRenderer.invoke('canvas:read-asset', args),
        evictAssetCache: (filePath: string) => ipcRenderer.invoke('canvas:evict-asset-cache', filePath),
        onFileOpened: (cb: (filePath: string) => void) => {
            const l = (_: any, p: string) => cb(p);
            ipcRenderer.on('canvas:file-opened', l);
            return () => ipcRenderer.removeListener('canvas:file-opened', l);
        },
    },
    resizeWindow: (height: number, width?: number) => ipcRenderer.send('resize-window', height, width),
    setIgnoreMouseEvents: (ignore: boolean, options?: any) => ipcRenderer.send('set-ignore-mouse-events', ignore, options),
    getCursorPosition: () => ipcRenderer.invoke('get-cursor-position'),
    getPrimaryDisplaySize: () => ipcRenderer.invoke('get-primary-display-size'),
    getWorkAreaSize: () => ipcRenderer.invoke('get-work-area-size'),
    launchNativeSnipping: () => ipcRenderer.invoke('launch-native-snipping'),
    copyToClipboard: (data: any) => ipcRenderer.send('copy-to-clipboard', data),
    getShortcut: () => ipcRenderer.invoke('get-shortcut'),
    setShortcut: (shortcut: string) => ipcRenderer.invoke('set-shortcut', shortcut),
    readActiveFile: () => ipcRenderer.invoke('read-active-file'),
    readFileByTitle: (title: string) => ipcRenderer.invoke('read-file-by-title', title),
    getAllOpenFiles: () => ipcRenderer.invoke('get-all-open-files'),
    readMultipleFiles: (files: any[]) => ipcRenderer.invoke('read-multiple-files', files),
    readPdfWithPassword: (filePath: string, password: string) => ipcRenderer.invoke('read-pdf-with-password', filePath, password),
    enableCdp: () => ipcRenderer.invoke('enable-cdp'),
    restartBrowser: (browser: string) => ipcRenderer.invoke('restart-browser', browser),
    checkBrowsersNeedCdp: () => ipcRenderer.invoke('check-browsers-need-cdp'),
    autoRestartBrowsersForCdp: () => ipcRenderer.invoke('auto-restart-browsers-for-cdp'),
    lightFetchAll: (files: any[]) => ipcRenderer.invoke('light-fetch-all', files),
    readWebContent: (params: { url: string; title: string; maxChars?: number }) => ipcRenderer.invoke('read-web-content', params),
    readWebContentClipboard: (params: { title: string }) => ipcRenderer.invoke('read-web-content-clipboard', params),
    extractBrowserUrl: () => ipcRenderer.invoke('extract-browser-url'),
    lookupBrowserUrl: (params: { title: string }) => ipcRenderer.invoke('lookup-browser-url', params),
    openExternal: (url: string) => ipcRenderer.send('open-external', url),
    onWindowResizing: (callback: (isResizing: boolean) => void) => {
        const listener = (_: any, isResizing: boolean) => callback(isResizing);
        ipcRenderer.on('window-resizing', listener);
        return () => ipcRenderer.removeListener('window-resizing', listener);
    },
    onMaximizeStateChanged: (callback: (isMaximized: boolean) => void) => {
        const listener = (_: any, isMaximized: boolean) => callback(isMaximized);
        ipcRenderer.on('maximize-state-changed', listener);
        return () => ipcRenderer.removeListener('maximize-state-changed', listener);
    },
    getActiveWindowContext: () => ipcRenderer.invoke('get-active-window-context'),
    onPreCapture: (callback: (data: any) => void) => {
        const listener = (_: any, data: any) => callback(data);
        ipcRenderer.on('pre-capture', listener);
        return () => ipcRenderer.removeListener('pre-capture', listener);
    },
    getCdpStatus: () => ipcRenderer.invoke('get-cdp-status'),
    openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
    validateDroppedFiles: (paths: string[]) => ipcRenderer.invoke('validate-dropped-files', paths),
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    // ── Agent Mode ──────────────────────────────────────────────────────────
    executeAction: (intent: any) => ipcRenderer.invoke('eye:execute-action', intent),
    readClipboard: () => ipcRenderer.invoke('read-clipboard'),
    getClipboardFormats: () => ipcRenderer.invoke('get-clipboard-formats'),
    readFileBytes: (filePath: string) => ipcRenderer.invoke('read-file-bytes', { filePath }),
    // ── Encrypted API Key Storage ────────────────────────────────────────
    apiKey: {
        store: (key: string) => ipcRenderer.invoke('api-key:store', key),
        get: () => ipcRenderer.invoke('api-key:get'),
        clear: () => ipcRenderer.invoke('api-key:clear'),
    },
    // ── Agent Engine (Claude) ────────────────────────────────────────────
    agent: {
        runShell: (opts: { command: string; timeout?: number }) =>
            ipcRenderer.invoke('run-shell-command', opts),
        readFile: (opts: { filePath: string; maxChars?: number }) =>
            ipcRenderer.invoke('read-file-at-path', opts),
        writeFile: (opts: { filePath: string; content: string }) =>
            ipcRenderer.invoke('write-file-at-path', opts),
        editFile: (opts: { filePath: string; oldText: string; newText: string }) =>
            ipcRenderer.invoke('edit-file-content', opts),
        listDir: (opts: { dirPath: string }) =>
            ipcRenderer.invoke('list-directory', opts),
    },
    claudeKey: {
        store: (key: string) => ipcRenderer.invoke('claude-key:store', key),
        get: () => ipcRenderer.invoke('claude-key:get'),
        clear: () => ipcRenderer.invoke('claude-key:clear'),
    },
    deepseekKey: {
        store: (key: string) => ipcRenderer.invoke('deepseek-key:store', key),
        get: () => ipcRenderer.invoke('deepseek-key:get'),
        clear: () => ipcRenderer.invoke('deepseek-key:clear'),
    },
    file: {
        exists: (filePath: string) => ipcRenderer.invoke('file:exists', { filePath }),
    },
    agentSettings: {
        getBudget: () => ipcRenderer.invoke('agent:get-budget'),
        setBudget: (value: number) => ipcRenderer.invoke('agent:set-budget', { value }),
        getDailySpend: () => ipcRenderer.invoke('agent:get-daily-spend'),
        addDailySpend: (amount: number) => ipcRenderer.invoke('agent:add-daily-spend', { amount }),
        resetDailySpend: () => ipcRenderer.invoke('agent:reset-daily-spend'),
        getCostHistory: () => ipcRenderer.invoke('agent:get-cost-history'),
        getEnabled: () => ipcRenderer.invoke('agent:get-enabled'),
        setEnabled: (value: boolean) => ipcRenderer.invoke('agent:set-enabled', { value }),
    },
    // ── WSL2 Sandbox ────────────────────────────────────────────────────────
    sandbox: {
        getStatus: () => ipcRenderer.invoke('sandbox:status'),
        execute: (request: any) => ipcRenderer.invoke('sandbox:execute', request),
        readFile: (path: string) => ipcRenderer.invoke('sandbox:readFile', path),
        writeFile: (path: string, content: string) => ipcRenderer.invoke('sandbox:writeFile', path, content),
        listDir: (path: string) => ipcRenderer.invoke('sandbox:listDir', path),
        deleteFile: (path: string) => ipcRenderer.invoke('sandbox:deleteFile', path),
        copyFromShared: (filename: string, destination?: string) => ipcRenderer.invoke('sandbox:copyFromShared', filename, destination),
        saveToShared: (sourcePath: string, filename?: string) => ipcRenderer.invoke('sandbox:saveToShared', sourcePath, filename),
        resetWorkspace: () => ipcRenderer.invoke('sandbox:resetWorkspace'),
        approvalResponse: (approved: boolean) => ipcRenderer.invoke('sandbox:approvalResponse', approved),
        onApprovalRequest: (callback: (request: any) => void) => {
            ipcRenderer.on('sandbox:approval-request', (_e: any, request: any) => callback(request));
        },
        onStatus: (callback: (status: any) => void) => {
            ipcRenderer.on('sandbox:status', (_e: any, status: any) => callback(status));
        },
        onStream: (callback: (event: any) => void) => {
            ipcRenderer.on('sandbox:stream', (_e: any, event: any) => callback(event));
        },
    },
    // ── MCP (Model Context Protocol) ────────────────────────────────────────
    mcp: {
        listTools: () => ipcRenderer.invoke('mcp:list-tools'),
        executeTool: (opts: { serverName: string; toolName: string; args: Record<string, any> }) =>
            ipcRenderer.invoke('mcp:execute-tool', opts),
        getServers: () => ipcRenderer.invoke('mcp:get-servers'),
        connectServer: (config: any) => ipcRenderer.invoke('mcp:connect-server', config),
        disconnectServer: (name: string) => ipcRenderer.invoke('mcp:disconnect-server', { name }),
        addServer: (config: any) => ipcRenderer.invoke('mcp:add-server', config),
        removeServer: (name: string) => ipcRenderer.invoke('mcp:remove-server', { name }),
        getConfigPath: () => ipcRenderer.invoke('mcp:get-config-path'),
        getConfigs: () => ipcRenderer.invoke('mcp:get-configs'),
    },
    // ── Document Generation ────────────────────────────────────────────────
    generateFile: (opts: any) => ipcRenderer.invoke('generate-file', opts),
    // ── Updater ──────────────────────────────────────────────────────────────
    updater: {
        check: () => ipcRenderer.invoke('updater:check'),
        install: () => ipcRenderer.invoke('updater:install'),
        getVersion: () => ipcRenderer.invoke('updater:get-version'),
        onChecking: (cb: () => void) => {
            const listener = () => cb();
            ipcRenderer.on('update:checking', listener);
            return () => ipcRenderer.removeListener('update:checking', listener);
        },
        onAvailable: (cb: (info: any) => void) => {
            const listener = (_: any, info: any) => cb(info);
            ipcRenderer.on('update:available', listener);
            return () => ipcRenderer.removeListener('update:available', listener);
        },
        onNotAvailable: (cb: () => void) => {
            const listener = () => cb();
            ipcRenderer.on('update:not-available', listener);
            return () => ipcRenderer.removeListener('update:not-available', listener);
        },
        onProgress: (cb: (progress: any) => void) => {
            const listener = (_: any, progress: any) => cb(progress);
            ipcRenderer.on('update:progress', listener);
            return () => ipcRenderer.removeListener('update:progress', listener);
        },
        onDownloaded: (cb: (info: any) => void) => {
            const listener = (_: any, info: any) => cb(info);
            ipcRenderer.on('update:downloaded', listener);
            return () => ipcRenderer.removeListener('update:downloaded', listener);
        },
        onError: (cb: (err: any) => void) => {
            const listener = (_: any, err: any) => cb(err);
            ipcRenderer.on('update:error', listener);
            return () => ipcRenderer.removeListener('update:error', listener);
        },
    },
    // ── Auth ─────────────────────────────────────────────────────────────────
    auth: {
        restoreSession: () => ipcRenderer.invoke('auth:restore-session'),
        signIn: (email: string, password: string) => ipcRenderer.invoke('auth:sign-in', { email, password }),
        signUp: (email: string, password: string, displayName?: string) => ipcRenderer.invoke('auth:sign-up', { email, password, displayName }),
        signInWithOAuth: (provider: string) => ipcRenderer.invoke('auth:sign-in-oauth', { provider }),
        activateLicense: (key: string) => ipcRenderer.invoke('auth:activate-license', { key }),
        signOut: () => ipcRenderer.invoke('auth:sign-out'),
        getUser: () => ipcRenderer.invoke('auth:get-user'),
        refreshUser: () => ipcRenderer.invoke('auth:refresh-user'),
        getTierLimits: (tier: string) => ipcRenderer.invoke('auth:get-tier-limits', { tier }),
        canUseFeature: (tier: string, feature: string) => ipcRenderer.invoke('auth:can-use-feature', { tier, feature }),
        isQueryAllowed: (tier: string, queriesToday: number) => ipcRenderer.invoke('auth:is-query-allowed', { tier, queriesToday }),
        trackUsage: (event: any) => ipcRenderer.invoke('auth:track-usage', event),
        resetPassword: (email: string) => ipcRenderer.invoke('auth:reset-password', { email }),
        onOAuthComplete: (callback: (result: any) => void) => {
            const listener = (_: any, result: any) => callback(result);
            ipcRenderer.on('auth:oauth-complete', listener);
            return () => ipcRenderer.removeListener('auth:oauth-complete', listener);
        },
    },
    cloud: {
        upload: (envelope: Uint8Array, titleHint: string | null) =>
            ipcRenderer.invoke('canvas-cloud:upload', envelope, titleHint),
        replace: (id: string, envelope: Uint8Array, titleHint: string | null) =>
            ipcRenderer.invoke('canvas-cloud:replace', id, envelope, titleHint),
        download: (id: string) => ipcRenderer.invoke('canvas-cloud:download', id),
        list: () => ipcRenderer.invoke('canvas-cloud:list'),
        delete: (id: string) => ipcRenderer.invoke('canvas-cloud:delete', id),
        createShareToken: (blobId: string) =>
            ipcRenderer.invoke('canvas-cloud:create-share-token', blobId),
        createInvitation: (args: { blobId: string; email?: string; titleHint?: string }) =>
            ipcRenderer.invoke('canvas-cloud:create-invitation', args),
        listInvitations: (blobId: string) =>
            ipcRenderer.invoke('canvas-cloud:list-invitations', blobId),
        revokeInvitation: (token: string) =>
            ipcRenderer.invoke('canvas-cloud:revoke-invitation', token),
        listCollaborators: (blobId: string) =>
            ipcRenderer.invoke('canvas-cloud:list-collaborators', blobId),
        removeCollaborator: (args: { blobId: string; userId: string }) =>
            ipcRenderer.invoke('canvas-cloud:remove-collaborator', args),
        pushOps: (args: { blobId: string; deviceId: string; ops: any[] }) =>
            ipcRenderer.invoke('canvas-cloud:push-ops', args),
        pullOps: (args: { blobId: string; sinceSeq: number }) =>
            ipcRenderer.invoke('canvas-cloud:pull-ops', args),
        listShared: () =>
            ipcRenderer.invoke('canvas-cloud:list-shared'),
    },
});
