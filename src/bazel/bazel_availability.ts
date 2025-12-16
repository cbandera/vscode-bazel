import { getDefaultBazelExecutablePath } from "../extension/configuration";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Logger } from "../extension/logger";
import * as which from "which";

function fileExistsSync(filename: string): boolean {
  try {
    fs.statSync(filename);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks whether bazel is available (either at the system PATH or a
 * user-specified path, depending on the value in Settings).
 */
export function checkBazelIsAvailable(logger: Logger): boolean {
  const bazelExecutable = getDefaultBazelExecutablePath();

  // Check if the program exists as a relative path of the workspace
  const pathExists = fileExistsSync(
    path.join(
      vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath,
      bazelExecutable,
    ),
  );

  if (!pathExists) {
    try {
      which.sync(bazelExecutable);
    } catch (e) {
      logger.debug(`Bazel not found: ${bazelExecutable} got ${e}`);
      return false;
    }
  }
  return true;
}
