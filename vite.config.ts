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
                    // Phase 23 backlog #5: carve the previously-monolithic
                    // 'vendor-misc' (~1.6MB) into named chunks per consumer
                    // domain. Most of these are canvas-only deps that ride
                    // the lazy KlypixCanvas chunk anyway — naming them
                    // makes the network waterfall + cache invalidation
                    // story explicit.
                    if (id.includes('/xlsx/') || id.includes('xlsx-')) {
                        // ~800KB. Used by canvas dropHandler + canvas agent.
                        return 'vendor-xlsx';
                    }
                    if (id.includes('/jszip/')) {
                        return 'vendor-jszip';
                    }
                    if (id.includes('/mathjs/')) {
                        // Palette calculator. Already lazy via dynamic
                        // import in calculatorProvider; named chunk so it
                        // shows up clearly in the build report.
                        return 'vendor-mathjs';
                    }
                    if (id.includes('/fuse.js/') || id.includes('fuse.js/dist')) {
                        return 'vendor-fuse';
                    }
                    if (id.includes('/perfect-freehand/')) {
                        return 'vendor-freehand';
                    }
                    if (id.includes('/pdfjs-dist/')) {
                        return 'vendor-pdfjs';
                    }
                    // Anthropic SDK — only lazy-loaded via claudeAdapter.
                    if (id.includes('@anthropic-ai/')) {
                        return 'vendor-anthropic';
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
