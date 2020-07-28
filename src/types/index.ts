// Copyright 2020 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {Logger} from '../logger';
import {Octokit} from '@octokit/rest';

type FileMode = '100644' | '100755' | '040000' | '160000' | '120000';

/**
 * GitHub definition of tree
 */
declare interface TreeObject {
  path: string;
  mode: FileMode;
  type: 'blob' | 'tree' | 'commit';
  sha?: string | null;
  content?: string;
}

/**
 * The content and the mode of a file.
 * Default file mode is a text file which has code '100644'.
 * If `content` is not null, then `content` must be the entire file content.
 * See https://developer.github.com/v3/git/trees/#tree-object for details on mode.
 */
class FileData {
  readonly mode: FileMode;
  readonly content: string | null;
  constructor(content: string | null, mode: FileMode = '100644') {
    this.mode = mode;
    this.content = content;
  }
}

/**
 * The map of a path to its content data.
 * The content must be the entire file content.
 */
type Changes = Map<string, FileData>;

/**
 * The domain of a repository
 */
interface RepoDomain {
  repo: string;
  owner: string;
}

/**
 * The domain for a branch
 */
interface BranchDomain extends RepoDomain {
  branch: string;
}

/**
 * The descriptive properties for any entity
 */
interface Description {
  title: string;
  body: string;
}

/**
 * The user options for creating GitHub PRs
 */
interface CreatePullRequestUserOptions {
  // the owner of the target fork repository
  upstreamOwner: string;
  // the name of the target fork repository
  upstreamRepo: string;
  // The message of any commits made.
  message: string;
  // The description of the pull request.
  description: string;
  // The title of the pull request.
  title: string;
  // the name of the branch to push changes to. Default is 'code-suggestions'. (optional)
  branch?: string;
  // Whether or not to force branch reference updates. Default is false. (optional)
  force?: boolean;
  // Primary upstream branch to open PRs against. Default is 'master' (optional)
  primary?: string;
  // Whether or not maintainers can modify the PR. Default is true. (optional)
  maintainersCanModify?: boolean;
}

/**
 * GitHub data needed for creating a PR
 */
interface CreatePullRequest {
  // the owner of the target fork repository
  upstreamOwner: string;
  // the name of the target fork repository
  upstreamRepo: string;
  // The message of any commits made.
  message: string;
  // The description of the pull request.
  description: string;
  // The title of the pull request
  title: string;
  // the name of the branch to push changes to.
  branch: string;
  // Whether or not to force branch reference updates.
  force: boolean;
  // Primary upstream branch to open PRs against.
  primary: string;
  // Whether or not maintainers can modify the PR.
  maintainersCanModify: boolean;
}

export {
  Changes,
  FileData,
  FileMode,
  TreeObject,
  BranchDomain,
  Description,
  CreatePullRequestUserOptions,
  CreatePullRequest,
  Logger,
  Octokit,
  RepoDomain,
};
