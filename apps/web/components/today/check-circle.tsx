"use client";

import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

interface Props {
  checked: boolean;
  /** Skipped items fill grey with a dash instead of the track colour and a check. */
  skipped?: boolean;
  color: string;
  label: string;
  onToggle(): void;
  className?: string;
}

/**
 * Round checkbox, Todoist-style but faster to read:
 * - rest: 1.5px ring in the track colour on a 10% tint of it
 * - hover/focus: the check previews inside the ring
 * - checked: the fill flips in the same frame as the click (no fade on the fill itself), then a
 *   220 ms pop + check draw. Reduced motion keeps only the instant fill.
 * - keyboard focus: a solid 2 px ring (focus-visible), never removed
 * The 20 px circle sits in a 40 px hit area.
 */
export function CheckCircle({ checked, skipped, color, label, onToggle, className }: Props) {
  const reduce = useReducedMotion();
  const c = skipped ? "var(--muted-foreground)" : color;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      data-testid="check"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={cn(
        "group/check relative grid size-10 shrink-0 place-items-center rounded-full",
        "focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-ring focus-visible:outline-solid",
        className,
      )}
      style={{ ["--c" as string]: c }}
    >
      <motion.span
        data-fill={checked ? "on" : "off"}
        className={cn(
          "relative grid size-5 place-items-center rounded-full border-[1.5px] border-(--c)",
          checked ? "bg-(--c)" : "bg-[color-mix(in_oklab,var(--c)_10%,transparent)]",
        )}
        initial={false}
        animate={checked && !reduce ? { scale: [1, 0.82, 1.06, 1] } : { scale: 1 }}
        transition={{ duration: 0.22, ease: [0.25, 1, 0.5, 1] }}
      >
        <svg viewBox="0 0 20 20" className="size-3.5" aria-hidden>
          <motion.path
            d={checked && skipped ? "M6 10H14" : "M5.5 10.4 8.6 13.4 14.6 7"}
            fill="none"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cn(
              checked
                ? "stroke-(--surface)"
                : "stroke-(--c) opacity-0 transition-opacity duration-150 group-hover/check:opacity-70 group-focus-visible/check:opacity-70",
            )}
            key={checked ? "on" : "off"}
            initial={checked && !reduce ? { pathLength: 0 } : false}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.2, ease: "easeOut", delay: 0.03 }}
          />
        </svg>
      </motion.span>
    </button>
  );
}
