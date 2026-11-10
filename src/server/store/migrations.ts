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
  // Version 3: document history for the artifact panel (brief, bible, product). The subject is a
  // project or a Library item, so there is no foreign key. Existing documents start at version 1.
  `
  CREATE TABLE document_versions (
    kind TEXT NOT NULL CHECK (kind IN ('brief', 'bible', 'product')),
    subject_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    data TEXT NOT NULL CHECK (json_valid(data)
      AND json_extract(data, '$.kind') = kind
      AND json_extract(data, '$.subjectId') = subject_id
      AND json_extract(data, '$.version') = version),
    PRIMARY KEY (kind, subject_id, version)
  );
  INSERT INTO document_versions(kind, subject_id, version, data)
    SELECT 'brief', id, 1, json_object(
      'kind', 'brief', 'subjectId', id, 'version', 1, 'author', NULL, 'restoredFrom', NULL,
      'createdAt', json_extract(data, '$.updatedAt'), 'content', json(json_extract(data, '$.brief')))
    FROM projects WHERE json_type(data, '$.brief') = 'object';
  INSERT INTO document_versions(kind, subject_id, version, data)
    SELECT 'bible', id, 1, json_object(
      'kind', 'bible', 'subjectId', id, 'version', 1, 'author', NULL, 'restoredFrom', NULL,
      'createdAt', json_extract(data, '$.updatedAt'),
      'content', json_remove(json_extract(data, '$.bible'), '$.references', '$.version'))
    FROM library_items WHERE kind = 'character';
  INSERT INTO document_versions(kind, subject_id, version, data)
    SELECT 'product', id, 1, json_object(
      'kind', 'product', 'subjectId', id, 'version', 1, 'author', NULL, 'restoredFrom', NULL,
      'createdAt', json_extract(data, '$.updatedAt'),
      'content', json_object(
        'name', json_extract(data, '$.name'),
        'appearance', coalesce(json_extract(data, '$.appearance'), ''),
        'link', json_extract(data, '$.link'),
        'allowedClaims', json(coalesce(json_extract(data, '$.allowedClaims'), '[]')),
        'imageAssetIds', json(coalesce(json_extract(data, '$.imageAssetIds'), '[]'))))
    FROM library_items WHERE kind = 'product';
  `,
  // Version 4: the monthly budget (v0.2 F2). The workspace allowance becomes the monthly budget with
  // reset day 1, and each "add to this month" click is a row keyed by its period's start date.
  `
  UPDATE workspace SET data = json_set(json_remove(data, '$.allowanceUsd'),
      '$.monthlyBudgetUsd', json_extract(data, '$.allowanceUsd'),
      '$.budgetResetDay', coalesce(json_extract(data, '$.budgetResetDay'), 1))
    WHERE json_type(data, '$.allowanceUsd') IN ('integer', 'real');
  CREATE TABLE budget_extensions (
    id TEXT PRIMARY KEY,
    period_key TEXT NOT NULL,
    data TEXT NOT NULL CHECK (${jsonOwnId} AND json_extract(data, '$.periodKey') = period_key)
  );
  CREATE INDEX budget_extensions_period ON budget_extensions(period_key);
  `,
  // Backends (v0.2 F6): the servers recipes run on, each with its last object_info probe and the
  // recipes verified there by a real run. Self-contained: one new table, nothing else changes, and
  // the built-in entries (Comfy Cloud, Comfy Router, COMFY_BASE_URL) are written on first read.
  `
  CREATE TABLE backends (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL CHECK (${jsonOwnId})
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
