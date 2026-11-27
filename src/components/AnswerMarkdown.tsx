import { Fragment, type ReactNode } from 'react'

type Props = {
  content: string
  className?: string
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g
  let last = 0
  let match: RegExpExecArray | null
  let key = 0

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index))
    }
    const token = match[0]
    if (token.startsWith('**')) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('`')) {
      nodes.push(<code key={key++}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key++}>{token.slice(1, -1)}</em>)
    }
    last = match.index + token.length
  }

  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function isHeading(line: string) {
  return /^(#{1,3})\s+(.+)$/.exec(line)
}

function isBullet(line: string) {
  return /^[-*•]\s+(.+)$/.exec(line)
}

function isNumbered(line: string) {
  return /^(\d+)[.)]\s+(.+)$/.exec(line)
}

function flushParagraph(buf: string[], out: ReactNode[], key: { n: number }) {
  const text = buf.join(' ').trim()
  buf.length = 0
  if (!text) return
  out.push(
    <p key={`p-${key.n++}`} className="md-p">
      {renderInline(text)}
    </p>,
  )
}

export default function AnswerMarkdown({ content, className = '' }: Props) {
  const text = (content || '').replace(/\r\n/g, '\n').trim()
  if (!text) {
    return <div className={`answer-md ${className}`.trim()} />
  }

  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  const para: string[] = []
  const key = { n: 0 }
  let i = 0

  while (i < lines.length) {
    const raw = lines[i]
    const line = raw.trimEnd()
    const trimmed = line.trim()

    if (!trimmed) {
      flushParagraph(para, blocks, key)
      i += 1
      continue
    }

    const heading = isHeading(trimmed)
    if (heading) {
      flushParagraph(para, blocks, key)
      const level = heading[1].length
      const Tag = (level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3') as 'h1' | 'h2' | 'h3'
      blocks.push(
        <Tag key={`h-${key.n++}`} className={`md-h md-h${level}`}>
          {renderInline(heading[2])}
        </Tag>,
      )
      i += 1
      continue
    }

    const bullet = isBullet(trimmed)
    if (bullet) {
      flushParagraph(para, blocks, key)
      const items: string[] = []
      while (i < lines.length) {
        const b = isBullet(lines[i].trim())
        if (!b) break
        items.push(b[1])
        i += 1
      }
      blocks.push(
        <ul key={`ul-${key.n++}`} className="md-ul">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ul>,
      )
      continue
    }

    const numbered = isNumbered(trimmed)
    if (numbered) {
      flushParagraph(para, blocks, key)
      const items: string[] = []
      while (i < lines.length) {
        const n = isNumbered(lines[i].trim())
        if (!n) break
        items.push(n[2])
        i += 1
      }
      blocks.push(
        <ol key={`ol-${key.n++}`} className="md-ol">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ol>,
      )
      continue
    }

    if (trimmed.startsWith('```')) {
      flushParagraph(para, blocks, key)
      i += 1
      const codeLines: string[] = []
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1
      blocks.push(
        <pre key={`pre-${key.n++}`} className="md-pre">
          <code>{codeLines.join('\n')}</code>
        </pre>,
      )
      continue
    }

    // Separators like --- become a subtle divider
    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      flushParagraph(para, blocks, key)
      blocks.push(<hr key={`hr-${key.n++}`} className="md-hr" />)
      i += 1
      continue
    }

    para.push(trimmed)
    i += 1
  }

  flushParagraph(para, blocks, key)

  return (
    <div className={`answer-md ${className}`.trim()}>
      {blocks.map((b, idx) => (
        <Fragment key={idx}>{b}</Fragment>
      ))}
    </div>
  )
}
