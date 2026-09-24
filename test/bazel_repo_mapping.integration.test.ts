import * as assert from "assert";
import * as path from "path";

import { getPackageLabelForFile } from "../src/bazel/bazel_utils";

// End-to-end test against a real `local_path_override`: unlike
// bazel_repo_mapping.test.ts (which stubs BazelInfo/BazelMod), this actually
// shells out to `bazel mod graph` against the fixture below, confirming the
// whole resolution pipeline (bazel_mod.ts + bazel_repo_mapping.ts +
// getPackageLabelForFile) works against a real Bazel invocation, not just
// our own assumptions about its output. This pays the same kind of real
// subprocess cost that other fixture-based suites (e.g.
// copy_label_to_clipboard.test.ts) already pay against test/bazel_workspace.
describe("getPackageLabelForFile (real bazel mod graph)", () => {
  const rootModulePath = path.join(
    __dirname,
    "..",
    "..",
    "test",
    "bazel_workspace",
    "module_with_override",
  );
  const overriddenModulePath = path.join(
    __dirname,
    "..",
    "..",
    "test",
    "bazel_workspace",
    "overridden_mod_target",
  );

  it("resolves a file inside the overridden module", async function () {
    // First run resolves the module graph via a real `bazel mod graph`
    // invocation, which can take a while depending on the local Bazel
    // cache's warmth.
    this.timeout(60000);

    const buildFile = path.join(overriddenModulePath, "BUILD");
    const label = await getPackageLabelForFile(rootModulePath, buildFile);

    assert.strictEqual(label, "@@overridden_mod+//");
  });

  it("still resolves an ordinary file to a plain package label", async () => {
    const buildFile = path.join(rootModulePath, "BUILD");
    const label = await getPackageLabelForFile(rootModulePath, buildFile);

    assert.strictEqual(label, "//");
  });
});
