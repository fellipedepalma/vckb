import { Lexer, type Token, type Tokens } from 'marked';
import { Component, type ReactNode } from 'react';
import { strings } from './strings';

/**
 * Markdown for task descriptions, rendered as React elements: marked only tokenizes (Lexer), and
 * the functions below turn tokens into elements. No HTML string is ever produced or injected, so a
 * text node is the only way text reaches the page. What is deliberately NOT rendered:
 * - raw HTML (`<script>`, `<b>`, ...): shown as literal text;
 * - images: shown as their alt text followed by the URL as text, and never requested;
 * - links other than absolute http, https and mailto: shown as their source text, without `href`.
 * The stored description stays the raw text; this is only a view of it.
 */

/** More than this (the server's limit for a whole task body) is shown as plain text, never parsed. */
export const PREVIEW_MAX_CHARS = 100_000;
/** Deeper than this a block is shown as source text: nothing legitimate nests that far. */
const MAX_DEPTH = 24;

// Lower-case scheme only; no whitespace or control characters anywhere in the URL.
const SAFE_URL = /^(?:https?:\/\/|mailto:)[^\s\u0000-\u001f\u007f-\u009f]+$/;

/**
 * The URL when it may become a link, else null. Checked here, at render time, whatever the parser
 * decided: only absolute http(s) URLs with a host, and mailto:. Case matters (`HTTP://` is refused),
 * and so does everything before the scheme: a space, a control character, an HTML entity or a line
 * break anywhere in it means the text is shown as text.
 */
export function safeHref(href: unknown): string | null {
  if (typeof href !== 'string' || !SAFE_URL.test(href)) return null;
  try {
    const url = new URL(href);
    if (url.protocol === 'mailto:') return href;
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname ? href : null;
  } catch {
    return null;
  }
}

/** marked leaves the basic named entities in text tokens as typed; show the characters they stand for. */
const decodeEntities = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|#39);/g, (_, name: string) => ({ lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'" })[name] as string);

const linkClass =
  'text-accent underline underline-offset-2 hover:text-text focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent [overflow-wrap:anywhere]';

function inline(tokens: Token[] | undefined, depth: number): ReactNode[] {
  return (tokens ?? []).map((t, i) => <InlineToken key={i} token={t} depth={depth} />);
}

function InlineToken({ token, depth }: { token: Token; depth: number }): ReactNode {
  if (depth > MAX_DEPTH) return token.raw;
  switch (token.type) {
    case 'text': {
      const t = token as Tokens.Text;
      return t.tokens?.length ? inline(t.tokens, depth + 1) : decodeEntities(t.text);
    }
    case 'escape':
      return (token as Tokens.Escape).text;
    case 'strong':
      return <strong className="font-semibold text-text">{inline((token as Tokens.Strong).tokens, depth + 1)}</strong>;
    case 'em':
      return <em>{inline((token as Tokens.Em).tokens, depth + 1)}</em>;
    case 'del':
      return <del>{inline((token as Tokens.Del).tokens, depth + 1)}</del>;
    case 'codespan':
      return <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[13px] text-text">{decodeEntities((token as Tokens.Codespan).text)}</code>;
    case 'br':
      return <br />;
    case 'link': {
      const t = token as Tokens.Link;
      const href = safeHref(t.href);
      // Not an allowed link: its own source text, `[x](javascript:...)`, shown as text.
      if (!href) return token.raw;
      return (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={linkClass}>
          {inline(t.tokens, depth + 1)}
        </a>
      );
    }
    case 'image': {
      const t = token as Tokens.Image;
      return strings.details.markdown.image(t.text, t.href);
    }
    default:
      // `html` (a tag or comment), and anything unknown: the source text.
      return token.raw;
  }
}

function blocks(tokens: Token[] | undefined, depth: number): ReactNode[] {
  return (tokens ?? []).map((t, i) => <BlockToken key={i} token={t} depth={depth} />);
}

const HEADING = ['text-[18px]', 'text-[16px]', 'text-[14px]'] as const; // three sizes for six levels

