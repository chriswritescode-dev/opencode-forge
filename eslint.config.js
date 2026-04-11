import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import solidPlugin from "eslint-plugin-solid";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      solid: solidPlugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: {
          allowDefaultProject: ["scripts/*.ts", "scripts/*.js", "test/*.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-deprecated": "warn",
      "no-useless-assignment": "warn",
      "no-empty": "off",
    },
  },
  {
    files: ["**/*.tsx"],
    rules: {
      ...solidPlugin.configs.recommended.rules,
    },
  },
  {
    files: ["scripts/*.js"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
      },
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "*.d.ts", "test/**", ".sbx/**"],
  }
);
