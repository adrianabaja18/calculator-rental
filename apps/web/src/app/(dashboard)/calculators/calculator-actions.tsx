'use client';

import { CalculatorCondition, CalculatorStatus } from '@calc-rental/shared';
import { ActionDialog } from '@/components/ui/action-dialog';
import { Field, Select, TextArea, TextInput } from '@/components/ui/form-field';
import {
  createCalculator,
  moveCalculatorToMaintenance,
  reactivateCalculator,
  updateCalculator,
} from './actions';

export interface LockerOption {
  id: string;
  label: string;
  /** Calculator id currently in this locker, if any */
  calculatorId: string | null;
}

export interface CalculatorRow {
  id: string;
  code: string;
  model: string;
  rfidUid: string;
  lockerId: string | null;
  condition: string;
  notes: string | null;
  status: string;
  hasOpenRental: boolean;
}

const CONDITION_OPTIONS = Object.values(CalculatorCondition).map((c) => ({ value: c, label: c }));

/** Lockers that are empty, plus the one this calculator is already in. */
function lockerChoices(lockers: LockerOption[], calculatorId?: string) {
  return [
    { value: '', label: 'No locker (not ready to lend)' },
    ...lockers
      .filter((l) => !l.calculatorId || l.calculatorId === calculatorId)
      .map((l) => ({ value: l.id, label: l.label })),
  ];
}

function DetailFields({ lockers, calculator }: { lockers: LockerOption[]; calculator?: CalculatorRow }) {
  return (
    <div className="space-y-3">
      <Field label="Model">
        <TextInput name="model" required maxLength={100} defaultValue={calculator?.model ?? 'Casio fx-991EX ClassWiz'} />
      </Field>
      <Field label="RFID tag UID" hint="As read by the RC522, e.g. 04-A1-B2-C3-D4 or 04:a1:b2:c3:d4">
        <TextInput name="rfidUid" required defaultValue={calculator?.rfidUid} className="font-mono" />
      </Field>
      <Field label="Locker">
        <Select name="lockerId" defaultValue={calculator?.lockerId ?? ''} options={lockerChoices(lockers, calculator?.id)} />
      </Field>
      <Field label="Condition">
        <Select name="condition" defaultValue={calculator?.condition ?? CalculatorCondition.GOOD} options={CONDITION_OPTIONS} />
      </Field>
      <Field label="Notes">
        <TextArea name="notes" maxLength={500} defaultValue={calculator?.notes ?? ''} />
      </Field>
    </div>
  );
}

export function AddCalculatorButton({ suggestedCode, lockers }: { suggestedCode: string; lockers: LockerOption[] }) {
  return (
    <ActionDialog
      triggerLabel="+ Add calculator"
      triggerVariant="primary"
      title="Add calculator"
      description="It becomes AVAILABLE once it has a locker. The kiosk still checks its RFID tag before lending it."
      submitLabel="Add calculator"
      action={createCalculator}
    >
      <Field label="Code" hint="Format CALC-001">
        <TextInput name="code" required defaultValue={suggestedCode} className="font-mono" />
      </Field>
      <DetailFields lockers={lockers} />
    </ActionDialog>
  );
}

export function CalculatorRowActions({ calculator, lockers }: { calculator: CalculatorRow; lockers: LockerOption[] }) {
  const inService = calculator.status === CalculatorStatus.AVAILABLE || calculator.status === CalculatorStatus.RENTED;
  return (
    <div className="flex justify-end gap-1.5">
      <ActionDialog
        triggerLabel="Edit"
        title={`Edit ${calculator.code}`}
        description={
          calculator.hasOpenRental
            ? 'This calculator is out with a student: its RFID tag and locker are locked until it is returned.'
            : undefined
        }
        submitLabel="Save changes"
        action={updateCalculator}
        hidden={{ calculatorId: calculator.id }}
      >
        <DetailFields lockers={lockers} calculator={calculator} />
      </ActionDialog>

      {inService ? (
        <ActionDialog
          triggerLabel="Maintenance"
          triggerVariant="danger"
          title={`Move ${calculator.code} to maintenance?`}
          description="The kiosk will stop lending it out until it is reactivated."
          submitLabel="Move to maintenance"
          danger
          action={moveCalculatorToMaintenance}
          hidden={{ calculatorId: calculator.id }}
          disabled={calculator.hasOpenRental}
          disabledReason="Out with a student: available after it is returned"
        >
          <Field label="Reason">
            <TextArea name="reason" required minLength={3} maxLength={200} placeholder="e.g. Sticky keys, needs cleaning" />
          </Field>
        </ActionDialog>
      ) : (
        <ActionDialog
          triggerLabel="Reactivate"
          title={`Reactivate ${calculator.code}?`}
          description="It becomes AVAILABLE. It needs a locker and must not be marked DAMAGED."
          submitLabel="Reactivate"
          action={reactivateCalculator}
          hidden={{ calculatorId: calculator.id }}
        />
      )}
    </div>
  );
}
