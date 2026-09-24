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
   * Runs `bazel mod graph --output=json` to force full bzlmod module
   * resolution. The JSON output itself is discarded; as a side effect of
   * resolution, Bazel populates `<output_base>/external/<canonical_repo>`
   * symlinks for every resolved module (including `local_path_override`s),
   * which is what callers actually read the repo mapping from (see
   * bazel_repo_mapping.ts).
   *
   * Throws if `bazel mod` is unavailable (old Bazel) or resolution fails
   * (e.g. a non-bzlmod workspace); callers should catch and treat that as
   * "no repo mapping available" rather than surfacing an error.
   */
  public async graph(): Promise<void> {
    await execFile(
      this.bazelExecutable,
      this.execArgs(["graph", "--output=json"]),
      {
        cwd: this.workingDirectory,
      },
    );
  }

  protected bazelCommand(): string {
    return "mod";
  }
}
