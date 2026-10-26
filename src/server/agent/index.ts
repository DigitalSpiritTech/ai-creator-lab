/**
 * The UGC Creator assistant: the creative director prompt, the tool-use loop, and the model port.
 * @packageDocumentation
 */
export { type AgentEvent, type AgentTurnInput, type AgentTurnOptions, MAX_TOOL_CALLS, runAgentTurn } from "@/server/agent/loop";
export { DEFAULT_LLM_MODEL, type LlmModel, type ModelEvent, type StreamParams, type Usage, anthropicModel } from "@/server/agent/model";
export { CREATIVE_DIRECTOR_PROMPT, systemPrompt } from "@/server/agent/prompts/creative-director";
export { CHECKLISTS, type ChecklistKind } from "@/server/agent/prompts/checklists";
export { type ProjectSnapshot, type Stage, type StageId, loadSnapshot, nextStage, renderSnapshot } from "@/server/agent/state";
export { AGENT_TOOL_DESCRIPTIONS, agentTools } from "@/server/agent/tools";
export { type ScriptedModel, type ScriptedStep, say, scriptedModel, use } from "@/server/agent/scripted-model";
