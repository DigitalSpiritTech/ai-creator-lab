/**
 * Versioned schema migrations. Entry N (1-based) upgrades `PRAGMA user_version` N-1 to N.
 * Never edit a shipped migration; append a new one.
 * @packageDocumentation
 */

const jsonOwnId = "json_valid(data) AND json_extract(data, '$.id') = id";

export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE workspace (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL CHECK (json_valid(data))
  );
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL CHECK (${jsonOwnId})
  );
  CREATE TABLE library_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('character', 'product', 'set')),
    data TEXT NOT NULL CHECK (${jsonOwnId} AND json_extract(data, '$.kind') = kind)
  );
  CREATE TABLE project_links (
    project_id TEXT NOT NULL REFERENCES projects(id),
    item_id TEXT NOT NULL REFERENCES library_items(id),
    data TEXT NOT NULL CHECK (json_valid(data)
      AND json_extract(data, '$.projectId') = project_id
      AND json_extract(data, '$.itemId') = item_id),
    PRIMARY KEY (project_id, item_id)
  );
  CREATE INDEX project_links_item ON project_links(item_id);
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    request_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    data TEXT NOT NULL CHECK (${jsonOwnId}
      AND json_extract(data, '$.projectId') = project_id
      AND json_extract(data, '$.requestId') = request_id
      AND json_extract(data, '$.status') = status)
  );
  CREATE INDEX jobs_project ON jobs(project_id);
  CREATE INDEX jobs_status ON jobs(status);
  CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id),
    job_id TEXT REFERENCES jobs(id),
    data TEXT NOT NULL CHECK (${jsonOwnId}
      AND json_extract(data, '$.projectId') IS project_id
      AND json_extract(data, '$.provenance.jobId') IS job_id)
  );
  CREATE INDEX assets_project ON assets(project_id);
  CREATE INDEX assets_job ON assets(job_id);
  CREATE TABLE scripts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    data TEXT NOT NULL CHECK (${jsonOwnId} AND json_extract(data, '$.projectId') = project_id)
  );
  CREATE INDEX scripts_project ON scripts(project_id);
  CREATE TABLE script_versions (
    script_id TEXT NOT NULL REFERENCES scripts(id),
    version INTEGER NOT NULL,
    data TEXT NOT NULL CHECK (json_valid(data)
      AND json_extract(data, '$.id') = script_id
      AND json_extract(data, '$.version') = version),
    PRIMARY KEY (script_id, version)
  );
  CREATE TABLE content_pieces (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    script_id TEXT NOT NULL REFERENCES scripts(id),
    data TEXT NOT NULL CHECK (${jsonOwnId}
      AND json_extract(data, '$.projectId') = project_id
      AND json_extract(data, '$.scriptId') = script_id)
  );
  CREATE INDEX content_pieces_project ON content_pieces(project_id);
  CREATE TABLE exports (
    id TEXT PRIMARY KEY,
    content_id TEXT NOT NULL REFERENCES content_pieces(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    data TEXT NOT NULL CHECK (${jsonOwnId}
      AND json_extract(data, '$.contentId') = content_id
      AND json_extract(data, '$.projectId') = project_id)
  );
  CREATE INDEX exports_content ON exports(content_id);
  `,
  // Version 2: assistant conversations. `seq` orders messages; content is the Anthropic content array.
  `
  CREATE TABLE conversation_messages (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL REFERENCES projects(id),
    data TEXT NOT NULL CHECK (${jsonOwnId} AND json_extract(data, '$.projectId') = project_id)
  );
  CREATE INDEX conversation_messages_project ON conversation_messages(project_id, seq);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
