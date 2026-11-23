// Chooses the provider of a new chat; it is drawn only before the chat exists, because a chat keeps its provider for good.
import type { ReactElement } from "react";

import { PROVIDER_NAMES, type ProviderId } from "../../shared/provider-id";

export type ProviderPickerProps = Readonly<{
  providers: ReadonlyArray<ProviderId>;
  selected: ProviderId;
  onChange: (provider: ProviderId) => void;
}>;

export function ProviderPicker({ providers, selected, onChange }: ProviderPickerProps): ReactElement {
  return (
    <select className="picker" aria-label="Provider" value={selected} onChange={(event) => onChange(providers.find((provider) => provider === event.target.value) ?? selected)}>
      {providers.map((provider) => (
        <option key={provider} value={provider}>
          {PROVIDER_NAMES[provider]}
        </option>
      ))}
    </select>
  );
}
