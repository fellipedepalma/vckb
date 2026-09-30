/** Shapes returned by the VCKB REST API (see README "REST API"). */

export type Priority = 'low' | 'medium' | 'high';

export interface ChecklistItem {
  text: string;
  done: boolean;
}

export interface Task {
  id: string;
  title: string;
  status: string;
  priority: Priority;
  labels: string[];
  order: number;
  created: string;
  updated: string;
  body: string;
  description: string;
  checklist: ChecklistItem[];
  progress: { done: number; total: number };
  file: string;
  etag: string;
}

export interface Project {
  slug: string;
  name: string;
  description: string;
  columns: string[];
  nextId: number;
}

export interface BoardWarning {
  code: string;
  message: string;
  file?: string;
  files?: string[];
  id?: string;
  column?: string;
  fields?: string[];
}

export interface BoardSnapshot {
  project: Project;
  tasks: Task[];
  warnings: BoardWarning[];
}
