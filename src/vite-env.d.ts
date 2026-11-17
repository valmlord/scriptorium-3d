/// <reference types="vite/client" />

// `import.meta.env` is Vite's, and nothing in this project declared it until
// `src/main.ts` read `MODE` to decide whether to install the debug hook. Vite
// replaces that expression with a literal at build time, which is what strips
// the hook from the production bundle, and without this reference the
// expression would not type-check at all.
