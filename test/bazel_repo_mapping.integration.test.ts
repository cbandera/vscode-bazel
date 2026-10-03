import * as assert from "assert";
import * as path from "path";

import { getRepoMapping } from "../src/bazel/bazel_repo_mapping";
import { getPackageLabelForFile } from "../src/bazel/bazel_utils";

// End-to-end test against a real `local_path_override`: unlike
// bazel_repo_mapping.test.ts (which stubs BazelInfo/BazelMod), this actually
// shells out to `bazel mod dump_repo_mapping` against test/bazel_workspace,
// whose MODULE.bazel overrides the nested `overridden_mod_target` directory
// and depends on bazel_skylib from the public registry.
describe("getPackageLabelForFile (real bazel mod dump_repo_mapping)", () => {
  const workspacePath = path.join(
    __dirname,
    "..",
    "..",
    "test",
    "bazel_workspace",
  );

  it("resolves a file inside the overridden module", async function () {
    // The first run resolves the module graph, which can take a while
    // depending on the local Bazel cache's warmth.
    this.timeout(60000);

    const buildFile = path.join(
      workspacePath,
      "overridden_mod_target",
      "BUILD",
    );
    const label = await getPackageLabelForFile(workspacePath, buildFile);

    assert.strictEqual(label, "@overridden_mod//");
  });

  it("still resolves an ordinary file to a plain package label", async () => {
    const buildFile = path.join(workspacePath, "pkg1", "BUILD");
    const label = await getPackageLabelForFile(workspacePath, buildFile);

    assert.strictEqual(label, "//pkg1");
  });

  it("maps no other directory of the workspace", async () => {
    // bazel_skylib may or may not appear, depending on whether a previous
    // build fetched it, but never inside the workspace.
    const mapping = await getRepoMapping(workspacePath);

    assert.deepStrictEqual(
      mapping
        .filter((entry) => entry.localPath.startsWith(workspacePath))
        .map((entry) => [entry.apparentName, entry.canonicalName]),
      [["overridden_mod", "overridden_mod+"]],
    );
  });
});
