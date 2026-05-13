import {
  Children,
  cloneElement,
  forwardRef,
  type HTMLAttributes,
  type ReactElement,
} from "react";
import styles from "./Card.module.css";

type CardVariant = "flat" | "bordered" | "elevated";
type CardPadding = "none" | "sm" | "md" | "lg";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  padding?: CardPadding;
  asChild?: boolean;
}

const variantClass: Record<CardVariant, string> = {
  flat: styles.flat,
  bordered: styles.bordered,
  elevated: styles.elevated,
};

const paddingClass: Record<CardPadding, string> = {
  none: styles.padNone,
  sm: styles.padSm,
  md: styles.padMd,
  lg: styles.padLg,
};

const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  {
    variant = "bordered",
    padding = "md",
    asChild = false,
    className,
    children,
    ...rest
  },
  ref
) {
  const cls = [
    styles.card,
    variantClass[variant],
    paddingClass[padding],
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  if (asChild) {
    const child = Children.only(children) as ReactElement<{ className?: string }>;
    return cloneElement(child, {
      className: `${cls} ${child.props.className ?? ""}`.trim(),
    });
  }

  return (
    <div ref={ref} className={cls} {...rest}>
      {children}
    </div>
  );
});

export default Card;
export type { CardProps, CardVariant, CardPadding };
