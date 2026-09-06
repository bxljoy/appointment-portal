import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { Button } from './button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from './dialog';

it('opens a labeled dialog by keyboard, traps focus, and restores focus on Escape', async () => {
  const user = userEvent.setup();
  render(<Dialog><DialogTrigger asChild><Button>Review appointment</Button></DialogTrigger><DialogContent><DialogTitle>Confirm appointment</DialogTitle><DialogDescription>Review the time before booking.</DialogDescription><Button>Confirm</Button></DialogContent></Dialog>);
  await user.tab();
  expect(screen.getByRole('button', { name: 'Review appointment' })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('dialog', { name: 'Confirm appointment' })).toHaveAccessibleDescription('Review the time before booking.');
  expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Review appointment' })).toHaveFocus();
});
