import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

/** Render markdown; path `./assets/x.png` (juga `../assets/` dari lampiran di subfolder) diarahkan ke endpoint bukti tugas. */
export function renderMarkdown(text: string, taskId?: string): string {
  const source = taskId
    ? text.replace(/\]\((?:\.{1,2}\/)*assets\//g, `](/api/tasks/${encodeURIComponent(taskId)}/assets/`)
    : text;
  return md.render(source);
}
