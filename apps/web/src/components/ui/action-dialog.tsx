'use client';

import { useActionState, useEffect, useRef } from 'react';
import { IDLE_RESULT, type ActionResult } from '@/lib/action-result';
import { useToast } from './toast';

type ServerAction = (previous: ActionResult, formData: FormData) => Promise<ActionResult>;

const triggerStyles = {
  primary: 'bg-blue-700 text-white hover:bg-blue-800 border-transparent',
  secondary: 'bg-white text-slate-700 hover:bg-slate-50 border-slate-300',
  danger: 'bg-white text-red-700 hover:bg-red-50 border-red-300',
} as const;

/**
 * A button that opens a dialog containing a form bound to a Server Action.
 * Used for both confirmations ("Block this student?") and edit forms.
 *
 * - Shows a pending state while the server works (prevents double-submit).
 * - On success: closes and shows a green toast.
 * - On failure: stays open and shows the error and field messages.
 */
export function ActionDialog({
  triggerLabel,
  triggerVariant = 'secondary',
  title,
  description,
  submitLabel,
  danger = false,
  action,
  hidden,
  children,
  disabled,
  disabledReason,
}: {
  triggerLabel: string;
  triggerVariant?: keyof typeof triggerStyles;
  title: string;
  description?: React.ReactNode;
  submitLabel: string;
  danger?: boolean;
  action: ServerAction;
  hidden?: Record<string, string>;
  children?: React.ReactNode;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState(action, IDLE_RESULT);
  const toast = useToast();

  useEffect(() => {
    if (state.at === 0) return;
    if (state.ok) {
      toast('success', state.message);
      formRef.current?.reset();
      dialogRef.current?.close();
    }
  }, [state, toast]);

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        onClick={() => dialogRef.current?.showModal()}
        className={`rounded-md border px-2.5 py-1 text-xs font-medium whitespace-nowrap shadow-sm disabled:cursor-not-allowed disabled:opacity-50 ${triggerStyles[triggerVariant]}`}
      >
        {triggerLabel}
      </button>

      <dialog
        ref={dialogRef}
        className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-slate-200 p-0 shadow-xl backdrop:bg-slate-900/40"
        aria-labelledby={`${title}-title`}
      >
        <form ref={formRef} action={formAction} className="space-y-4 p-5" noValidate>
          <div>
            <h2 id={`${title}-title`} className="text-base font-semibold text-slate-900">
              {title}
            </h2>
            {description && <div className="mt-1 text-sm text-slate-600">{description}</div>}
          </div>

          {Object.entries(hidden ?? {}).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}

          {!state.ok && state.at !== 0 && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <p>{state.message}</p>
              {state.fieldErrors && (
                <ul className="mt-1 list-disc pl-5">
                  {Object.entries(state.fieldErrors).map(([field, message]) => (
                    <li key={field}>{message}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {children}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              className={`rounded-md px-3 py-1.5 text-sm font-semibold text-white shadow-sm disabled:opacity-60 ${
                danger ? 'bg-red-700 hover:bg-red-800' : 'bg-blue-700 hover:bg-blue-800'
              }`}
            >
              {pending ? 'Saving…' : submitLabel}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
