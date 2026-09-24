// Copyright 2026 The Bazel Authors. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { BazelInfo } from "./bazel_info";
import { BazelMod } from "./bazel_mod";
import {
  getBazelWorkspaceFolder,
  getBazelWorkspaceRelativePath,
} from "./bazel_utils";
import { getBazelExecutablePath } from "../extension/configuration";
import { logDebug } from "../extension/logger";

/** One resolved external Bazel module: its canonical repo name and local path. */
export interface RepoMappingEntry {
  /** The canonical repo name, without a leading "@@" (e.g. "nested_mod+"). */
  readonly canonicalName: string;
  /** The resolved, absolute local path the module lives at on disk. */
  readonly localPath: string;
}

/** All external modules resolved for a single Bazel workspace. */
export type RepoMapping = readonly RepoMappingEntry[];

/**
 * Resolves the package label for `buildFile` against an already-fetched
 * RepoMapping. Pure and synchronous, independent of any subprocess, so it
 * can be tested directly against fixture data.
 *
 * @param mapping The workspace's resolved external modules.
 * @param buildFile The absolute path to a BUILD file or source file.
 * @returns The `@@canonicalName//pkg` label, or `undefined` if `buildFile`
 * isn't inside any mapped external module (the caller should fall back to
 * `getPackageLabelForBuildFile` in that case).
 */
export function resolvePackageLabelFromMapping(
  mapping: RepoMapping,
  buildFile: string,
): string | undefined {
  // Defensive sort: correctness must not depend on the caller's ordering.
  // Longest localPath first, so a module nested inside another module's
  // override resolves to the more specific one.
  const sorted = [...mapping].sort(
    (a, b) => b.localPath.length - a.localPath.length,
  );
  for (const entry of sorted) {
    const relPathToDoc = getBazelWorkspaceRelativePath(
      entry.localPath,
      buildFile,
    );
    if (relPathToDoc === undefined) {
      continue;
    }
    let pkgDir = path.posix.dirname(relPathToDoc);
    if (pkgDir === ".") {
      pkgDir = "";
    }
    return `@@${entry.canonicalName}//${pkgDir}`;
  }
  return undefined;
}

async function buildRepoMapping(
  bazelExecutable: string,
  workspace: string,
): Promise<RepoMapping> {
  // Cheap guard: skip the subprocess entirely for pure-WORKSPACE projects,
  // which have no external modules to resolve here.
  if (!fs.existsSync(path.join(workspace, "MODULE.bazel"))) {
    return [];
  }

  let outputBase: string;
  try {
    outputBase = await new BazelInfo(bazelExecutable, workspace).getOne(
      "output_base",
    );
    // Forces full bzlmod resolution, which populates the external/ symlinks
    // read below. The graph output itself isn't used.
    await new BazelMod(bazelExecutable, workspace).graph();
  } catch (err) {
    logDebug(
      "bazel mod graph failed; treating workspace as having no external " +
        "modules",
      false,
      workspace,
      err,
    );
    return [];
  }

  const externalDir = path.join(outputBase, "external");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(externalDir, { withFileTypes: true });
  } catch {
    return [];
  }

  let workspaceReal = workspace;
  try {
    workspaceReal = fs.realpathSync(workspace);
  } catch {
    // Keep the un-resolved path; the comparison below will simply never
    // match, which just means the root module's self-symlink (if any)
    // won't be excluded.
  }

  const mapping: RepoMappingEntry[] = [];
  for (const entry of entries) {
    const full = path.join(externalDir, entry.name);
    try {
      const lst = fs.lstatSync(full);
      if (!lst.isSymbolicLink()) {
        continue;
      }
      const real = fs.realpathSync(full);
      if (real === workspaceReal) {
        // The root module's own self-symlink (e.g. "_main") — not an
        // external module.
        continue;
      }
      if (!fs.statSync(real).isDirectory()) {
        continue;
      }
      mapping.push({ canonicalName: entry.name, localPath: real });
    } catch {
      // Broken or unreadable symlink — skip it.
      continue;
    }
  }
  return mapping.sort((a, b) => b.localPath.length - a.localPath.length);
}

const repoMappingCache = new Map<string, Promise<RepoMapping>>();

/**
 * Returns the resolved RepoMapping for `workspace`, memoized so concurrent
 * callers during first resolution share one `bazel mod` subprocess run, and
 * so repeated calls don't re-run it at all until `invalidateRepoMapping` is
 * called (see `registerRepoMappingWatcher`).
 */
export function getRepoMapping(workspace: string): Promise<RepoMapping> {
  let cached = repoMappingCache.get(workspace);
  if (cached === undefined) {
    cached = buildRepoMapping(getBazelExecutablePath(), workspace).catch(
      (): RepoMapping => [],
    );
    repoMappingCache.set(workspace, cached);
  }
  return cached;
}

/**
 * Forces the next `getRepoMapping(workspace)` call to recompute, by
 * replacing the cached Promise with a freshly-started one (rather than just
 * deleting the entry) so a resolution is already in flight by the time
 * anything asks for it again.
 */
export function invalidateRepoMapping(workspace: string): void {
  repoMappingCache.set(
    workspace,
    buildRepoMapping(getBazelExecutablePath(), workspace).catch(
      (): RepoMapping => [],
    ),
  );
}

/**
 * Watches every workspace's `MODULE.bazel`/`MODULE.bazel.lock` for changes
 * and invalidates that workspace's cached RepoMapping accordingly. Registers
 * its disposable with `context.subscriptions`.
 */
export function registerRepoMappingWatcher(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher(
    "**/{MODULE.bazel,MODULE.bazel.lock}",
    /* ignoreCreateEvents */ false,
    /* ignoreChangeEvents */ false,
    /* ignoreDeleteEvents */ false,
  );
  const onEvent = (uri: vscode.Uri) => {
    const workspace = getBazelWorkspaceFolder(uri.fsPath);
    if (workspace) {
      invalidateRepoMapping(workspace);
    }
  };
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(onEvent),
    watcher.onDidCreate(onEvent),
    watcher.onDidDelete(onEvent),
  );
  return watcher;
}
