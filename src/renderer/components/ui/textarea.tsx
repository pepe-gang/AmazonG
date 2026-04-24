import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border border-white/10 bg-gradient-to-b from-white/[0.05] to-white/[0.01] backdrop-blur-xl backdrop-saturate-150 px-3 py-2 text-sm transition-[color,background-color,border-color] outline-none",
        "placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        "hover:from-white/[0.07] hover:to-white/[0.018] hover:border-white/[0.14]",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:border-ring/50 focus-visible:from-white/[0.08] focus-visible:to-white/[0.02]",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
