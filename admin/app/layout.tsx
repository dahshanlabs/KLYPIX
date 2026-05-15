import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
    title: 'KLYPIX',
    description: 'KLYPIX — personal AI workspace that lives in one file',
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
