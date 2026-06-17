/**
 * FILENAME: auto-compress.js
 * PURPOSE: Automated context compaction and message pruning plugin for OpenCode.
 *          Summarizes pruned messages using the active Build model and prepends the summary Turn.
 *          Injects a configured summary token budget into the summarization prompt.
 *          Supports a fixed summarization model for predictable summary generation.
 *          Returns the modified output object to ensure host-side state persistence.
 * DEPENDENCIES: fs, path, os, @opencode-ai/plugin, @opencode-ai/sdk
 */

import { writeFileSync, mkdirSync, existsSync, appendFileSync, readFileSync, readdirSync, statSync, unlinkSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const DEFAULT_TOKEN_COEFFICIENT = 3.5;
const DEFAULT_MAX_CONTEXT_TOKENS = 40000;
const DEFAULT_MIN_CONTEXT_TOKENS = 20000;
const DEFAULT_FAILURE_BACKOFF_STEP_TOKENS = 5000;
const DEFAULT_FAILURE_BACKOFF_MAX_OFFSET_TOKENS = 25000;
const DEFAULT_MAX_SUMMARY_FILES = 5;
const DEBUG_DIR = join(homedir(), ".config", "opencode", "logs", "auto-compress");
const LOG_FILE = join(DEBUG_DIR, "auto-compress.log");
const TOKEN_LOG_FILE = join(DEBUG_DIR, "token-calc.log");
const SUMMARY_DIR = join(DEBUG_DIR, "summaries");
const LOG_LEVELS = new Set(["none", "error", "debug"]);
let logLevel = "none";
let tokenCalcDebugEnabled = false;
let tokenCoefficient = DEFAULT_TOKEN_COEFFICIENT;

function normalizeLogLevel(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return LOG_LEVELS.has(normalized) ? normalized : "none";
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
  if (logLevel !== "debug") return;
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    ensureDir();
    appendFileSync(LOG_FILE, line, "utf-8");
  } catch {}
}

/**
 * WHAT:    Appends token-calculation trace lines to a dedicated debug file.
 * WHY:     Allows auditing exact inputs and per-part values used by token estimator.
 * HOW:     Writes timestamped line into TOKEN_LOG_FILE when token calc debug is enabled.
 * PARAMS:  msg: string — Trace line to persist.
 * RETURNS: void
 */
function logTokenCalc(_msg) {
  if (!tokenCalcDebugEnabled || logLevel !== "debug") return;
  const line = `[${new Date().toISOString()}] ${_msg}\n`;
  try {
    ensureDir();
    appendFileSync(TOKEN_LOG_FILE, line, "utf-8");
  } catch {}
}

function reportError(msg) {
  if (logLevel === "none") return;
  console.error(msg);
}

function stripSystemReminderBlocks(text) {
  if (typeof text !== "string" || !text) return "";
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
}

function sanitizeToolText(text) {
  if (typeof text !== "string" || !text) return "";
  return stripSystemReminderBlocks(text).trim();
}

function stringifyToolInput(input, raw) {
  if (typeof raw === "string" && raw.trim()) {
    return sanitizeToolText(raw);
  }
  if (input === undefined) return "";
  try {
    const serialized = JSON.stringify(input, null, 2);
    return sanitizeToolText(serialized);
  } catch {
    return "";
  }
}

function buildToolTranscriptText(part) {
  if (!part || part.type !== "tool") return "";
  const toolName = typeof part.tool === "string" ? part.tool.trim() : "tool";
  const status = part.state?.status;
  const fragments = [`TOOL ${toolName}`];
  const input = stringifyToolInput(part.state?.input, part.state?.raw);

  if (input) fragments.push(`INPUT:\n${input}`);

  if (status === "completed") {
    const title = sanitizeToolText(part.state?.title);
    const output = sanitizeToolText(part.state?.output);
    if (title) fragments.push(`TITLE: ${title}`);
    if (output) fragments.push(`OUTPUT:\n${output}`);
  } else if (status === "error") {
    const error = sanitizeToolText(part.state?.error);
    if (error) fragments.push(`ERROR: ${error}`);
  } else if (status === "running") {
    const title = sanitizeToolText(part.state?.title);
    if (title) fragments.push(`STATUS: ${title}`);
  }

  return fragments.length > 1 ? fragments.join("\n") : "";
}

const TOKEN_SPLIT_RE = /(\s+|[^\s\w]|\d+|[A-Za-z0-9_]+|[\u00C0-\u024F\u1E00-\u1EFF]+)/g;

function tokenizeText(text) {
  if (typeof text !== "string" || !text) return 0;
  let count = 0;
  for (const match of text.matchAll(TOKEN_SPLIT_RE)) {
    const token = match[0];
    if (!token) continue;
    if (/^\s+$/.test(token)) {
      continue;
    }
    if (/^[^\s\w]$/.test(token)) {
      count += 1;
      continue;
    }
    if (/^\d+$/.test(token)) {
      count += Math.max(1, Math.ceil(token.length / 3.5));
      continue;
    }
    if (/^[\u00C0-\u024F\u1E00-\u1EFF]+$/.test(token)) {
      count += Math.max(1, Math.ceil(token.length / tokenCoefficient));
      continue;
    }
    let wordTokens = Math.max(1, Math.ceil(token.length / tokenCoefficient));
    const upper = token.match(/[A-Z]/g);
    if (upper) {
      wordTokens = Math.max(wordTokens - Math.floor(upper.length * 0.25), 1);
    }
    if (/[_]/.test(token)) {
      wordTokens = Math.max(wordTokens - 1, 1);
    }
    count += wordTokens;
  }
  return count;
}

