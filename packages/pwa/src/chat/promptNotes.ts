/*
 * Notes the daemon adds to the prompt the agent receives: the phone-send hint and the loop instruction
 * (acp-mapping.ts, session-manager.ts). The daemon's `user_message` does not store them, but the agent's own history
 * (session/load replay) can, so the chat removes them when it shows a user message. Both notes come last in the
 * prompt, so everything from the first note to the end is removed.
 */
const NOTE_STARTS = [
  '[Nanachi Remote] Esta execução faz parte de um loop',
  '[Nanachi Remote] O usuário está no celular.',
] as const;

/** The user's text without the trailing notes. Text without a note comes back unchanged. */
export function stripPromptNotes(text: string): string {
  let cut = -1;
  for (const start of NOTE_STARTS) {
    const index = text.indexOf(start);
    if (index !== -1 && (cut === -1 || index < cut)) cut = index;
  }
  return cut === -1 ? text : text.slice(0, cut).trimEnd();
}
