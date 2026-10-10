"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * A button that shows and hides a panel of links (the disclosure pattern; not an ARIA menu, so Tab moves through the links as usual).
 * Opening moves focus to the first link; Escape closes and returns focus to the button; a click or focus outside closes it; so does
 * following a link. The caller wires `rootRef` round both, `buttonRef` + `aria-expanded`/`aria-controls={panelId}` on the button,
 * and `panelRef` + `id={panelId}` on the panel.
 */
export function useDisclosure() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const pathname = usePathname();

  useEffect(() => { setOpen(false); }, [pathname]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>("a[href], button:not([disabled])")?.focus();
    const outside = (t: EventTarget | null) => !(t instanceof Node && rootRef.current?.contains(t));
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onPointer = (e: PointerEvent) => { if (outside(e.target)) setOpen(false); };
    const onFocus = (e: FocusEvent) => { if (outside(e.target)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("focusin", onFocus);
    };
  }, [open]);

  const toggle = useCallback(() => setOpen((o) => !o), []);
  /** Put on the panel: following one of its links closes it, even when the link is the current page. */
  const onPanelClick = useCallback((e: React.MouseEvent) => { if ((e.target as HTMLElement).closest("a")) setOpen(false); }, []);
  return { open, toggle, rootRef, buttonRef, panelRef, panelId, onPanelClick };
}
