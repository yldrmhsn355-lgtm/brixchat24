import { forwardRef } from "react";
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

type ClassValue = string | false | null | undefined;

export function cx(...values: ClassValue[]) {
  return values.filter(Boolean).join(" ");
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      children,
      className,
      variant = "primary",
      size = "md",
      type = "button",
      ...props
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        className={cx(
          "ui-button",
          `ui-button-${variant}`,
          `ui-button-${size}`,
          className,
        )}
        type={type}
        {...props}
      >
        {children}
      </button>
    );
  },
);

export type CardProps = HTMLAttributes<HTMLElement> & {
  children: ReactNode;
  interactive?: boolean;
};

export function Card({
  children,
  className,
  interactive = false,
  ...props
}: CardProps) {
  return (
    <section
      className={cx("ui-card", interactive && "ui-card-interactive", className)}
      {...props}
    >
      {children}
    </section>
  );
}

export type BadgeTone = "neutral" | "brand" | "success" | "warning" | "danger";

export function Badge({
  children,
  className,
  tone = "neutral",
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  children: ReactNode;
  tone?: BadgeTone;
}) {
  return (
    <span className={cx("ui-badge", `ui-badge-${tone}`, className)} {...props}>
      {children}
    </span>
  );
}

export type SurfaceTone = "default" | "raised" | "subtle" | "glass";

export function Surface({
  children,
  className,
  tone = "default",
  ...props
}: HTMLAttributes<HTMLElement> & {
  children: ReactNode;
  tone?: SurfaceTone;
}) {
  return (
    <section
      className={cx("ui-surface", `ui-surface-${tone}`, className)}
      {...props}
    >
      {children}
    </section>
  );
}

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cx("ui-input", className)} {...props} />;
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cx("ui-input", "ui-textarea", className)}
      {...props}
    />
  );
});

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, children, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={cx("ui-input", "ui-select", className)}
      {...props}
    >
      {children}
    </select>
  );
});

export type StatusTone = "neutral" | "brand" | "success" | "warning" | "danger";

export function Status({
  children,
  className,
  tone = "neutral",
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  children: ReactNode;
  tone?: StatusTone;
}) {
  return (
    <span
      className={cx("ui-status", `ui-status-${tone}`, className)}
      {...props}
    >
      <i aria-hidden="true" />
      {children}
    </span>
  );
}

export function Skeleton({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      aria-hidden="true"
      className={cx("ui-skeleton", className)}
      {...props}
    />
  );
}
