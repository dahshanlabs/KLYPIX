import React, { useState, useEffect } from 'react';
import { useAuth } from './AuthProvider';
import { Eye, EyeOff, ArrowLeft, Loader2, KeyRound, Mail, Lock, User } from 'lucide-react';

type View = 'login' | 'signup' | 'forgot-password' | 'license' | 'email-confirmation';

// ── Stable sub-components (defined outside LoginScreen to prevent re-creation) ──

function InputField({ icon: Icon, type = 'text', placeholder, value, onChange, showPassword, onTogglePassword }: {
    icon: any; type?: string; placeholder: string; value: string; onChange: (v: string) => void;
    showPassword?: boolean; onTogglePassword?: () => void;
}) {
    const inputType = type === 'password' && showPassword ? 'text' : type;
    return (
        <div className="relative">
            <Icon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
            <input
                type={inputType}
                placeholder={placeholder}
                value={value}
                onChange={e => onChange(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-lg pl-10 pr-4 py-3 text-white text-sm placeholder-white/30 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30 transition-all"
            />
            {type === 'password' && onTogglePassword && (
                <button
                    type="button"
                    onClick={onTogglePassword}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60 transition-colors"
                >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
            )}
        </div>
    );
}

function GoogleIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
            <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
            <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
            <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
            <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
        </svg>
    );
}

function MicrosoftIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 21 21" xmlns="http://www.w3.org/2000/svg">
            <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
            <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
            <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
            <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
        </svg>
    );
}

function Divider() {
    return (
        <div className="flex items-center gap-3 my-5">
            <div className="flex-1 h-px bg-white/10" />
            <span className="text-white/30 text-xs uppercase tracking-wider">or</span>
            <div className="flex-1 h-px bg-white/10" />
        </div>
    );
}

// ── LoginScreen ──────────────────────────────────────────────────────────────

