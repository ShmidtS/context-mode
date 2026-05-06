import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["build/", "server.bundle.mjs", "cli.bundle.mjs", "hooks/*.bundle.mjs", "insight/"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Downgrade recommended errors to warnings for initial rollout
      "no-empty": "warn",
      "no-useless-escape": "warn",
      "no-irregular-whitespace": "warn",
      "prefer-const": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "@typescript-eslint/no-extra-non-null-assertion": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-undef": "off",
      "@typescript-eslint/consistent-type-imports": "warn",
      "no-console": "warn",
    },
  },
);
