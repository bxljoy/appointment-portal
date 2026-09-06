import { readFile, readdir } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { X509Certificate } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const features = ['profiles', 'availability', 'appointments'] as const;
const localCode = /X-Local-Actor|LOCAL_AUTH_DEVELOPMENT_ONLY|src\/local\/|local\/identity|local-session|dev-toolbar|patient-a|patient-b|clinician-a|clinician-b/i;
const nonProductionInput = /(?:^|\/)(?:local|test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/;
type Metadata = {
  inputs: Record<string, unknown>;
  outputs: Record<string, { entryPoint?: string; imports: { path: string; external?: boolean }[]; exports: string[] }>;
};

export async function checkMigrationBundle(directory: string, root: string): Promise<void> {
  const bundlePath = join(directory, 'index.mjs');
  if (localCode.test(await readFile(bundlePath, 'utf8'))) throw new Error('Local authentication code found in migration Lambda.');
  const metadata = JSON.parse(await readFile(join(directory, 'index.meta.json'), 'utf8')) as Metadata;
  const inputs = Object.keys(metadata.inputs);
  if (inputs.some((input) => nonProductionInput.test(input.replaceAll('\\', '/')) || input.endsWith('/seed-cli.ts'))) throw new Error('Local or test input found in migration Lambda.');
  if (!inputs.some((input) => input.includes('/@aws-sdk/client-secrets-manager/')) || !inputs.some((input) => input.endsWith('/pg-format/lib/reserved.js'))) {
    throw new Error('Migration SDK or pg-format support is not fully bundled.');
  }
  const outputs = Object.values(metadata.outputs);
  if (outputs.length !== 1 || !outputs[0]!.entryPoint?.endsWith('packages/database/src/lambda.ts') || !outputs[0]!.exports.includes('handler')) {
    throw new Error('Expected the migration Lambda handler entry point and export.');
  }
  for (const dependency of outputs[0]!.imports) {
    if (!dependency.external || (!isBuiltin(dependency.path) && dependency.path !== 'pg-native')) throw new Error('Unbundled dependency in migration Lambda.');
  }
  const sourceDirectory = join(root, 'packages/database/migrations');
  const names = (await readdir(sourceDirectory)).sort();
  if (!names.length || JSON.stringify((await readdir(join(directory, 'migrations'))).sort()) !== JSON.stringify(names)) throw new Error('Migration SQL files are incomplete.');
  for (const name of names) {
    if (!(await readFile(join(sourceDirectory, name))).equals(await readFile(join(directory, 'migrations', name)))) throw new Error('Packaged migration SQL differs from source.');
  }
  const ca = await readFile(join(directory, 'certs/rds-global-bundle.pem'), 'utf8');
  if (ca !== await readFile(join(root, 'infra/assets/rds-global-bundle.pem'), 'utf8') || ca.includes('PRIVATE KEY')) throw new Error('Migration CA bundle differs from the public source.');
  const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!certificates?.length || certificates.some((pem) => !new X509Certificate(pem).ca)) throw new Error('Migration CA bundle is invalid.');
  if (typeof (await import(pathToFileURL(bundlePath).href)).handler !== 'function') throw new Error('Migration Lambda does not export a runnable handler.');
}

export async function checkBundles(root: string): Promise<void> {
  for (const feature of features) {
    const directory = join(root, 'apps/api/dist/lambda');
    const bundlePath = join(directory, feature, 'index.mjs');
    const bundle = await readFile(bundlePath, 'utf8');
    if (localCode.test(bundle)) throw new Error(`Local authentication code found in ${feature} Lambda.`);
    const metadata = JSON.parse(await readFile(join(directory, `${feature}.meta.json`), 'utf8')) as Metadata;
    const inputs = Object.keys(metadata.inputs);
    if (inputs.some((input) => nonProductionInput.test(input.replaceAll('\\', '/')))) throw new Error(`Local or test import found in ${feature} Lambda metadata.`);
    if (!inputs.some((input) => input.includes('/@aws-sdk/client-secrets-manager/'))) throw new Error(`Secrets Manager SDK is not bundled in ${feature} Lambda.`);
    const outputs = Object.values(metadata.outputs);
    if (outputs.length !== 1 || !outputs[0]!.entryPoint?.endsWith(`src/modules/${feature}/handler.ts`) || !outputs[0]!.exports.includes('handler')) {
      throw new Error(`Expected the ${feature} Lambda handler entry point and export.`);
    }
    for (const dependency of outputs[0]!.imports) {
      // pg exposes a lazy optional native implementation. We use the bundled
      // JavaScript Pool; pg-native is the only intentionally absent external.
      if (!dependency.external || (!isBuiltin(dependency.path) && dependency.path !== 'pg-native')) {
        throw new Error(`Unbundled dependency ${dependency.path} in ${feature} Lambda.`);
      }
    }
    const loaded = await import(pathToFileURL(bundlePath).href) as { handler?: unknown };
    if (typeof loaded.handler !== 'function') throw new Error(`The ${feature} bundle does not export a runnable handler.`);
  }
  const webRoot = join(root, 'apps/web/dist');
  await readFile(join(webRoot, 'index.html')); // Missing builds must fail closed.
  const assets = await artifactFiles(webRoot);
  if (!assets.some((path) => path.endsWith('.js'))) throw new Error('No frontend JavaScript artifacts were found.');
  for (const path of assets) {
    if (localCode.test(path) || localCode.test(await readFile(path, 'utf8'))) throw new Error(`Local authentication found in frontend artifact ${path}.`);
  }
}

async function artifactFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await artifactFiles(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Unexpected non-file production artifact ${path}.`);
  }
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    await checkBundles(root);
    await checkMigrationBundle(join(root, 'packages/database/dist/lambda'), root);
    process.stdout.write('Bundle check passed: three API Lambdas, private migration Lambda with SQL and CA, and a frontend without local authentication.\n');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Bundle inspection failed.'}\n`);
    process.exitCode = 1;
  }
}
