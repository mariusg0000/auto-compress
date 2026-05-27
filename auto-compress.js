/**
 * FILENAME: auto-compress.js
 * PURPOSE: Automated context compaction and message pruning plugin for OpenCode.
 *          Summarizes pruned messages using the active Build model and prepends the summary Turn.
 *          Injects a configured summary token budget into the summarization prompt.
 *          Supports a fixed summarization model for predictable summary generation.
 *          Returns the modified output object to ensure host-side state persistence.
 * DEPENDENCIES: fs, path, os, @opencode-ai/plugin, @opencode-ai/sdk
 */

import { writeFileSync, mkdirSync, existsSync, appendFileSync, readFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const MSG_TOK_COEF = 3.5;
const DEBUG_DIR = join(homedir(), ".config", "opencode", "logs", "auto-compress");
const LOG_FILE = join(DEBUG_DIR, "auto-compress.log");
let fetchDebugInstalled = false;
let debugEnabled = false;

function installRequestPayloadDebug(enabled) {
  if (!enabled || fetchDebugInstalled || typeof globalThis.fetch !== "function") return;
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    try {
      const url = typeof input === "string" ? input : input?.url;
      const bodyRaw = init?.body;
      if (typeof bodyRaw === "string") {
        const lowerUrl = String(url || "").toLowerCase();
        const looksLikeLlm =
          lowerUrl.includes("/chat/completions") ||
          lowerUrl.includes("/responses") ||
          lowerUrl.includes("/messages");
        if (looksLikeLlm) {
          const parsed = JSON.parse(bodyRaw);
          const marker = JSON.stringify(parsed);
          if (marker.includes("Update the previous project summary")) {
            log(`[llm-payload] URL: ${url}`);
            log(`[llm-payload] BODY: ${JSON.stringify(parsed)}`);
          }
        }
      }
    } catch (err) {
      log(`[llm-payload] Debug wrapper error: ${err.message}`);
    }
    return originalFetch(input, init);
  };
  fetchDebugInstalled = true;
  log("[llm-payload] Request payload debug wrapper installed.");
}

/**
 * WHAT:    Ensures that the logs/debug output directory exists.
 * WHY:     To avoid ENOSPC or ENOENT failures when appending logs or writing debug files.
 * HOW:     Uses fs.mkdirSync with recursive: true.
 * PARAMS:  none
 * RETURNS: void
 */
function ensureDir() {
  if (!existsSync(DEBUG_DIR)) mkdirSync(DEBUG_DIR, { recursive: true });
}

/**
 * WHAT:    Appends a log line to the plugin's debug log file.
 * WHY:     For debugging context compaction behavior.
 * HOW:     Appends string line to LOG_FILE, falling back to /tmp if write fails.
 * PARAMS:  msg: string — The log message.
 * RETURNS: void
 */
function log(msg) {
  if (!debugEnabled) return;
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    ensureDir();
    appendFileSync(LOG_FILE, line, "utf-8");
  } catch {}
}

function stripSystemReminderBlocks(text) {
  if (typeof text !== "string" || !text) return "";
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
}

/**
 * WHAT:    Builds the set of reasoning part coordinates that must be preserved.
 * WHY:     Keeps token estimation and effective stripping behavior aligned with preserve-last policy.
 * HOW:     Walks messages from newest to oldest and marks up to preserveLast reasoning parts.
 * PARAMS:  messages: Array<object> — Active messages currently in transform pipeline.
 *          preserveLast: number — Number of newest reasoning parts to preserve.
 * RETURNS: Set<string> — Coordinates encoded as "messageIndex:partIndex".
 */
function buildKeptReasoningSet(messages, preserveLast) {
  const keepCount = Number.isFinite(Number(preserveLast)) ? Math.max(0, Math.floor(Number(preserveLast))) : 0;
  const kept = new Set();
  if (keepCount <= 0) return kept;

  for (let mi = messages.length - 1; mi >= 0 && kept.size < keepCount; mi--) {
    const parts = Array.isArray(messages[mi]?.parts) ? messages[mi].parts : [];
    for (let pi = parts.length - 1; pi >= 0 && kept.size < keepCount; pi--) {
      if (parts[pi]?.type === "reasoning") {
        kept.add(`${mi}:${pi}`);
      }
    }
  }

  return kept;
}

