import { describe, expect, it } from "vitest";
import { calculate, calculatorTool, CalculationError } from "./calculatorTool.js";

describe("calculate", () => {
  it("follows the usual precedence and parentheses", () => {
    expect(calculate("2 + 3 * 4")).toBe(14);
    expect(calculate("(2 + 3) * 4")).toBe(20);
    expect(calculate("10 - 4 - 3")).toBe(3);
    expect(calculate("100 / 8 / 5")).toBe(2.5);
  });

  it("handles percentages written out, decimals and a modulo", () => {
    expect(calculate("84.50 * 0.15")).toBe(12.675);
    expect(calculate(".5 + 1.")).toBe(1.5);
    expect(calculate("17 % 5")).toBe(2);
  });

  it("raises to a power, right to left, and lets the exponent be negative", () => {
    expect(calculate("2 ^ 3 ^ 2")).toBe(512);
    expect(calculate("2 ^ -1")).toBe(0.5);
    expect(calculate("-2 ^ 2")).toBe(-4);
  });

  it("accepts unary signs and thousands separators", () => {
    expect(calculate("-(3 + 4)")).toBe(-7);
    expect(calculate("+5 - -5")).toBe(10);
    expect(calculate("1,200 * 2")).toBe(2400);
  });

  it("drops floating point noise", () => {
    expect(calculate("0.1 + 0.2")).toBe(0.3);
  });

  it.each([
    ["", "nothing to calculate"],
    ["   ", "nothing to calculate"],
    ["2 +", "incomplete"],
    ["(2 + 3", "not closed"],
    ["2 3", "not valid"],
    ["2 ) 3", "not valid"],
    ["1 / 0", "divide by zero"],
    ["5 % 0", "divide by zero"],
    ["2 ^ 5000", "too large"],
    ["1.2.3 + 1", "not valid"],
    ["alert(1)", 'not "a"'],
    ["2 * x", 'not "x"'],
    ["1 + 1; process.exit()", 'not ";"'],
    ["1".repeat(201), "too long"],
  ])("refuses %j", (input, reason) => {
    expect(() => calculate(input)).toThrow(CalculationError);
    expect(() => calculate(input)).toThrow(reason.replace(/^not "/, 'not "'));
  });
});

describe("calculatorTool", () => {
  const tool = calculatorTool();

  it("answers with the expression and its result", async () => {
    expect(tool.name).toBe("calculate");
    expect(await tool.invoke({ expression: "84.50 * 0.15" })).toBe("84.50 * 0.15 = 12.675");
  });

  it("reports a bad expression as a failure the model can read", async () => {
    expect(await tool.invoke({ expression: "1 / 0" })).toBe("The calculator failed: Cannot divide by zero.");
    expect(await tool.invoke({ expression: "rm -rf" })).toMatch(/^The calculator failed: Only numbers/);
  });
});