export function LoginScreen({ trialExpired }: { trialExpired?: boolean } = {}) {
    const auth = useAuth();
    const [view, setView] = useState<View>('login');

    // Resize window to fit full login screen (signature is resizeWindow(height, width))
    // Max enforced in main: height 980, width 750. Need tall window to fit logo, trial banner,
    // OAuth buttons, email/password, links, and "Activate with license key".
    useEffect(() => {
        (window as any).electron?.resizeWindow?.(900, 520);
    }, []);

    // Form state
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [licenseKey, setLicenseKey] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [localError, setLocalError] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);

    const error = localError || auth.error;

    const clearForm = () => {
        setEmail('');
        setPassword('');
        setDisplayName('');
        setLicenseKey('');
        setLocalError(null);
        setSuccessMessage(null);
    };

    const handleSignIn = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!email || !password) { setLocalError('Please fill in all fields'); return; }
        setIsSubmitting(true);
        setLocalError(null);
        const result = await auth.signIn(email, password);
        if (!result.success) setLocalError(result.error || 'Sign in failed');
        setIsSubmitting(false);
    };

    const handleSignUp = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!email || !password || !displayName) { setLocalError('Please fill in all fields'); return; }
        if (password.length < 6) { setLocalError('Password must be at least 6 characters'); return; }
        setIsSubmitting(true);
        setLocalError(null);
        const result = await auth.signUp(email, password, displayName);
        if (result.needsEmailConfirmation) {
            setView('email-confirmation');
        } else if (!result.success) {
            setLocalError(result.error || 'Sign up failed');
        }
        setIsSubmitting(false);
    };

    const handleOAuth = async (provider: 'google' | 'microsoft') => {
        setIsSubmitting(true);
        setLocalError(null);
        if (provider === 'google') {
            await auth.signInWithGoogle();
        } else {
            await auth.signInWithMicrosoft();
        }
        setIsSubmitting(false);
    };

    const handleForgotPassword = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!email) { setLocalError('Please enter your email'); return; }
        setIsSubmitting(true);
        setLocalError(null);
        const result = await auth.resetPassword(email);
        if (result.success) {
            setSuccessMessage('Password reset email sent. Check your inbox.');
        } else {
            setLocalError(result.error || 'Failed to send reset email');
        }
        setIsSubmitting(false);
    };

    const handleLicenseActivation = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!licenseKey.trim()) { setLocalError('Please enter a license key'); return; }
        setIsSubmitting(true);
        setLocalError(null);
        const result = await auth.activateLicense(licenseKey.trim());
        if (result.success) {
            setSuccessMessage('License activated successfully!');
        } else {
            setLocalError(result.error || 'Activation failed');
        }
        setIsSubmitting(false);
    };

    const togglePassword = () => setShowPassword(p => !p);

    return (
        <div className="h-screen w-screen bg-[#0a0a0a] flex flex-col overflow-y-auto select-none" style={{ WebkitAppRegion: 'drag' } as any}>
            {/* Title bar */}
            <div className="flex items-center justify-between px-4 py-2 shrink-0" style={{ WebkitAppRegion: 'drag' } as any}>
                <span className="text-white/40 text-xs font-bold tracking-wider uppercase">Klypix</span>
                <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as any}>
                    <button onClick={() => (window as any).electron?.minimizeWindow?.()} className="p-1.5 hover:bg-white/10 rounded transition-all text-white/40 hover:text-white cursor-pointer" title="Minimize">
                        <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
                    </button>
                    <button onClick={() => (window as any).electron?.hideWindow?.()} className="p-1.5 hover:bg-red-500/20 rounded transition-all text-white/40 hover:text-red-400 cursor-pointer" title="Close">
                        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.5"/></svg>
                    </button>
                </div>
            </div>

            <div className="flex-1 flex items-center justify-center overflow-y-auto">
            <div className="w-full max-w-sm px-6 py-4" style={{ WebkitAppRegion: 'no-drag' } as any}>

                {/* Logo */}
                <div className="text-center mb-6">
                    <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                        <img src="./logo.png" alt="Klypix" className="w-8 h-8" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                    </div>
                    <h1 className="text-xl font-bold tracking-wider text-white font-[Outfit] uppercase">Klypix</h1>
                    <p className="text-white/40 text-sm mt-1">AI Desktop Assistant</p>
                    {trialExpired && (
                        <div className="mt-3 px-4 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                            <p className="text-amber-400 text-xs text-center">Your free trial has ended. Sign in to continue using Klypix.</p>
                        </div>
                    )}
                </div>

                {/* ── Login ──────────────────────────────────────────────── */}
                {view === 'login' && (
                    <div className="space-y-4">
                        <div className="space-y-2.5">
                            <button onClick={() => handleOAuth('google')} disabled={isSubmitting} className="w-full flex items-center justify-center gap-3 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 rounded-lg py-3 text-white/80 text-sm font-medium transition-all disabled:opacity-50 cursor-pointer">
                                <GoogleIcon /> Sign in with Google
                            </button>
                            <button onClick={() => handleOAuth('microsoft')} disabled={isSubmitting} className="w-full flex items-center justify-center gap-3 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 rounded-lg py-3 text-white/80 text-sm font-medium transition-all disabled:opacity-50 cursor-pointer">
                                <MicrosoftIcon /> Sign in with Microsoft
                            </button>
                        </div>
                        <Divider />
                        <form onSubmit={handleSignIn} className="space-y-3">
                            <InputField icon={Mail} type="email" placeholder="Email" value={email} onChange={setEmail} />
                            <InputField icon={Lock} type="password" placeholder="Password" value={password} onChange={setPassword} showPassword={showPassword} onTogglePassword={togglePassword} />
                            {error && <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2.5 text-red-400 text-sm">{error}</div>}
                            <button type="submit" disabled={isSubmitting} className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg py-3 text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer">
                                {isSubmitting && <Loader2 size={16} className="animate-spin" />} Sign In
                            </button>
                        </form>
                        <div className="flex items-center justify-between mt-4">
                            <button onClick={() => { clearForm(); setView('forgot-password'); }} className="text-white/40 hover:text-emerald-400 text-xs transition-colors cursor-pointer">Forgot password?</button>
                            <button onClick={() => { clearForm(); setView('signup'); }} className="text-white/40 hover:text-emerald-400 text-xs transition-colors cursor-pointer">Create account</button>
                        </div>
                        <Divider />
                        <button onClick={() => { clearForm(); setView('license'); }} className="w-full flex items-center justify-center gap-2 text-white/40 hover:text-white/70 text-sm transition-colors cursor-pointer">
                            <KeyRound size={14} /> Activate with license key
                        </button>
                    </div>
                )}

                {/* ── Sign Up ────────────────────────────────────────────── */}
                {view === 'signup' && (
                    <div className="space-y-4">
                        <button onClick={() => { clearForm(); setView('login'); }} className="flex items-center gap-1.5 text-white/40 hover:text-white/70 text-sm transition-colors mb-4 cursor-pointer">
                            <ArrowLeft size={14} /> Back
                        </button>
                        <h2 className="text-lg font-medium text-white mb-2">Create your account</h2>
                        <div className="space-y-2.5">
                            <button onClick={() => handleOAuth('google')} disabled={isSubmitting} className="w-full flex items-center justify-center gap-3 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 rounded-lg py-3 text-white/80 text-sm font-medium transition-all disabled:opacity-50 cursor-pointer">
                                <GoogleIcon /> Sign in with Google
                            </button>
                            <button onClick={() => handleOAuth('microsoft')} disabled={isSubmitting} className="w-full flex items-center justify-center gap-3 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 rounded-lg py-3 text-white/80 text-sm font-medium transition-all disabled:opacity-50 cursor-pointer">
                                <MicrosoftIcon /> Sign in with Microsoft
                            </button>
                        </div>
                        <Divider />
                        <form onSubmit={handleSignUp} className="space-y-3">
                            <InputField icon={User} placeholder="Full name" value={displayName} onChange={setDisplayName} />
                            <InputField icon={Mail} type="email" placeholder="Email" value={email} onChange={setEmail} />
                            <InputField icon={Lock} type="password" placeholder="Password (min 6 characters)" value={password} onChange={setPassword} showPassword={showPassword} onTogglePassword={togglePassword} />
                            {error && <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2.5 text-red-400 text-sm">{error}</div>}
                            <button type="submit" disabled={isSubmitting} className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg py-3 text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer">
                                {isSubmitting && <Loader2 size={16} className="animate-spin" />} Create Account
                            </button>
                        </form>
                        <div className="text-center mt-3">
                            <button onClick={() => { clearForm(); setView('login'); }} className="text-white/40 hover:text-emerald-400 text-xs transition-colors cursor-pointer">Already have an account? Sign in</button>
                        </div>
                    </div>
                )}

                {/* ── Forgot Password ────────────────────────────────────── */}
                {view === 'forgot-password' && (
                    <div className="space-y-4">
                        <button onClick={() => { clearForm(); setView('login'); }} className="flex items-center gap-1.5 text-white/40 hover:text-white/70 text-sm transition-colors mb-4 cursor-pointer">
                            <ArrowLeft size={14} /> Back
                        </button>
                        <h2 className="text-lg font-medium text-white mb-2">Reset your password</h2>
                        <p className="text-white/40 text-sm mb-4">Enter your email and we'll send you a reset link.</p>
                        <form onSubmit={handleForgotPassword} className="space-y-3">
                            <InputField icon={Mail} type="email" placeholder="Email" value={email} onChange={setEmail} />
                            {error && <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2.5 text-red-400 text-sm">{error}</div>}
                            {successMessage && <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-4 py-2.5 text-emerald-400 text-sm">{successMessage}</div>}
                            <button type="submit" disabled={isSubmitting} className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg py-3 text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer">
                                {isSubmitting && <Loader2 size={16} className="animate-spin" />} Send Reset Link
                            </button>
                        </form>
                    </div>
                )}

                {/* ── License Key ────────────────────────────────────────── */}
                {view === 'license' && (
                    <div className="space-y-4">
                        <button onClick={() => { clearForm(); setView('login'); }} className="flex items-center gap-1.5 text-white/40 hover:text-white/70 text-sm transition-colors mb-4 cursor-pointer">
                            <ArrowLeft size={14} /> Back
                        </button>
                        <h2 className="text-lg font-medium text-white mb-2">Activate License</h2>
                        <p className="text-white/40 text-sm mb-4">
                            {auth.isAuthenticated ? 'Enter your license key to upgrade your account.' : 'Sign in first, then activate your license key.'}
                        </p>
                        {auth.isAuthenticated ? (
                            <form onSubmit={handleLicenseActivation} className="space-y-3">
                                <InputField icon={KeyRound} placeholder="XXXX-XXXX-XXXX-XXXX" value={licenseKey} onChange={setLicenseKey} />
                                {error && <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2.5 text-red-400 text-sm">{error}</div>}
                                {successMessage && <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-4 py-2.5 text-emerald-400 text-sm">{successMessage}</div>}
                                <button type="submit" disabled={isSubmitting} className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg py-3 text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer">
                                    {isSubmitting && <Loader2 size={16} className="animate-spin" />} Activate License
                                </button>
                            </form>
                        ) : (
                            <div className="space-y-3">
                                <p className="text-amber-400/80 text-sm bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-2.5">
                                    Please sign in or create an account first, then return here to activate your license key.
                                </p>
                                <button onClick={() => { clearForm(); setView('login'); }} className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg py-3 text-sm transition-all cursor-pointer">
                                    Go to Sign In
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {/* ── Email Confirmation ──────────────────────────────────── */}
                {view === 'email-confirmation' && (
                    <div className="space-y-4 text-center">
                        <div className="w-16 h-16 mx-auto rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                            <Mail size={28} className="text-emerald-400" />
                        </div>
                        <h2 className="text-lg font-medium text-white">Check your email</h2>
                        <p className="text-white/50 text-sm">
                            We've sent a confirmation link to <span className="text-white/80">{email}</span>. Click the link to activate your account.
                        </p>
                        <button onClick={() => { clearForm(); setView('login'); }} className="w-full bg-white/5 hover:bg-white/10 border border-white/10 text-white/80 font-medium rounded-lg py-3 text-sm transition-all cursor-pointer mt-4">
                            Back to Sign In
                        </button>
                    </div>
                )}

                {/* Footer */}
                <div className="text-center mt-6">
                    <p className="text-white/20 text-xs">by Dahshan Labs</p>
                </div>
            </div>
            </div>
        </div>
    );
}
