/**
 * Small product-image tile used inside Deals-table rows. Ports
 * Bestie's `DealImageTile` verbatim — white fallback bg so product
 * shots with transparent backgrounds stay readable on the dark glass.
 */
interface Props {
  imageUrl: string | null | undefined;
  className?: string;
  fallback?: string;
}

export function DealImageTile({ imageUrl, className, fallback = 'DEAL' }: Props) {
  return (
    <div
      className={
        'w-10 h-10 rounded-md overflow-hidden bg-white p-0.5 flex items-center justify-center shrink-0 ring-1 ring-border/50 ' +
        (className ?? '')
      }
    >
      {imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          className="max-w-full max-h-full object-contain"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
          }}
        />
      ) : (
        <span className="text-[10px] text-muted-foreground">{fallback}</span>
      )}
    </div>
  );
}
