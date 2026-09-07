#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { parsePortalConfig } from '../lib/config.js';
import { PortalStack } from '../lib/portal-stack.js';
import { DeliveryStack } from '../lib/delivery-stack.js';

const app = new App();
const config = parsePortalConfig({
  account: app.node.tryGetContext('account'),
  region: app.node.tryGetContext('region'),
  postgresVersion: app.node.tryGetContext('postgresVersion'),
  phase: app.node.tryGetContext('phase'),
  qualifier: app.node.tryGetContext('qualifier'),
  expiresAt: app.node.tryGetContext('expiresAt'),
  frontendUrl: app.node.tryGetContext('frontendUrl'),
});
const sourceCommit = app.node.tryGetContext('sourceCommit') as unknown;
if (sourceCommit !== undefined && (typeof sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(sourceCommit))) throw new Error('Invalid source commit context.');
new PortalStack(app, 'AppointmentPortal', {
  env: { account: config.account, region: config.region }, config, ...(sourceCommit ? { sourceCommit } : {}),
});
const repository = app.node.tryGetContext('repository') as unknown;
if (repository !== undefined) {
  const branch = app.node.tryGetContext('branch') as unknown;
  const oidcProviderArn = app.node.tryGetContext('oidcProviderArn') as unknown;
  if (typeof repository !== 'string' || typeof branch !== 'string' || (oidcProviderArn !== undefined && typeof oidcProviderArn !== 'string')) {
    throw new Error('Delivery context requires repository and branch strings plus an optional OIDC provider ARN.');
  }
  new DeliveryStack(app, 'AppointmentPortalDelivery', {
    env: { account: config.account, region: config.region },
    repository, branch, ...(oidcProviderArn ? { oidcProviderArn } : {}),
    qualifier: 'apptdemo', projectTag: 'appointment-portal',
  });
}
