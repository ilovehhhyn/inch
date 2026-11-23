// Lists the models of the chosen provider; a stored model that is no longer offered shows as unavailable instead of being replaced.
import type { ReactElement } from "react";

import type { ModelOption } from "../../shared/models";

export type ModelPickerProps = Readonly<{
  models: ReadonlyArray<ModelOption>;
  value: string;
  onChange: (modelId: string) => void;
}>;

export function ModelPicker({ models, value, onChange }: ModelPickerProps): ReactElement {
  const isOffered = models.some((model) => model.id === value);
  return (
    <select className="picker" aria-label="Model" value={value} onChange={(event) => onChange(event.target.value)}>
      {isOffered ? null : (
        <option value={value} disabled>
          {value} (not offered)
        </option>
      )}
      {models.map((model) => (
        <option key={model.id} value={model.id}>
          {model.label}
        </option>
      ))}
    </select>
  );
}
