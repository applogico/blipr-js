import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      complexity: ['error', 8],
      'max-depth': ['error', 4],
      'max-lines-per-function': [
        'error',
        { max: 50, skipBlankLines: true, skipComments: true },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      // Ports and HTTP statuses read fine inline; only objects are ambiguous.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // A `describe` block is a container, not a function — its length says nothing.
    files: ['test/**'],
    rules: { 'max-lines-per-function': 'off' },
  },
  {
    // Build and lint configs sit outside the typechecked project.
    files: ['eslint.config.js', 'tsup.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
