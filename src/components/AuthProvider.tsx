import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AuthUser {
    id: string;
    email: string;
    displayName: string;
    tier: 'free' | 'pro' | 'team' | 'enterprise' | 'admin';
    licenseKey: string | null;
    queriesToday: number;
    queriesTotal: number;
    avatarUrl: string | null;
}

export interface TierLimits {
    queriesPerDay: number;
    deepMode: boolean;
    agentMode: boolean;
    docGeneration: boolean;
    imageGeneration: boolean;
}

interface AuthContextType {
    user: AuthUser | null;
    isLoading: boolean;
    isAuthenticated: boolean;
    error: string | null;
    // Actions
    signIn: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
    signUp: (email: string, password: string, displayName: string) => Promise<{ success: boolean; error?: string; needsEmailConfirmation?: boolean }>;
    signInWithGoogle: () => Promise<{ success: boolean; error?: string }>;
    signInWithMicrosoft: () => Promise<{ success: boolean; error?: string }>;
    activateLicense: (key: string) => Promise<{ success: boolean; error?: string }>;
    signOut: () => Promise<void>;
    refreshUser: () => Promise<void>;
    resetPassword: (email: string) => Promise<{ success: boolean; error?: string }>;
    // Tier checks
    canUse: (feature: keyof TierLimits) => boolean;
    tierLimits: TierLimits;
}

const AuthContext = createContext<AuthContextType | null>(null);

// ── Default tier limits (free) ───────────────────────────────────────────────
const FREE_LIMITS: TierLimits = {
    queriesPerDay: 50,
    deepMode: false,
    agentMode: false,
    docGeneration: false,
    imageGeneration: false,
};

const UNLIMITED: TierLimits = {
    queriesPerDay: -1,
    deepMode: true,
    agentMode: true,
    docGeneration: true,
    imageGeneration: true,
};

function getLimitsForTier(tier: string): TierLimits {
    if (tier === 'free') return FREE_LIMITS;
    return UNLIMITED;
}

// ── Provider ─────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<AuthUser | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [tierLimits, setTierLimits] = useState<TierLimits>(FREE_LIMITS);

    // Restore session on mount
    useEffect(() => {
        (async () => {
            try {
                const result = await (window as any).electron.auth.restoreSession();
                if (result.success && result.user) {
                    setUser(result.user);
                    setTierLimits(getLimitsForTier(result.user.tier));
                }
            } catch {
                // No session or not configured — stay on login screen
            } finally {
                setIsLoading(false);
            }
        })();

        // Listen for OAuth callback completion
        const cleanup = (window as any).electron.auth.onOAuthComplete((result: any) => {
            if (result.success && result.user) {
                setUser(result.user);
                setTierLimits(getLimitsForTier(result.user.tier));
                setError(null);
            } else if (result.error) {
                setError(result.error);
            }
        });

        return () => cleanup();
    }, []);

    const signIn = useCallback(async (email: string, password: string) => {
        setError(null);
        const result = await (window as any).electron.auth.signIn(email, password);
        if (result.success && result.user) {
            setUser(result.user);
            setTierLimits(getLimitsForTier(result.user.tier));
        } else if (result.error) {
            setError(result.error);
        } else if (result.success && !result.user) {
            setError('Sign in succeeded, but your profile is missing from the database. This usually means you created the user manually before running the SQL setup.');
        }
        return result;
    }, []);

    const signUp = useCallback(async (email: string, password: string, displayName: string) => {
        setError(null);
        const result = await (window as any).electron.auth.signUp(email, password, displayName);
        if (result.success && result.user) {
            setUser(result.user);
            setTierLimits(getLimitsForTier(result.user.tier));
        } else if (result.error) {
            setError(result.error);
        } else if (result.success && !result.user && !result.needsEmailConfirmation) {
            setError('Account created, but database profile could not be generated.');
        }
        return result;
    }, []);

    const signInWithGoogle = useCallback(async () => {
        setError(null);
        const result = await (window as any).electron.auth.signInWithOAuth('google');
        if (result.error) setError(result.error);
        return result;
    }, []);

    const signInWithMicrosoft = useCallback(async () => {
        setError(null);
        const result = await (window as any).electron.auth.signInWithOAuth('azure');
        if (result.error) setError(result.error);
        return result;
    }, []);

    const activateLicense = useCallback(async (key: string) => {
        setError(null);
        const result = await (window as any).electron.auth.activateLicense(key);
        if (result.success && result.user) {
            setUser(result.user);
            setTierLimits(getLimitsForTier(result.user.tier));
        } else if (result.error) {
            setError(result.error);
        }
        return result;
    }, []);

    const handleSignOut = useCallback(async () => {
        await (window as any).electron.auth.signOut();
        setUser(null);
        setTierLimits(FREE_LIMITS);
        setError(null);
    }, []);

    const refreshUser = useCallback(async () => {
        const result = await (window as any).electron.auth.refreshUser();
        if (result.success && result.user) {
            setUser(result.user);
            setTierLimits(getLimitsForTier(result.user.tier));
        }
    }, []);

    const resetPasswordFn = useCallback(async (email: string) => {
        setError(null);
        const result = await (window as any).electron.auth.resetPassword(email);
        if (result.error) setError(result.error);
        return result;
    }, []);

    const canUse = useCallback((feature: keyof TierLimits) => {
        const value = tierLimits[feature];
        if (typeof value === 'boolean') return value;
        return true;
    }, [tierLimits]);

    const value: AuthContextType = {
        user,
        isLoading,
        isAuthenticated: !!user,
        error,
        signIn,
        signUp,
        signInWithGoogle,
        signInWithMicrosoft,
        activateLicense,
        signOut: handleSignOut,
        refreshUser,
        resetPassword: resetPasswordFn,
        canUse,
        tierLimits,
    };

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used within AuthProvider');
    return ctx;
}
