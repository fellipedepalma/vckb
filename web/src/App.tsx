import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, onUnauthorized, paths } from './api';
import { Board } from './components/Board';
import { Login } from './components/Login';
import { BoardSkeleton, ErrorPanel, Notice } from './components/States';
import { TopBar } from './components/TopBar';
import { useBoard, useDebounced, useLiveEvents, useProjectRoute, useProjects } from './hooks';
import { strings } from './strings';

type Session = { state: 'checking' } | { state: 'signedOut' } | { state: 'signedIn' } | { state: 'error'; error: unknown };

export function App() {
  const [session, setSession] = useState<Session>({ state: 'checking' });

  const check = useCallback(async () => {
    setSession({ state: 'checking' });
    try {
      await api.get(paths.session, { quiet401: true });
      setSession({ state: 'signedIn' });
    } catch (error) {
      // 421: the sign-in screen explains VCKB_ALLOWED_HOSTS when the user tries.
      if (error instanceof ApiError && (error.status === 401 || error.status === 421)) setSession({ state: 'signedOut' });
      else setSession({ state: 'error', error });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);
  useEffect(() => onUnauthorized(() => setSession({ state: 'signedOut' })), []);

  if (session.state === 'checking') {
    return (
      <p role="status" className="px-6 py-10 text-muted">
        {strings.session.checking}
      </p>
    );
  }
  if (session.state === 'error') return <ErrorPanel title={strings.errors.generic} error={session.error} onRetry={check} />;
  if (session.state === 'signedOut') return <Login onSignedIn={() => setSession({ state: 'signedIn' })} />;
  return <Workspace onSignedOut={() => setSession({ state: 'signedOut' })} />;
}

function Workspace({ onSignedOut }: { onSignedOut: () => void }) {
  const [projects, reloadProjects] = useProjects();
  const [routeSlug, go] = useProjectRoute();
  const list = projects.status === 'ready' ? projects.data : (projects.data ?? []);
  const slug = routeSlug ?? list[0]?.slug ?? null;
  const [board, reloadBoard] = useBoard(slug);

  // /  ->  /p/<first project>
  useEffect(() => {
    if (!routeSlug && slug) go(slug, true);
  }, [routeSlug, slug, go]);

  useEffect(() => {
    const name = list.find((p) => p.slug === slug)?.name;
    document.title = strings.app.documentTitle(name);
  }, [list, slug]);

  // Live updates: refetch the affected board (debounced: an agent often writes several files at once).
  const refreshBoard = useDebounced(() => void reloadBoard(), 250);
  const refreshProjects = useDebounced(() => void reloadProjects(), 250);
  const known = useRef(new Set<string>());
  known.current = new Set(list.map((p) => p.slug));
  const live = useLiveEvents((project) => {
    if (project === slug) refreshBoard();
    if (!known.current.has(project)) refreshProjects();
  });

  // Events may have been missed while disconnected: resync when the stream comes back.
  const wasLive = useRef(false);
  useEffect(() => {
    if (live === 'live' && wasLive.current === false) {
      wasLive.current = true;
      return;
    }
    if (live === 'live') {
      refreshBoard();
      refreshProjects();
    }
    if (live === 'reconnecting') wasLive.current = true;
  }, [live, refreshBoard, refreshProjects]);

  const signOut = async () => {
    try {
      await api.post(paths.logout);
    } finally {
      onSignedOut();
    }
  };

  let content;
  if (projects.status === 'loading' && !projects.data) content = <BoardSkeleton />;
  else if (projects.status === 'error' && !projects.data)
    content = <ErrorPanel title={strings.board.loadError} error={projects.error} onRetry={reloadProjects} />;
  else if (!list.length) content = <Notice title={strings.projects.none}>{strings.projects.noneHint}</Notice>;
  else if (slug && !list.some((p) => p.slug === slug)) content = <Notice title={strings.projects.notFound(slug)} />;
  else if (board.data) content = <Board snapshot={board.data} />;
  else if (board.status === 'error') content = <ErrorPanel title={strings.board.loadError} error={board.error} onRetry={reloadBoard} />;
  else content = <BoardSkeleton />;

  return (
    <div className="flex h-dvh flex-col">
      <TopBar projects={list} current={slug} onSelect={(s) => go(s)} live={live} onSignOut={signOut} />
      <main className="flex min-h-0 flex-1 flex-col">
        {board.status === 'error' && board.data && (
          <ErrorPanel title={strings.board.loadError} error={board.error} onRetry={reloadBoard} />
        )}
        {content}
      </main>
    </div>
  );
}
