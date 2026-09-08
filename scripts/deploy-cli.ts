import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAwsDemoDependencies, readAwsDemoInput } from './aws-lifecycle.js';
import { deploymentCompletionMessage, runDemo } from './deploy.js';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Expected one .runtime deployment configuration path.');
    const config = await readAwsDemoInput(process.argv[2]!);
    const manifest = await runDemo(makeAwsDemoDependencies(config));
    process.stdout.write(`${deploymentCompletionMessage(manifest.outputs.FrontendUrl ?? 'the recorded frontend')}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Deployment failed.'}\n`);
    process.exitCode = 1;
  }
}
