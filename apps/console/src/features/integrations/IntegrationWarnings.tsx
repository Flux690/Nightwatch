import { Alert, AlertDescription } from "@/shared/ui/alert";

/* One box for everything a product will not do unless you go and check it.
   Stacked as a box each, two of them read as two unrelated problems; the set
   is one warning about one screen, so it is drawn once and lists its items. */
export function IntegrationWarnings({
  warnings,
}: {
  warnings: string[];
}): React.JSX.Element | null {
  if (warnings.length === 0) return null;
  return (
    <Alert variant="warning">
      <AlertDescription>
        {warnings.length === 1 ? (
          warnings[0]
        ) : (
          <ul className="m-0 flex list-disc flex-col gap-1 pl-4">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  );
}
