import { forwardRef } from 'react';
import { MoreHorizontal } from 'lucide-react';

type Props = React.ButtonHTMLAttributes<HTMLButtonElement>;

/**
 * Small square 7x7 button with a three-dot icon — DropdownMenuTrigger
 * payload for table-row action menus. Ports Bestie's component so the
 * kebab behaves the same across the two apps.
 */
export const KebabTrigger = forwardRef<HTMLButtonElement, Props>((props, ref) => {
  return (
    <button
      ref={ref}
      {...props}
      className={
        'inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground transition hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ' +
        (props.className ?? '')
      }
    >
      <MoreHorizontal className="h-4 w-4" />
    </button>
  );
});
KebabTrigger.displayName = 'KebabTrigger';