/**
 * WHAT:    Removes reasoning parts from output messages except the preserve-last subset.
 * WHY:     Reduces context footprint right before provider payload generation without changing persisted DB state.
 * HOW:     Rewrites non-preserved reasoning parts to empty text parts in-place and reports totals.
 * PARAMS:  messages: Array<object> — Messages to mutate in-memory.
 *          keptReasoningSet: Set<string> — Coordinates of reasoning parts to keep.
 * RETURNS: { stripped: number, chars: number } — Removal counters used for debug logs.
 */
function applyReasoningStrip(messages, keptReasoningSet) {
  let stripped = 0;
  let chars = 0;

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    const parts = Array.isArray(msg?.parts) ? msg.parts : [];
    msg.parts = parts
      .map((part, pi) => {
        if (!part || part.type !== "reasoning") return part;
        if (keptReasoningSet.has(`${mi}:${pi}`)) return part;
        stripped++;
        chars += (part.text || "").length;
        return { type: "text", text: "" };
      })
      .filter(Boolean);
  }

  return { stripped, chars };
}

/**
 * WHAT:    Normalizes legacy summary section headings to explicit historical labels.
 * WHY:     Avoids ambiguity where old headings like "Current task" can be interpreted as active instructions.
 * HOW:     Applies deterministic heading replacements while preserving summary body content.
 * PARAMS:  text: string — The persisted summary text.
 * RETURNS: string — The normalized summary text.
 */
function normalizeLegacySummaryHeadings(text) {
  if (typeof text !== "string" || !text.trim()) return "";

  return text
    .replace(/^Current task:\s*$/gim, "Last known task before retained messages:")
    .replace(/^Files:\s*$/gim, "Files referenced in pruned history:")
    .replace(/^Completed:\s*$/gim, "Completed before retained messages:")
    .replace(/^Decisions:\s*$/gim, "Decisions from pruned history:")
    .replace(/^Open items:\s*$/gim, "Open items at end of pruned history:");
}

/**
 * WHAT:    Builds the synthetic summary message inserted into active context.
 * WHY:     Ensures historical summary framing and stable per-message IDs.
 * HOW:     Generates one shared summary message ID and one part ID, then returns a user-role synthetic message.
 * PARAMS:  sessionID: string — Active session identifier.
 *          summaryText: string — Historical summary text to embed.
 * RETURNS: object — Synthetic summary message compatible with OpenCode message schema.
 */
function buildSummaryMessage(sessionID, summaryText) {
  const normalizedSummary = normalizeLegacySummaryHeadings(summaryText);
  const summaryTextFormatted = `### CONTEXT SUMMARY: PRUNED HISTORY ONLY\nThis is a historical summary of messages removed from context.\nIt is older than all retained messages that follow.\nUse it as background only; retained messages override it on conflicts.\n\n\`\`\`xml\n<pruned_history_summary>\n${normalizedSummary}\n</pruned_history_summary>\n\`\`\``;
  const now = Date.now();
  const summaryID = `summary-${now}`;
  const summaryPartID = `summary-part-${now}`;

  return {
    info: {
      id: summaryID,
      sessionID: sessionID,
      role: "user",
      time: { created: now },
      synthetic: true
    },
    parts: [
      {
        id: summaryPartID,
        sessionID: sessionID,
        messageID: summaryID,
        type: "text",
        text: summaryTextFormatted,
        synthetic: true
      }
    ]
  };
}

/**
 * WHAT:    Parses the local opencode.json config file to extract the current build model.
 * WHY:     To match the user's configured Build-mode model for high quality technical summaries.
 * HOW:     Reads and parses ~/.config/opencode/opencode.json, defaulting to deepseek-v4-flash if parse fails.
 * PARAMS:  none
 * RETURNS: { providerID: string, modelID: string } — Object with providerID and modelID.
 */
function getBuildModel() {
  const configPath = join(homedir(), ".config", "opencode", "opencode.json");
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const modelStr = config.agent?.build?.model || "opencode-go/deepseek-v4-flash";
    const [providerID, modelID] = modelStr.split("/");
    return { providerID, modelID };
  } catch (e) {
    log(`Failed to parse opencode.json config: ${e.message}. Using fallback deepseek-v4-flash.`);
    return { providerID: "opencode-go", modelID: "deepseek-v4-flash" };
  }
}

