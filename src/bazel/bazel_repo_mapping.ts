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
import { getBazelWorkspaceRelativePath } from "./bazel_utils";
import { getBazelExecutablePath } from "../extension/configuration";
import { logDebug } from "../extension/logger";

/** One resolved external Bazel module: its repo names and local path. */
export interface RepoMappingEntry {
  /** The canonical repo name, without a leading "@@" (e.g. "nested_mod+"). */
  readonly canonicalName: string;
  /**
   * The apparent repo name the root module uses for it (e.g. "nested_mod"),
   * or `undefined` if the root module has no direct `bazel_dep` on it.
   */
  readonly apparentName?: string;
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
 * @returns The `@apparentName//pkg` label (or `@@canonicalName//pkg` if the
 * root module can't see the repo under an apparent name), or `undefined` if
 * `buildFile` isn't inside any mapped external module (the caller should fall
 * back to `getPackageLabelForBuildFile` in that case).
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
    const repo =
      entry.apparentName !== undefined
        ? `@${entry.apparentName}`
        : `@@${entry.canonicalName}`;
    return `${repo}//${pkgDir}`;
  }
  return undefined;
}

async function buildRepoMapping(
  bazelExecutable: string,
  workspace: string,
  abortSignal: AbortSignal,
): Promise<RepoMapping> {
  // Cheap guard: skip the subprocess entirely for pure-WORKSPACE projects,
  // which have no external modules to resolve here.
  if (!fs.existsSync(path.join(workspace, "MODULE.bazel"))) {
    return [];
  }

  let outputBase: string;
  const apparentNames = new Map<string, string>();
  try {
    outputBase = await new BazelInfo(bazelExecutable, workspace).getOne(
      "output_base",
      { abortSignal },
    );
    // Resolving the root module's repo mapping also populates the external/
    // symlinks read below.
    const repoMapping = await new BazelMod(
      bazelExecutable,
      workspace,
    ).dumpRepoMapping({ abortSignal });
    for (const [apparent, canonical] of Object.entries(repoMapping)) {
      // "" is the main repo; first apparent name wins if several alias it.
      if (canonical !== "" && !apparentNames.has(canonical)) {
        apparentNames.set(canonical, apparent);
      }
    }
  } catch (err) {
    if (!abortSignal.aborted) {
      logDebug(
        "bazel mod dump_repo_mapping failed; treating workspace as having " +
          "no external modules",
        false,
        workspace,
        err,
      );
    }
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
      if (getBazelWorkspaceRelativePath(real, workspaceReal) !== undefined) {
        // The root module's own self-symlink (e.g. "_main"), or anything
        // containing the workspace, which would swallow every file in it.
        continue;
      }
      if (!fs.statSync(real).isDirectory()) {
        continue;
      }
      mapping.push({
        canonicalName: entry.name,
        apparentName: apparentNames.get(entry.name),
        localPath: real,
      });
    } catch {
      // Broken or unreadable symlink — skip it.
      continue;
    }
  }
  return mapping.sort((a, b) => b.localPath.length - a.localPath.length);
}

interface CacheEntry {
  readonly mapping: Promise<RepoMapping>;
  readonly controller: AbortController;
}

/**
 * Per-workspace cache of RepoMappings. Concurrent callers during a
 * resolution share one subprocess run, and nothing is recomputed until the
 * workspace's root module file changes.
 */
export class RepoMappingCache implements vscode.Disposable {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly watchers = new Map<string, vscode.Disposable>();
  private watchModuleFiles = false;

  /** Returns the (possibly still resolving) RepoMapping for `workspace`. */
  public get(workspace: string): Promise<RepoMapping> {
    return this.entries.get(workspace)?.mapping ?? this.refresh(workspace);
  }

