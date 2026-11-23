// Lists the reasoning levels the chosen model supports; a stored level the model lacks shows as unavailable instead of being replaced.
import type { ReactElement } from "react";

export type ReasoningPickerProps = Readonly<{
  levels: ReadonlyArray<string>;
  value: string;
  onChange: (level: string) => void;
}>;

export function ReasoningPicker({ levels, value, onChange }: ReasoningPickerProps): ReactElement {
  const isOffered = levels.includes(value);
  return (
    <select className="picker" aria-label="Reasoning" value={value} onChange={(event) => onChange(event.target.value)}>
      {isOffered ? null : (
        <option value={value} disabled>
          {value} (not offered)
        </option>
      )}
      {levels.map((level) => (
        <option key={level} value={level}>
          {level}
        </option>
      ))}
    </select>
  );
}