/**
 * WHAT:    Resolves the active model by scanning the chat history in reverse.
 * WHY:     In OpenCode, the active model in build mode can be changed dynamically by the user,
 *          and is embedded in assistant message metadata, rather than immediately saved to disk.
 * HOW:     Scans messages from end to beginning. Finds the first assistant message with
 *          info.modelID and info.providerID. Falls back to getBuildModel().
 * PARAMS:  messages: Array<object> — The list of messages in the session.
 * RETURNS: { providerID: string, modelID: string } — The active model configuration.
 */
function getActiveModel(messages) {
  if (messages && Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i]?.info;
      if (info && info.modelID && info.providerID) {
        log(`[model] Found active model in message history (msg ID: ${info.id}): ${info.providerID}/${info.modelID}`);
        return { providerID: info.providerID, modelID: info.modelID };
      }
    }
  }
  const fallback = getBuildModel();
  log(`[model] No active model found in history. Falling back to disk config: ${fallback.providerID}/${fallback.modelID}`);
  return fallback;
}

/**
 * WHAT:    Resolves the model used by the summarizer.
 * WHY:     Allows fixed summarization model via plugin config while preserving safe fallbacks.
 * HOW:     Uses plugin-level model override when valid; otherwise derives model from active message history.
 * PARAMS:  configuredModel: object|string|undefined — Optional model override (`provider/model` or { providerID, modelID }).
 *          messages: Array<object> — The active message list used for model detection.
 * RETURNS: { providerID: string, modelID: string } — Model object accepted by promptAsync.
 */
function resolveSummaryModel(configuredModel, messages) {
  if (typeof configuredModel === "string") {
    const normalized = configuredModel.trim();
    const slashIndex = normalized.indexOf("/");
    if (slashIndex > 0 && slashIndex < normalized.length - 1) {
      const providerID = normalized.slice(0, slashIndex).trim();
      const modelID = normalized.slice(slashIndex + 1).trim();
      if (providerID && modelID) {
        return { providerID, modelID };
      }
    }
    log(`[model] Ignoring invalid configured summary model string: ${configuredModel}`);
  }

  if (configuredModel && typeof configuredModel === "object") {
    const providerID = typeof configuredModel.providerID === "string" ? configuredModel.providerID.trim() : "";
    const modelID = typeof configuredModel.modelID === "string" ? configuredModel.modelID.trim() : "";
    if (providerID && modelID) {
      return { providerID, modelID };
    }
    log("[model] Ignoring invalid configured summary model object.");
  }

  return getActiveModel(messages);
}

/**
 * WHAT:    Invokes the LLM to generate a dense technical summary of pruned messages using a temporary session.
 * WHY:     To abstract away conversation turns slated for physical deletion without losing context.
 * HOW:     Creates a temp session via OpenCode API, posts the transcript, polls status or checks messages until an assistant message is generated, extracts assistant text, deletes temp session.
 * PARAMS:  client: object — The OpencodeClient instance.
 *          transcript: string — Format transcript of pruned messages.
 *          buildModel: object — The { providerID, modelID } build model configurations.
 *          summaryMaxTokens: number — Approximate maximum token budget for the generated summary.
 *          debug: boolean — Optional flag to enable highly verbose JSON debugging logs.
 * RETURNS: Promise<string> — The resulting summarized text.
 */
