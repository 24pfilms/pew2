import { expect, test } from "bun:test";
import {
  buildAskResult,
  EMPTY_DRAFT,
  pickOption,
  questionHint,
  questionOptions,
  readAskEvent,
  readAskList,
  typeOther,
  type AskQuestion,
} from "./askUser";

const choice: AskQuestion = {
  id: "db",
  question: "Which database?",
  kind: "choice",
  options: [{ label: "Postgres", value: "pg", recommended: true }, { label: "SQLite" }],
};
const multi: AskQuestion = { id: "checks", question: "Run?", kind: "multi", options: [{ label: "Tests" }, { label: "Lint" }] };
const text: AskQuestion = { id: "name", question: "Name?", kind: "text" };
const confirm: AskQuestion = { id: "go", question: "Go?", kind: "confirm", allowOther: false };

test("reads a live ask_user payload and rejects junk", () => {
  expect(readAskEvent({ kind: "ask_user", requestId: "r1", questions: [choice] })).toEqual({ requestId: "r1", questions: [choice] });
  expect(readAskEvent({ kind: "user_message", requestId: "r1", questions: [choice] })).toBeUndefined();
  expect(readAskEvent({ kind: "ask_user", requestId: "r1", questions: [] })).toBeUndefined();
  expect(readAskEvent({ kind: "ask_user", requestId: "r1", questions: [{ ...choice, options: "[CIRCULAR]" }] })).toBeUndefined();
});

test("Replay.asks: absent stays absent, [] is none", () => {
  expect(readAskList(undefined)).toBeUndefined();
  expect(readAskList([])).toEqual([]);
  expect(readAskList([{ requestId: "r", questions: [text] }, { nope: 1 }])).toEqual([{ requestId: "r", questions: [text] }]);
});

test("confirm without options is yes/no; recommended is never preselected", () => {
  expect(questionOptions(confirm).map((o) => o.label)).toEqual(["Yes", "No"]);
  expect(buildAskResult([choice], EMPTY_DRAFT)).toBeUndefined();
  expect(questionHint(confirm)).toBe("Pick one");
  expect(questionHint(multi)).toBe("Pick any that apply, or write your own");
});

test("answers are keyed by id, value else label, complete only", () => {
  let draft = pickOption(EMPTY_DRAFT, choice, "pg");
  draft = pickOption(draft, multi, "Tests");
  draft = pickOption(draft, multi, "Lint");
  draft = pickOption(draft, multi, "Tests");
  expect(buildAskResult([choice, multi, text], draft)).toBeUndefined();
  draft = typeOther(draft, text, "  Ken ");
  expect(buildAskResult([choice, multi, text], draft)).toEqual({
    action: "answer",
    answers: { db: "pg", checks: ["Lint"], name: "Ken" },
  });
});

test("free text replaces a single pick and joins a multi", () => {
  let draft = pickOption(EMPTY_DRAFT, choice, "pg");
  draft = typeOther(draft, choice, "MySQL");
  expect(buildAskResult([choice], draft)).toEqual({ action: "answer", answers: { db: "MySQL" } });
  draft = pickOption(draft, choice, "SQLite");
  expect(buildAskResult([choice], draft)).toEqual({ action: "answer", answers: { db: "SQLite" } });
  const m = typeOther(pickOption(EMPTY_DRAFT, multi, "Tests"), multi, "Build");
  expect(buildAskResult([multi], m)).toEqual({ action: "answer", answers: { checks: ["Tests", "Build"] } });
});

test("typed text is ignored when the question opts out", () => {
  const draft = typeOther(EMPTY_DRAFT, confirm, "maybe");
  expect(buildAskResult([confirm], draft)).toBeUndefined();
  expect(buildAskResult([confirm], pickOption(draft, confirm, "yes"))).toEqual({ action: "answer", answers: { go: "yes" } });
});
