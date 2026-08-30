import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Derived from tsconfig.json paths — keep in sync
export function getViteConfig() {
  return {
    '@core': `${__dirname}/src/core`,
    '@worker': `${__dirname}/src/worker`,
    '@engine': `${__dirname}/src/engine`,
    '@motion': `${__dirname}/src/motion`,
    '@state': `${__dirname}/src/state`,
    '@ui': `${__dirname}/src/ui`,
    '@app': `${__dirname}/src/app`,
  };
}
