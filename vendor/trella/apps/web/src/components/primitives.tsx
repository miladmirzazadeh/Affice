import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { avatarTone, cn, initials, priorityLabel } from '../lib/format';
import type { Actor, Priority } from '../lib/types';

/**
 * One icon wrapper for the whole product. Stroke follows the weight of the text
 * it sits beside, the glyph is always decorative, and nothing else may set a
 * stroke width by hand.
 */
export function Icon({
  icon: Glyph,
  size = 16,
  beside = 'regular',
  className,
}: {
  icon: LucideIcon;
  size?: 14 | 16 | 20;
  beside?: 'regular' | 'semibold';
  className?: string;
}) {
  return (
    <Glyph
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      strokeWidth={beside === 'semibold' ? 2 : 1.5}
      className={cn('shrink-0', className)}
    />
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  /** Disables the press scale where motion would be distracting. */
  static?: boolean;
};

const VARIANTS: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary:
    'bg-accent-solid text-on-accent hover:bg-accent-solid-hover shadow-[var(--lift-1)] disabled:opacity-50',
  secondary:
    'surface-card text-ink hover:shadow-[var(--lift-2)] disabled:opacity-50 disabled:shadow-[var(--lift-1)]',
  ghost: 'text-ink-soft hover:bg-ink/5 hover:text-ink disabled:opacity-50',
  danger: 'bg-danger-solid text-on-danger hover:opacity-90 disabled:opacity-50',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', static: isStatic, className, children, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-(--radius-control)',
        'font-medium whitespace-nowrap select-none',
        'motion-press touch-manipulation',
        size === 'sm' ? 'h-8 px-3 text-[13px]' : 'h-10 px-4 text-sm',
        !isStatic && 'active:not-disabled:scale-[0.96]',
        'disabled:cursor-not-allowed',
        VARIANTS[variant],
        className
      )}
    >
      {children}
    </button>
  );
});

/**
 * Small glyph control. The visible box stays compact; a pseudo-element carries
 * the 40px target so neighbouring buttons never share a hit area.
 */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: LucideIcon; active?: boolean }
>(function IconButton({ label, icon, active, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={cn(
        'relative inline-grid size-8 place-items-center rounded-(--radius-field)',
        'text-ink-faint hover:bg-ink/5 hover:text-ink',
        'after:absolute after:top-1/2 after:left-1/2 after:size-10 after:-translate-x-1/2 after:-translate-y-1/2',
        'motion-press touch-manipulation disabled:opacity-40 disabled:hover:bg-transparent',
        active && 'bg-accent-soft text-accent-soft-ink hover:bg-accent-soft',
        className
      )}
    >
      <Icon icon={icon} size={16} />
    </button>
  );
});

/**
 * Priority as a drawn signal rather than a colour, so it survives greyscale and
 * never competes with the accent. Urgent adds the danger hue and a filled dot.
 */
export function PriorityGlyph({ priority, className }: { priority: Priority; className?: string }) {
  const filled = { low: 1, medium: 2, high: 3, urgent: 3 }[priority];
  const urgent = priority === 'urgent';
  return (
    <span
      className={cn('inline-flex items-end gap-[2px]', className)}
      title={`${priorityLabel(priority)} priority`}
    >
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          aria-hidden="true"
          className={cn(
            'w-[3px] rounded-[1px]',
            index === 0 ? 'h-[5px]' : index === 1 ? 'h-[8px]' : 'h-[11px]',
            index < filled
              ? urgent
                ? 'bg-danger'
                : 'bg-ink-faint'
              : 'bg-ink-faint/25'
          )}
        />
      ))}
      {urgent && <span aria-hidden="true" className="mb-[1px] ms-[3px] size-[5px] rounded-full bg-danger" />}
      <span className="sr-only">{priorityLabel(priority)} priority</span>
    </span>
  );
}

const TONES = [
  'bg-bone-200 text-bone-800 dark:bg-bone-800 dark:text-bone-200',
  'bg-bone-300 text-bone-900 dark:bg-bone-850 dark:text-bone-100',
  'bg-verdigris-100 text-verdigris-900 dark:bg-verdigris-950 dark:text-verdigris-200',
  'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  'bg-plum-100 text-plum-900 dark:bg-plum-950 dark:text-plum-200',
  'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
];

/**
 * Human is a rounded square, agent is a hexagon. The shape carries the meaning;
 * the tint is decoration derived from the actor id.
 */
export function ActorAvatar({
  actor,
  size = 20,
  className,
}: {
  actor: Actor;
  size?: 20 | 28;
  className?: string;
}) {
  const tone = TONES[avatarTone(actor.id)]!;
  const isAgent = actor.type === 'agent';
  return (
    <span
      className={cn(
        'inline-grid shrink-0 place-items-center font-semibold tabular-nums select-none',
        size === 20 ? 'size-5 text-[9px]' : 'size-7 text-[11px]',
        tone,
        isAgent ? 'rounded-[3px]' : 'rounded-[6px]',
        className
      )}
      style={
        isAgent
          ? {
              clipPath:
                'polygon(50% 0%, 93% 25%, 93% 75%, 50% 100%, 7% 75%, 7% 25%)',
            }
          : undefined
      }
      title={`${actor.name} (${isAgent ? 'agent' : 'you'})`}
    >
      <span aria-hidden="true">{initials(actor)}</span>
      <span className="sr-only">{`${actor.name}, ${isAgent ? 'agent' : 'person'}`}</span>
    </span>
  );
}

export function Chip({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'danger' | 'caution';
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-(--radius-chip) px-1.5 py-0.5',
        'text-[11px] leading-4 font-medium whitespace-nowrap',
        tone === 'neutral' && 'bg-ink/6 text-ink-soft',
        tone === 'accent' && 'bg-accent-soft text-accent-soft-ink',
        tone === 'danger' && 'bg-danger-soft text-danger-soft-ink',
        tone === 'caution' && 'bg-caution-soft text-caution',
        className
      )}
    >
      {children}
    </span>
  );
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-micro text-ink-faint">
        {label}
      </label>
      {children}
      {hint && <p className="text-caption text-ink-faint">{hint}</p>}
    </div>
  );
}

export const inputClass = cn(
  'w-full rounded-(--radius-field) bg-inset px-3 py-2',
  'border border-line text-ink placeholder:text-ink-faint',
  'focus-visible:border-accent-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--focus-ring)'
);