async function summarizePrunedMessages(client, transcript, buildModel, summaryMaxTokens = 1000, debug = false) {
  let tempSession = null;
  try {
    log("[summarize] Creating temp session...");
    tempSession = await client.session.create({
      body: { title: "auto-compress-temp-summarizer" }
    });
    if (debug) {
      log(`[summarize] Temp session created response: ${JSON.stringify(tempSession)}`);
    }

    const sessionId = tempSession.data?.id;
    if (!sessionId) {
      throw new Error("Failed to retrieve temp session ID from creation response.");
    }
    log(`[summarize] Extracted sessionId: ${sessionId}`);

    const targetSummaryTokens = Number.isFinite(Number(summaryMaxTokens))
      ? Math.max(1, Math.floor(Number(summaryMaxTokens)))
      : 1000;
    const summaryPrompt = `TASK:
Update the previous project summary with the new messages.

RULES:
- The output summarizes only pruned history and not the retained messages that follow in runtime context.
- Use temporally explicit labels so historical state is not interpreted as the active request.
- Treat retained messages (outside this input) as newer context that can override this summary.
- Keep only project-related facts.
- Remove chit-chat, off-topic text, English corrections, repeated dialogue, and tool/meta discussion.
- Preserve important file paths, commands, errors, decisions, implementation status, and open items.
- If new messages prove an open item was completed, move it to Completed.
- If a new unfinished task appears, put it under Last known task before retained messages.
- Never answer the conversation.
- Never continue the conversation.
- Do not reproduce the transcript.
- Keep the summary under approximately ${targetSummaryTokens} tokens.

OUTPUT FORMAT:
Last known task before retained messages:
- ...

Files referenced in pruned history:
- path: fact

Completed before retained messages:
- ...

Decisions from pruned history:
- ...

Open items at end of pruned history:
- ...

INPUT:
${transcript}`;

    log(`[summarize] Sending prompt to temp session ${sessionId}...`);
    const promptRes = await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        agent: "compaction",
        model: buildModel,
        tools: {},
        parts: [{ type: "text", text: summaryPrompt }]
      }
    });
    if (debug) {
      log(`[summarize] PromptAsync sent response: ${JSON.stringify(promptRes)}`);
    }

    const startTime = Date.now();
    const timeout = 60000;
    const fallbackAfter = 30000;
    const interval = 1000;
    let isIdle = false;
    let iteration = 0;
    let wasBusy = false;
    let fallbackTried = false;

    log("[summarize] Starting polling status loop...");
    while (Date.now() - startTime < timeout) {
      iteration++;
      const elapsed = Date.now() - startTime;
      if (debug) {
        log(`[summarize] Iteration ${iteration}, elapsed: ${elapsed}ms`);
      }
      
      let statusesRes;
      try {
        statusesRes = await client.session.status();
        if (debug) {
          log(`[summarize] Iteration ${iteration} status fetch succeeded: ${JSON.stringify(statusesRes)}`);
        }
      } catch (err) {
        log(`[summarize] Iteration ${iteration} status fetch failed: ${err.message}`);
        await new Promise((resolve) => setTimeout(resolve, interval));
        continue;
      }

      const statuses = statusesRes.data;
      const status = statuses?.[sessionId];
      if (debug) {
        log(`[summarize] Session ${sessionId} status: ${JSON.stringify(status)}`);
      }

      if (status && status.type === "idle") {
        isIdle = true;
        break;
      }

      if (status && status.type === "busy") {
        wasBusy = true;
      }

      if (status === undefined || (wasBusy && elapsed >= fallbackAfter && !fallbackTried)) {
        if (elapsed >= fallbackAfter) fallbackTried = true;
        if (debug) {
          log(`[summarize] Session ${sessionId} status is ${status?.type || "undefined"}. Checking messages (elapsed=${elapsed}ms)...`);
        }
        try {
          const msgCheck = await client.session.messages({ path: { id: sessionId } });
          const msgs = msgCheck.data || [];
          const hasAssistantMsg = msgs.some((m) => m.info?.role === "assistant");
          if (hasAssistantMsg) {
            log(`[summarize] Found assistant message in session ${sessionId}. Treating as completed.`);
            isIdle = true;
            break;
          }
        } catch (err) {
          log(`[summarize] Failed to check messages for session ${sessionId}: ${err.message}`);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    if (!isIdle) {
      throw new Error(`Timeout waiting for summary session ${sessionId} to become idle.`);
    }

    log("[summarize] Fetching session messages...");
    const messagesRes = await client.session.messages({
      path: { id: sessionId }
    });
    if (debug) {
      log(`[summarize] Messages response: ${JSON.stringify(messagesRes)}`);
    }

    const messagesList = messagesRes.data || [];
    const assistantMsg = [...messagesList]
      .reverse()
      .find((m) => m.info?.role === "assistant");

    if (!assistantMsg) {
      throw new Error("No assistant message found in summary session.");
    }

    const summaryText = assistantMsg.parts?.find((p) => p.type === "text")?.text;
    if (!summaryText) {
      throw new Error("No text found in summary response assistant message.");
    }

    return summaryText;
  } catch (err) {
    log(`LLM summarization call failed: ${err.message}`);
    throw err;
  } finally {
    if (tempSession && tempSession.data?.id) {
      log(`[summarize] Cleaning up temp session ${tempSession.data.id}...`);
      try {
        await client.session.delete({ path: { id: tempSession.data.id } });
        log("[summarize] Clean up temp session completed.");
      } catch (e) {
        log(`Failed to clean up temp session ${tempSession.data.id}: ${e.message}`);
      }
    }
  }
}

/**
 * WHAT:    Estimates the number of tokens in a message based on a character-to-token ratio.
 * WHY:     Enables lightweight, fast estimation of history size in tokens.
 * HOW:     Computes character lengths per part type divided by the MSG_TOK_COEF.
 * PARAMS:  msg: object — The message structure with parts.
 * RETURNS: number — Estimated token count.
 */
function sumTokens(msg, messageIndex = -1, keptReasoningSet = null) {
  let s = 0;
  for (let partIndex = 0; partIndex < msg.parts.length; partIndex++) {
    const p = msg.parts[partIndex];
    if (p.type === "text") s += Math.ceil((p.text || "").length / MSG_TOK_COEF);
    else if (p.type === "reasoning") {
      const keepReasoning = keptReasoningSet instanceof Set
        ? keptReasoningSet.has(`${messageIndex}:${partIndex}`)
        : true;
      if (keepReasoning) {
        s += Math.ceil((p.text || "").length / MSG_TOK_COEF);
      }
    }
    else if (p.type === "tool") s += Math.ceil(JSON.stringify(p.state || "").length / MSG_TOK_COEF);
    else if (p.text) s += Math.ceil(p.text.length / MSG_TOK_COEF);
  }
  return s;
}

/**
 * WHAT:    Writes a highly granular JSON debug log summarizing the pruning operation.
 * WHY:     Auditing tool to trace exact before/after message state changes.
 * HOW:     Saves structured JSON data to a unique prune file in the DEBUG_DIR.
 * PARAMS:  debug: boolean — Enable/disable flag.
 *          sessionID: string — Identifies the active chat session.
 *          beforeCount: number — Message count before compaction.
 *          beforeTokens: number — Token estimate before compaction.
 *          afterCount: number — Message count after compaction.
 *          afterTokens: number — Token estimate after compaction.
 *          removedIndices: Array<number> — Indices of messages that were deleted.
 *          messages: Array<object> — List of currently kept messages.
 * RETURNS: void
 */
function writeDebugLog(debug, sessionID, beforeCount, beforeTokens, afterCount, afterTokens, removedIndices, messages) {
  if (!debug) return;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(DEBUG_DIR, `prune-${sessionID}-${ts}.json`);
    const logData = {
      timestamp: new Date().toISOString(),
      sessionID,
      before: { messages: beforeCount, tokens: beforeTokens },
      after: { messages: afterCount, tokens: afterTokens },
      removedIndices,
      kept: messages.map((m) => ({
        role: m.info?.role,
        id: m.info?.id,
        tokens: sumTokens(m),
        parts: m.parts.map((p) => ({
          type: p.type,
          text: p.type === "text" ? (p.text || "").slice(0, 200) : p.type === "tool" ? `${p.tool}(${p.callID})` : "",
        })),
      })),
    };
    writeFileSync(file, JSON.stringify(logData, null, 2), "utf-8");
    log(`debug log written: ${file}`);
  } catch (e) {
    log(`failed to write debug log: ${e.message}`);
  }
}