  /**
   * Starts resolving `workspace`'s RepoMapping, aborting and replacing any
   * cached or in-flight one. Aborting `abortSignal` kills the resolution;
   * anyone awaiting it then gets an empty mapping.
   *
   * Shaped to be the task of a `CoalescingRunner` (#712), see `invalidate`.
   */
  public refresh(
    workspace: string,
    abortSignal?: AbortSignal,
  ): Promise<RepoMapping> {
    this.entries.get(workspace)?.controller.abort();
    const controller = new AbortController();
    abortSignal?.addEventListener("abort", () => controller.abort(), {
      once: true,
    });
    const mapping = buildRepoMapping(
      getBazelExecutablePath(),
      workspace,
      controller.signal,
    ).catch((): RepoMapping => []);
    const entry = { mapping, controller };
    this.entries.set(workspace, entry);
    void mapping.then(() => {
      // Don't serve an aborted, empty result to later callers.
      if (controller.signal.aborted && this.entries.get(workspace) === entry) {
        this.entries.delete(workspace);
      }
    });
    this.watch(workspace);
    return mapping;
  }

  /**
   * Drops `workspace`'s RepoMapping, aborting a resolution in flight. The
   * next `get` resolves it again, so a burst of file events costs nothing
   * until a feature actually needs a label.
   */
  public invalidate(workspace: string): void {
    // TODO(#712): once CoalescingRunner is merged, refresh eagerly in the
    // background instead, with one runner per workspace:
    //   new CoalescingRunner(BUILD_FILE_CHANGE_DELAY_MS, (signal) =>
    //     this.refresh(workspace, signal))
    // and call its schedule() here; dispose the runners in dispose().
    this.entries.get(workspace)?.controller.abort();
    this.entries.delete(workspace);
  }

  /**
   * From now on, invalidates each cached workspace's RepoMapping when its
   * root module file changes.
   */
  public enableWatching(): void {
    this.watchModuleFiles = true;
    for (const workspace of this.entries.keys()) {
      this.watch(workspace);
    }
  }

  /** Aborts all resolutions in flight and stops watching. */
  public dispose(): void {
    for (const entry of this.entries.values()) {
      entry.controller.abort();
    }
    this.entries.clear();
    for (const watcher of this.watchers.values()) {
      watcher.dispose();
    }
    this.watchers.clear();
    this.watchModuleFiles = false;
  }

  private watch(workspace: string): void {
    if (!this.watchModuleFiles || this.watchers.has(workspace)) {
      return;
    }
    // Only the root module can add or remove a local_path_override: Bazel
    // ignores overrides in non-root modules. Overrides may also live in
    // files the root MODULE.bazel include()s, which must be named
    // *.MODULE.bazel. MODULE.bazel.lock is deliberately not watched: it
    // never changes overrides on its own, and Bazel rewrites it on many
    // commands (including our own dump_repo_mapping), which would only
    // re-trigger resolution.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspace, "{MODULE.bazel,**/*.MODULE.bazel}"),
    );
    const onEvent = () => this.invalidate(workspace);
    this.watchers.set(
      workspace,
      vscode.Disposable.from(
        watcher,
        watcher.onDidChange(onEvent),
        watcher.onDidCreate(onEvent),
        watcher.onDidDelete(onEvent),
      ),
    );
  }
}

const repoMappingCache = new RepoMappingCache();

/** Returns the cached RepoMapping for `workspace`, see RepoMappingCache. */
export function getRepoMapping(workspace: string): Promise<RepoMapping> {
  return repoMappingCache.get(workspace);
}

/** Forces the next `getRepoMapping(workspace)` call to recompute. */
export function invalidateRepoMapping(workspace: string): void {
  repoMappingCache.invalidate(workspace);
}

/**
 * Starts resolving the RepoMappings of `workspaces` in the background, so
 * the first label lookup doesn't wait for Bazel, and keeps them up to date
 * from then on. Registers its disposable with `context.subscriptions`.
 */
export function registerRepoMappingCache(
  context: vscode.ExtensionContext,
  workspaces: readonly string[],
): vscode.Disposable {
  repoMappingCache.enableWatching();
  for (const workspace of workspaces) {
    void repoMappingCache.get(workspace);
  }
  context.subscriptions.push(repoMappingCache);
  return repoMappingCache;
}
