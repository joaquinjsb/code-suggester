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
 * //Modifications made by Joaquin Santana on 26/09/25, 17:42
 */

import {BranchDomain, Changes, FileData, RepoDomain, TreeObject} from '../types';
import {Octokit} from '@octokit/rest';
import {logger} from '../logger';
import {createCommit, CreateCommitOptions} from './create-commit';
import {CommitError} from '../errors';
import * as git from 'isomorphic-git';
import {TreeEntry} from 'isomorphic-git';

const DEFAULT_FILES_PER_COMMIT = 100;
function mode2type$1(mode: string) {
    // prettier-ignore
    switch (mode) {
        case '040000': return 'tree'
        case '100644': return 'blob'
        case '100755': return 'blob'
        case '120000': return 'blob'
        case '160000': return 'commit'
    }
    throw new Error(`Unexpected GitTree entry mode: ${mode}`)
}
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
        type: mode2type$1(fileData.mode),
        sha: null,
      });
    } else {
      // update file with its content
      tree.push({
        path,
        mode: fileData.mode,
        type: mode2type$1(fileData.mode),
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
  try {
    const commit = await octokit.git.getCommit({
      owner: origin.owner,
      repo: origin.repo,
      commit_sha: refHead,
    });
    // @ts-ignore
    const oldTreeSha = commit.data.commit.tree.sha;
    logger.info('Got the latest commit tree');

    let currentTree = (await git.readTree({...gitConfig, oid: oldTreeSha}))
      .tree;

    for (const fileData of tree) {
      const pathParts = fileData.path.split('/');
      currentTree = await updateTreeRecursively(
        gitConfig,
        currentTree,
        pathParts,
        fileData
      );
    }

    const treeSha = await git.writeTree({...gitConfig, tree: currentTree});

    logger.info(
      `Successfully created a tree with the desired changes with SHA ${treeSha}`
    );
    return treeSha;
  } catch (e) {
    throw new CommitError(`Error adding to tree: ${refHead}`, e as Error);
  }
}

async function updateTreeRecursively(
    gitConfig: any,
    existingTree: TreeEntry[],
    pathParts: string[],
    fileData: TreeObject
): Promise<TreeEntry[]> {
    const newTree = [...existingTree];
    const part = pathParts[0];
    const remainingParts = pathParts.slice(1);
    const existingIndex = newTree.findIndex(entry => entry.path === part);

    if (remainingParts.length === 0) {
        // Siamo al file/blob
        const blobOid =
            fileData.content === null
                ? null // Eliminazione
                : await git.writeBlob({
                    ...gitConfig,
                    blob: Buffer.from(fileData.content!),
                });

        if (blobOid === null) {
            // Remove if existing
            if (existingIndex !== -1) {
                newTree.splice(existingIndex, 1);
            }
        } else {
            const newEntry: TreeEntry = {
                mode: fileData.mode,
                path: part,
                oid: blobOid,
                type: 'blob',
            };
            if (existingIndex !== -1) {
                newTree[existingIndex] = newEntry;
            } else {
                newTree.push(newEntry);
            }
        }
    } else {
        // we are in a directory
        let subTree: TreeEntry[] = [];
        if (existingIndex !== -1 && newTree[existingIndex].type === 'tree') {
            const subTreeOid = newTree[existingIndex].oid;
            subTree = (await git.readTree({...gitConfig, oid: subTreeOid})).tree;
        }

        const updatedSubTree = await updateTreeRecursively(
            gitConfig,
            subTree,
            remainingParts,
            fileData
        );
        const newSubTreeOid = await git.writeTree({
            ...gitConfig,
            tree: updatedSubTree,
        });

        const newEntry: TreeEntry = {
            mode: '040000', // directory mode
            path: part,
            oid: newSubTreeOid,
            type: 'tree',
        };

        if (existingIndex !== -1) {
            newTree[existingIndex] = newEntry;
        } else {
            newTree.push(newEntry);
        }
    }

    return newTree;
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
