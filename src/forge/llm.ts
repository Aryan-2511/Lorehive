/**
 * Forge LLMs (Atlassian-hosted Claude). Data stays on Atlassian.
 *
 * The writer only receives structured `LessonDraftInput` - diff lines, topic,
 * counts - never ticket or comment text. If the model call fails or returns
 * something unusable, we fall back to the deterministic template so the
 * pipeline never stalls on an LLM.
 */
import { chat, list } from '@forge/llm';
import { LessonDraftInput, LessonText, LessonWriter, templateWriter } from '../core/distill';
import { Reranker } from '../core/retrieve';
import { Lesson } from '../core/types';

let cachedModel: string | undefined;

/** Pick a model: LOREHIVE_MODEL if set, else the first active Haiku, else Sonnet. */
export async function pickModel(prefer: 'haiku' | 'sonnet' = 'haiku'): Promise<string> {
  if (process.env.LOREHIVE_MODEL) return process.env.LOREHIVE_MODEL;
  if (cachedModel) return cachedModel;
  const { models } = await list();
  const active = models.filter((m) => m.status === 'active').map((m) => m.model);
  cachedModel = active.find((m) => m.includes(prefer)) ?? active.find((m) => m.includes('sonnet')) ?? active[0];
  if (!cachedModel) throw new Error('No Forge LLM model available');
  return cachedModel;
}

function extractJson(s: string): unknown {
  const m = /\{[\s\S]*\}/.exec(s);
  return m ? JSON.parse(m[0]) : undefined;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p as { text?: string }).text ?? '').join('');
  return '';
}

export const llmWriter: LessonWriter = {
  async write(input: LessonDraftInput): Promise<LessonText> {
    const fallback = await templateWriter.write(input);
    try {
      const model = await pickModel('haiku');
      const res = await chat({
        model,
        max_completion_tokens: 300,
        messages: [
          {
            role: 'system',
            content:
              'You write one short, imperative coding rule for AI coding agents from structured evidence of human corrections. ' +
              'Use only the facts given. Never add requirements that are not shown in the diff lines. ' +
              'Reply with JSON only: {"title": string (<= 60 chars), "rule": string (<= 200 chars), "rationale": string (<= 140 chars)}.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              topic: input.topic,
              files: input.files,
              linesPeopleRemoved: input.removed,
              linesPeopleAdded: input.added,
              preferredReplacement: input.preferred,
              correctionKinds: input.kinds,
              agentVendorsCorrected: input.vendors,
              placesSeen: input.scopes.length,
              deterministicDraft: fallback,
            }),
          },
        ],
      });
      const parsed = extractJson(textOf(res.choices[0]?.message.content)) as Partial<LessonText> | undefined;
      if (!parsed?.title || !parsed.rule) return fallback;
      return {
        title: String(parsed.title).slice(0, 80),
        rule: String(parsed.rule).slice(0, 280),
        rationale: String(parsed.rationale ?? fallback.rationale).slice(0, 200),
      };
    } catch (err) {
      console.warn('Forge LLM writer failed, using template', err);
      return fallback;
    }
  },
};

export const llmReranker: Reranker = {
  async rerank(task: string, lessons: Lesson[]): Promise<Lesson[]> {
    try {
      const model = await pickModel('haiku');
      const res = await chat({
        model,
        max_completion_tokens: 100,
        messages: [
          { role: 'system', content: 'Rank lessons by relevance to the task. Reply with JSON only: {"order": [lesson ids, most relevant first]}.' },
          { role: 'user', content: JSON.stringify({ task, lessons: lessons.map((l) => ({ id: l.id, title: l.title, rule: l.rule })) }) },
        ],
      });
      const parsed = extractJson(textOf(res.choices[0]?.message.content)) as { order?: string[] } | undefined;
      if (!parsed?.order) return lessons;
      const rank = new Map(parsed.order.map((id, i) => [id, i]));
      return [...lessons].sort((a, b) => (rank.get(a.id) ?? 99) - (rank.get(b.id) ?? 99));
    } catch (err) {
      console.warn('Forge LLM rerank failed, keeping keyword order', err);
      return lessons;
    }
  },
};
