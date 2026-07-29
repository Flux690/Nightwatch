import { Button } from "@/components/ui/button";
import { FIELD_HINT, FIELD_WIDTH } from "./layout";

interface AccountSectionProps {
  onLogoutAll: () => void;
}

export function AccountSection({
  onLogoutAll,
}: AccountSectionProps): React.JSX.Element {
  return (
    <div className="flex flex-col items-start gap-2">
      <Button type="button" variant="destructive" onClick={onLogoutAll}>
        Log out all devices
      </Button>
      <p className={FIELD_HINT}>
        Ends every signed-in session, including this one. Use it if a device was
        lost or a session may have been taken.
      </p>
    </div>
  );
}
