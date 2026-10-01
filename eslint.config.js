// Lint rules plus the module boundaries from CLAUDE.md, checked in CI:
// contracts stay pure JSON/Zod, core stays free of drivers and UI, and the
// clients (GUI, Main, CLI, MCP) never open the DB or run a writable core.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const restrict = (paths, patterns = []) => ({
  'no-restricted-imports': [
    'error',
    {
      paths: [...new Set(paths)].map((name) => ({ name, message: 'Crosses a module boundary (see CLAUDE.md).' })),
      patterns,
    },
  ],
});

const NODE_BUILTINS = { group: ['node:*'], message: 'Must stay runnable in the browser GUI.' };
const DRIVERS_AND_UI = ['electron', 'react', 'react-dom', 'better-sqlite3', '@modelcontextprotocol/sdk'];
const WRITERS = ['@draft-tide/core', '@draft-tide/local-store', 'better-sqlite3'];

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/dist-e2e/**', '**/out/**', '**/node_modules/**', 'spikes/**', '.ref/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      // Explicit list: the desktop app has two configs (Node and GUI) in one
      // directory, which the project service cannot tell apart.
      parserOptions: {
        project: [
          './tsconfig.json',
          './packages/*/tsconfig.json',
          './apps/companion/tsconfig.json',
          './apps/desktop/tsconfig.json',
          './apps/desktop/tsconfig.gui.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/only-throw-error': 'error',
      'no-console': 'error',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['packages/contracts/src/**'],
    rules: restrict(
      [...DRIVERS_AND_UI, '@draft-tide/core', '@draft-tide/local-store', '@draft-tide/engine-client'],
      [NODE_BUILTINS],
    ),
  },
  {
    files: ['packages/core/src/**'],
    rules: restrict([
      ...DRIVERS_AND_UI,
      '@draft-tide/local-store',
      '@draft-tide/engine-client',
      'node:child_process',
      'node:fs',
      'node:fs/promises',
      'node:net',
    ]),
  },
  {
    files: ['packages/engine-client/src/**'],
    rules: restrict([...DRIVERS_AND_UI, ...WRITERS]),
  },
  {
    files: ['apps/companion/src/cli/**', 'apps/companion/src/mcp/**'],
    rules: restrict([...WRITERS, 'node:child_process']),
  },
  {
    files: ['apps/desktop/src/main/**', 'apps/desktop/src/preload/**'],
    rules: restrict([...WRITERS, '@modelcontextprotocol/sdk']),
  },
  {
    files: ['apps/desktop/src/gui/**'],
    languageOptions: { globals: { ...globals.browser } },
    rules: restrict(
      [...WRITERS, 'electron', '@draft-tide/engine-client', '@modelcontextprotocol/sdk'],
      [NODE_BUILTINS],
    ),
  },
);
