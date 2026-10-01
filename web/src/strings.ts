/**
 * Every piece of UI text lives here, so a translation layer can replace this module later.
 * Plain values for fixed text, functions for text with values in it.
 */
export const strings = {
  app: {
    name: 'VCKB',
    fullName: 'Vibe Coding Kanban',
    documentTitle: (project?: string) => (project ? `${project} · VCKB` : 'VCKB'),
  },

  login: {
    title: 'Sign in',
    intro: 'Paste the access token of this VCKB server. It is the VCKB_TOKEN value in the server’s .env file.',
    tokenLabel: 'Access token',
    submit: 'Sign in',
    submitting: 'Signing in…',
    wrongToken: 'That token doesn’t match. Copy VCKB_TOKEN again from the server’s .env file.',
    tooMany: (seconds: number) => `Too many failed attempts. You can try again in ${seconds} s.`,
    tooManyDone: 'You can try again now.',
    misdirected: (host: string) =>
      `This server doesn’t accept the address ${host}. Add it to VCKB_ALLOWED_HOSTS in the server’s .env and restart the server.`,
    network: 'Can’t reach the VCKB server. Check that it is running.',
    unexpected: (status: number) => `Sign-in failed with an unexpected error (HTTP ${status}).`,
    staysPrivate: 'The token is sent once and never stored in this browser. You get a session cookie for 7 days.',
  },

  session: {
    checking: 'Checking your session…',
    signOut: 'Sign out',
  },

  connection: {
    connecting: 'Connecting',
    live: 'Live',
    reconnecting: 'Reconnecting',
    liveHint: 'Changes made by agents appear here as they happen.',
    reconnectingHint: 'Lost the live connection. Retrying; the board may be out of date.',
  },

  projects: {
    navLabel: 'Projects',
    loading: 'Loading projects…',
    none: 'No projects yet',
    noneHint:
      'Projects are folders with a board.json inside the boards directory (VCKB_BOARDS_DIR). A new one appears here as soon as it exists.',
    notFound: (slug: string) => `There is no project called “${slug}”.`,
  },

  board: {
    loading: 'Loading board…',
    loadError: 'Couldn’t load this board.',
    retry: 'Try again',
    empty: 'No tasks in this project yet.',
    emptyColumn: 'No tasks',
    count: (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'}`,
    reviewHint: 'Waiting for your approval',
    needsYou: 'needs you',
    tasksLabel: 'Tasks',
    reviewLabel: 'Review',
    warnsLabel: 'Warnings',
    kanbanLabel: 'kanban',
    labelsAria: 'Labels',
    breadcrumbAria: 'Breadcrumb',
    columnName: (slug: string) => {
      const s = slug.replace(/-/g, ' ');
      return s.charAt(0).toUpperCase() + s.slice(1);
    },
  },

  task: {
    priority: { high: 'High', medium: 'Medium', low: 'Low' } as Record<string, string>,
    priorityFull: (p: string) => `${strings.task.priority[p] ?? p} priority`,
    checklist: (done: number, total: number) => `${done} of ${total} checklist items done`,
    hasWarnings: 'This task has problems in its file',
  },

  warnings: {
    title: (n: number) => (n === 1 ? 'This board has 1 problem in its files' : `This board has ${n} problems in its files`),
    body: 'Usually a task file edited by hand. Nothing is lost; see the list and repair it from a terminal:',
    report: (slug: string) => `vckb doctor ${slug}`,
    fix: (slug: string) => `vckb doctor ${slug} --fix`,
    show: 'Show problems',
    hide: 'Hide problems',
  },

  errors: {
    generic: 'Something went wrong.',
    network: 'Can’t reach the VCKB server.',
    sessionExpired: 'Your session ended. Sign in again.',
  },
};
