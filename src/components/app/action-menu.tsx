import { ChevronDown } from "lucide-react";

import { Button } from "../ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.js";

export interface ActionMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
}

/**
 * One action with a choice of target, such as connecting one of several apps. The button reads
 * as the action itself, and the menu under it names each target; a single target is just the
 * button, so callers pass whatever they have.
 */
export function ActionMenu({
  label,
  items,
  disabled = false,
}: {
  label: string;
  items: readonly ActionMenuItem[];
  disabled?: boolean;
}) {
  const only = items.length === 1 ? items[0] : undefined;
  if (only !== undefined) {
    return (
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={only.onSelect}>
        {label}
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          {label}
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((item) => (
          <DropdownMenuItem key={item.id} onSelect={item.onSelect}>
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
