// ESLint flat config: the JavaScript rules ESLint recommends, and typescript-eslint's recommended rules for .ts files.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [js.configs.recommended, ...tseslint.configs.recommended];
