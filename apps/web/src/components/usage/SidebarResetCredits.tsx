import { useState } from "react";
import {
  resetCreditAccountLabel,
  resetCreditSummaryLines,
  resetCreditChoices,
  type LimitAccount,
} from "@t3tools/shared/usageLimits";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ResetCreditDialog, useResetCredit } from "./UsageLimits";

/** Keep the confirmation outside the popover so closing details cannot dismiss it. */
export function SidebarResetCredits({
  account,
  now,
}: {
  readonly account: LimitAccount & { readonly redeem: NonNullable<LimitAccount["redeem"]> };
  readonly now: number;
}) {
  const [open, setOpen] = useState(false);
  const reset = useResetCredit(account.redeem.environmentId);
  const credits = account.limits.resetCredits;
  if (!credits) return null;
  const accountLabel = resetCreditAccountLabel(account);
  const summaries = resetCreditSummaryLines(credits, now);
  const choices = resetCreditChoices(credits, account.redeem.input, now);
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={<Button variant="ghost" size="sm-multiline" />}
          className="w-full flex-col items-start text-left"
        >
          <span>{accountLabel}: reset credits</span>
          {summaries.map((summary) => (
            <span key={summary} className="text-muted-foreground">
              {summary}
            </span>
          ))}
        </PopoverTrigger>
        <PopoverPopup width="md" side="right" align="end" className="max-w-[calc(100vw-2rem)]">
          <div className="flex flex-col gap-3 text-xs">
            <p className="font-medium">Reset credits · {accountLabel}</p>
            {choices.map((choice) => (
              <div key={choice.key} className="flex flex-col items-start gap-2">
                <span>{choice.summary}</span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={choice.availableCount === 0 || reset.busy || !reset.canManageProviders}
                  onClick={() => {
                    setOpen(false);
                    reset.confirm({
                      ...choice,
                      confirmDescription: `${accountLabel}. ${choice.confirmDescription}`,
                    });
                  }}
                >
                  Use reset…
                </Button>
              </div>
            ))}
          </div>
        </PopoverPopup>
      </Popover>
      {reset.status ? (
        <p role="status" className="px-1 text-xs">
          {reset.status}
        </p>
      ) : null}
      <ResetCreditDialog
        open={reset.confirming}
        onOpenChange={reset.setConfirming}
        choice={reset.choice}
        onConfirm={() => void reset.redeem()}
        disabled={reset.busy || !reset.canManageProviders}
      />
    </>
  );
}
