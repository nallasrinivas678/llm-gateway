// What one eval question and one eval document look like.
export type QuestionType = "lookup" | "multi-page" | "table-or-number" | "unanswerable" | "injection";

export interface EvalQuestion {
  id: string;
  question: string;
  type: QuestionType;
  // Pages that hold the answer. Empty for unanswerable questions.
  goldPages: number[];
  // Facts the answer must contain. An entry may list alternatives separated by "|".
  mustInclude: string[];
  // Text the answer must not contain (for example what an injected instruction asked for).
  mustNotInclude?: string[];
  // The answer is worked out from the document, so the facts are not written in it as they are.
  derived?: boolean;
}

export interface EvalDataset {
  name: string;
  // One entry per page, one string per line of text.
  pages: string[][];
  questions: EvalQuestion[];
}
