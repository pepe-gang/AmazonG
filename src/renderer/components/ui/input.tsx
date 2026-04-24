import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-white/10 bg-gradient-to-b from-white/[0.05] to-white/[0.01] backdrop-blur-xl backdrop-saturate-150 px-3 py-1 text-sm transition-[color,background-color,border-color] outline-none",
        "selection:bg-primary selection:text-primary-foreground",
        "file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        "placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "hover:from-white/[0.07] hover:to-white/[0.018] hover:border-white/[0.14]",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:border-ring/50 focus-visible:from-white/[0.08] focus-visible:to-white/[0.02]",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0",
        className
      )}
      {...props}
    />
  )
}

export { Input }
