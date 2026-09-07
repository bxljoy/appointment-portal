import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAwsPreflightProbe, readAwsDemoInput, type AwsDemoInput } from './aws-lifecycle.js';
import { runPreflight, toPreflightInput, type PreflightProbe } from './preflight.js';

type PreflightCliDependencies = {
  readInput?: (path: string) => Promise<AwsDemoInput>;
  makeProbe?: (input: AwsDemoInput) => PreflightProbe;
  run?: typeof runPreflight;
};

export const runPreflightCli = async (configPath: string, dependencies: PreflightCliDependencies = {}) => {
  const readInput = dependencies.readInput ?? readAwsDemoInput;
  const makeProbe = dependencies.makeProbe ?? makeAwsPreflightProbe;
  const full = await readInput(configPath);
  return (dependencies.run ?? runPreflight)(toPreflightInput(full), makeProbe(full));
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Expected one .runtime preflight configuration path.');
    const report = await runPreflightCli(process.argv[2]!);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Preflight failed.'}\n`);
    process.exitCode = 1;
  }
}
