import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
    metadataBase: new URL('https://klypix.com'),
    title: {
        default: 'KLYPIX',
        template: '%s · KLYPIX',
    },
    description: 'KLYPIX — the personal AI workspace that lives in one file.',
    openGraph: {
        title: 'KLYPIX',
        description: 'The personal AI workspace that lives in one file you own. Spatial canvas. Local-first. End-to-end encrypted sharing.',
        url: 'https://klypix.com',
        siteName: 'KLYPIX',
        type: 'website',
    },
    twitter: {
        card: 'summary',
        title: 'KLYPIX',
        description: 'The personal AI workspace that lives in one file.',
    },
    icons: {
        icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
    },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <body className="antialiased min-h-screen bg-[#0a0a0a]">
                {children}
            </body>
        </html>
    );
}
