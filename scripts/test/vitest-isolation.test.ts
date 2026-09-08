import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { runTestInvocations, testInvocationPlan, vitestCliArguments } from '../run-tests.mjs';

const listLighthouseTest = (project: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'list', 'scripts/test/measure-web.lighthouse.test.ts', '--project', project], {
    cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  child.on('error', reject); child.on('close', (code) => resolve({ code, stdout, stderr }));
});

const runTestCli = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/run-tests.mjs', ...args], {
    cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  child.on('error', reject); child.on('close', (code) => resolve({ code, stdout, stderr }));
});

it('discovers the real Lighthouse case only in its isolated project', async () => {
  const [server, lighthouse] = await Promise.all([listLighthouseTest('server'), listLighthouseTest('lighthouse')]);
  expect(server).toMatchObject({ code: 0, stdout: '', stderr: '' });
  expect(lighthouse).toMatchObject({ code: 0, stderr: '' });
  expect(lighthouse.stdout).toContain('scripts/test/measure-web.lighthouse.test.ts');
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as { scripts?: { test?: string } };
  expect(packageJson.scripts?.test?.split(/\s+/)).toContain('scripts/run-tests.mjs');
  expect(packageJson.scripts?.test).not.toContain('--import');
});

it('splits only a bare run and delegates every focused argument unchanged to all projects', () => {
  const allProjects = ['server', 'infra', 'web', 'lighthouse'];
  expect(testInvocationPlan([])).toEqual([
    { projects: ['server'], fixedArgs: [], userArgs: [] },
    { projects: ['infra'], fixedArgs: ['--no-file-parallelism'], userArgs: [] },
    { projects: ['web'], fixedArgs: [], userArgs: [] },
    { projects: ['lighthouse'], fixedArgs: [], userArgs: [] },
  ]);
  expect(testInvocationPlan(['scripts/test/lifecycle.test.ts', '--reporter=verbose'])).toEqual([
    { projects: allProjects, fixedArgs: [], userArgs: ['scripts/test/lifecycle.test.ts', '--reporter=verbose'] },
  ]);
  expect(testInvocationPlan(['scripts/test/measure-web.lighthouse.test.ts', '--reporter=verbose'])).toEqual([
    { projects: allProjects, fixedArgs: [], userArgs: ['scripts/test/measure-web.lighthouse.test.ts', '--reporter=verbose'] },
  ]);
  expect(testInvocationPlan(['scripts/test/lifecycle.test.ts', 'scripts/test/measure-web.lighthouse.test.ts'])).toEqual([
    { projects: allProjects, fixedArgs: [], userArgs: ['scripts/test/lifecycle.test.ts', 'scripts/test/measure-web.lighthouse.test.ts'] },
  ]);
  expect(testInvocationPlan(['--reporter=verbose'])).toEqual([
    { projects: allProjects, fixedArgs: [], userArgs: ['--reporter=verbose'] },
  ]);
  expect(testInvocationPlan(['-t', 'executes the pinned Lighthouse navigation adapter'])).toEqual([
    { projects: allProjects, fixedArgs: [], userArgs: ['-t', 'executes the pinned Lighthouse navigation adapter'] },
  ]);
  expect(testInvocationPlan(['scripts/test/does-not-exist.test.ts'])).toEqual([
    { projects: allProjects, fixedArgs: [], userArgs: ['scripts/test/does-not-exist.test.ts'] },
  ]);
});

it('places fixed infra serialization before unchanged user arguments in spawned Vitest argv', () => {
  const [server, infra] = testInvocationPlan([]);
  expect(vitestCliArguments(server!)).toEqual(['run', '--project', 'server']);
  expect(vitestCliArguments(infra!)).toEqual(['run', '--project', 'infra', '--no-file-parallelism']);
  expect(vitestCliArguments(testInvocationPlan(['--reporter=verbose'])[0]!)).toEqual([
    'run', '--project', 'server', '--project', 'infra', '--project', 'web', '--project', 'lighthouse', '--reporter=verbose',
  ]);
});

it('preserves Vitest no-match failure semantics', async () => {
  expect((await runTestCli(['scripts/test/does-not-exist.test.ts'])).code).not.toBe(0);
});

it('runs bare projects sequentially and stops before later projects after a failure', async () => {
  const plan = testInvocationPlan([]);
  const success = vi.fn().mockResolvedValue(0);
  expect(await runTestInvocations(plan, success)).toBe(0);
  expect(success.mock.calls.map(([invocation]) => ({ projects: invocation.projects, fixedArgs: invocation.fixedArgs }))).toEqual([
    { projects: ['server'], fixedArgs: [] },
    { projects: ['infra'], fixedArgs: ['--no-file-parallelism'] },
    { projects: ['web'], fixedArgs: [] },
    { projects: ['lighthouse'], fixedArgs: [] },
  ]);
  const failAtInfra = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1).mockResolvedValue(0);
  expect(await runTestInvocations(plan, failAtInfra)).toBe(1);
  expect(failAtInfra.mock.calls.map(([invocation]) => invocation.projects)).toEqual([['server'], ['infra']]);
});
