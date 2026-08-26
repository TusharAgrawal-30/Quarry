import React from 'react';

// Minimal, safe markdown renderer for issue bodies and comments.
// Supports: ## headings, paragraphs, - / 1. lists, ``` fences, `code`,
// **bold**, *italic*, > quotes, and links. Everything is rendered through
// React elements — no innerHTML, so no sanitization gap to get wrong.

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // token order matters: code first so ** inside code stays literal
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (tok.startsWith('`')) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('**')) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('*')) out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    else {
      const label = tok.slice(1, tok.indexOf(']'));
      const href = m[5];
      out.push(
        <a key={k} href={href} target="_blank" rel="noopener noreferrer">
          {label}
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = (text ?? '').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let bi = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++; // closing fence
      blocks.push(
        <pre key={bi++}>
          <code>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    if (/^###?\s/.test(line)) {
      const level = line.startsWith('###') ? 3 : 2;
      const content = line.replace(/^###?\s+/, '');
      blocks.push(level === 2 ? <h2 key={bi++}>{content}</h2> : <h3 key={bi++}>{content}</h3>);
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(<blockquote key={bi++}>{renderInline(buf.join(' '), `q${bi}`)}</blockquote>);
      continue;
    }
    if (/^[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) items.push(lines[i++].replace(/^[-*]\s/, ''));
      blocks.push(
        <ul key={bi++}>
          {items.map((it, j) => (
            <li key={j}>{renderInline(it, `ul${bi}-${j}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) items.push(lines[i++].replace(/^\d+\.\s/, ''));
      blocks.push(
        <ol key={bi++}>
          {items.map((it, j) => (
            <li key={j}>{renderInline(it, `ol${bi}-${j}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    // paragraph: gather until blank
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(```|###?\s|[-*]\s|\d+\.\s|>)/.test(lines[i])) buf.push(lines[i++]);
    blocks.push(<p key={bi++}>{renderInline(buf.join(' '), `p${bi}`)}</p>);
  }

  return <div className="md">{blocks}</div>;
}
