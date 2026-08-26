import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "data/**",
      "reference/**",
      "research/**",
      "devdocs/**",
      "coverage/**",
      "dist/**",
      ".agents/**",
      "local/**",
      "out/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "no-console": ["error", { allow: ["error"] }],
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    rules: {
      "no-console": "off", // CLI scripts legitimately write to stdout/stderr
    },
  },
);
