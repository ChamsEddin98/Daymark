/** Task-file schema v1. The authoritative description is the "Task-file schema" section of README.md. */

export const SCHEMA_ID = "planner/task-file@1";

export const TASK_TYPES = ["coding", "concept", "build", "mock", "drill", "reading", "admin"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const FILE_KINDS = ["prep", "lessons", "portfolio", "recurring"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export interface Link {
  label: string;
  url: string;
}

export interface FileMeta {
  schema: typeof SCHEMA_ID;
  /** Stable id of the source this file feeds, e.g. "bcg". Several files may share a track. */
  track: string;
  title: string;
  kind: FileKind;
  /** Only meaningful for kind=prep: lower runs first. */
  priority?: number;
  /** Used when a task block omits `duration`. */
  defaultDurationMin?: number;
  sourceHtml?: string;
  /** Tasks from this file are only scheduled once every task of this track is done or skipped. */
  startsAfter?: string;
}

/**
 * Where a task lives in its file. All numbers are 1-based, inclusive file lines, counting the
 * front matter. The parser computes these to find `body`; the surgical editor in `edit.ts`
 * uses them so it never has to re-derive a position the parser already knew.
 */
export interface TaskSpan {
  /** The heading line, e.g. "### A1 · Boolean filtering". */
  heading: number;
  /** The ```task fence. */
  blockOpen: number;
  /** The closing fence of the task block. */
  blockClose: number;
  /** Last line of the body: the line before the next heading of the same or a higher level. */
  end: number;
}

export interface Task {
  /** Globally unique: `${track}/${id}`. This is what state, calendar events and the API key on. */
  uid: string;
  track: string;
  id: string;
  /** The heading text. Names the actual work; used verbatim in calendar event titles. */
  title: string;
  durationMin: number;
  type: TaskType;
  /** Platform links declared in the task block. links[0] is the primary one. */
  links: Link[];
  /** "daily": the task is scheduled once on every plan day instead of once overall. */
  repeat?: "daily";
  /** With repeat: stop after this many scheduled days. Omitted = no end. */
  occurrences?: number;
  /** Markdown between the task block and the next heading of the same or higher level. */
  body: string;
  /** Links that appear inside `body`. */
  bodyLinks: Link[];
  /** Nearest enclosing heading above the task heading, for grouping in the UI. */
  section: string | null;
  /** Position within the file, 0-based. Defines default order inside a track. */
  order: number;
  file: string;
  line: number;
  /** The task's lines in the file, 1-based and inclusive. See TaskSpan. */
  span: TaskSpan;
}

export interface TaskFile {
  path: string;
  meta: FileMeta;
  tasks: Task[];
  /** Links in prose that belongs to no task (sources, tables, notes). */
  references: Link[];
}

export interface ParseIssue {
  file: string;
  line: number;
  message: string;
}

export interface ParseResult {
  file: TaskFile | null;
  errors: ParseIssue[];
}
