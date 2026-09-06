import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

const ownedByProcess = (uid: number) => uid === process.getuid?.();

export const writePrivateFile = async (path: string, contents: string | Uint8Array): Promise<void> => {
  const directory = dirname(path);
  await assertNoSymlinkAncestors(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNoSymlinkAncestors(directory);
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || !ownedByProcess(directoryInfo.uid)) throw new Error('Unsafe private directory.');
  await chmod(directory, 0o700);
  const protectedDirectory = await lstat(directory);
  if (!protectedDirectory.isDirectory() || protectedDirectory.isSymbolicLink() || !ownedByProcess(protectedDirectory.uid) ||
    (protectedDirectory.mode & 0o777) !== 0o700) throw new Error('Unsafe private directory after protection.');
  try {
    const prior = await lstat(path);
    if (!prior.isFile() || prior.isSymbolicLink() || prior.nlink !== 1 || !ownedByProcess(prior.uid) || (prior.mode & 0o777) !== 0o600) {
      throw new Error('Unsafe private file.');
    }
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    const written = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await written.stat();
      if (!info.isFile() || info.nlink !== 1 || !ownedByProcess(info.uid) || (info.mode & 0o777) !== 0o600) throw new Error('Unsafe private file after write.');
    } finally { await written.close(); }
  } finally { await rm(temporary, { force: true }); }
};

export const writePrivateJson = async (path: string, value: unknown): Promise<void> => {
  await writePrivateFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

const hasCode = (error: unknown, code: string): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === code;

const assertNoSymlinkAncestors = async (path: string): Promise<void> => {
  let candidate = path;
  while (true) {
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink() && ownedByProcess(info.uid)) throw new Error('Unsafe private directory ancestry.');
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return;
    candidate = parent;
  }
};
