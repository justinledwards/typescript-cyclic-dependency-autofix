import js from '@eslint/js';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '.output/**',
      '.vinxi/**',
      'coverage/**',
      'worktrees/**',
      'src/routeTree.gen.ts',
    ],
  },

  // Base JS rules
  js.configs.recommended,

  // TypeScript rules
  ...tseslint.configs.recommended,

  // Unicorn plugin (best practices)
  unicorn.configs.recommended,

  // SonarJS plugin (bug detection & code smells)
  sonarjs.configs.recommended,

  // Project-wide settings
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      // Unicorn overrides — relax some overly strict rules
      'unicorn/prevent-abbreviations': 'off', // We use common abbrevs like db, repo, etc.
      'unicorn/no-null': 'off', // SQLite uses null extensively
      'unicorn/filename-case': 'off', // TanStack Router uses specific filename conventions
      'unicorn/no-process-exit': 'off', // CLI and server need process.exit
      'unicorn/prefer-top-level-await': 'off', // Not always appropriate

      // SonarJS overrides
      'sonarjs/no-duplicate-string': ['warn', { threshold: 4 }],

      // TypeScript overrides
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },

  // Test file overrides
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'sonarjs/no-duplicate-string': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // Frontend (React/TSX) files
  {
    files: ['src/**/*.tsx', 'src/**/*.ts'],
    rules: {
      'unicorn/no-anonymous-default-export': 'off',
    },
  },
);