const STATE_DIR = join(DEBUG_DIR, "state");

/**
 * WHAT:    Ensures that the session state directory exists.
 * WHY:     To prevent write failures when saving the persistent session state files.
 * HOW:     Uses fs.mkdirSync with recursive: true on STATE_DIR.
 * PARAMS:  none
 * RETURNS: void
 */
function ensureStateDir() {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

/**
 * WHAT:    Loads the persistent summary state for a given session.
 * WHY:     To retrieve the rolling summary and the list of already compacted message IDs.
 * HOW:     Reads the JSON state file from STATE_DIR. Returns empty state if file doesn't exist or is invalid.
 * PARAMS:  sessionID: string — The active conversation session ID.
 * RETURNS: object — The loaded state containing { summary: string, summarizedIDs: Array<string> }.
 */
function loadSessionState(sessionID) {
  ensureStateDir();
  const filePath = join(STATE_DIR, `${sessionID}.json`);
  if (existsSync(filePath)) {
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      if (data && typeof data === "object") {
        return {
          summary: data.summary || "",
          summarizedIDs: Array.isArray(data.summarizedIDs) ? data.summarizedIDs : []
        };
      }
    } catch (e) {
      log(`[state] Failed to load session state for ${sessionID}: ${e.message}`);
    }
  }
  return { summary: "", summarizedIDs: [] };
}

