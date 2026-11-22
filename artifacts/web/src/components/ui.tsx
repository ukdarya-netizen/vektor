import { useEffect, type ButtonHTMLAttributes, type ComponentProps, type ReactNode } from "react";

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

export function Button({ variant = "primary", size = "md", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | "outline"; size?: "sm" | "md" | "lg" }) {
  return (
    <button
      {...p}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition disabled:opacity-50 disabled:cursor-not-allowed",
        size === "sm" && "h-8 px-3 text-sm",
        size === "md" && "h-10 px-4 text-sm",
        size === "lg" && "h-12 px-5 text-base",
        variant === "primary" && "bg-accent text-white hover:bg-accent-2",
        variant === "outline" && "border border-line text-text hover:bg-panel-2",
        variant === "ghost" && "text-muted hover:text-text hover:bg-panel-2",
        variant === "danger" && "text-down hover:bg-down/10",
        className,
      )}
    />
  );
}

export function Input({ label, hint, error, className, ...p }: ComponentProps<"input"> & { label?: string; hint?: ReactNode; error?: string | null }) {
  return (
    <label className="block">
      {label && <span className="mb-1.5 block text-sm text-muted">{label}</span>}
      <input
        {...p}
        className={cx(
          "h-11 w-full rounded-lg border bg-bg px-3 text-text outline-none transition focus:border-accent",
          error ? "border-down" : "border-line",
          className,
        )}
      />
      {error ? <span className="mt-1.5 block text-sm text-down">{error}</span> : hint ? <span className="mt-1.5 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export const Card = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cx("rounded-xl border border-line bg-panel", className)}>{children}</div>
);

export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "up" | "down" | "warn" | "accent" }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold",
        tone === "muted" && "bg-panel-2 text-muted",
        tone === "up" && "bg-up/15 text-up",
        tone === "down" && "bg-down/15 text-down",
        tone === "warn" && "bg-warn/15 text-warn",
        tone === "accent" && "bg-accent/15 text-accent",
      )}
    >
      {children}
    </span>
  );
}

export function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
      className={cx("relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50", checked ? "bg-accent" : "bg-line")}
    >
      <span className={cx("absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all", checked ? "left-[22px]" : "left-0.5")} />
    </button>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onMouseDown={onClose}>
      <div
        role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}
        className={cx("max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-line bg-panel p-5 sm:rounded-2xl sm:p-6", wide ? "sm:max-w-2xl" : "sm:max-w-md")}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-muted hover:text-text" aria-label="close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const Spinner = () => <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />;

export function Empty({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <div className="text-base font-medium">{title}</div>
      {text && <div className="max-w-md text-sm text-muted">{text}</div>}
      {action}
    </div>
  );
}

export const Alert = ({ children, tone = "down" }: { children: ReactNode; tone?: "down" | "warn" | "up" | "accent" }) => (
  <div
    className={cx(
      "rounded-lg border px-3 py-2.5 text-sm",
      tone === "down" && "border-down/30 bg-down/10 text-down",
      tone === "warn" && "border-warn/30 bg-warn/10 text-warn",
      tone === "up" && "border-up/30 bg-up/10 text-up",
      tone === "accent" && "border-accent/30 bg-accent/10 text-text",
    )}
  >
    {children}
  </div>
);

export { cx };
