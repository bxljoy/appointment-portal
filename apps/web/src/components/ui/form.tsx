import { createContext, useContext, useId, type ComponentProps } from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { Slot } from '@radix-ui/react-slot';
import { Controller, FormProvider, useFormContext, type ControllerProps, type FieldPath, type FieldValues } from 'react-hook-form';
import { cn } from './button';

export const Form = FormProvider;
const FieldContext = createContext<{ name: string } | null>(null);
const ItemContext = createContext<string | null>(null);
export function FormField<T extends FieldValues, N extends FieldPath<T>>(props: ControllerProps<T, N>) {
  return <FieldContext.Provider value={{ name: props.name }}><Controller {...props} /></FieldContext.Provider>;
}
function useFormField() {
  const field = useContext(FieldContext);
  const id = useContext(ItemContext);
  const form = useFormContext();
  if (!field || !id || !form) throw new Error('Form fields require Form, FormField and FormItem');
  return { id: `${id}-control`, descriptionId: `${id}-description`, messageId: `${id}-message`, ...form.getFieldState(field.name, form.formState) };
}
export function FormItem({ className, ...props }: ComponentProps<'div'>) {
  const id = useId();
  return <ItemContext.Provider value={id}><div className={cn('space-y-2', className)} {...props} /></ItemContext.Provider>;
}
export function FormLabel(props: ComponentProps<typeof LabelPrimitive.Root>) {
  const { id, invalid } = useFormField();
  return <LabelPrimitive.Root {...props} htmlFor={id} className={cn('text-sm font-medium', invalid && 'text-destructive', props.className)} />;
}
export function FormControl(props: ComponentProps<typeof Slot>) {
  const { id, descriptionId, messageId, invalid } = useFormField();
  return <Slot {...props} id={id} aria-describedby={invalid ? `${descriptionId} ${messageId}` : descriptionId} aria-invalid={invalid} />;
}
export function FormDescription(props: ComponentProps<'p'>) {
  const { descriptionId } = useFormField();
  return <p {...props} id={descriptionId} className={cn('text-sm text-muted-foreground', props.className)} />;
}
export function FormMessage({ children, ...props }: ComponentProps<'p'>) {
  const { error, messageId } = useFormField();
  const body = error ? String(error.message ?? '') : children;
  if (!body) return null;
  return <p {...props} id={messageId} role="alert" className={cn('text-sm text-destructive', props.className)}>{body}</p>;
}
