"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";

const KEYS: [string[], string][] = [
  [["j", "↓"], "Next task"],
  [["k", "↑"], "Previous task"],
  [["x", "Space"], "Complete / reopen"],
  [["d"], "Skip / unskip the task"],
  [["o", "Enter"], "Open the task's link"],
  [["s"], "Shift the rest of today"],
  [["1–4"], "Pick a shift option"],
  [["p"], "Pause / resume the schedule"],
  [["u"], "Undo the last change (5 s)"],
  [["n"], "Jump to now"],
  [["?"], "This help"],
  [["Esc"], "Close"],
];

export function HelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange(o: boolean): void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" data-testid="help-dialog">
        <DialogHeader>
          <DialogTitle>Keyboard</DialogTitle>
          <DialogDescription>Everything on this page works without a mouse.</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          {KEYS.map(([keys, what]) => (
            <div key={what} className="contents">
              <dt className="flex gap-1">
                {keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </dt>
              <dd className="text-muted-foreground">{what}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
