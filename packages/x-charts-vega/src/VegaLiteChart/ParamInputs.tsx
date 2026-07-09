'use client';
import * as React from 'react';
import Slider from '@mui/material/Slider';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Checkbox from '@mui/material/Checkbox';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormLabel from '@mui/material/FormLabel';
import RadioGroup from '@mui/material/RadioGroup';
import Radio from '@mui/material/Radio';
import type { CompiledParamInput } from '../compile/params';

/*
 * OWNERSHIP: the "selections & interactivity" work unit owns this file.
 *
 * Renders the bound-param input widgets (range/select/checkbox/radio) as a
 * flex-wrap toolbar above the chart. Each control is fully controlled off the
 * shared param values (falling back to the descriptor's `initialValue`) and
 * writes coerced values back through `onChange`. select/radio round-trip the
 * chosen option by index so numbers/booleans survive the DOM string coercion.
 */

export interface ParamInputsProps {
  inputs: CompiledParamInput[];
  values: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
}

function currentOptionIndex(input: CompiledParamInput, values: Record<string, unknown>): number {
  const options = input.options ?? [];
  const current = values[input.name] ?? input.initialValue;
  const index = options.findIndex((option) => option === current);
  return index >= 0 ? index : 0;
}

function ParamInput(props: {
  input: CompiledParamInput;
  values: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
}) {
  const { input, values, onChange } = props;
  const { name, label } = input;

  if (input.kind === 'range') {
    const value = Number(values[name] ?? input.initialValue);
    return (
      <FormControl sx={{ minWidth: 160 }}>
        <FormLabel sx={{ fontSize: 12 }}>{label}</FormLabel>
        <Slider
          size="small"
          aria-label={label}
          value={Number.isFinite(value) ? value : (input.min ?? 0)}
          min={input.min ?? 0}
          max={input.max ?? 100}
          step={input.step}
          valueLabelDisplay="auto"
          onChange={(_event, next) => onChange(name, Number(Array.isArray(next) ? next[0] : next))}
        />
      </FormControl>
    );
  }

  if (input.kind === 'checkbox') {
    const checked = Boolean(values[name] ?? input.initialValue);
    return (
      <FormControlLabel
        control={
          <Checkbox
            size="small"
            checked={checked}
            onChange={(event) => onChange(name, event.target.checked)}
          />
        }
        label={label}
      />
    );
  }

  const options = input.options ?? [];
  const selectedIndex = currentOptionIndex(input, values);
  const optionLabel = (index: number) => input.labels?.[index] ?? String(options[index]);

  if (input.kind === 'radio') {
    return (
      <FormControl>
        <FormLabel sx={{ fontSize: 12 }}>{label}</FormLabel>
        <RadioGroup
          row
          value={String(selectedIndex)}
          onChange={(event) => onChange(name, options[Number(event.target.value)])}
        >
          {options.map((_option, index) => (
            <FormControlLabel
              key={index}
              value={String(index)}
              control={<Radio size="small" />}
              label={optionLabel(index)}
            />
          ))}
        </RadioGroup>
      </FormControl>
    );
  }

  // select
  return (
    <FormControl sx={{ minWidth: 160 }}>
      <FormLabel sx={{ fontSize: 12 }}>{label}</FormLabel>
      <Select
        size="small"
        value={String(selectedIndex)}
        onChange={(event) => onChange(name, options[Number(event.target.value)])}
      >
        {options.map((_option, index) => (
          <MenuItem key={index} value={String(index)}>
            {optionLabel(index)}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

/**
 * Toolbar of controls for a spec's bound variable params.
 * @param {ParamInputsProps} props The input descriptors, current values, and change handler.
 * @returns {React.JSX.Element} The rendered widget toolbar.
 */
export function ParamInputs(props: ParamInputsProps) {
  const { inputs, values, onChange } = props;
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 16,
        alignItems: 'flex-end',
        marginBottom: 8,
      }}
    >
      {inputs.map((input) => (
        <ParamInput key={input.name} input={input} values={values} onChange={onChange} />
      ))}
    </div>
  );
}