function countTextTokens(text) {
  return tokenizeText(text);
}

function normalizeStripReasoningOptions(options = {}) {
  const stripReasoning = options?.stripReasoning;
  const enabled = Boolean(stripReasoning?.enable);
  const preserveLastRaw = stripReasoning?.preserveLast ?? 1;
  const preserveLast = Number.isFinite(Number(preserveLastRaw))
    ? Math.max(0, Math.floor(Number(preserveLastRaw)))
    : 1;

  return {
    enabled,
    preserveLast,
  };
}

function getReasoningPartKey(messageIndex, partIndex) {
  return `${messageIndex}:${partIndex}`;
}

function collectReasoningKeepSet(messages, preserveLast) {
  const keepSet = new Set();
  if (!Array.isArray(messages) || preserveLast <= 0) return keepSet;

  for (let messageIndex = messages.length - 1; messageIndex >= 0 && keepSet.size < preserveLast; messageIndex--) {
    const parts = Array.isArray(messages[messageIndex]?.parts) ? messages[messageIndex].parts : [];
    for (let partIndex = parts.length - 1; partIndex >= 0 && keepSet.size < preserveLast; partIndex--) {
      if (parts[partIndex]?.type === "reasoning") {
        keepSet.add(getReasoningPartKey(messageIndex, partIndex));
      }
    }
  }

  return keepSet;
}

function shouldKeepReasoningPart(part, messageIndex, partIndex, stripReasoningOptions, reasoningKeepSet) {
  if (part?.type !== "reasoning") return true;
  if (!stripReasoningOptions?.enabled) return true;
  return reasoningKeepSet.has(getReasoningPartKey(messageIndex, partIndex));
}

function applyReasoningStripInPlace(messages, stripReasoningOptions) {
  if (!Array.isArray(messages) || !stripReasoningOptions?.enabled) return messages;

  const reasoningKeepSet = collectReasoningKeepSet(messages, stripReasoningOptions.preserveLast);
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    if (!Array.isArray(message?.parts)) continue;
    message.parts = message.parts.map((part, partIndex) => {
      if (shouldKeepReasoningPart(part, messageIndex, partIndex, stripReasoningOptions, reasoningKeepSet)) {
        return part;
      }
      return { type: "text", text: "" };
    });
  }

  return messages;
}

function finalizeOutputWithReasoningStrip(output, stripReasoningOptions) {
  if (!output?.messages || !stripReasoningOptions?.enabled) return output;
  applyReasoningStripInPlace(output.messages, stripReasoningOptions);
  return output;
}

function getAssistantPromptTokens(message) {
  if (message?.info?.role !== "assistant") return null;
  const tokens = message?.info?.tokens;
  if (!tokens) return null;
  const input = Number(tokens.input);
  const cacheRead = Number(tokens.cache?.read);
  const cacheWrite = Number(tokens.cache?.write);
  if (![input, cacheRead, cacheWrite].every((n) => Number.isFinite(n) && n >= 0)) return null;
  return input + cacheRead + cacheWrite;
}

function buildContextLedger(messages) {
  const ledger = [];
  let previous = 0;
  for (const message of messages || []) {
    if (message?.info?.synthetic) continue;
    const contextTokens = getAssistantPromptTokens(message);
    if (contextTokens === null) continue;
    ledger.push({
      messageID: message.info.id,
      contextTokens,
      deltaTokens: Math.max(0, contextTokens - previous),
    });
    previous = contextTokens;
  }
  return ledger;
}

function buildAssistantUsageRecords(messages) {
  const records = [];
  for (let index = 0; index < (messages || []).length; index++) {
    const message = messages[index];
    if (message?.info?.synthetic) continue;
    const contextTokens = getAssistantPromptTokens(message);
    if (contextTokens === null) continue;
    records.push({
      messageID: message.info.id,
      parentID: message.info.parentID || null,
      contextTokens,
      index,
    });
  }
  return records;
}

function sumMessageTokens(messages, startIndex = 0, stripReasoningOptions = null, reasoningKeepSet = new Set()) {
  return messages.slice(startIndex).reduce(
    (s, m, messageIndex) => s + sumTokens(m, startIndex + messageIndex, stripReasoningOptions, reasoningKeepSet),
    0,
  );
}

