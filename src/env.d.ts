// Module declarations for non-JS asset imports so TypeScript doesn't complain
// about `import logo from '../public/logo.png'` and similar Vite-bundled assets.
declare module '*.png' { const src: string; export default src; }
declare module '*.jpg' { const src: string; export default src; }
declare module '*.jpeg' { const src: string; export default src; }
declare module '*.gif' { const src: string; export default src; }
declare module '*.svg' { const src: string; export default src; }
declare module '*.webp' { const src: string; export default src; }
declare module '*.bmp' { const src: string; export default src; }

// Vite-specific `?url` suffix — emits the asset and returns its bundled URL.
declare module '*?url' { const src: string; export default src; }
declare module '*?raw' { const src: string; export default src; }
