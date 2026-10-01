import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { appConfig } from "../config";
import { buildContext, estimateTokens, type ContextStrategy } from "../context/builder";
import { countSharedPrefixMessages } from "../context/cache-observability";
import { toDeepseekMessages, toDeepseekModelUsage } from "../model/deepseek";
import type { Message, ModelUsage } from "../model/types";

const apiKey = appConfig.model.deepseekApiKey;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required for the cache A/B test");

const client = new OpenAI({ apiKey, baseURL: "https://api.deepseek.com" });
const waitMs = readPositiveNumber("DEEPSEEK_CACHE_AB_WAIT_MS", 6_000);
const completedTurns = 32;

const cacheFirst = await runScenario("cache-first");
const legacyWindow = await runScenario("legacy-window");
const cacheFirstRatio = cacheFirst.test.cacheHitRatio ?? 0;
const legacyRatio = legacyWindow.test.cacheHitRatio ?? 0;

console.log(
  JSON.stringify(
    {
      model: appConfig.model.deepseekModel,
      waitMs,
      scenarios: { cacheFirst, legacyWindow },
      verdict: {
        structuralPrefixPreserved:
          cacheFirst.sharedPrefixMessages === cacheFirst.warm.messageCount &&
          legacyWindow.sharedPrefixMessages < legacyWindow.warm.messageCount,
        apiCacheRatioImproved: cacheFirstRatio > legacyRatio,
        cacheHitRatioDelta: round(cacheFirstRatio - legacyRatio),
      },
    },
    null,
    2,
  ),
);

async function runScenario(strategy: ContextStrategy) {
  const marker = `scenario-${randomUUID()}`;
  const transcript = makeInvocationTranscript(completedTurns, marker);
  const contextConfig = {
    strategy,
    recentTurns: 32,
    pruneBatchUserTurns: 8,
    maxToolResultChars: 12_000,
    maxContextTokens: 500_000,
  } as const;
  const warmContext = buildContext(transcript, contextConfig);
  const warmResponse = await complete(warmContext.messages);

  await delay(waitMs);

  transcript.push(
    {
      role: "assistant",
      content: warmResponse.content || "OK",
    },
    { role: "user", content: nextUserPrompt(completedTurns + 2) },
  );
  const testContext = buildContext(transcript, contextConfig);
  const sharedPrefixMessages = countSharedPrefixMessages(warmContext.messages, testContext.messages);
  const sharedPrefixTokenEstimate = estimateTokens(testContext.messages.slice(0, sharedPrefixMessages));
  const testResponse = await complete(testContext.messages);

  return {
    sharedPrefixMessages,
    sharedPrefixTokenEstimate,
    warm: summarize(warmContext.messages.length, warmResponse.usage),
    test: summarize(testContext.messages.length, testResponse.usage),
    omitted: testContext.omitted,
  };
}

async function complete(messages: Message[]): Promise<{ content: string; usage?: ModelUsage }> {
  const response = await client.chat.completions.create({
    model: appConfig.model.deepseekModel,
    messages: toDeepseekMessages(messages),
    stream: false,
    max_tokens: 8,
    thinking: { type: "disabled" },
  } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);

  return {
    content: response.choices[0]?.message.content ?? "",
    usage: toDeepseekModelUsage(response.usage, response),
  };
}

function makeInvocationTranscript(turns: number, marker: string): Message[] {
  const messages: Message[] = [
    {
      role: "system",
      content: `Cache A/B ${marker}. You are validating a coding-agent transcript. Reply with OK only.`,
    },
  ];
  for (let turn = 1; turn <= turns; turn++) {
    messages.push(
      { role: "user", content: userPrompt(turn) },
      {
        role: "assistant",
        content: `OK ${turn}. Inspected src/module-${turn}.ts and preserved the requested behavior.`,
      },
    );
  }
  messages.push({ role: "user", content: nextUserPrompt(turns + 1) });
  return messages;
}

function userPrompt(turn: number): string {
  return `Coding step ${turn}: inspect src/module-${turn}.ts, keep public behavior stable, and report OK.`;
}

function nextUserPrompt(turn: number): string {
  return `Coding step ${turn}: this is a cache measurement request. Reply with OK only.`;
}

function summarize(messageCount: number, usage?: ModelUsage) {
  const hit = usage?.cachedInputTokens ?? 0;
  const miss = usage?.cacheMissInputTokens ?? Math.max(0, (usage?.inputTokens ?? hit) - hit);
  const cacheInput = hit + miss;
  return {
    requestId: usage?.requestId,
    messageCount,
    inputTokens: usage?.inputTokens,
    cachedInputTokens: usage?.cachedInputTokens,
    cacheMissInputTokens: usage?.cacheMissInputTokens,
    cacheHitRatio: cacheInput > 0 ? round(hit / cacheInput) : undefined,
  };
}

function readPositiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
