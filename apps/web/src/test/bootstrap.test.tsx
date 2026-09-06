import { expect, it, vi } from 'vitest';

it('waits for validated configuration before creating a React tree', async () => {
  const render = vi.fn();
  const createRoot = vi.fn(() => ({ render }));
  let resolveConfig!: (value: unknown) => void;
  const config = new Promise((resolve) => { resolveConfig = resolve; });
  vi.doMock('react-dom/client', () => ({ createRoot }));
  vi.doMock('../lib/config', () => ({ loadPublicConfig: () => config }));
  document.body.innerHTML = '<div id="root"></div>';
  await import('../main');
  expect(createRoot).not.toHaveBeenCalled();
  resolveConfig({ mode: 'local', apiBaseUrl: '/api' });
  await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
  expect(createRoot).toHaveBeenCalledWith(document.getElementById('root'));
});

it('shows a recoverable startup error for invalid configuration', async () => {
  vi.resetModules();
  const render = vi.fn();
  const createRoot = vi.fn(() => ({ render }));
  vi.doMock('react-dom/client', () => ({ createRoot }));
  vi.doMock('../lib/config', () => ({ loadPublicConfig: async () => { throw new Error('Invalid deployment config'); } }));
  document.body.innerHTML = '<div id="root"></div>';
  await import('../main');
  await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
  const { renderToStaticMarkup } = await import('react-dom/server');
  const html = renderToStaticMarkup(render.mock.calls[0]?.[0]);
  expect(html).toContain('We could not start the portal');
  expect(html).toContain('Reload page');
  expect(html).not.toContain('Invalid deployment config');
});
