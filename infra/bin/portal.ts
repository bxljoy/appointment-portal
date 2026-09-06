#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { parsePortalConfig } from '../lib/config.js';
import { PortalStack } from '../lib/portal-stack.js';

const app = new App();
const config = parsePortalConfig({
  account: app.node.tryGetContext('account'),
  region: app.node.tryGetContext('region'),
  postgresVersion: app.node.tryGetContext('postgresVersion'),
  phase: app.node.tryGetContext('phase'),
  qualifier: app.node.tryGetContext('qualifier'),
  frontendUrl: app.node.tryGetContext('frontendUrl'),
});
new PortalStack(app, 'AppointmentPortal', {
  env: { account: config.account, region: config.region }, config,
});
