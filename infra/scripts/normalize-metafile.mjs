import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { argv } from 'node:process';

const metadataPath = argv[2];
if (!metadataPath) throw new Error('Expected the Lambda esbuild metafile path.');
const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
const outputs = Object.entries(metadata.outputs);
if (outputs.length !== 1 || basename(outputs[0][0]) !== 'index.mjs') {
  throw new Error('Expected exactly one index.mjs Lambda output.');
}

// esbuild includes CDK's random synth/staging directory in this output key.
// Keep all analyzed inputs/imports/exports/bytes, using its archive-relative name
// before CDK computes the asset hash over the completed bundling output.
metadata.outputs = { 'index.mjs': outputs[0][1] };
writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
