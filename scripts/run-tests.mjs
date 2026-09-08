// @ts-check
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

/** @typedef {{ projects: string[]; fixedArgs: string[]; userArgs: string[] }} TestInvocation */
/** @typedef {(invocation: TestInvocation) => Promise<number>} InvocationRunner */

const coreProjects = ['server', 'infra', 'web'];
const allProjects = [...coreProjects, 'lighthouse'];

/** @param {readonly string[]} userArgs @returns {TestInvocation[]} */
export const testInvocationPlan = (userArgs) => {
  const args = [...userArgs];
  if (args.length === 0) return allProjects.map((project) => ({
    projects: [project], fixedArgs: project === 'infra' ? ['--no-file-parallelism'] : [], userArgs: [],
  }));
  return [{ projects: [...allProjects], fixedArgs: [], userArgs: args }];
};

const vitestCli = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
/** @param {TestInvocation} invocation */
export const vitestCliArguments = ({ projects, fixedArgs, userArgs }) => [
  'run', ...projects.flatMap((project) => ['--project', project]), ...fixedArgs, ...userArgs,
];
/** @type {InvocationRunner} */
const runVitest = (invocation) => new Promise((resolveRun, reject) => {
  const child = spawn(process.execPath, [vitestCli, ...vitestCliArguments(invocation)], {
    cwd: process.cwd(), env: process.env, shell: false, stdio: 'inherit',
  });
  child.once('error', reject);
  child.once('close', (code) => resolveRun(code ?? 1));
});

/** @param {readonly TestInvocation[]} invocations @param {InvocationRunner} [run] */
export const runTestInvocations = async (invocations, run = runVitest) => {
  for (const invocation of invocations) {
    const code = await run(invocation);
    if (code !== 0) return code;
  }
  return 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runTestInvocations(testInvocationPlan(process.argv.slice(2))); }
  catch { process.stderr.write('Test runner failed to start.\n'); process.exitCode = 1; }
}
