import { cx } from "./ui";

/** The VECTOR mark: white V inside a blue→violet ring. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={cx("shrink-0", className)} aria-hidden>
      <defs>
        <linearGradient id="vk-ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#3b82f6" /><stop offset="1" stopColor="#8b5cf6" /></linearGradient>
        <linearGradient id="vk-v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#c7d2fe" /></linearGradient>
      </defs>
      <circle cx="24" cy="24" r="20.5" fill="#0b0f1b" stroke="url(#vk-ring)" strokeWidth="3.5" />
      <path d="M14.5 15.5h5.6L24 26.2l3.9-10.7h5.6L26.6 33h-5.2z" fill="url(#vk-v)" />
    </svg>
  );
}

export function Wordmark({ size = "md", sub }: { size?: "sm" | "md" | "lg"; sub?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <Logo className={size === "lg" ? "h-12 w-12" : size === "sm" ? "h-7 w-7" : "h-8 w-8"} />
      <span className="leading-none">
        <span className={cx("block font-display font-bold tracking-[0.14em] text-white", size === "lg" ? "text-3xl" : size === "sm" ? "text-base" : "text-lg")}>VECTOR</span>
        {sub && <span className="mt-1 block text-[9px] font-medium tracking-[0.32em] text-muted">CRYPTO TRADING TERMINAL</span>}
      </span>
    </span>
  );
}
