/*
 * // Copyright 2020 Google LLC
 * //
 * // Licensed under the Apache License, Version 2.0 (the "License");
 * // you may not use this file except in compliance with the License.
 * // You may obtain a copy of the License at
 * //
 * //     https://www.apache.org/licenses/LICENSE-2.0
 * //
 * // Unless required by applicable law or agreed to in writing, software
 * // distributed under the License is distributed on an "AS IS" BASIS,
 * // WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * // See the License for the specific language governing permissions and
 * // limitations under the License.
 * //
 * //Modifications made by Joaquin Santana on 18/11/24, 22:09
 */

import {BranchDomain, Changes, FileData, RepoDomain, TreeObject} from '../types';
import {Octokit} from '@octokit/rest';
import {logger} from '../logger';
import {createCommit, CreateCommitOptions} from './create-commit';
import {CommitError} from '../errors';
import * as git from 'isomorphic-git';
import {TreeEntry} from 'isomorphic-git';

const DEFAULT_FILES_PER_COMMIT = 100;

/**
 * Generate and return a GitHub tree object structure
 * containing the target change data
 * See https://developer.github.com/v3/git/trees/#tree-object
 * @param {Changes} changes the set of repository changes
 * @returns {TreeObject[]} The new GitHub changes
 */
export function generateTreeObjects(changes: Changes): TreeObject[] {
  const tree: TreeObject[] = [];
  changes.forEach((fileData: FileData, path: string) => {
    if (fileData.content === null) {
      // if no file content then file is deleted
      tree.push({
        path,
        mode: fileData.mode,
        type: 'blob',
        sha: null,
      });
    } else {
      // update file with its content
      tree.push({
        path,
        mode: fileData.mode,
        type: 'blob',
        content: fileData.content,
      });
    }
  });
  return tree;
}

function* inGroupsOf<T>(
  all: T[],
  groupSize: number
): Generator<T[], void, void> {
  for (let i = 0; i < all.length; i += groupSize) {
    yield all.slice(i, i + groupSize);
  }
}

/**
 * Upload and create a remote GitHub tree
 * and resolves with the new tree SHA.
 * Rejects if GitHub V3 API fails with the GitHub error response
 * @param {Octokit} octokit The authenticated octokit instance
 * @param {RepoDomain} origin the the remote repository to push changes to
 * @param {string} refHead the base of the new commit(s)
 * @param {TreeObject[]} tree the set of GitHub changes to upload
 * @param gitConfig
 * @returns {Promise<string>} the GitHub tree SHA
 * @throws {CommitError}
 */
export async function createTree(
  octokit: Octokit,
  origin: RepoDomain,
  refHead: string,
  tree: TreeObject[],
  gitConfig: any
): Promise<string> {
  const oldTreeSha = (
    await octokit.git.getCommit({
      owner: origin.owner,
      repo: origin.repo,
      commit_sha: refHead,
    })
  )// @ts-ignore
      .data.commit.tree.sha;
  logger.info('Got the latest commit tree');
  try {
    const oldTree = await git.readTree({...gitConfig, oid: oldTreeSha});
    const transformTree = await Promise.all(
      tree.map(async value => {
        if (value.content) {
          value.sha = await git.writeBlob({
            ...gitConfig,
            blob: Buffer.from(value.content),
          });
        }
        const treeEntry: TreeEntry = {
          mode: value.mode,
          path: value.path,
          oid: value.sha || '',
          type: value.type,
        };

        return treeEntry;
      })
    );

    //add all the old tree entries to the new tree if the path is not already in the new tree
    oldTree.tree.forEach(value => {
      if (!transformTree.find(treeEntry => treeEntry.path === value.path)) {
        transformTree.push(value);
      }
    });

    const treeSha = await git.writeTree({...gitConfig, tree: transformTree});

    logger.info(
      `Successfully created a tree with the desired changes with SHA ${treeSha}`
    );
    return treeSha;
  } catch (e) {
    throw new CommitError(`Error adding to tree: ${refHead}`, e as Error);
  }
}

/**
 * Update a reference to a SHA
 * Rejects if GitHub V3 API fails with the GitHub error response
 * @param {BranchDomain} origin the the remote branch to push changes to
 * @param {string} newSha the ref to update the commit HEAD to
 * @param {boolean} force to force the commit changes given refHead
 * @param gitConfig
 * @returns {Promise<void>}
 */
export async function updateRef(
  origin: BranchDomain,
  newSha: string,
  force: boolean,
  gitConfig: any
): Promise<void> {
  logger.info(`Updating reference heads/${origin.branch} to ${newSha}`);
  try {
    await git.writeRef({
      ...gitConfig,
      ref: `refs/heads/${origin.branch}`,
      value: newSha,
      force,
    });
    logger.info(`Successfully updated reference ${origin.branch} to ${newSha}`);
  } catch (e) {
    throw new CommitError(
      `Error updating ref heads/${origin.branch} to ${newSha}`,
      e as Error
    );
  }
}

interface CommitAndPushOptions extends CreateCommitOptions {
  filesPerCommit?: number;
}

/**
 * Given a set of changes, apply the commit(s) on top of the given branch's head and upload it to GitHub
 * Rejects if GitHub V3 API fails with the GitHub error response
 * @param {Octokit} octokit The authenticated octokit instance
 * @param {string} refHead the base of the new commit(s)
 * @param {Changes} changes the set of repository changes
 * @param originBranch
 * @param {string} commitMessage the message of the new commit
 * @param {boolean} force to force the commit changes given refHead
 * @param options
 * @returns {Promise<void>}
 * @throws {CommitError}
 */
export async function commitAndPush(
  octokit: Octokit,
  refHead: string,
  changes: Changes,
  originBranch: BranchDomain,
  commitMessage: string,
  force: boolean,
  options?: CommitAndPushOptions
): Promise<void> {
  const filesPerCommit = options?.filesPerCommit ?? DEFAULT_FILES_PER_COMMIT;
  const tree = generateTreeObjects(changes);
  for (const treeGroup of inGroupsOf(tree, filesPerCommit)) {
    const treeSha = await createTree(
      octokit,
      originBranch,
      refHead,
      treeGroup,
      options?.gitConfig
    );
    refHead = await createCommit(refHead, treeSha, commitMessage, options);
  }

  await updateRef(originBranch, refHead, force, options?.gitConfig);

  await git.push({...options?.gitConfig, force: force});

  logger.info('Pushed to remote repository successfully');
}
