import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as sinon from "sinon";

import { BazelInfo } from "../src/bazel/bazel_info";
import { BazelMod } from "../src/bazel/bazel_mod";
import {
  RepoMapping,
  getRepoMapping,
  invalidateRepoMapping,
  resolvePackageLabelFromMapping,
} from "../src/bazel/bazel_repo_mapping";

describe("resolvePackageLabelFromMapping", () => {
  const mapping: RepoMapping = [
    { canonicalName: "nested_mod+", localPath: "/ws/external/nested_mod" },
    { canonicalName: "outer_mod+", localPath: "/ws/external" },
  ];

  it("returns undefined for an empty mapping", () => {
    assert.strictEqual(
      resolvePackageLabelFromMapping([], "/ws/pkg/BUILD"),
      undefined,
    );
  });

  it("returns undefined for a file outside every entry", () => {
    assert.strictEqual(
      resolvePackageLabelFromMapping(mapping, "/elsewhere/BUILD"),
      undefined,
    );
  });

  it("resolves a file directly at an entry's root", () => {
    assert.strictEqual(
      resolvePackageLabelFromMapping(mapping, "/ws/external/nested_mod/BUILD"),
      "@@nested_mod+//",
    );
  });

  it("resolves a file nested inside an entry", () => {
    assert.strictEqual(
      resolvePackageLabelFromMapping(
        mapping,
        "/ws/external/nested_mod/sub/dir/BUILD",
      ),
      "@@nested_mod+//sub/dir",
    );
  });

  it("does not treat a matching path prefix as containment", () => {
    // "/ws/external/nested_mod2" is NOT inside "/ws/external/nested_mod",
    // even though it shares a string prefix.
    assert.strictEqual(
      resolvePackageLabelFromMapping(mapping, "/ws/external/nested_mod2/BUILD"),
      "@@outer_mod+//nested_mod2",
    );
  });

  it("picks the longest-prefix match regardless of input order", () => {
    // Deliberately unsorted/reversed input: the function must sort for
    // itself rather than trusting caller order.
    const unsorted: RepoMapping = [mapping[1], mapping[0]];
    assert.strictEqual(
      resolvePackageLabelFromMapping(unsorted, "/ws/external/nested_mod/BUILD"),
      "@@nested_mod+//",
    );
  });
});

describe("getRepoMapping / invalidateRepoMapping", () => {
  let sandbox: sinon.SinonSandbox;
  let temporaryDirectories: string[];

  async function makeTempDir(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    temporaryDirectories.push(dir);
    return dir;
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    temporaryDirectories = [];
  });

  afterEach(async () => {
    sandbox.restore();
    await Promise.all(
      temporaryDirectories.map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("skips spawning bazel when there is no MODULE.bazel", async () => {
    const workspace = await makeTempDir("vscode-bazel-repo-mapping-no-mod-");
    const getOne = sandbox.stub(BazelInfo.prototype, "getOne");
    const graph = sandbox.stub(BazelMod.prototype, "graph");

    const mapping = await getRepoMapping(workspace);

    assert.deepStrictEqual(mapping, []);
    assert.strictEqual(getOne.called, false);
    assert.strictEqual(graph.called, false);
  });

  it("resolves external/ symlinks, excluding the self-symlink", async () => {
    const workspace = await makeTempDir("vscode-bazel-repo-mapping-ws-");
    await fs.writeFile(path.join(workspace, "MODULE.bazel"), "");
    const outputBase = await makeTempDir("vscode-bazel-repo-mapping-ob-");
    const overrideTarget = await makeTempDir(
      "vscode-bazel-repo-mapping-override-",
    );

    const externalDir = path.join(outputBase, "external");
    await fs.mkdir(externalDir);
    await fs.symlink(
      await fs.realpath(workspace),
      path.join(externalDir, "_main"),
      "dir",
    );
    await fs.symlink(
      overrideTarget,
      path.join(externalDir, "nested_mod+"),
      "dir",
    );

    sandbox.stub(BazelInfo.prototype, "getOne").resolves(outputBase);
    sandbox.stub(BazelMod.prototype, "graph").resolves();

    const mapping = await getRepoMapping(workspace);

    assert.deepStrictEqual(
      [...mapping].sort((a, b) =>
        a.canonicalName.localeCompare(b.canonicalName),
      ),
      [
        {
          canonicalName: "nested_mod+",
          localPath: await fs.realpath(overrideTarget),
        },
      ],
    );
  });

  it("treats a failing `bazel mod graph` as no external modules", async () => {
    const workspace = await makeTempDir("vscode-bazel-repo-mapping-fail-mod-");
    await fs.writeFile(path.join(workspace, "MODULE.bazel"), "");
    sandbox.stub(BazelInfo.prototype, "getOne").resolves("/does/not/matter");
    sandbox.stub(BazelMod.prototype, "graph").rejects(new Error("boom"));

    const mapping = await getRepoMapping(workspace);

    assert.deepStrictEqual(mapping, []);
  });

  it("memoizes concurrent callers into a single resolution", async () => {
    const workspace = await makeTempDir(
      "vscode-bazel-repo-mapping-concurrent-",
    );
    await fs.writeFile(path.join(workspace, "MODULE.bazel"), "");
    const getOne = sandbox
      .stub(BazelInfo.prototype, "getOne")
      .rejects(new Error("no output_base in this test"));
    sandbox.stub(BazelMod.prototype, "graph").resolves();

    await Promise.all([getRepoMapping(workspace), getRepoMapping(workspace)]);

    assert.strictEqual(getOne.callCount, 1);
  });

  it("recomputes after invalidateRepoMapping", async () => {
    const workspace = await makeTempDir(
      "vscode-bazel-repo-mapping-invalidate-",
    );
    await fs.writeFile(path.join(workspace, "MODULE.bazel"), "");
    const getOne = sandbox
      .stub(BazelInfo.prototype, "getOne")
      .rejects(new Error("no output_base in this test"));
    sandbox.stub(BazelMod.prototype, "graph").resolves();

    await getRepoMapping(workspace);
    assert.strictEqual(getOne.callCount, 1);

    invalidateRepoMapping(workspace);
    await getRepoMapping(workspace);

    assert.strictEqual(getOne.callCount, 2);
  });
});
