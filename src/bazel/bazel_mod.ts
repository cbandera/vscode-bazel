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

import * as child_process from "child_process";
import * as util from "util";

import { BazelCommand } from "./bazel_command";

const execFile = util.promisify(child_process.execFile);

/** Provides a promise-based API around the `bazel mod` command. */
export class BazelMod extends BazelCommand {
  /**
   * Runs `bazel mod dump_repo_mapping ""` and returns the root module's repo
   * mapping, i.e. apparent repo name -> canonical repo name (e.g.
   * `{"my_dep": "my_dep+"}`). The main repo maps to `""`.
   *
   * Resolving the mapping only needs the module graph, which for
   * `local_path_override`s materializes `<output_base>/external/<canonical>`
   * as a symlink to the local path (see bazel_repo_mapping.ts). Unlike
   * `bazel mod graph`, it does not fetch the source archives of registry
   * modules (verified with Bazel 8.3.1 and 9.2.0).
   *
   * Throws if `bazel mod dump_repo_mapping` is unavailable (Bazel < 7.1),
   * resolution fails (e.g. a non-bzlmod workspace) or `abortSignal` fires;
   * callers should treat that as "no repo mapping available".
   */
  public async dumpRepoMapping({
    abortSignal,
  }: { abortSignal?: AbortSignal } = {}): Promise<Record<string, string>> {
    const execResult = await execFile(
      this.bazelExecutable,
      this.execArgs(["dump_repo_mapping", ""]),
      {
        cwd: this.workingDirectory,
        signal: abortSignal,
      },
    );
    return JSON.parse(execResult.stdout.trim().split("\n")[0]) as Record<
      string,
      string
    >;
  }

  protected bazelCommand(): string {
    return "mod";
  }
}
