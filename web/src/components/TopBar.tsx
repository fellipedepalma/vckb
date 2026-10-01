import type { LiveStatus } from '../hooks';
import { strings } from '../strings';
import type { Project } from '../types';

const LIVE: Record<LiveStatus, { text: string; hint: string; dot: string; bg: string }> = {
  connecting: { text: strings.connection.connecting, hint: strings.connection.reconnectingHint, dot: 'bg-muted', bg: 'bg-surface' },
  live: { text: strings.connection.live, hint: strings.connection.liveHint, dot: 'bg-accent animate-pulse', bg: 'bg-surface' },
  reconnecting: { text: strings.connection.reconnecting, hint: strings.connection.reconnectingHint, dot: 'bg-accent-2 animate-pulse', bg: 'bg-surface' },
};

export function TopBar(props: {
  projects: Project[];
  current: string | null;
  onSelect: (slug: string) => void;
  live: LiveStatus;
  onSignOut: () => void;
}) {
  const live = LIVE[props.live];
  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-4 border-b border-line bg-surface px-4 py-3 sm:px-6">
      <div className="flex items-center gap-3">
        <div className="flex size-[30px] items-center justify-center rounded-[8px] bg-accent text-surface font-bold">
          <svg className="size-4" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
        </div>
        <div className="flex flex-col">
          <span className="text-[17px] font-bold tracking-widest text-text leading-none">{strings.app.name}</span>
          <span className="text-[9px] uppercase tracking-wider text-muted mt-0.5">{strings.app.fullName}</span>
        </div>
      </div>

      <nav aria-label={strings.projects.navLabel} className="order-last -mx-1 w-full overflow-x-auto sm:order-none sm:w-auto sm:flex-1">
        <ul className="flex gap-4 px-1">
          {props.projects.map((p) => {
            const active = p.slug === props.current;
            return (
              <li key={p.slug} className="flex flex-col items-center">
                <a
                  href={`/p/${encodeURIComponent(p.slug)}`}
                  aria-current={active ? 'page' : undefined}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    props.onSelect(p.slug);
                  }}
                  className={`block whitespace-nowrap px-1 py-1 text-[14px] transition-colors ${
                    active ? 'font-bold text-text' : 'text-muted hover:text-text'
                  }`}
                >
                  {p.name}
                </a>
                {active && <div className="mt-0.5 size-1 rounded-full bg-accent" />}
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="ml-auto flex items-center gap-4 sm:ml-0">
        <div className={`flex items-center gap-2 rounded-full px-3 py-1 ${live.bg} border border-line`} title={live.hint} role="status" aria-live="polite">
          <span aria-hidden="true" className={`size-2 rounded-full ${live.dot}`} />
          <span className="text-[12px] font-medium text-text">{live.text}</span>
          <span className="sr-only">{live.hint}</span>
        </div>
        <button
          type="button"
          onClick={props.onSignOut}
          className="rounded-md px-2.5 py-1.5 text-[13px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {strings.session.signOut}
        </button>
      </div>
    </header>
  );
}
