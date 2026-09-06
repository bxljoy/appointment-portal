import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ComponentProps } from 'react';
import { cn } from './button';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export function DialogContent({ className, children, ...props }: ComponentProps<typeof DialogPrimitive.Content>) {
  return <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/40" />
    <DialogPrimitive.Content className={cn('fixed left-1/2 top-1/2 z-50 w-[calc(100%_-_2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-6 shadow-lg', className)} {...props}>
      {children}
      <DialogPrimitive.Close className="absolute right-3 top-3 flex min-h-11 min-w-11 items-center justify-center rounded-md text-xl hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" aria-label="Close dialog">×</DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>;
}
export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('pr-10 text-xl font-semibold', className)} {...props} />;
}
export function DialogDescription({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('mt-2 text-sm text-muted-foreground', className)} {...props} />;
}
