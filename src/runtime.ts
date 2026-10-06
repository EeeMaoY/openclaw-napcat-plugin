import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Global runtime reference for the plugin
let _runtime: any;
let _config: any = {};
// One entry per inbound group message, kept until it expires rather than until the webhook
// handler returns. With queue mode "followup" the handler returns as soon as the message is
// enqueued and the agent run happens later, so tearing the entry down on return removed the
// context before the run that needed it had even started -- and that run's replies then went
// out with neither a quote nor an @.
const activeGroupReplyContexts = new Map<string, Array<{
  senderId: string;
  messageId?: string;
  token: symbol;
  expiresAt: number;
}>>();

// Bounds the map for groups that go quiet: entries are pruned lazily, so a group that never
// sees another message would otherwise keep its entries forever.
const GROUP_CONTEXT_LIMIT = 500;

export function setNapCatRuntime(runtime: any) {
  _runtime = runtime;
}

export function setNapCatConfig(config: any) {
  _config = config;
}

export function getNapCatRuntime() {
  if (!_runtime) {
    throw new Error("NapCat runtime not initialized");
  }
  return _runtime;
}

export function getNapCatConfig() {
  return _config || {};
}

// Opt-in: an absent key means upstream behaviour (the @ mention), so only an explicit
// true turns quoting on. Per-conversation files inherit this default.
export function isNapCatGroupQuoteReplyEnabled(config: any): boolean {
  return config?.groupReplyQuote === true;
}

// Behaviour keys a per-conversation override file may set. Connection-layer keys
// (url, token, mediaProxy*, conversationConfigDir, ...) are deliberately excluded so a
// stray file can never redirect traffic at a different NapCat instance.
const CONVERSATION_OVERRIDABLE_KEYS = new Set([
  "groupReplyQuote",
  "streaming_mode",
  "enable_progress_messages",
  "plainTextMode",
  "groupMentionOnly",
  "enablePrivateTypingStatus",
  "agentId",
]);

const CONVERSATION_CONFIG_CACHE_LIMIT = 500;
const conversationConfigCache = new Map<string, { mtimeMs: number; data: Record<string, any> }>();
const warnedNonOverridableKeys = new Set<string>();

// Mirrors the schema default. Applied here too because an absent key is not guaranteed to
// have been materialised into the runtime config; a missing directory is a no-op anyway.
const DEFAULT_CONVERSATION_CONFIG_DIR = "~/.openclaw/napcat/conversations";

function expandHome(dir: string): string {
  if (dir === "~") return homedir();
  if (dir.startsWith("~/")) return join(homedir(), dir.slice(2));
  return dir;
}

// Absent -> the default directory. Explicitly empty -> disabled.
function resolveConversationConfigDir(config: any): string {
  const raw = config?.conversationConfigDir;
  if (raw === undefined || raw === null) return expandHome(DEFAULT_CONVERSATION_CONFIG_DIR);
  const trimmed = String(raw).trim();
  return trimmed ? expandHome(trimmed) : "";
}

// Reads <dir>/<fileName> as a flat JSON object, cached by mtime so an edited file takes
// effect on the next message without restarting anything. Never throws: an unreadable or
// malformed file degrades to "no override" instead of taking the channel down.
function readConversationConfigLayer(dir: string, fileName: string): Record<string, any> | null {
  const filePath = join(dir, fileName);

  let mtimeMs: number;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    conversationConfigCache.delete(filePath);
    return null;
  }

  const cached = conversationConfigCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.data;

  let data: Record<string, any>;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(`[NapCat] Conversation config ${filePath} must be a JSON object; ignored`);
      return null;
    }
    data = parsed;
  } catch (err: any) {
    console.warn(`[NapCat] Failed to read conversation config ${filePath}:`, err?.message || err);
    return null;
  }

  if (conversationConfigCache.size >= CONVERSATION_CONFIG_CACHE_LIMIT) {
    const oldest = conversationConfigCache.keys().next().value;
    if (oldest !== undefined) conversationConfigCache.delete(oldest);
  }
  conversationConfigCache.set(filePath, { mtimeMs, data });
  return data;
}

