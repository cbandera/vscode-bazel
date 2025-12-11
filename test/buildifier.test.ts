import * as vscode from "vscode";
import * as path from "path";
import * as assert from "assert";
import { BuildifierDiagnosticsManager } from "../src/buildifier";

async function openSourceFile(sourceFile: string) {
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.file(sourceFile),
  );
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.One, false);
}

let disposables: vscode.Disposable[] = [];

afterEach(() => {
  for (const disposable of disposables) {
    disposable.dispose();
  }
  disposables = [];
});

const workspacePath = path.join(
  __dirname,
  "..",
  "..",
  "test",
  "bazel_workspace",
);

describe("buildifier", () => {
  it("diagnostics are added from buildifier", async () => {

    // Promise that resolves when diagnostics are added to the file.
    const diagnosticsPromise = new Promise<vscode.Diagnostic[]>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          disposable.dispose();
          reject(new Error("Timed out waiting for diagnostics"));
        }, 5000);

        const disposable = vscode.languages.onDidChangeDiagnostics((e) => {
          if (!e.uris.some((u) => u.toString() === uri.toString())) {
            return;
          }
          const diags = vscode.languages.getDiagnostics(uri);
          if (diags.length > 0) {
            clearTimeout(timeout);
            disposable.dispose();
            resolve(diags);
          }
        });
      },
    );

    // Create DiagnosticsManager and open file
    const buildFile = path.join(workspacePath, "buildifier", "BUILD");
    const uri = vscode.Uri.file(buildFile);
    disposables.push(new BuildifierDiagnosticsManager());
    await openSourceFile(buildFile);

    // Wait for diagnostics for this file
    const diagnostics = await diagnosticsPromise;

    // Assert expected diagnostic is among returned diagnostics
    const hasExpected = diagnostics.some((d) => {
      return (
        d.code === "unused-variable" &&
        d.message === 'Variable "_foo" is unused. Please remove it.' &&
        d.source === "buildifier" &&
        d.severity === vscode.DiagnosticSeverity.Warning &&
        d.range.start.line === 1 &&
        d.range.start.character === 0 &&
        d.range.end.line === 1 &&
        d.range.end.character === 4
      );
    });

    assert.ok(
      hasExpected,
      "Expected buildifier unused-variable diagnostic was not found",
    );
  });
});
