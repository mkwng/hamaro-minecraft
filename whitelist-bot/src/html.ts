// Minimal server-side HTML rendering with escaping of user-provided values.

const ESCAPES: Record<'&' | '<' | '>' | '"' | "'", string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch as keyof typeof ESCAPES]);
}

/** Renders a small standalone HTML page. `bodyHtml` must already be safe/escaped. */
export function renderPage(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0;
         background: #10141b; color: #e8ecf3; display: grid; place-items: center; min-height: 100vh; }
  main { max-width: 34rem; padding: 2rem; margin: 1rem; background: #1a2130;
         border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.4); }
  h1 { margin-top: 0; font-size: 1.5rem; }
  code { background: #0d1117; padding: 0.15rem 0.4rem; border-radius: 6px; font-size: 1.05em; }
  .muted { color: #98a3b3; font-size: 0.9rem; }
  a { color: #7cc4ff; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
</main>
</body>
</html>`;
}
