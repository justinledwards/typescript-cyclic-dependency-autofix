import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.json'] })],
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['node_modules', '.output', '.tanstack', 'worktrees'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['db/**/*.ts', 'analyzer/**/*.ts', 'cli/**/*.ts', 'backend/**/*.ts'],
      exclude: [
        'node_modules',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.d.ts',
        'src/**', // Frontend tested separately
      ],
      thresholds: {
        lines: 95,
        functions: 100,
        branches: 95,
        statements: 95,
      },
    },
  },
});
