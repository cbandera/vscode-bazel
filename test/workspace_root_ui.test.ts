import * as assert from "assert";
import * as path from "path";
import * as sinon from "sinon";
import * as vscode from "vscode";

import { getWorkspaceRootHint } from "../src/workspace-root/workspace_root_hint";
import { describeWorkspaceRoot } from "../src/workspace-root/workspace_root_status";

describe("Workspace root status and hint", () => {
  const workspacePath = path.join(
    __dirname,
    "..",
    "..",
    "test",
    "bazel_workspace",
  );
  const nestedBuildFile = path.join(workspacePath, "nested_module", "BUILD");
  const rootBuildFile = path.join(workspacePath, "pkg1", "BUILD");

  function starlarkDocument(fsPath: string): vscode.TextDocument {
    return {
      uri: vscode.Uri.file(fsPath),
      languageId: "starlark",
    } as unknown as vscode.TextDocument;
  }

  async function pin(configuredPath: string | undefined): Promise<void> {
    await vscode.workspace
      .getConfiguration("bazel.workspace")
      .update("path", configuredPath, vscode.ConfigurationTarget.Workspace);
  }

  afterEach(async () => {
    await pin(undefined);
  });

  it("shows the detected root for a file inside it", () => {
    const status = describeWorkspaceRoot(starlarkDocument(rootBuildFile));

    assert.strictEqual(status?.text, "Bazel: bazel_workspace");
    assert.ok(status?.tooltip.includes("detected from the folder"));
    assert.strictEqual(getWorkspaceRootHint(rootBuildFile), undefined);
  });

  it("marks a pinned root", async () => {
    await pin("nested_module");

    const status = describeWorkspaceRoot(starlarkDocument(nestedBuildFile));

    assert.strictEqual(status?.text, "$(pin) Bazel: nested_module");
    assert.ok(status?.tooltip.includes("pinned by bazel.workspace.path"));
  });

  it("warns about and hints at a file outside the root", async () => {
    await pin("nested_module");

    const status = describeWorkspaceRoot(starlarkDocument(rootBuildFile));
    const hint = getWorkspaceRootHint(rootBuildFile);

    assert.strictEqual(status?.text, "$(warning) Bazel: nested_module");
    assert.ok(status?.tooltip.includes(`Bazel workspace at ${workspacePath}`));
    assert.ok(status?.tooltip.includes("not the active Bazel workspace"));
    assert.ok(hint?.includes(`Bazel workspace at ${workspacePath}`));
    assert.ok(hint?.includes("bazel.workspace.path"));
    assert.ok(hint?.includes("multi-root"));
  });

  it("explains an ignored file without warning", async () => {
    await vscode.workspace
      .getConfiguration("bazel.workspace")
      .update("pathsToIgnore", ["pkg1"], vscode.ConfigurationTarget.Workspace);

    try {
      const status = describeWorkspaceRoot(starlarkDocument(rootBuildFile));

      assert.strictEqual(status?.text, "Bazel: bazel_workspace");
      assert.ok(status?.tooltip.includes("bazel.workspace.pathsToIgnore"));
      assert.strictEqual(getWorkspaceRootHint(rootBuildFile), undefined);
    } finally {
      await vscode.workspace
        .getConfiguration("bazel.workspace")
        .update(
          "pathsToIgnore",
          undefined,
          vscode.ConfigurationTarget.Workspace,
        );
    }
  });

  describe("with a folder that is not itself a Bazel workspace", () => {
    // The repository's test/ directory has no workspace marker file at or
    // above it, unlike the test workspace folder (test/bazel_workspace).
    const testDirectory = path.dirname(workspacePath);
    const markerlessBuildFile = path.join(testDirectory, "BUILD");
    let sandbox: sinon.SinonSandbox;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      // Simulate opening test/ as the VS Code folder.
      const folder: vscode.WorkspaceFolder = {
        uri: vscode.Uri.file(testDirectory),
        name: "test",
        index: 0,
      };
      sandbox.stub(vscode.workspace, "getWorkspaceFolder").returns(folder);
    });

    afterEach(() => {
      sandbox.restore();
    });

    it("warns about a file in no Bazel workspace", async () => {
      await pin(workspacePath);

      const status = describeWorkspaceRoot(
        starlarkDocument(markerlessBuildFile),
      );

      assert.strictEqual(status?.text, "$(warning) Bazel: bazel_workspace");
      assert.ok(
        status?.tooltip.includes("not in any Bazel workspace"),
        status?.tooltip,
      );
      // There is no other Bazel workspace to point the user to.
      assert.strictEqual(getWorkspaceRootHint(markerlessBuildFile), undefined);
    });
  });

  it("hides for non-Bazel files", () => {
    const document = {
      uri: vscode.Uri.file(path.join(workspacePath, "pkg1", "main.py")),
      languageId: "python",
    } as unknown as vscode.TextDocument;

    assert.strictEqual(describeWorkspaceRoot(document), undefined);
  });
});
