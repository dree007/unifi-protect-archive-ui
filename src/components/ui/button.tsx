import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  // Atelier Soft: always a pill; pressed buttons sink 1 px. Colors 120 ms, shadows 200 ms.
  "group/button inline-flex shrink-0 items-center justify-center rounded-full border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[background-color,color,box-shadow,transform] duration-200 outline-none select-none focus-ring active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-45 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // The one primary action of a view: ink with a soft gloss.
        default: "bg-primary text-primary-foreground shadow-ink hover:bg-primary-hover",
        // The standard button: a raised eggshell pill.
        outline: "surface-control",
        // Quiet tonal button on the warm-taupe level.
        secondary: "bg-secondary text-secondary-foreground hover:bg-stone active:shadow-pressed aria-expanded:bg-stone",
        ghost: "hover:bg-muted hover:text-foreground active:bg-stone active:shadow-pressed aria-expanded:bg-muted aria-expanded:text-foreground",
        destructive: "bg-danger-soft text-danger-strong hover:bg-stone",
        link: "text-violet-spark underline-offset-4 hover:text-violet-ink hover:underline",
      },
      size: {
        // Touch screens get the 44 px minimum target (pointer-coarse).
        default:
          "h-10 pointer-coarse:h-11 gap-2 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        xs: "h-6 gap-1 px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-9 pointer-coarse:h-11 gap-1.5 px-3 text-[0.8125rem] has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-11 gap-2 px-5 has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        icon: "size-10 pointer-coarse:size-11",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-9 pointer-coarse:size-11",
        "icon-lg": "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
