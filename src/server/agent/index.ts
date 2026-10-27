/**
 * The UGC Creator assistant: the creative director prompt, the tool-use loop, and the model port.
 * @packageDocumentation
 */
export { type AgentEvent, type AgentTurnInput, type AgentUsage, type AgentTurnOptions, MAX_TOOL_CALLS, runAgentTurn } from "@/server/agent/loop";
export {
  DEFAULT_LLM_MODEL,
  type LlmModel,
  type ModelEvent,
  type RouterMessagesPort,
  type StreamParams,
  type Usage,
  anthropicModel,
  assistantModel,
  buildRequest,
  messageEvents,
  routerModel,
} from "@/server/agent/model";
export { CREATIVE_DIRECTOR_PROMPT, STATE_CLOSE, STATE_OPEN, stagePrompt, systemPrompt } from "@/server/agent/prompts/creative-director";
export { CHECKLISTS, type ChecklistKind } from "@/server/agent/prompts/checklists";
export { type ProjectSnapshot, type Stage, type StageId, loadSnapshot, nextStage, renderSnapshot } from "@/server/agent/state";
export { AGENT_TOOL_DESCRIPTIONS, agentTools } from "@/server/agent/tools";
export { type ScriptedModel, type ScriptedStep, say, scriptedModel, toolUse } from "@/server/agent/scripted-model";
