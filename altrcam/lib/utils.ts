import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export const cn = (...i: ClassValue[]) => twMerge(clsx(i));

export function relativeTime(date: Date | string, now = new Date()) {
  const s = Math.round((new Date(date).getTime() - now.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [u, sec] of steps) if (Math.abs(s) >= sec) return rtf.format(Math.round(s / sec), u);
  return "just now";
}
export const fmtNum = (n: number) => n.toLocaleString("en-US");
export function money(minor: number, currency: string) {
  return new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: minor % 100 ? 2 : 0 }).format(minor / 100);
}
