"use client";

import { DBInfotext, DBTooltip } from "@db-ux/react-core-components";
import type { CSSProperties, ReactNode } from "react";

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
 * The one slider in the app.
 *
 * There is no design system slider, so a native range input is styled with design
 * system tokens instead (see `input[type="range"]` in globals.css). Chromium draws
 * no filled part of the track once the track has its own background, and has no
 * pseudo element for it either, so the fill is a gradient and the position has to
 * come from here as `--range-fill`.
 */
export function RangeInput({
  id,
  describedBy,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  id?: string;
  /**
   * Id of the element describing this slider, for `aria-describedby`.
   *
   * Has to be passed in: DBTooltip attaches its `aria-describedby` to its own
   * parent, which for a {@link Setting} is the wrapping field rather than the
   * control - so without this the help text never reaches the slider itself.
   */
  describedBy?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  // Guard against min === max, which would divide by zero on a fixed range.
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;

  return (
    <input
      id={id}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-describedby={describedBy}
      onChange={(event) => onChange(Number(event.target.value))}
      style={{ "--range-fill": `${fill}%` } as CSSProperties}
    />
  );
}

/**
 * A setting backed by a range input.
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
      {/* Only while the tooltip is actually rendered - `Setting` leaves it out on a
          disabled field, and pointing at an id that does not exist is worse than
          pointing at nothing. */}
      <RangeInput
        id={id}
        describedBy={disabled ? undefined : `${id}-help`}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={onChange}
      />
    </Setting>
  );
}
