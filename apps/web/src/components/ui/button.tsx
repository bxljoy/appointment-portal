import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: Parameters<typeof clsx>) => twMerge(clsx(inputs));
const buttonVariants = cva('inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50', {
  variants: {
    variant: {
      default: 'bg-primary text-primary-foreground hover:bg-primary-hover',
      outline: 'border border-border bg-surface text-foreground hover:bg-muted',
      ghost: 'text-foreground hover:bg-muted',
      destructive: 'bg-destructive text-white hover:opacity-90',
    },
  },
  defaultVariants: { variant: 'default' },
});
export function Button({ className, variant, asChild = false, type = 'button', ...props }: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'button';
  return <Component data-slot="button" type={asChild ? undefined : type} className={cn(buttonVariants({ variant }), className)} {...props} />;
}
