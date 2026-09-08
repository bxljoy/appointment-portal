/** @param {'bootstrap' | 'ready'} phase @returns {string[]} */
export const offlineSynthContextArgs = (phase) => [
  '-c', 'account=111111111111',
  '-c', 'region=eu-north-1',
  '-c', 'postgresVersion=17.6',
  '-c', 'qualifier=apptdemo',
  '-c', `phase=${phase}`,
  '-c', 'repository=OWNER/REPOSITORY',
  '-c', 'repositoryOwnerId=12345678',
  '-c', 'repositoryId=87654321',
  '-c', 'branch=main',
  '-c', 'expiresAt=2030-06-01T18:00:00.000Z',
  ...(phase === 'ready' ? ['-c', 'frontendUrl=https://demo.cloudfront.net'] : []),
];
