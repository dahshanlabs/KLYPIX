import { safeStorage, app } from 'electron';
import fs from 'fs';
import path from 'path';

// ── Encrypted Token Store ────────────────────────────────────────────────────
// Uses Electron's safeStorage (Windows Credential Manager / DPAPI) to encrypt
// auth tokens at rest. Even if someone copies the app data folder, they cannot
// extract the token without the user's Windows login session.

// Lazy-init paths — app.getPath() is not available at module load time
let AUTH_DIR = '';
let TOKEN_PATH = '';
let OFFLINE_GRACE_PATH = '';

function initPaths() {
    if (!AUTH_DIR) {
        AUTH_DIR = path.join(app.getPath('userData'), 'auth');
        TOKEN_PATH = path.join(AUTH_DIR, '.session');
        OFFLINE_GRACE_PATH = path.join(AUTH_DIR, '.last_verified');
    }
}

function ensureDir() {
    initPaths();
    if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
    }
}

// ── Session Token ────────────────────────────────────────────────────────────

export function storeSession(session: { access_token: string; refresh_token: string; expires_at?: number; user: any }): void {
    ensureDir();
    if (!safeStorage.isEncryptionAvailable()) {
        // Fallback: store as plain JSON (less secure, but functional)
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(session), 'utf-8');
        return;
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(session));
    fs.writeFileSync(TOKEN_PATH, encrypted);
}

export function getSession(): { access_token: string; refresh_token: string; expires_at?: number; user: any } | null {
    initPaths();
    if (!fs.existsSync(TOKEN_PATH)) return null;
    try {
        const raw = fs.readFileSync(TOKEN_PATH);
        if (safeStorage.isEncryptionAvailable()) {
            const decrypted = safeStorage.decryptString(raw);
            return JSON.parse(decrypted);
        }
        // Fallback: plain JSON
        return JSON.parse(raw.toString('utf-8'));
    } catch {
        return null;
    }
}

export function clearSession(): void {
    initPaths();
    if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
    if (fs.existsSync(OFFLINE_GRACE_PATH)) fs.unlinkSync(OFFLINE_GRACE_PATH);
}

export function hasSession(): boolean {
    initPaths();
    return fs.existsSync(TOKEN_PATH);
}

// ── Offline Grace Period ─────────────────────────────────────────────────────
// Stores the last time the token was verified online.
// If the user is offline, allow up to 7 days of use before requiring re-login.

const OFFLINE_GRACE_DAYS = 7;

export function markVerified(): void {
    ensureDir();
    fs.writeFileSync(OFFLINE_GRACE_PATH, Date.now().toString(), 'utf-8');
}

export function isWithinGracePeriod(): boolean {
    initPaths();
    if (!fs.existsSync(OFFLINE_GRACE_PATH)) return false;
    try {
        const lastVerified = parseInt(fs.readFileSync(OFFLINE_GRACE_PATH, 'utf-8'), 10);
        const daysSince = (Date.now() - lastVerified) / (1000 * 60 * 60 * 24);
        return daysSince <= OFFLINE_GRACE_DAYS;
    } catch {
        return false;
    }
}

// ── Encrypted API Key Storage ───────────────────────────────────────────────

function getApiKeyPath(): string {
    initPaths();
    return path.join(AUTH_DIR, '.api_key');
}

export function storeApiKey(key: string): void {
    ensureDir();
    if (!safeStorage.isEncryptionAvailable()) {
        fs.writeFileSync(getApiKeyPath(), key, 'utf-8');
        return;
    }
    const encrypted = safeStorage.encryptString(key);
    fs.writeFileSync(getApiKeyPath(), encrypted);
}

export function getApiKey(): string | null {
    if (!fs.existsSync(getApiKeyPath())) return null;
    try {
        const raw = fs.readFileSync(getApiKeyPath());
        if (safeStorage.isEncryptionAvailable()) {
            return safeStorage.decryptString(raw);
        }
        return raw.toString('utf-8');
    } catch {
        return null;
    }
}

export function clearApiKey(): void {
    if (fs.existsSync(getApiKeyPath())) fs.unlinkSync(getApiKeyPath());
}
