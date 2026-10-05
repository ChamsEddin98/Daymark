/**
 * Loss check for the one-shot HTML -> Markdown migration. Any link or task present in the
 * original HTML must survive (a) into resources/*.md and (b) into the parsed task objects.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hasRealPlans } from "./real-plans.ts";
import { parseTaskFile, type Link, type TaskFile } from "../src/index.ts";

const RES = resolve(import.meta.dirname, "../../../resources");

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–",
  middot: "·", times: "×", minus: "−", sup2: "²", rarr: "→", hellip: "…",
};
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e.startsWith("#x") ? String.fromCodePoint(parseInt(e.slice(2), 16))
      : e.startsWith("#") ? String.fromCodePoint(Number(e.slice(1)))
        : ENTITIES[e.toLowerCase()] ?? m);
const htmlText = (s: string) => norm(decode(s.replace(/<[^>]+>/g, "")).replace(/\*/g, ""));
const mdText = (s: string) =>
  norm(s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\\\|/g, "|").replace(/[*`]/g, ""));
function norm(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

const externalHrefs = (html: string) =>
  [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => decode(m[1]!));

interface Card { id: string; title: string; hrefs: string[] }

/** Cut `html` into segments starting at each match of `start`, ending at the next `stop`. */
function cards(html: string, start: RegExp, stop: RegExp, id: (m: RegExpMatchArray) => [string, string]): Card[] {
  return [...html.matchAll(start)].map((m) => {
    const from = m.index!;
    const rest = html.slice(from + m[0].length);
    const end = rest.search(stop);
    const seg = end < 0 ? rest : rest.slice(0, end);
    const [cid, title] = id(m);
    return { id: cid, title: norm(decode(title.replace(/<[^>]+>/g, ""))), hrefs: externalHrefs(seg) };
  });
}

const SOURCES = [
  {
    html: "bcg_prep_plan.html", md: "bcg.md", cardCount: 52,
    cards: (h: string) => cards(h, /<span class="num">(\w+)<\/span><b>(.*?)<\/b>/g, /<div class="card|<h2/,
      (m) => [m[1]!, m[2]!]),
  },
  {
    html: "fde-coding-screen-plan.html", md: "anthropic.md", cardCount: 8,
    cards: (h: string) => cards(h, /<section class="tech"[^>]*>[\s\S]*?<span>(T\d) &middot; (.*?)<\/span>/g,
      /<\/section>/, (m) => [m[1]!, m[2]!]),
  },
  {
    html: "salesforce-fde-coding-screen-plan.html", md: "salesforce.md", cardCount: 17,
    cards: (h: string) => cards(h, /<div class="card">\s*<h3>(\w+) &mdash; (.*?) <span/g, /<div class="card">|<h2/,
      (m) => [m[1]!, m[2]!]),
  },
];

// Guarded: these read the owner's own plan files, which are gitignored (see test/real-plans.ts).
describe.skipIf(!hasRealPlans).each(SOURCES)("$html -> $md", (src) => {
  const html = readFileSync(resolve(RES, src.html), "utf8").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "");
  const md = readFileSync(resolve(RES, src.md), "utf8");
  const { file, errors } = parseTaskFile(md, src.md);
  const parsed = file as TaskFile;
  const parsedUrls = new Set<string>([
    ...parsed.tasks.flatMap((t) => [...t.links, ...t.bodyLinks]),
    ...parsed.references,
  ].map((l: Link) => l.url));

  it("parses without errors", () => {
    expect(errors).toEqual([]);
  });

  it("keeps every external link in the markdown", () => {
    const missing = externalHrefs(html).filter((u) => !md.includes(`](${u})`));
    expect(missing).toEqual([]);
  });

  it("keeps every external link in the parsed objects", () => {
    const missing = externalHrefs(html).filter((u) => !parsedUrls.has(u));
    expect(missing).toEqual([]);
  });

  it(`turns all ${src.cardCount} technique cards into tasks, links on the right task`, () => {
    const found = src.cards(html);
    expect(found).toHaveLength(src.cardCount);
    for (const card of found) {
      const task = parsed.tasks.find((t) => t.id === card.id);
      expect(task, `task ${card.id}`).toBeDefined();
      expect(task!.title).toContain(card.title);
      const own = [...task!.links, ...task!.bodyLinks].map((l) => l.url);
      expect(own, `links of ${card.id}`).toEqual(expect.arrayContaining(card.hrefs));
    }
  });

  it("puts a card's problem link in the task block, so the calendar event gets it", () => {
    for (const card of src.cards(html)) {
      const task = parsed.tasks.find((t) => t.id === card.id)!;
      const platform = card.hrefs.filter((u) => /leetcode\.com\/problems|kaggle|github\.com/.test(u));
      for (const u of platform) expect(task.links.map((l) => l.url), card.id).toContain(u);
    }
  });

  it("keeps every checkbox item (skip tests, checklists, schedule rows) as text", () => {
    const labels = [...html.matchAll(/<input type="checkbox"[^>]*>\s*<span>([\s\S]*?)<\/span>/g)]
      .map((m) => htmlText(m[1]!))
      .filter((t) => t !== "Done");
    const body = mdText(md);
    const missing = labels.filter((l) => !body.includes(l));
    expect(missing).toEqual([]);
  });

  it("keeps the text of every paragraph and list item", () => {
    const body = mdText(md);
    const missing: string[] = [];
    for (const m of html.matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      const text = htmlText(m[2]!);
      if (!text || text === "Done" || body.includes(text)) continue;
      // A paragraph that is only link(s) ("Problem: [X]", "[A] and [B]") became the task's
      // `link` field; then each label must survive instead of the sentence.
      const labels = [...m[2]!.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map((a) => htmlText(a[1]!));
      let rest = text;
      for (const l of labels) rest = rest.replace(l, "");
      const onlyLinks = labels.length > 0 && rest.replace(/\bProblem:|\band\b|[\s,.;:()\-—–]/g, "").length <= 3;
      if (!onlyLinks || labels.some((l) => !md.includes(l))) missing.push(text);
    }
    expect(missing).toEqual([]);
  });

  it("keeps every table row", () => {
    const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) =>
      [...m[1]!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => htmlText(c[1]!)).filter(Boolean));
    const body = mdText(md);
    const missing = rows.flat().filter((cell) => !body.includes(cell));
    expect(missing).toEqual([]);
  });
});

/** Practice tasks carry "Day N" in their body; their minutes must equal that row's Hours cell. */
it.each([
  ["bcg_prep_plan.html", "bcg.md", /<tr><td>(\d+)<\/td><td>(.*?)<\/td><td class="n">.*?<\/td><td class="n">([\d.]+)<\/td><\/tr>/g],
  ["fde-coding-screen-plan.html", "anthropic.md", /<tr><td class="mono">(\d+)<\/td><td>(.*?)<\/td><td>[\s\S]*?<\/td><td class="mono">\d+<\/td><td class="mono">([\d.]+)<\/td><\/tr>/g],
  ["salesforce-fde-coding-screen-plan.html", "salesforce.md", /<tr><td>(\d+)<\/td><td>(.*?)<\/td><td>.*?<\/td><td>([\d.]+)<\/td><\/tr>/g],
] as const)("%s: practice tasks add up to each schedule day's hours", (htmlName, mdName, rowRe) => {
  const html = readFileSync(resolve(RES, htmlName), "utf8");
  const { file } = parseTaskFile(readFileSync(resolve(RES, mdName), "utf8"), mdName);
  const perDay = new Map<string, number>();
  for (const t of file!.tasks) {
    const day = t.body.match(/^Day (\d+)\b/)?.[1];
    if (day) perDay.set(day, (perDay.get(day) ?? 0) + t.durationMin);
  }
  let checked = 0;
  for (const m of html.matchAll(rowRe)) {
    const [, day, block, hours] = m;
    // Rows that also hold technique cards (A1, T3, "Skip test") are budgeted per technique instead.
    if (/\b[A-HT]\d\b|Skip test|Technique drills|Rest/.test(htmlText(block!)) || !perDay.has(day!)) continue;
    expect(perDay.get(day!), `${mdName} day ${day}`).toBe(Number(hours) * 60);
    checked++;
  }
  expect(checked).toBeGreaterThan(2);
});

it.skipIf(!hasRealPlans)("anthropic: every non-rest, non-technique schedule row became a practice task", () => {
  const html = readFileSync(resolve(RES, "fde-coding-screen-plan.html"), "utf8");
  const sched = html.slice(html.indexOf('id="sched"'), html.indexOf('id="day"'));
  const rows = [...sched.matchAll(/<tr><td class="mono">\d+<\/td><td>(.*?)<\/td><td>[\s\S]*?<span>(.*?)<\/span>/g)]
    .filter((m) => !["Rest", "Technique drills"].includes(m[1]!));
  const { file } = parseTaskFile(readFileSync(resolve(RES, "anthropic.md"), "utf8"), "anthropic.md");
  for (const m of rows) {
    const item = htmlText(m[2]!);
    expect(file!.tasks.some((t) => t.title.includes(item)), item).toBe(true);
  }
  expect(rows).toHaveLength(22);
});
