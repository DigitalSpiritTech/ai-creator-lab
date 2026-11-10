/**
 * What the project shell hands every workspace panel. A plugin's panel component receives
 * `PanelProps` and nothing else from the app, so a plugin package never imports app code: it
 * reads and changes the project through the same domain tools the assistant uses.
 * @packageDocumentation
 */

export type NoticeTone = "error" | "warn" | "ok" | "muted";

export interface PanelHost {
  projectId: string;
  /** The content type whose workspace this is. */
  contentTypeId: string;
  /** Switches the workspace to another panel of this content type. */
  openPanel(panelId: string): void;
  /** Reloads the project view after a change. */
  refresh(): Promise<void>;
  /** Adds a notice line to the chat transcript. */
  notify(tone: NoticeTone, text: string): void;
  /**
   * Runs a roster tool for this project (`POST /api/projects/<id>/tools/<name>`) and returns its
   * output; an expected failure rejects with its message. Spending tools return a proposal that
   * still goes through the gate in the chat panel.
   */
  callTool<T = unknown>(name: string, input: Record<string, unknown>): Promise<T>;
}

export interface PanelProps {
  host: PanelHost;
}
