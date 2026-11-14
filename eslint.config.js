import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'docs/**', '**/target/**', '**/build/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    // Engine tests and the legacy .lep fixture use Node globals and JSON imports.
    files: ['packages/engine/test/**/*.js'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        URL: 'readonly',
        console: 'readonly',
        structuredClone: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