/**
 * WHAT:    Saves the persistent summary state for a given session.
 * WHY:     To preserve the rolling summary and compacted message IDs across chat turn reloads.
 * HOW:     Writes the JSON state to STATE_DIR.
 * PARAMS:  sessionID: string — The active conversation session ID.
 *          summary: string — The updated rolling summary.
 *          summarizedIDs: Array<string> — The full list of compacted message IDs.
 * RETURNS: void
 */
function saveSessionState(sessionID, summary, summarizedIDs) {
  ensureStateDir();
  const filePath = join(STATE_DIR, `${sessionID}.json`);
  try {
    writeFileSync(filePath, JSON.stringify({ summary, summarizedIDs }, null, 2), "utf-8");
    log(`[state] Saved session state for ${sessionID} with ${summarizedIDs.length} messages.`);
  } catch (e) {
    log(`[state] Failed to save session state for ${sessionID}: ${e.message}`);
  }
}

/**
 * WHAT:    Deletes persisted state files older than a retention window.
 * WHY:     Prevents unbounded growth of per-session state snapshots on disk.
 * HOW:     Scans state directory and unlinks files whose mtime is older than maxAgeDays.
 * PARAMS:  maxAgeDays: number — Retention window in days.
 * RETURNS: void
 */
function cleanupOldStateFiles(maxAgeDays = 30) {
  try {
    const stateDir = join(DEBUG_DIR, "state");
    if (!existsSync(stateDir)) return;
    const now = Date.now();
    const cutoffMs = maxAgeDays * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const name of readdirSync(stateDir)) {
      const filePath = join(stateDir, name);
      let stat;
      try {
        stat = statSync(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs <= cutoffMs) continue;
      try {
        unlinkSync(filePath);
        removed++;
      } catch (e) {
        log(`[state-cleanup] Failed deleting ${filePath}: ${e.message}`);
      }
    }

    if (removed > 0) {
      log(`[state-cleanup] Removed ${removed} state file(s) older than ${maxAgeDays} days.`);
    }
  } catch (e) {
    log(`[state-cleanup] Failed: ${e.message}`);
  }
}

/**
 * WHAT:    Standard ESM plugin export.
 * WHY:     Registers the chat message transform hook in the OpenCode ecosystem.
 * HOW:     Returns experimental.chat.messages.transform function hooks.
 * PARAMS:  _ctx: object — Plugin context object.
 *          options: object — Configured options from opencode.json.
 * RETURNS: Promise<object> — Object representing hooks.
 */
