import { useLayoutEffect, useRef, type ComponentProps } from 'react';

/** A stable focus destination when an authentication or loading screen mounts. */
export function FocusMain(props: ComponentProps<'main'>) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => { ref.current?.focus(); }, []);
  return <main {...props} id="main-content" tabIndex={-1} ref={ref} />;
}