// Layers <dir>/default.json, then <dir>/<group|private>-<id>.json, on top of the channel
// config. The result is a superset of baseConfig, so callers can keep reading
// connection-layer keys (url, token, ...) from it unchanged.
export function resolveNapCatConversationConfig(baseConfig: any, conversationId: string): any {
  const dir = resolveConversationConfigDir(baseConfig);
  if (!dir) return baseConfig;

  const layers: Array<Record<string, any>> = [];
  const defaultLayer = readConversationConfigLayer(dir, "default.json");
  if (defaultLayer) layers.push(defaultLayer);

  // Validate before building a filename: group ids and sender ids arrive from NapCat over
  // the wire, so an unchecked value could escape the directory via "..".
  const match = /^(group|private):(\d+)$/.exec(String(conversationId || "").trim());
  if (match) {
    const layer = readConversationConfigLayer(dir, `${match[1]}-${match[2]}.json`);
    if (layer) layers.push(layer);
  }

  if (layers.length === 0) return baseConfig;

  const merged: any = { ...baseConfig };
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (!CONVERSATION_OVERRIDABLE_KEYS.has(key)) {
        if (!warnedNonOverridableKeys.has(key)) {
          warnedNonOverridableKeys.add(key);
          console.warn(`[NapCat] Conversation config key "${key}" is not overridable; ignored`);
        }
        continue;
      }
      merged[key] = value;
    }
  }
  return merged;
}

export function beginNapCatGroupReplyContext(
  groupId: string,
  senderId: string,
  messageId?: string
): symbol | null {
  const normalizedGroupId = String(groupId || "").trim();
  const normalizedSenderId = String(senderId || "").trim();
  if (!/^\d+$/.test(normalizedGroupId) || !/^\d+$/.test(normalizedSenderId)) {
    return null;
  }

  const normalizedMessageId = String(messageId ?? "").trim();
  const token = Symbol(`napcat-group-reply:${normalizedGroupId}`);
  const now = Date.now();

  let entries = activeGroupReplyContexts.get(normalizedGroupId) || [];
  if (entries.length > 0) {
    entries = entries.filter((entry) => entry.expiresAt > now);
    if (entries.length === 0) activeGroupReplyContexts.delete(normalizedGroupId);
  }

  if (!activeGroupReplyContexts.has(normalizedGroupId) && activeGroupReplyContexts.size >= GROUP_CONTEXT_LIMIT) {
    const oldest = activeGroupReplyContexts.keys().next().value;
    if (oldest !== undefined) activeGroupReplyContexts.delete(oldest);
  }

  entries.push({
    senderId: normalizedSenderId,
    messageId: /^\d+$/.test(normalizedMessageId) ? normalizedMessageId : undefined,
    token,
    expiresAt: now + 10 * 60 * 1000,
  });
  activeGroupReplyContexts.set(normalizedGroupId, entries);
  return token;
}

// Most recent still-live turn for the group. Two overlapping turns are genuinely ambiguous
// from the outbound side (the message tool knows the group, not which turn called it), so this
// keeps the previous "latest wins" behaviour -- it must merely never return nothing while some
// turn is still live.
function mostRecentGroupReplyContext(groupId: string) {
  const normalizedGroupId = String(groupId || "").trim();
  const entries = activeGroupReplyContexts.get(normalizedGroupId);
  if (!entries || entries.length === 0) return undefined;

  const now = Date.now();
  const live = entries.filter((entry) => entry.expiresAt > now);
  if (live.length !== entries.length) {
    if (live.length > 0) activeGroupReplyContexts.set(normalizedGroupId, live);
    else activeGroupReplyContexts.delete(normalizedGroupId);
  }
  return live[live.length - 1];
}

export function getNapCatGroupReplyMentionUser(groupId: string): string | undefined {
  return mostRecentGroupReplyContext(groupId)?.senderId;
}

// Shares the mention user's 10 minute window rather than a shorter one of its own: agent
// turns routinely run for minutes, and expiring the quote earlier would make replies @
// instead of quote depending on how long the turn happened to take.
export function getNapCatGroupReplyMessageId(groupId: string): string | undefined {
  return mostRecentGroupReplyContext(groupId)?.messageId;
}
