// Lints TypeScript with the strict typescript-eslint rules and the React hooks rules.
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["out/**", "dist/**", "node_modules/**", "src/codex/generated/**", "spikes/**", "demo/**", ".superpowers/**"] },
  ...tseslint.configs.strict,
  { files: ["**/*.tsx"], plugins: { "react-hooks": reactHooks }, rules: { ...reactHooks.configs.recommended.rules } },
  { rules: { "@typescript-eslint/no-explicit-any": "error", "@typescript-eslint/no-non-null-assertion": "error", eqeqeq: "error" } },
);
