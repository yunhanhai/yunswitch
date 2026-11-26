import { useCallback, useEffect, useRef, type FormEvent } from "react";

// A session stays dirty after the first edit, even if a value is later restored.
// No field values are retained here: passwords/configuration stay in the form.
export function useProviderDraftChange(
  onDirtyChange?: (dirty: boolean) => void,
) {
  const dirty = useRef(false);
  const notify = useRef(onDirtyChange);
  notify.current = onDirtyChange;

  useEffect(() => {
    notify.current?.(dirty.current);
  }, []);

  const markDirty = useCallback(() => {
    if (dirty.current) return;
    dirty.current = true;
    notify.current?.(true);
  }, []);

  // Keep callback identity for stable setters; child hydration effects must
  // not interpret a new wrapper as another user update. Weak keys retain no
  // discarded callback or its captured draft after the session is gone.
  const tracked = useRef(
    new WeakMap<(...args: never[]) => unknown, (...args: never[]) => unknown>(),
  );
  const trackChange = useCallback(
    <Args extends unknown[], Result>(
      change: (...args: Args) => Result,
    ): ((...args: Args) => Result) => {
      let wrapper = tracked.current.get(change) as
        | ((...args: Args) => Result)
        | undefined;
      if (!wrapper) {
        wrapper = (...args: Args): Result => {
          markDirty();
          return change(...args);
        };
        tracked.current.set(change, wrapper);
      }
      return wrapper;
    },
    [markDirty],
  );

  // Run after the field's own handler. Updating the parent in capture can
  // restore a controlled input's old value before its change handler runs.
  const onFieldChange = useCallback(
    (event: FormEvent) => {
      const element = event.target;
      if (!(element instanceof HTMLElement)) return;
      // Search in a model picker changes only the visible choices.
      if (
        element.closest(
          '[cmdk-input], input[type="search"], [data-draft-ignore]',
        )
      )
        return;
      if (
        element.matches("input, textarea, select") ||
        element.isContentEditable
      ) {
        markDirty();
      }
    },
    [markDirty],
  );

  return { markDirty, trackChange, onFieldChange };
}
