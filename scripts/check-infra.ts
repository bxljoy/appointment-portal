import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'portal-offline-synth-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AWS_|CDK_)/.test(key)));
Object.assign(env, { AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_EC2_METADATA_DISABLED: 'true' });
env.PATH = `${dirname(process.execPath)}:${env.PATH ?? ''}`;
try {
  // CDK executes --app through a shell. Keep its command literal and put the absolute path in JavaScript instead.
  await writeFile(join(temporary, 'app.mjs'), `await import(${JSON.stringify(pathToFileURL(join(root, 'infra/dist/bin/portal.js')).href)});\n`);
  await writeFile(join(temporary, 'cdk.context.json'), JSON.stringify({ 'availability-zones:account=111111111111:region=eu-north-1': ['eu-north-1a', 'eu-north-1b'] }));
  for (const phase of ['bootstrap', 'ready']) {
    const output = join(root, 'infra/cdk.out', phase);
    execFileSync(process.execPath, [join(root, 'infra/node_modules/aws-cdk/bin/cdk'), 'synth', '--app', 'node app.mjs', '--no-lookups', '--no-notices', '-q',
      '-c', 'account=111111111111', '-c', 'region=eu-north-1', '-c', 'postgresVersion=17.6', '-c', 'qualifier=portal123', '-c', `phase=${phase}`,
      ...(phase === 'ready' ? ['-c', 'frontendUrl=https://demo.cloudfront.net'] : []), '--output', output], { cwd: temporary, env, stdio: 'inherit' });
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')) as { missing?: unknown[] };
    if (manifest.missing?.length) throw new Error('Offline synthesis requested external context.');
  }
  process.stdout.write('Both infrastructure phases synthesized without credentials or lookups.\n');
} finally { await rm(temporary, { recursive: true, force: true }); }