function BlockToken({ token, depth }: { token: Token; depth: number }): ReactNode {
  if (depth > MAX_DEPTH) return <p className="whitespace-pre-wrap font-mono text-[13px] [overflow-wrap:anywhere]">{token.raw}</p>;
  switch (token.type) {
    case 'space':
    case 'def':
      return null;
    case 'paragraph':
      return <p className="[overflow-wrap:anywhere]">{inline((token as Tokens.Paragraph).tokens, depth + 1)}</p>;
    case 'text': {
      const t = token as Tokens.Text;
      return <>{t.tokens?.length ? inline(t.tokens, depth + 1) : decodeEntities(t.text)}</>;
    }
    case 'heading': {
      const t = token as Tokens.Heading;
      const Tag = `h${Math.min(t.depth + 2, 6)}` as 'h3';
      return <Tag className={`font-semibold text-text ${HEADING[Math.min(t.depth, 3) - 1]} [overflow-wrap:anywhere]`}>{inline(t.tokens, depth + 1)}</Tag>;
    }
    case 'code':
      return (
        <pre className="overflow-x-auto rounded-md border border-line bg-surface-2 p-3 font-mono text-[13px] leading-relaxed text-text">
          <code>{(token as Tokens.Code).text}</code>
        </pre>
      );
    case 'blockquote':
      return <blockquote className="border-l-[3px] border-line-strong pl-3 text-muted">{blocks((token as Tokens.Blockquote).tokens, depth + 1)}</blockquote>;
    case 'hr':
      return <hr className="border-line-strong" />;
    case 'list': {
      const t = token as Tokens.List;
      const items = t.items.map((item, i) => (
        <li key={i} className="[overflow-wrap:anywhere]">
          {blocks(item.tokens, depth + 1)}
        </li>
      ));
      return t.ordered ? (
        <ol start={typeof t.start === 'number' && Number.isFinite(t.start) ? t.start : undefined} className="list-decimal space-y-1 pl-6">
          {items}
        </ol>
      ) : (
        <ul className="list-disc space-y-1 pl-6">{items}</ul>
      );
    }
    case 'checkbox': {
      const checked = (token as Tokens.Checkbox).checked;
      return (
        <span role="img" aria-label={checked ? strings.details.markdown.done : strings.details.markdown.todo} className="mr-1.5 font-mono">
          {checked ? '☑' : '☐'}
        </span>
      );
    }
    case 'table': {
      const t = token as Tokens.Table;
      const align = (a: string | null) => (a === 'center' ? 'text-center' : a === 'right' ? 'text-right' : 'text-left');
      return (
        <div className="overflow-x-auto">
          {/* overflow-wrap back to normal: otherwise cells break inside words and a wide table is squeezed instead of scrolling */}
          <table className="border-collapse text-[13px] [overflow-wrap:normal]">
            <thead>
              <tr>
                {t.header.map((c, i) => (
                  <th key={i} className={`border border-line-strong px-2 py-1 font-semibold text-text ${align(c.align)}`}>
                    {inline(c.tokens, depth + 1)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((c, i) => (
                    <td key={i} className={`border border-line-strong px-2 py-1 ${align(c.align)}`}>
                      {inline(c.tokens, depth + 1)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    default:
      // Block HTML (`<script>...`, `<iframe>`, comments) and anything unknown: the source, as text.
      return <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{token.raw.replace(/\s+$/, '')}</p>;
  }
}

/** The elements for `source`. May throw (the lexer overflows its stack on absurd nesting). */
export function MarkdownView({ source }: { source: string }) {
  const tokens = new Lexer({ gfm: true, breaks: true }).lex(source);
  return <div className="space-y-3 text-[14px] leading-relaxed text-text [overflow-wrap:anywhere]">{blocks(tokens, 0)}</div>;
}

function PlainText({ source, notice }: { source: string; notice: string }) {
  return (
    <div>
      <p role="status" className="mb-2 text-[12px] font-medium text-accent-2">
        {notice}
      </p>
      <pre className="whitespace-pre-wrap font-sans text-[14px] leading-relaxed text-text [overflow-wrap:anywhere]">{source}</pre>
    </div>
  );
}

/** If rendering throws, the raw text and a notice take its place; the rest of the dialog keeps working. */
class PreviewBoundary extends Component<{ source: string; children: ReactNode }, { failedFor: string | null }> {
  state = { failedFor: null as string | null };
  static getDerivedStateFromError() {
    return { failedFor: '' };
  }
  componentDidCatch() {
    this.setState({ failedFor: this.props.source });
  }
  render() {
    // A new text gets a new try.
    if (this.state.failedFor !== null && (this.state.failedFor === '' || this.state.failedFor === this.props.source)) {
      return <PlainText source={this.props.source} notice={strings.details.markdown.renderFailed} />;
    }
    return this.props.children;
  }
}

/** The Preview tab: the description as Markdown, read-only. */
export function MarkdownPreview({ source }: { source: string }) {
  if (!source.trim()) return <p className="text-[13px] text-muted">{strings.details.markdown.empty}</p>;
  if (source.length > PREVIEW_MAX_CHARS) return <PlainText source={source} notice={strings.details.markdown.tooLong(PREVIEW_MAX_CHARS)} />;
  return (
    <PreviewBoundary source={source}>
      <MarkdownView source={source} />
    </PreviewBoundary>
  );
}
