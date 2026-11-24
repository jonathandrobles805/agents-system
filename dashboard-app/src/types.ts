// Shapes of the data the page reads: /api/status (kit_status.js), /api/architecture (arch_live.js), /api/events,
// /api/history (server.js), and the functions of kit/dashboard/model.js. Only the fields the page uses are listed.

export interface Lane {
  slug: string;
  feature: string;
  position: string;
  branch?: string;
  stage?: string;
  worktree?: string | null;
  head?: string | null;
  behind_base: number;
  spec?: string | null;
  approved?: boolean;
  risk?: string;
  pr?: string | null;
  progress: { criteria: number; green: number; red: number; escalated?: boolean; attempts?: string | number; failure?: string; current_step?: string | null };
  review: { exists: boolean; verdict?: string | null; valid?: boolean; head_matches?: boolean; fails?: number };
  events: { blocked: number; tests_green: number; tests_red: number; stop_refused: number };
  last_check?: { kind: string; result: string; summary?: string; ts?: string } | null;
}

export interface Project {
  root: string;
  project: string;
  kit_version?: string;
  wip: { in_flight: number; limit: number };
  needs_you: { slug: string; position: string; failure?: string }[];
  ci_main?: { conclusion?: string | null; status?: string } | null;
  debt: { text_only_lessons: number; claude_md_bytes: number; claude_md_cap: number; bootstrap_todos: number };
  research: { questions: number; stale: number };
  lanes?: Lane[];
}

export interface KitNode {
  id: string;
  kind: string;
  label: string;
  path: string;
  purpose?: string;
  writes?: string;
  stats?: { lines?: number; cases?: number };
  attrs: {
    tools: string[]; model?: string; description?: string; events?: string[]; argument_hint?: string;
    allowed_tools?: string[]; pipeline?: string; steps?: number; deny_rules?: number;
  };
}
export interface Edge { from: string; to: string; kind: string; event?: string; matcher?: string }
export interface Problem { severity: string; id: string; message: string; component?: string }
export interface PipelineStage { id: string; pause?: number; line: number; agents: string[] }
export interface Manifest { nodes: KitNode[]; edges: Edge[]; problems: Problem[]; pipeline: PipelineStage[]; digest: string; kit_version?: string }
export interface Git { branch?: string; commit?: string }
export interface Overlay {
  root: string;
  lanes: { slug: string }[];
  settings: unknown;
  hooks: { expected: number; missing: { node: string; event: string }[]; stale: string[] };
  kit_version: { project?: string; kit?: string };
  installed_nodes: string[];
}
export interface Arch { manifest: Manifest; git: Git | null; projects: Overlay[] }

export interface KitEvent { ts?: string; event: string; result?: string; path?: string; command?: string; summary?: string; agent?: string; lane?: string }
export interface Commit { sha: string; date: string; author: string; subject: string }

export interface Index { byId: Map<string, KitNode>; out: Map<string, Edge[]>; inn: Map<string, Edge[]> }
export interface Tag { key: string; label: string; detail: string; tone: string }
export interface NodeState { tone: string; tags: Tag[] }
export interface Placed { id: string; x: number; y: number; w: number; h: number }
export interface Layout { width: number; height: number; bands: { title: string; y: number; nodes: Placed[] }[] }
export interface Group { kind: string; label: string; count: number; total: number; first: string; more: number; ids: string[] }
export interface Blast {
  dependents: string[];
  dependsOn: { id: string; label: string; kind: string; event?: string; evidence: { file: string; line: number } }[];
  groups: Group[];
  tests: string[];
  directTests: string[];
  jobs: string[];
  cases: number;
}
export interface PipelineBox { id: string; pause?: number; line: number; agents: string[]; skills: string[]; lanes: string[] }

/** kit/dashboard/model.js, loaded at runtime. */
export interface Model {
  index(m: Manifest): Index;
  nodeStates(m: Manifest, idx: Index, ctx: { git: Git | null; overlay: Overlay | null; lastEventAt: Record<string, number>; now: number }): Map<string, NodeState>;
  layoutBands(m: Manifest, width: number): Layout;
  blastRadius(m: Manifest, idx: Index, id: string): Blast;
  edgePath(a: Placed, b: Placed): string;
  orderedNodes(m: Manifest, kind: string): KitNode[];
  pipelineView(m: Manifest, overlay: Overlay | null): PipelineBox[];
  searchNodes(m: Manifest, query: string, kind: string | null): KitNode[];
  kindLabel(kind: string): string;
  githubFileUrl(git: Git | null, node: KitNode): string | null;
}
