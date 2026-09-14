/** Editor Assistant. Read tools run in Rust. History is user/assistant text. */

export const ASSISTANT_CHAT_MAX_TURNS = 40;

export type AssistantChatRole = "user" | "assistant";

export type AssistantChatTurn = {
  role: AssistantChatRole;
  content: string;
  at: string;
};

export function assistantSystemPrompt(projectTitle: string): string {
  const title = projectTitle.trim() || "Untitled";
  return [
    `You are an assistant in Parascene Desktop for the project titled "${title}".`,
    "You have read tools for this project. Call them when you need facts about Assets or the timeline.",
    "You cannot generate, edit, or delete.",
    "Help rewrite generate prompts when asked.",
    "Be concise. Do not invent Assets or clips you have not looked up.",
  ].join(" ");
}

export function normalizeAssistantChat(value: unknown): AssistantChatTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: AssistantChatTurn[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const role = record.role;
    const content =
      typeof record.content === "string" ? record.content.trim() : "";
    if ((role !== "user" && role !== "assistant") || !content) continue;
    const at =
      typeof record.at === "string" && record.at.trim()
        ? record.at.trim()
        : new Date().toISOString();
    turns.push({ role, content, at });
  }
  return turns.slice(-ASSISTANT_CHAT_MAX_TURNS);
}

export function assistantChatEqual(
  left: readonly AssistantChatTurn[],
  right: readonly AssistantChatTurn[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (turn, index) =>
      turn.role === right[index]?.role &&
      turn.content === right[index]?.content &&
      turn.at === right[index]?.at,
  );
}

export function assistantChatInvokePayload(opts: {
  projectId: string;
  projectTitle: string;
  messages: readonly AssistantChatTurn[];
  userMessage: string;
}): {
  projectId: string;
  projectTitle: string;
  system: string;
  messages: Array<{ role: AssistantChatRole; content: string }>;
} {
  const userMessage = opts.userMessage.trim();
  const history = normalizeAssistantChat(opts.messages).map((turn) => ({
    role: turn.role,
    content: turn.content,
  }));
  return {
    projectId: opts.projectId.trim(),
    projectTitle: opts.projectTitle.trim() || "Untitled",
    system: assistantSystemPrompt(opts.projectTitle),
    messages: [...history, { role: "user", content: userMessage }],
  };
}

export function replyFromAssistantResult(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const record = data as Record<string, unknown>;
  const content =
    typeof record.content === "string"
      ? record.content
      : typeof record.reply === "string"
        ? record.reply
        : "";
  return content.trim();
}
