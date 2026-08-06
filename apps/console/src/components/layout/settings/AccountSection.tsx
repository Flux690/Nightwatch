import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsRow } from "./SettingsRow";

interface AccountSectionProps {
  onLogoutAll: () => void;
}

export function AccountSection({
  onLogoutAll,
}: AccountSectionProps): React.JSX.Element {
  return (
    <SettingsGroup>
      <SettingsRow
        controlId="settings-logout-all"
        title="Log out all devices"
        description="Ends every signed-in session, including this one."
      >
        <Button
          id="settings-logout-all"
          type="button"
          variant="destructive-ghost"
          onClick={onLogoutAll}
        >
          Log out everywhere
        </Button>
      </SettingsRow>
    </SettingsGroup>
  );
}