function findCutIndexByEstimatedTokens(messages, startIndex, targetRetainedTokens, stripReasoningOptions = null, reasoningKeepSet = new Set()) {
  if (!Array.isArray(messages) || messages.length === 0) return -1;

  let keptTokens = 0;
  let chosenIndex = -1;

  for (let i = messages.length - 1; i >= startIndex; i--) {
    keptTokens += sumTokens(messages[i], i, stripReasoningOptions, reasoningKeepSet);
    if (keptTokens >= targetRetainedTokens) {
      chosenIndex = i;
      break;
    }
  }

  if (chosenIndex < 0) {
    return startIndex;
  }

  return chosenIndex;
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
 * HOW:     Bundles persisted per-session summary chunks into one shared synthetic message.
 * PARAMS:  sessionID: string — Active session identifier.
 *          summaryEntries: Array<object> — Historical summary chunks to embed in chronological order.
 * RETURNS: object — Synthetic summary message compatible with OpenCode message schema.
 */
function sanitizeSummaryText(text) {
  return normalizeLegacySummaryHeadings(stripSystemReminderBlocks(text)).trim();
}

function buildSummaryMessage(sessionID, summaryEntries) {
  const normalizedEntries = Array.isArray(summaryEntries)
    ? summaryEntries
        .map((entry) => ({
          fileName: typeof entry?.fileName === "string" ? entry.fileName : "",
          text: sanitizeSummaryText(entry?.text || ""),
        }))
        .filter((entry) => entry.fileName && entry.text)
    : [];

  if (normalizedEntries.length === 0) return null;

  const summaryBody = normalizedEntries
    .map((entry, index) => `<summary file="${entry.fileName}" order="${index + 1}" chronology="${index === normalizedEntries.length - 1 ? "newest" : "older"}">\n${entry.text}\n</summary>`)
    .join("\n\n");
  const summaryTextFormatted = `### CONTEXT SUMMARIES: PRUNED HISTORY ONLY\nThese are historical segment summaries of messages removed from context.\nOlder summaries appear first. Newer summaries override older ones on conflicts.\nUse them as background only; retained messages that follow are newer than all summaries here.\n\n\`\`\`xml\n<pruned_history_summaries>\n${summaryBody}\n</pruned_history_summaries>\n\`\`\``;
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
    reportError(`Failed to parse opencode.json config: ${e.message}. Using fallback deepseek-v4-flash.`);
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
    const approximateWordBudget = Math.max(1, Math.floor(targetSummaryTokens * 0.75));
    const summaryPrompt = `TASK:
Write the next append-only compact memory chunk replacing exactly the NEW PRUNED MESSAGES in a long-running coding/session context.

This summary is for LLM context only, not for a human report. It will be inserted after EXISTING HISTORICAL SUMMARIES and before later retained normal messages. Therefore it must describe only the pruned span it replaces, not the global current project/session state.

INPUT STRUCTURE:

EXISTING HISTORICAL SUMMARIES: older immutable summary chunks, in chronological order. Use them only as read-only context.
NEW PRUNED MESSAGES: the exact conversation span being replaced by this new summary chunk.

CORE RULES:

Summarize only NEW PRUNED MESSAGES.
Use EXISTING HISTORICAL SUMMARIES only to resolve references, continuity, names, prior decisions, unresolved work, and deduplication.
Do not rewrite, merge, correct, restate, or reformat old summaries.
Do not summarize retained messages that may come after this pruned span.
Do not infer or declare overall current project state. Only record facts/events that occurred inside NEW PRUNED MESSAGES.
Preserve chronological order inside the pruned span when order affects causality or continuation.
Prefer delta facts over narrative: what changed, what was decided, what was verified, what failed, what remains unresolved from this span.
If a fact already exists in old summaries, repeat it only if NEW PRUNED MESSAGES changed, completed, contradicted, clarified, or depended on it.
Treat explicit [REASONING] blocks in NEW PRUNED MESSAGES as evidence for workflow continuity, intent, decisions, course corrections, and validation.
Do not quote, imitate, or reproduce [REASONING] blocks verbatim. Distill only project-relevant facts.
Never answer the conversation.
Never continue the conversation as assistant.
Do not reproduce transcript dialogue.

KEEP:

Requirements or constraints introduced in the pruned span.
File paths, filenames, modules, functions, types, config keys, schema fields.
Commands, test names, test results, errors, warnings, logs, verification results.
Commits, hashes, branches, pushes, staged/uncommitted status if mentioned.
Implementation/config/documentation changes.
Technical decisions, formulas, mappings, conventions, migrations.
False starts only if they explain an important decision, avoid repeating a mistake, or changed repo/session state.
Open items created or still unresolved at the end of this pruned span, if needed to understand the following retained context.

DROP:

Chit-chat, politeness, repeated dialogue, English corrections, assistant meta-talk, tool noise.
Phrases like "the assistant wanted/tried/decided/began" unless actor identity is technically necessary.
Global status summaries such as "current state", "overall state", "project status".
Decorative headings, banners, wrappers, or report-style titles.
Human-friendly explanation when compact technical wording is enough.
Emoji.

STYLE:

Output only the new summary chunk text.
Optimize for low tokens and high LLM recall.
Use compact chronological technical log lines or dense short paragraphs.
Use bullets only when they reduce tokens or improve parsing for multiple related changes.
Prefer technical subjects over conversation actors:
Good: "Synced config from canonical INI."
Bad: "The user provided the INI and the assistant updated the config."
Prefer direct deltas:
A -> B
A != B
A = value


added


removed
? unresolved/unknown
! important warning
Do not overuse symbols; clarity for an LLM is more important than visual compactness.

TOKEN-FRIENDLY MARKERS:
Use these uppercase markers inline when helpful. Do not create empty sections.

REQ: requirement/constraint introduced in this span
DECISION: technical decision
CHANGE: implementation/config/doc change
FIX: bug fix
FILE: relevant file/path
CFG: config/schema/key/value detail
CMD: command executed
VERIFY: test/check result
ERR: error/failure/warning
COMMIT: commit hash/message
PUSH: branch/remote push status
OPEN: unresolved item from this pruned span
NOTE: important context that prevents future confusion
SPAN-END: only if the exact end-of-pruned-span handoff is necessary; do not use as global current state

COMPRESSION PRIORITY:
If space is tight, keep information in this order:

irreversible repo/session changes: commits, pushes, file edits, config migrations
requirements/decisions that constrain future work
verification results and errors
open items created by this span
useful chronology/cause
minor attempts or explanations

LENGTH:
Keep under approximately ${targetSummaryTokens} tokens, roughly ${approximateWordBudget} words.

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

    const summaryText = sanitizeSummaryText(assistantMsg.parts?.find((p) => p.type === "text")?.text || "");
    if (!summaryText) {
      throw new Error("No text found in summary response assistant message.");
    }

    return summaryText;
  } catch (err) {
    reportError(`LLM summarization call failed: ${err.message}`);
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
function sumTokens(msg, messageIndex = -1, stripReasoningOptions = null, reasoningKeepSet = new Set()) {
  let s = 0;
  const messageID = msg?.info?.id || "unknown";
  const role = msg?.info?.role || "unknown";
  logTokenCalc(`[message:start] index=${messageIndex} id=${messageID} role=${role}`);
  for (let partIndex = 0; partIndex < msg.parts.length; partIndex++) {
    const p = msg.parts[partIndex];
    if (p.type === "text") {
      const tokens = countTextTokens(p.text || "");
      s += tokens;
      logTokenCalc(`[part] messageIndex=${messageIndex} partIndex=${partIndex} type=text chars=${(p.text || "").length} tokens=${tokens}`);
    }
    else if (p.type === "reasoning") {
      if (!shouldKeepReasoningPart(p, messageIndex, partIndex, stripReasoningOptions, reasoningKeepSet)) {
        logTokenCalc(`[part] messageIndex=${messageIndex} partIndex=${partIndex} type=reasoning chars=${(p.text || "").length} tokens=0 source=reasoning-text reason=stripped`);
        continue;
      }
      const tokens = countTextTokens(p.text || "");
      s += tokens;
      logTokenCalc(`[part] messageIndex=${messageIndex} partIndex=${partIndex} type=reasoning chars=${(p.text || "").length} tokens=${tokens} source=reasoning-text`);
    }
    else if (p.type === "tool") {
      const transcriptText = buildToolTranscriptText(p);
      const tokens = countTextTokens(transcriptText);
      s += tokens;
      logTokenCalc(`[part] messageIndex=${messageIndex} partIndex=${partIndex} type=tool chars=${transcriptText.length} tokens=${tokens} source=tool-input-title-output-error`);
    }
    else if (p.text) {
      const tokens = countTextTokens(p.text);
      s += tokens;
      logTokenCalc(`[part] messageIndex=${messageIndex} partIndex=${partIndex} type=${p.type || "unknown"} chars=${p.text.length} tokens=${tokens} source=part.text`);
    } else {
      logTokenCalc(`[part] messageIndex=${messageIndex} partIndex=${partIndex} type=${p.type || "unknown"} chars=0 tokens=0 reason=no-text`);
    }
  }
  logTokenCalc(`[message:end] index=${messageIndex} id=${messageID} role=${role} totalTokens=${s}`);
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

function ensureSummaryDir() {
  if (!existsSync(SUMMARY_DIR)) {
    mkdirSync(SUMMARY_DIR, { recursive: true });
  }
}

function getSessionSummaryDir(sessionID) {
  return join(SUMMARY_DIR, sessionID);
}

function ensureSessionSummaryDir(sessionID) {
  ensureSummaryDir();
  const sessionDir = getSessionSummaryDir(sessionID);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

function parseSummarySequence(fileName) {
  const match = /^(\d{6})\.md$/.exec(fileName || "");
  return match ? Number(match[1]) : null;
}

function listSessionSummaryEntries(sessionID) {
  ensureSummaryDir();
  const sessionDir = getSessionSummaryDir(sessionID);
  if (!existsSync(sessionDir)) return [];

  return readdirSync(sessionDir)
    .filter((fileName) => parseSummarySequence(fileName) !== null)
    .sort((a, b) => parseSummarySequence(a) - parseSummarySequence(b))
    .map((fileName) => {
      const filePath = join(sessionDir, fileName);
      try {
        const text = sanitizeSummaryText(readFileSync(filePath, "utf-8"));
        return text ? { fileName, filePath, text } : null;
      } catch (e) {
        log(`[summary] Failed reading ${filePath}: ${e.message}`);
        return null;
      }
    })
    .filter((entry) => entry && entry.text);
}

function appendSessionSummary(sessionID, summaryText, maxSummaryFiles = DEFAULT_MAX_SUMMARY_FILES) {
  const sanitizedText = sanitizeSummaryText(summaryText);
  if (!sanitizedText) {
    throw new Error("Refusing to persist empty session summary chunk.");
  }

  const sessionDir = ensureSessionSummaryDir(sessionID);
  const existingEntries = listSessionSummaryEntries(sessionID);
  const highestSequence = existingEntries.reduce((maxValue, entry) => {
    const seq = parseSummarySequence(entry.fileName);
    return seq !== null ? Math.max(maxValue, seq) : maxValue;
  }, 0);
  const nextSequence = highestSequence + 1;
  const fileName = `${String(nextSequence).padStart(6, "0")}.md`;
  const filePath = join(sessionDir, fileName);

  writeFileSync(filePath, `${sanitizedText}\n`, "utf-8");

  const retentionLimit = Number.isFinite(Number(maxSummaryFiles))
    ? Math.max(1, Math.floor(Number(maxSummaryFiles)))
    : DEFAULT_MAX_SUMMARY_FILES;
  const updatedEntries = listSessionSummaryEntries(sessionID);
  const overflowEntries = updatedEntries.slice(0, Math.max(0, updatedEntries.length - retentionLimit));
  for (const entry of overflowEntries) {
    try {
      unlinkSync(entry.filePath);
    } catch (e) {
      log(`[summary] Failed deleting old summary chunk ${entry.filePath}: ${e.message}`);
    }
  }

  log(`[summary] Appended summary chunk ${fileName} for ${sessionID}; retentionLimit=${retentionLimit}.`);
  return listSessionSummaryEntries(sessionID);
}

function buildHistoricalSummaryContext(summaryEntries) {
  if (!Array.isArray(summaryEntries) || summaryEntries.length === 0) {
    return "EXISTING HISTORICAL SUMMARIES:\n(none)";
  }

  const body = summaryEntries
    .map((entry) => `### ${entry.fileName}\n${sanitizeSummaryText(entry.text)}`)
    .join("\n\n");
  return `EXISTING HISTORICAL SUMMARIES:\n${body}`;
}

function cleanupOldSummaryDirectories(maxAgeDays = 30) {
  try {
    if (!existsSync(SUMMARY_DIR)) return;
    const now = Date.now();
    const cutoffMs = maxAgeDays * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const name of readdirSync(SUMMARY_DIR)) {
      const dirPath = join(SUMMARY_DIR, name);
      let stat;
      try {
        stat = statSync(dirPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      if (now - stat.mtimeMs <= cutoffMs) continue;
      try {
        rmSync(dirPath, { recursive: true, force: true });
        removed++;
      } catch (e) {
        log(`[summary-cleanup] Failed deleting ${dirPath}: ${e.message}`);
      }
    }

    if (removed > 0) {
      log(`[summary-cleanup] Removed ${removed} summary director${removed === 1 ? "y" : "ies"} older than ${maxAgeDays} days.`);
    }
  } catch (e) {
    log(`[summary-cleanup] Failed: ${e.message}`);
  }
}

function migrateLegacySummaryIfNeeded(sessionID, sessionState, maxSummaryFiles) {
  const legacySummary = sanitizeSummaryText(sessionState?.summary || "");
  if (!legacySummary) return { ...sessionState, summary: "" };

  const existingEntries = listSessionSummaryEntries(sessionID);
  if (existingEntries.length === 0) {
    appendSessionSummary(sessionID, legacySummary, maxSummaryFiles);
    log(`[summary] Migrated legacy rolling summary into summary chunks for ${sessionID}.`);
  }

  const nextState = {
    ...sessionState,
    summary: "",
  };
  saveSessionState(
    sessionID,
    nextState.summary,
    nextState.summarizedIDs,
    nextState.summaryFailureCount,
    nextState.contextLedger,
  );
  return nextState;
}

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
 * WHY:     To retrieve compacted message IDs, failure counters, and any legacy rolling summary awaiting migration.
 * HOW:     Reads the JSON state file from STATE_DIR. Returns empty state if file doesn't exist or is invalid.
 * PARAMS:  sessionID: string — The active conversation session ID.
 * RETURNS: object — The loaded state containing { summary: string, summarizedIDs: Array<string>, summaryFailureCount: number, contextLedger: Array<object> }.
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
          summarizedIDs: Array.isArray(data.summarizedIDs) ? data.summarizedIDs : [],
          summaryFailureCount: Number.isFinite(Number(data.summaryFailureCount))
            ? Math.max(0, Math.floor(Number(data.summaryFailureCount)))
            : 0,
          contextLedger: Array.isArray(data.contextLedger)
            ? data.contextLedger
                .map((entry) => ({
                  messageID: typeof entry?.messageID === "string" ? entry.messageID : "",
                  contextTokens: Number.isFinite(Number(entry?.contextTokens)) ? Math.max(0, Math.floor(Number(entry.contextTokens))) : 0,
                  deltaTokens: Number.isFinite(Number(entry?.deltaTokens)) ? Math.max(0, Math.floor(Number(entry.deltaTokens))) : 0,
                }))
                .filter((entry) => entry.messageID)
            : [],
        };
      }
    } catch (e) {
      log(`[state] Failed to load session state for ${sessionID}: ${e.message}`);
    }
  }
  return { summary: "", summarizedIDs: [], summaryFailureCount: 0, contextLedger: [] };
}