export default async (_ctx, options = {}) => {
  const maxLimit = options.maxContextLimit ?? 70000;
  const minLimit = options.minContextLimit ?? 30000;
  const summaryMaxTokens = options.summaryMaxTokens ?? 1000;
  const configuredSummaryModel = options.model;
  const debug = options.debug ?? false;
  const debugRequestPayload = options.debugRequestPayload ?? false;
  const stripReasoning = options.stripReasoning ?? false;
  const preserveReasoningLast = options.preserveReasoningLast ?? 1;
  const stripReasoningVerbosity = options.stripReasoningVerbosity ?? true;

  debugEnabled = Boolean(debug);

  if (debugEnabled) {
    log("MODULE LOADED");
  }

  installRequestPayloadDebug(debugEnabled && debugRequestPayload);
  cleanupOldStateFiles(30);

  log(`===== PLUGIN EXPORT DEFAULT CALLED ===== maxLimit=${maxLimit}, minLimit=${minLimit}, summaryMaxTokens=${summaryMaxTokens}, debug=${debug}, debugRequestPayload=${debugRequestPayload}, stripReasoning=${stripReasoning}, preserveReasoningLast=${preserveReasoningLast}, stripReasoningVerbosity=${stripReasoningVerbosity}`);

  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      log(`[hook] transform hook called, messages count: ${output?.messages?.length || 0}`);

      const messages = output.messages;
      if (!messages || messages.length === 0) {
        log("no messages");
        return;
      }

      const sessionID = messages.find((m) => m.info?.sessionID)?.info?.sessionID || "unknown";
      const sessionState = loadSessionState(sessionID);
      log(`[hook] Loaded state for session ${sessionID}. Summarized count: ${sessionState.summarizedIDs.length}`);

      // 1. Filter out already-summarized messages and synthetic summary messages.
      const summarizedSet = new Set(sessionState.summarizedIDs);
      const filteredMessages = messages.filter((m) => {
        if (m.info?.synthetic || m.info?.id?.startsWith("summary-")) {
          return false;
        }
        if (m.info?.id && summarizedSet.has(m.info.id)) {
          return false;
        }
        return true;
      });

      // Clear the original messages array and rebuild it.
      messages.length = 0;

      // 2. Prepend the previous summary if one exists.
      if (sessionState.summary) {
        const summaryMessage = buildSummaryMessage(sessionID, sessionState.summary);
        messages.push(summaryMessage);
      }

      // Add the remaining active messages.
      messages.push(...filteredMessages);

      const keptReasoningSet = stripReasoning ? buildKeptReasoningSet(messages, preserveReasoningLast) : null;
      const totalTokens = messages.reduce((s, m, messageIndex) => s + sumTokens(m, messageIndex, keptReasoningSet), 0);
      log(`[hook] Reconstructed messages=${messages.length}, totalTokens=${totalTokens}, maxLimit=${maxLimit}, minLimit=${minLimit}`);
      
      if (totalTokens < maxLimit) {
        if (stripReasoning) {
          const stripStats = applyReasoningStrip(messages, keptReasoningSet);
          if (stripReasoningVerbosity && stripStats.stripped > 0) {
            const approxTokens = Math.round(stripStats.chars / MSG_TOK_COEF);
            log(`[reasoning] stripped=${stripStats.stripped}, chars=${stripStats.chars}, approxTokens=${approxTokens}, preserveLast=${preserveReasoningLast}`);
          }
        }
        log("[hook] Below maxLimit, returning reconstructed context.");
        return output;
      }

      // Re-map tool call indexes on the active messages.
      const callIDUseIndex = new Map();
      const callIDResultIndex = new Map();
      for (let i = 0; i < messages.length; i++) {
        for (const p of messages[i].parts) {
          if (p.type !== "tool" || !p.callID) continue;
          if (p.state?.status === "pending" || p.state?.status === "running") {
            callIDUseIndex.set(p.callID, i);
          } else if (p.state?.status === "completed" || p.state?.status === "error") {
            callIDResultIndex.set(p.callID, i);
          }
        }
      }

      let accumulated = 0;
      let cutIndex = 0;
      let lastUseCallID = null;

      // Start evaluation from index 1 if index 0 is the synthetic summary message.
      const startIndex = (messages[0]?.info?.synthetic) ? 1 : 0;

      for (let i = startIndex; i < messages.length; i++) {
        const msgTok = sumTokens(messages[i], i, keptReasoningSet);
        accumulated += msgTok;

        for (const p of messages[i].parts) {
          if (p.type === "tool" && (p.state?.status === "pending" || p.state?.status === "running")) {
            lastUseCallID = p.callID;
          }
        }

        const remaining = totalTokens - accumulated;
        if (remaining <= minLimit) {
          cutIndex = i + 1;
          break;
        }
      }

      if (cutIndex <= startIndex) {
        log(`[hook] cutIndex (${cutIndex}) <= startIndex (${startIndex}), nothing to prune.`);
        return output;
      }

      if (lastUseCallID) {
        const resultIdx = callIDResultIndex.get(lastUseCallID);
        if (resultIdx !== undefined && resultIdx >= cutIndex) {
          log(`extending cutIndex ${cutIndex} -> ${resultIdx + 1} to include tool result for ${lastUseCallID}`);
          cutIndex = resultIdx + 1;
        }
      }

      const beforeTokens = totalTokens;
      const activeBeforeCount = messages.length - startIndex;
      const pruned = messages.slice(startIndex, cutIndex);
      const kept = messages.slice(cutIndex);

      let summaryText = sessionState.summary;
      let summaryError = null;
      if (pruned.length > 0) {
        const newTranscriptLines = [];
        for (const m of pruned) {
          const role = m.info?.role || "unknown";
          const text = m.parts
            .filter((p) => p.type === "text")
            .map((p) => stripSystemReminderBlocks(p.text))
            .filter((t) => t)
            .join("\n")
            .trim();
          if (!text) continue;
          newTranscriptLines.push(`${role.toUpperCase()}: ${text}`);
        }
        const newTranscript = newTranscriptLines.join("\n\n");

        const buildModel = resolveSummaryModel(configuredSummaryModel, messages);
        log(`Pruned count: ${pruned.length}. Running summarization with model ${buildModel.providerID}/${buildModel.modelID}...`);

        let combinedTranscript = "";
        if (sessionState.summary) {
          combinedTranscript =
`PREVIOUS SUMMARY:
${sessionState.summary}

NEW MESSAGES:
${newTranscript}`;
        } else {
          combinedTranscript =
`PREVIOUS SUMMARY:
(none)

NEW MESSAGES:
${newTranscript}`;
        }

        try {
          summaryText = await summarizePrunedMessages(_ctx.client, combinedTranscript, buildModel, summaryMaxTokens, debug);
          if (!summaryText || !summaryText.trim()) {
            throw new Error("Empty summary text returned.");
          }
          log(`
======================================================================
[COMPACTARE CONTEXT] TRANSCRIERE MESAJE ELIMINATE:
======================================================================
${combinedTranscript}
======================================================================
[COMPACTARE CONTEXT] SUMAR REZULTAT:
======================================================================
${summaryText}
======================================================================
          `);

          const newlySummarizedIDs = pruned
            .map((m) => m.info?.id)
            .filter((id) => id);

          const updatedSummarizedIDs = [...sessionState.summarizedIDs, ...newlySummarizedIDs];
          saveSessionState(sessionID, summaryText, updatedSummarizedIDs);

        } catch (err) {
          summaryError = err;
          log(`Summarization execution failed: ${err.message}. Continuing context compaction without updated summary.`);
        }
      }

      // Re-reconstruct messages array with updated summary at index 0 and kept messages.
      messages.length = 0;

      if (summaryText) {
        const summaryMessage = buildSummaryMessage(sessionID, summaryText);
        messages.push(summaryMessage);
      }

      messages.push(...kept);

      const finalKeptReasoningSet = stripReasoning ? buildKeptReasoningSet(messages, preserveReasoningLast) : null;
      if (stripReasoning) {
        const stripStats = applyReasoningStrip(messages, finalKeptReasoningSet);
        if (stripReasoningVerbosity && stripStats.stripped > 0) {
          const approxTokens = Math.round(stripStats.chars / MSG_TOK_COEF);
          log(`[reasoning] stripped=${stripStats.stripped}, chars=${stripStats.chars}, approxTokens=${approxTokens}, preserveLast=${preserveReasoningLast}`);
        }
      }

      const afterTokens = messages.reduce((s, m, messageIndex) => s + sumTokens(m, messageIndex, finalKeptReasoningSet), 0);
      const removedIndices = [];
      for (let i = startIndex; i < cutIndex; i++) removedIndices.push(i);

      log(`pruned: ${pruned.length} messages. Remaining active messages: ${messages.length}. totalTokens=${afterTokens}`);

      writeDebugLog(debug, sessionID, activeBeforeCount, beforeTokens, messages.length, afterTokens, removedIndices, messages);

      if (summaryError) {
        console.error(`[auto-compress] Summarization failed; context was still pruned: ${summaryError.message}`);
      }

      return output;
    },
  };
};
