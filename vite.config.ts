import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    base: './',
    server: {
        port: 5173,
        strictPort: true,
    },
    build: {
        outDir: 'dist',
        assetsDir: '.',
        // Phase 22.5: split heavy third-party deps into stable vendor chunks
        // so they cache independently of app code (changing one component
        // doesn't bust the React or Supabase chunk for users updating). Also
        // shrinks the per-tick initial bundle the browser parses on cold start.
        //
        // Anything not matched here ends up in the default `index` chunk OR
        // (for canvas-specific code) in the lazy KlypixCanvas chunk created
        // by the dynamic import in App.tsx (Phase 22.5 #7).
        rollupOptions: {
            output: {
                manualChunks(id) {
                    if (!id.includes('node_modules')) return undefined;
                    // React + scheduler — change rarely, almost every page touches them.
                    if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
                        return 'vendor-react';
                    }
                    // Markdown rendering stack — only used in chat message bubbles.
                    if (id.includes('/react-markdown/') || id.includes('/remark-') || id.includes('/micromark') || id.includes('/mdast-') || id.includes('/unist-')) {
                        return 'vendor-markdown';
                    }
                    // Supabase SDK — needed by auth + canvas cloud. Bundled
                    // separately so an app code change doesn't bust its cache.
                    if (id.includes('@supabase/')) {
                        return 'vendor-supabase';
                    }
                    // Lucide icon set — large at import time even after tree-shaking.
                    if (id.includes('lucide-react')) {
                        return 'vendor-icons';
                    }
                    // Google Generative AI — eager via src/api/gemini.ts. Splitting
                    // here so it doesn't drag the main chunk's size up.
                    if (id.includes('@google/generative-ai')) {
                        return 'vendor-gemini';
                    }
                    // Everything else node_modules → a single vendor chunk.
                    return 'vendor-misc';
                },
            },
        },
        // Splits leave us well under 500KB per chunk; bump the soft limit
        // so the build log isn't noisy with already-handled warnings.
        chunkSizeWarningLimit: 800,
    }
})
