import { useEffect, type ReactNode } from "react";

// Right-hand slide-over for deep-dive flows (inventory editor, recipe editor…).
// Esc, overlay-click, or the ✕ closes it.
export default function Drawer({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose]);

  return (
    <div className="drawer-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer">
        <header className="drawer-head">
          <span>{title}</span>
          <button className="mini" onClick={onClose}>✕ esc</button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}
