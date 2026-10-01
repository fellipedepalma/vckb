import type { ReactNode } from 'react';
import { ApiError, NetworkError } from '../api';
import { strings } from '../strings';

/** Placeholder columns while a board loads (static: no shimmer). */
export function BoardSkeleton() {
  return (
    <div className="flex gap-3 px-4 pt-3 sm:px-6" aria-busy="true">
      <p className="sr-only" role="status">
        {strings.board.loading}
      </p>
      {[5, 3, 2, 1, 4].map((n, i) => (
        <div key={i} aria-hidden="true" className="w-[min(85vw,17rem)] shrink-0 rounded-[9px] border border-line bg-bg p-2 sm:w-[17rem]">
          <div className="mx-1 mb-3 mt-1 h-4 w-20 rounded bg-surface" />
          {Array.from({ length: n }, (_, j) => (
            <div key={j} className="mb-2 h-[72px] rounded-md bg-surface" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function describeError(err: unknown): string {
  if (err instanceof NetworkError) return strings.errors.network;
  if (err instanceof ApiError) return err.message;
  return strings.errors.generic;
}

export function ErrorPanel({ title, error, onRetry }: { title: string; error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="mx-4 mt-6 max-w-xl rounded-md border-l-[3px] border-danger bg-surface px-4 py-3 sm:mx-6">
      <p className="font-semibold text-danger">{title}</p>
      <p className="mt-1 text-[15px] text-muted">{describeError(error)}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-3 rounded-md bg-surface-2 px-3 py-1.5 text-sm font-medium hover:bg-line">
          {strings.board.retry}
        </button>
      )}
    </div>
  );
}

export function Notice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mx-4 mt-10 max-w-xl sm:mx-6">
      <h1 className="text-lg font-semibold">{title}</h1>
      {children && <div className="mt-2 text-[15px] leading-relaxed text-muted">{children}</div>}
    </div>
  );
}
