// Invariant: the app's name is "Margin", so its application support folder is the one the plan requires.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

test("product_name_is_margin_so_user_data_lives_under_application_support_margin", () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")) as { productName?: string };

  expect(manifest.productName).toBe("Margin");
});
