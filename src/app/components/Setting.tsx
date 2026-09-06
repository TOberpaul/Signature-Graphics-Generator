"use client";

import { DBInfotext, DBTooltip } from "@db-ux/react-core-components";
import type { ReactNode } from "react";

/**
 * One setting in the panel.
 *
 * Every setting looks and behaves the same: a control, an explanation on hover,
 * and optionally a line showing what the current value means. The tooltip
 * attaches to this wrapper, so hovering anywhere on the field shows it - which
 * also works for design system components that render their own label markup and
 * cannot host a tooltip themselves.
 *
 * Disabled settings stay visible rather than disappearing, so the panel does not
 * change shape when an image arrives. They keep their own explanation, so the
 * settings can be read up front; that they need an image is stated once for the
 * whole panel instead of repeated on every field.
 */
export function Setting({
  id,
  help,
  state,
  disabled,
  children,
}: {
  /** Id for the tooltip, referenced by aria-describedby. */
  id: string;
  help: string;
  /** What the current value means, shown permanently below the control. */
  state?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="field" data-disabled={disabled ? "true" : undefined}>
      {children}
      {state && !disabled ? (
        <DBInfotext semantic="adaptive" size="small" showIcon={false}>
          {state}
        </DBInfotext>
      ) : null}
      {/* No per field explanation while the setting cannot be used: the panel says
          once that an image is missing, and a field explaining what it would do
          only competes with that. */}
      {disabled ? null : (
        <DBTooltip placement="right" id={id}>
          {help}
        </DBTooltip>
      )}
    </div>
  );
}

/**
 * A setting backed by a range input.
 *
 * There is no design system slider, so this is the one place where a native
 * control is styled with design system tokens. Keeping it here means every
 * slider in the app is identical.
 */
export function RangeSetting({
  id,
  label,
  help,
  state,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  state?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <Setting id={`${id}-help`} help={help} state={state} disabled={disabled}>
      {/* `data-font-size="sm"` matches the small DBCheckbox label next to it, so
          the slider labels read at the same size as the other controls' labels. */}
      <label className="field-label" data-font-size="sm" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-describedby={`${id}-help`}
      />
    </Setting>
  );
}