/**
 * WHAT:    Saves the persistent summary state for a given session.
 * WHY:     To preserve compacted message IDs and failure state across chat turn reloads.
 * HOW:     Writes the JSON state to STATE_DIR.
 * PARAMS:  sessionID: string — The active conversation session ID.
 *          summary: string — Legacy rolling summary slot retained for migration compatibility.
 *          summarizedIDs: Array<string> — The full list of compacted message IDs.
 *          summaryFailureCount: number — Count of consecutive summarization failures for adaptive backoff.
 *          contextLedger: Array<object> — Rolling assistant context history for prompt-token deltas.
 * RETURNS: void
 */
function saveSessionState(sessionID, summary, summarizedIDs, summaryFailureCount = 0, contextLedger = []) {
  ensureStateDir();
  const filePath = join(STATE_DIR, `${sessionID}.json`);
  try {
    writeFileSync(
      filePath,
      JSON.stringify(
        {
          summary,
          summarizedIDs,
          summaryFailureCount: Number.isFinite(Number(summaryFailureCount))
            ? Math.max(0, Math.floor(Number(summaryFailureCount)))
            : 0,
          contextLedger: Array.isArray(contextLedger)
            ? contextLedger
                .map((entry) => ({
                  messageID: typeof entry?.messageID === "string" ? entry.messageID : "",
                  contextTokens: Number.isFinite(Number(entry?.contextTokens)) ? Math.max(0, Math.floor(Number(entry.contextTokens))) : 0,
                  deltaTokens: Number.isFinite(Number(entry?.deltaTokens)) ? Math.max(0, Math.floor(Number(entry.deltaTokens))) : 0,
                }))
                .filter((entry) => entry.messageID)
            : [],
        },
        null,
        2,
      ),
      "utf-8",
    );
    log(
      `[state] Saved session state for ${sessionID} with ${summarizedIDs.length} messages, ledger=${Array.isArray(contextLedger) ? contextLedger.length : 0}, summaryFailureCount=${summaryFailureCount}.`,
    );
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
  const maxTokens = options.maxContextTokens ?? options.maxContextLimit ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const minTokens = options.minContextTokens ?? options.minContextLimit ?? DEFAULT_MIN_CONTEXT_TOKENS;
  const summaryMaxTokens = options.summaryMaxTokens ?? 1000;
  const configuredSummaryModel = options.model;
  const configuredTokenCoefficient = options.tokenCoefficient;
  const logLevelInput = normalizeLogLevel(options.logLevel);
  const failureBackoffStepTokens = options.failureBackoffStepTokens ?? DEFAULT_FAILURE_BACKOFF_STEP_TOKENS;
  const failureBackoffMaxOffsetTokens = options.failureBackoffMaxOffsetTokens ?? DEFAULT_FAILURE_BACKOFF_MAX_OFFSET_TOKENS;
  const debugTokenCalc = options.debugTokenCalc ?? false;
  const maxSummaryFiles = options.maxSummaryFiles ?? DEFAULT_MAX_SUMMARY_FILES;
  const stripReasoningOptions = normalizeStripReasoningOptions(options);

  logLevel = logLevelInput;
  tokenCalcDebugEnabled = logLevel === "debug" && Boolean(debugTokenCalc);
  tokenCoefficient = Number.isFinite(Number(configuredTokenCoefficient)) && Number(configuredTokenCoefficient) > 0
    ? Number(configuredTokenCoefficient)
    : DEFAULT_TOKEN_COEFFICIENT;

  if (logLevel === "debug") {
    log("MODULE LOADED");
  }

  cleanupOldStateFiles(30);
  cleanupOldSummaryDirectories(30);

  log(`===== PLUGIN EXPORT DEFAULT CALLED ===== providerContextLimits maxContextTokens=${maxTokens}, minContextTokens=${minTokens}`);

  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      log(`[hook] transform hook called, messages count: ${output?.messages?.length || 0}`);

      const messages = output.messages;
      if (!messages || messages.length === 0) {
        log("no messages");
        return;
      }

      const sessionID = messages.find((m) => m.info?.sessionID)?.info?.sessionID || "unknown";
      let sessionState = loadSessionState(sessionID);
      sessionState = migrateLegacySummaryIfNeeded(sessionID, sessionState, maxSummaryFiles);
      let summaryEntries = listSessionSummaryEntries(sessionID);
      log(`[hook] Loaded state for session ${sessionID}. Summarized count: ${sessionState.summarizedIDs.length}, summaryFiles=${summaryEntries.length}, summaryFailureCount=${sessionState.summaryFailureCount}`);

      const sanitizedMaxTokens = Number.isFinite(Number(maxTokens))
        ? Math.max(1, Math.floor(Number(maxTokens)))
        : DEFAULT_MAX_CONTEXT_TOKENS;
      const sanitizedMinTokens = Number.isFinite(Number(minTokens))
        ? Math.max(0, Math.floor(Number(minTokens)))
        : DEFAULT_MIN_CONTEXT_TOKENS;
      const sanitizedBackoffStep = Number.isFinite(Number(failureBackoffStepTokens))
        ? Math.max(0, Math.floor(Number(failureBackoffStepTokens)))
        : DEFAULT_FAILURE_BACKOFF_STEP_TOKENS;
      const sanitizedBackoffMaxOffset = Number.isFinite(Number(failureBackoffMaxOffsetTokens))
        ? Math.max(0, Math.floor(Number(failureBackoffMaxOffsetTokens)))
        : DEFAULT_FAILURE_BACKOFF_MAX_OFFSET_TOKENS;
      const failureCount = Number.isFinite(Number(sessionState.summaryFailureCount))
        ? Math.max(0, Math.floor(Number(sessionState.summaryFailureCount)))
        : 0;
      const currentBackoffOffset = Math.min(failureCount * sanitizedBackoffStep, sanitizedBackoffMaxOffset);
      const effectiveMaxTokens = sanitizedMaxTokens + currentBackoffOffset;
      const hardMaxTokens = sanitizedMaxTokens + sanitizedBackoffMaxOffset;
      const hardMinTokens = sanitizedMinTokens + sanitizedBackoffMaxOffset;

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

      // 2. Prepend the persisted summary bundle if one exists.
      if (summaryEntries.length > 0) {
        const summaryMessage = buildSummaryMessage(sessionID, summaryEntries);
        if (summaryMessage) {
          messages.push(summaryMessage);
        }
      }

      // Add the remaining active messages.
      messages.push(...filteredMessages);

      if (tokenCalcDebugEnabled) {
        logTokenCalc("================================================================================");
        logTokenCalc(`[transform:start] sessionID=${sessionID} messages=${messages.length}`);
      }

      const usageRecords = buildAssistantUsageRecords(messages);
      const latestUsage = usageRecords.length > 0 ? usageRecords[usageRecords.length - 1] : null;
      const latestContextTokens = latestUsage?.contextTokens || 0;

      // Provider context is the only trigger for compaction. Do not replace this with any local estimator.
      log(`[hook] providerContextTokens=${latestContextTokens}, maxContextTokens=${sanitizedMaxTokens}, effectiveMaxTokens=${effectiveMaxTokens}, hardMaxTokens=${hardMaxTokens}, minContextTokens=${sanitizedMinTokens}, hardMinTokens=${hardMinTokens}`);
      logTokenCalc(`[transform:reconstructed] providerContextTokens=${latestContextTokens} maxContextTokens=${sanitizedMaxTokens} effectiveMaxTokens=${effectiveMaxTokens} hardMaxTokens=${hardMaxTokens} minContextTokens=${sanitizedMinTokens} hardMinTokens=${hardMinTokens}`);

      // If the provider says the session is still under the threshold, do not summarize.
      if (latestContextTokens < effectiveMaxTokens) {
        log("[hook] Below effectiveMaxTokens, returning reconstructed context.");
        return finalizeOutputWithReasoningStrip(output, stripReasoningOptions);
      }

      // Re-map tool call indexes on the active messages.
      const callIDResultIndex = new Map();
      for (let i = 0; i < messages.length; i++) {
        for (const p of messages[i].parts) {
          if (p.type !== "tool" || !p.callID) continue;
          if (p.state?.status === "completed" || p.state?.status === "error") {
            callIDResultIndex.set(p.callID, i);
          }
        }
      }

      const startIndex = (messages[0]?.info?.synthetic) ? 1 : 0;
      const isHardLimitExceeded = latestContextTokens > hardMaxTokens;
      const targetRetainedTokens = isHardLimitExceeded ? hardMinTokens : sanitizedMinTokens;
      const activeMessages = messages.slice(startIndex);
      const reasoningKeepSet = collectReasoningKeepSet(activeMessages, stripReasoningOptions.enabled ? stripReasoningOptions.preserveLast : Number.MAX_SAFE_INTEGER);
      const indexedReasoningKeepSet = new Set(
        Array.from(reasoningKeepSet, (key) => {
          const [messageIndexRaw, partIndexRaw] = key.split(":");
          return getReasoningPartKey(startIndex + Number(messageIndexRaw), Number(partIndexRaw));
        }),
      );
      // The cut point is still chosen by the software estimator: walk from newest to oldest until the retained tail reaches the minimum budget.
      // Provider context decides whether to compact; the estimator decides where to cut.
      let cutIndex = findCutIndexByEstimatedTokens(
        messages,
        startIndex,
        targetRetainedTokens,
        stripReasoningOptions,
        indexedReasoningKeepSet,
      );

      if (cutIndex <= startIndex) {
        log(`[hook] cutIndex (${cutIndex}) <= startIndex (${startIndex}), nothing to prune.`);
        return finalizeOutputWithReasoningStrip(output, stripReasoningOptions);
      }

      const pruned = messages.slice(startIndex, cutIndex);
      let kept = messages.slice(cutIndex);

      const lastPrunedToolUse = pruned
        .flatMap((m) => m.parts || [])
        .filter((p) => p.type === "tool" && (p.state?.status === "pending" || p.state?.status === "running") && p.callID)
        .at(-1)?.callID || null;
      if (lastPrunedToolUse) {
        const resultIdx = callIDResultIndex.get(lastPrunedToolUse);
        if (resultIdx !== undefined && resultIdx >= cutIndex) {
          log(`extending cutIndex ${cutIndex} -> ${resultIdx + 1} to include tool result for ${lastPrunedToolUse}`);
          cutIndex = resultIdx + 1;
          kept = messages.slice(cutIndex);
        }
      }

      const beforeTokens = latestContextTokens;
      const activeBeforeCount = messages.length - startIndex;
      
      let latestSummaryEntryText = summaryEntries.length > 0 ? summaryEntries[summaryEntries.length - 1].text : "";
      let summaryError = null;
      let nextFailureCount = failureCount;
      if (pruned.length > 0) {
        const prunedReasoningKeepSet = collectReasoningKeepSet(pruned, stripReasoningOptions.enabled ? stripReasoningOptions.preserveLast : Number.MAX_SAFE_INTEGER);
        const newTranscriptLines = [];
        for (let messageIndex = 0; messageIndex < pruned.length; messageIndex++) {
          const m = pruned[messageIndex];
          const role = m.info?.role || "unknown";
          const text = m.parts
            .flatMap((p, partIndex) => {
              if (p.type === "text") {
                const value = stripSystemReminderBlocks(p.text);
                return value ? [value] : [];
              }
              if (p.type === "reasoning") {
                if (!shouldKeepReasoningPart(p, messageIndex, partIndex, stripReasoningOptions, prunedReasoningKeepSet)) {
                  return [];
                }
                const value = stripSystemReminderBlocks(p.text);
                return value ? [`[REASONING]\n${value}\n[/REASONING]`] : [];
              }
              return [];
            })
            .join("\n")
            .trim();
          if (!text) continue;
          newTranscriptLines.push(`${role.toUpperCase()}: ${text}`);
        }
        const newTranscript = newTranscriptLines.join("\n\n");

        const buildModel = resolveSummaryModel(configuredSummaryModel, messages);
        log(`Pruned count: ${pruned.length}. Running summarization with model ${buildModel.providerID}/${buildModel.modelID}...`);

        const combinedTranscript = `${buildHistoricalSummaryContext(summaryEntries)}

NEW PRUNED MESSAGES:
${newTranscript}`;

        try {
          latestSummaryEntryText = await summarizePrunedMessages(_ctx.client, combinedTranscript, buildModel, summaryMaxTokens, logLevel === "debug");
          if (!latestSummaryEntryText || !latestSummaryEntryText.trim()) {
            throw new Error("Empty summary text returned.");
          }
          nextFailureCount = 0;
          log(`
======================================================================
[COMPACTARE CONTEXT] TRANSCRIERE MESAJE ELIMINATE:
======================================================================
${combinedTranscript}
======================================================================
[COMPACTARE CONTEXT] SUMAR SEGMENT REZULTAT:
======================================================================
${latestSummaryEntryText}
======================================================================
          `);

          const newlySummarizedIDs = pruned
            .map((m) => m.info?.id)
            .filter((id) => id);

          const updatedSummarizedIDs = [...sessionState.summarizedIDs, ...newlySummarizedIDs];
          const nextContextLedger = buildContextLedger([...messages.slice(0, startIndex), ...kept]);
          summaryEntries = appendSessionSummary(sessionID, latestSummaryEntryText, maxSummaryFiles);
          saveSessionState(sessionID, "", updatedSummarizedIDs, nextFailureCount, nextContextLedger);

        } catch (err) {
          summaryError = err;
          nextFailureCount = failureCount + 1;

          if (!isHardLimitExceeded) {
            log(`Summarization execution failed: ${err.message}. Hard limit not exceeded (latestContextTokens=${latestContextTokens}, hardMaxTokens=${hardMaxTokens}); skipping prune and increasing summaryFailureCount to ${nextFailureCount}.`);
            saveSessionState(sessionID, "", sessionState.summarizedIDs, nextFailureCount, buildContextLedger(messages));
            return finalizeOutputWithReasoningStrip(output, stripReasoningOptions);
          }

          log(`Summarization execution failed: ${err.message}. Hard limit exceeded (latestContextTokens=${latestContextTokens}, hardMaxTokens=${hardMaxTokens}); forcing prune to hardMinTokens=${hardMinTokens} and increasing summaryFailureCount to ${nextFailureCount}.`);

          const newlySummarizedIDs = pruned
            .map((m) => m.info?.id)
            .filter((id) => id);
          const updatedSummarizedIDs = [...sessionState.summarizedIDs, ...newlySummarizedIDs];
          const nextContextLedger = buildContextLedger([...messages.slice(0, startIndex), ...kept]);
          saveSessionState(sessionID, "", updatedSummarizedIDs, nextFailureCount, nextContextLedger);
        }
      }

      // Re-reconstruct messages array with updated summary at index 0 and kept messages.
      messages.length = 0;

      if (summaryEntries.length > 0) {
        const summaryMessage = buildSummaryMessage(sessionID, summaryEntries);
        if (summaryMessage) {
          messages.push(summaryMessage);
        }
      }

      messages.push(...kept);

      applyReasoningStripInPlace(messages, stripReasoningOptions);

      const afterTotalTokens = messages.reduce((s, m, messageIndex) => s + sumTokens(m, messageIndex), 0);
      const afterLatestUsage = buildAssistantUsageRecords(messages).at(-1) || null;
      const afterLatestContextTokens = afterLatestUsage?.contextTokens || 0;
      const removedIndices = [];
      for (let i = startIndex; i < cutIndex; i++) removedIndices.push(i);

      // This log reuses the last retained assistant context metadata; it is not a fresh provider measurement.
      log(`[hook] providerContextTokens=${afterLatestContextTokens}, maxContextTokens=${sanitizedMaxTokens}, effectiveMaxTokens=${effectiveMaxTokens}, hardMaxTokens=${hardMaxTokens}, minContextTokens=${sanitizedMinTokens}, hardMinTokens=${hardMinTokens}`);
      logTokenCalc(`[transform:final] providerContextTokens=${afterLatestContextTokens} maxContextTokens=${sanitizedMaxTokens} effectiveMaxTokens=${effectiveMaxTokens} hardMaxTokens=${hardMaxTokens} minContextTokens=${sanitizedMinTokens} hardMinTokens=${hardMinTokens}`);

      writeDebugLog(logLevel === "debug", sessionID, activeBeforeCount, beforeTokens, messages.length, afterTotalTokens, removedIndices, messages);

      if (summaryError) {
        reportError(`[auto-compress] Summarization failed; context was still pruned: ${summaryError.message}`);
      }

      return finalizeOutputWithReasoningStrip(output, stripReasoningOptions);
    },
  };
};
