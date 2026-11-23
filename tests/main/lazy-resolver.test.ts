// Invariant: a lookup that succeeded runs once for the life of the process, and a lookup that failed runs again on the next call.
import { expect, test } from "vitest";

import { lazyUntilItFails } from "../../src/main/lazy-resolver";

test("a_success_is_shared_and_the_lookup_runs_once", async () => {
  let runs = 0;
  const resolve = lazyUntilItFails(async () => ++runs);

  expect(await Promise.all([resolve(), resolve()])).toEqual([1, 1]);
  expect(await resolve()).toBe(1);
  expect(runs).toBe(1);
});

test("a_failure_is_not_kept_so_the_next_call_runs_the_lookup_again", async () => {
  let runs = 0;
  const resolve = lazyUntilItFails(async () => {
    runs += 1;
    if (runs === 1) throw new Error("the login shell did not answer");
    return "path";
  });

  await expect(resolve()).rejects.toThrow("the login shell did not answer");

  expect(await resolve()).toBe("path");
  expect(runs).toBe(2);
});
