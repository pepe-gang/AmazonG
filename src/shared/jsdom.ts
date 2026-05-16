import { JSDOM, VirtualConsole } from 'jsdom';

/**
 * Shared JSDOM construction with a quiet VirtualConsole.
 *
 * Amazon's pages ship modern / nested CSS (`#nav { .child { … } }`,
 * `@layer`, etc.) inside <style> blocks. jsdom's CSS sub-parser
 * rejects that syntax and, by default, dumps a multi-line
 * "Could not parse CSS stylesheet" stack trace to the console for
 * EVERY page we parse — pure noise, since the HTML tree (the only
 * thing we read) is built by parse5 regardless of the CSS.
 *
 * The VirtualConsole below swallows ONLY that CSS-parse error. Any
 * other jsdom-internal error still goes to the real console, so a
 * genuinely useful diagnostic isn't lost.
 *
 * Use `htmlToDocument` when you just need the Document (the common
 * case); `htmlToDom` when the caller also needs the JSDOM/window.
 */
const quietConsole = new VirtualConsole();
quietConsole.on('jsdomError', (err: Error) => {
  if (/Could not parse CSS/i.test(err?.message ?? '')) return;
  console.error(err);
});

export function htmlToDocument(html: string): Document {
  return new JSDOM(html, { virtualConsole: quietConsole }).window.document;
}

export function htmlToDom(html: string): JSDOM {
  return new JSDOM(html, { virtualConsole: quietConsole });
}
