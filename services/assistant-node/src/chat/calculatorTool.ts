// Arithmetic for the chat. Models are unreliable at multi-digit sums and percentages, and this is a
// small hand-written parser (numbers, + - * / % ^ and parentheses), so nothing is ever evaluated as code.
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

const MAX_LENGTH = 200;

export class CalculationError extends Error {}

type Token = { kind: "num"; value: number } | { kind: "op"; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  // Thousands separators are allowed ("1,200 * 2"); anything else outside the grammar is refused.
  const text = input.replace(/(\d),(?=\d{3}\b)/g, "$1");
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9.]/.test(ch)) {
      const match = /^(?:\d+\.?\d*|\.\d+)/.exec(text.slice(i));
      if (!match) throw new CalculationError("That is not a valid number.");
      tokens.push({ kind: "num", value: Number(match[0]) });
      i += match[0].length;
    } else if ("+-*/%^()".includes(ch)) {
      tokens.push({ kind: "op", value: ch });
      i++;
    } else {
      throw new CalculationError(`Only numbers and + - * / % ^ ( ) are allowed, not "${ch}".`);
    }
  }
  return tokens;
}

// expr  := term (("+" | "-") term)*
// term  := unary (("*" | "/" | "%") unary)*
// unary := ("+" | "-") unary | power
// power := primary ("^" unary)?        (right to left, so 2^3^2 is 2^9)
// primary := number | "(" expr ")"
export function calculate(input: string): number {
  if (input.length > MAX_LENGTH) throw new CalculationError("That expression is too long.");
  const tokens = tokenize(input);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (value: string) => {
    const token = peek();
    return token?.kind === "op" && token.value === value;
  };

  function primary(): number {
    const token = tokens[pos++];
    if (token?.kind === "num") return token.value;
    if (token?.kind === "op" && token.value === "(") {
      const value = expr();
      if (!isOp(")")) throw new CalculationError("A parenthesis is not closed.");
      pos++;
      return value;
    }
    throw new CalculationError("The expression is incomplete.");
  }
  function power(): number {
    const base = primary();
    if (!isOp("^")) return base;
    pos++;
    return base ** unary();
  }
  function unary(): number {
    if (isOp("-")) {
      pos++;
      return -unary();
    }
    if (isOp("+")) {
      pos++;
      return unary();
    }
    return power();
  }
  function term(): number {
    let value = unary();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const op = (tokens[pos++] as { value: string }).value;
      const right = unary();
      if ((op === "/" || op === "%") && right === 0) throw new CalculationError("Cannot divide by zero.");
      value = op === "*" ? value * right : op === "/" ? value / right : value % right;
    }
    return value;
  }
  function expr(): number {
    let value = term();
    while (isOp("+") || isOp("-")) {
      const op = (tokens[pos++] as { value: string }).value;
      const right = term();
      value = op === "+" ? value + right : value - right;
    }
    return value;
  }

  if (tokens.length === 0) throw new CalculationError("There is nothing to calculate.");
  const result = expr();
  if (pos < tokens.length) throw new CalculationError("The expression is not valid.");
  if (!Number.isFinite(result)) throw new CalculationError("The result is too large to show.");
  // Drops floating point noise (0.1 + 0.2) without hiding real digits.
  return Number(result.toPrecision(12));
}

export function calculatorTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "calculate",
    description: "Calculate an arithmetic expression exactly: numbers with + - * / % ^ and parentheses, for example 84.50 * 0.15. For percentages write them out (15% of 84.50 is 84.50 * 0.15).",
    schema: z.object({ expression: z.string().min(1).max(MAX_LENGTH).describe("The expression, like (12 + 8) * 3") }),
    func: async ({ expression }) => {
      try {
        return `${expression} = ${calculate(expression)}`;
      } catch (error) {
        return `The calculator failed: ${error instanceof CalculationError ? error.message : "it could not calculate that."}`;
      }
    },
  });
}
