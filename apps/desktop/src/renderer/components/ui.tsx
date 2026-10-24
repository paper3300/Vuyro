import { type ReactNode, useEffect, useId, useRef } from 'react';
import type { Tone } from '../board-model.ts';

/** Small shared pieces: tone colours, chips, buttons, the modal. Agent and user text is always rendered as text. */

export const TONE_BAR: Readonly<Record<Tone, string>> = {
  done: 'bg-done',
  agent: 'bg-agent',
  human: 'bg-human',
  rejected: 'bg-rejected',
  failed: 'bg-failed',
  paused: 'bg-stale',
  stale: 'bg-[#9aa1ad]',
  wait: 'bg-waitbar',
};

export const TONE_CHIP: Readonly<Record<Tone, string>> = {
  done: 'text-done bg-done/10 border-done/30',
  agent: 'text-agent bg-agent/10 border-agent/30',
  human: 'text-human bg-human/10 border-human/30',
  rejected: 'text-rejected bg-rejected/10 border-rejected/30',
  failed: 'text-failed bg-failed/10 border-failed/30',
  paused: 'text-stale bg-stale/10 border-stale/30',
  stale: 'text-stale bg-stale/10 border-stale/30',
  wait: 'text-muted bg-chip border-line',
};

export function statusTone(status: string): Tone {
  switch (status) {
    case 'done':
      return 'done';
    case 'running':
    case 'queued':
      return 'agent';
    case 'review':
      return 'human';
    case 'rejected':
    case 'discarded':
      return 'rejected';
    case 'failed':
      return 'failed';
    case 'paused':
      return 'paused';
    case 'stale':
    case 'superseded':
      return 'stale';
    default:
      return 'wait';
  }
}

export function Chip({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string | undefined }) {
  return (
    <span title={title} className={`inline-flex items-center rounded-full border px-2 py-px text-[11.5px] font-semibold whitespace-nowrap ${TONE_CHIP[tone]}`}>
      {children}
    </span>
  );
}

type ButtonKind = 'primary' | 'secondary' | 'danger' | 'ghost';
const BUTTON: Readonly<Record<ButtonKind, string>> = {
  primary: 'bg-agent text-white border-transparent hover:bg-[#163f8c]',
  secondary: 'bg-white text-ink border-[#d5d9e0] hover:bg-chip',
  danger: 'bg-white text-rejected border-rejected/40 hover:bg-rejected/10',
  ghost: 'bg-transparent text-muted border-transparent hover:bg-chip',
};

export function Button({
  kind = 'secondary',
  children,
  onClick,
  disabled,
  title,
  type = 'button',
  small,
}: {
  kind?: ButtonKind;
  children: ReactNode;
  onClick?: (() => void) | undefined;
  disabled?: boolean | undefined;
  title?: string | undefined;
  type?: 'button' | 'submit';
  small?: boolean | undefined;
}) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`${small === true ? 'h-7 px-2.5 text-[12.5px]' : 'h-[34px] px-3.5'} inline-flex items-center justify-center gap-1 rounded-lg border font-semibold whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON[kind]}`}
    >
      {children}
    </button>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    box.current?.querySelector<HTMLElement>('input, textarea, select, button')?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-ink/30 p-10" onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}>
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`w-full ${wide === true ? 'max-w-3xl' : 'max-w-lg'} rounded-xl border border-line bg-white p-6 shadow-xl`}>
        <h2 id={titleId} className="mb-4 text-[17px] font-bold">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

/** Text from agents, people and the engine: shown as-is (line breaks kept), never parsed as HTML. */
export function PlainText({ text, className }: { text: string; className?: string }) {
  return <div className={`break-words whitespace-pre-wrap ${className ?? ''}`}>{text}</div>;
}

/** A JSON value shown as indented text. */
export function JsonBlock({ value }: { value: unknown }) {
  return <pre className="max-h-64 overflow-auto rounded-md bg-chip p-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all">{JSON.stringify(value, null, 2)}</pre>;
}

export function ErrorNote({ error }: { error: string | undefined }) {
  if (error === undefined) return null;
  return (
    <div role="alert" className="rounded-md border border-failed/30 bg-failed/10 px-3 py-2 text-[13px] text-failed">
      {error}
    </div>
  );
}
