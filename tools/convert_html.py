"""One-shot migration: resources/*.html prep plans -> resources/*.md task files.

The Markdown files are the source of truth after this runs. This script exists so the
conversion is reproducible and auditable (tests compare the HTML against the .md), not
because anyone should re-run it: re-running overwrites hand edits.

    python tools/convert_html.py            # writes resources/*.md
"""
from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

from bs4 import BeautifulSoup, NavigableString, Tag

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "resources"
OUT = ROOT / "resources"


# ---------------------------------------------------------------- inline / block walker

def slug(text: str) -> str:
    """GitHub-style heading anchor."""
    s = text.strip().lower()
    s = re.sub(r"[^\w\- ]", "", s)
    return s.replace(" ", "-")


def inline(node) -> str:
    if isinstance(node, NavigableString):
        return re.sub(r"\s+", " ", str(node))
    if not isinstance(node, Tag):
        return ""
    name = node.name
    if name in ("input", "button", "script", "style"):
        return ""
    inner = "".join(inline(c) for c in node.children)
    if name in ("b", "strong"):
        t = inner.strip()
        return f"**{t}**" if t else ""
    if name == "em":
        t = inner.strip()
        return f"*{t}*" if t else ""
    if name == "code":
        t = node.get_text()
        tick = "``" if "`" in t else "`"
        return f"{tick}{t}{tick}"
    if name == "a":
        href = node.get("href", "")
        return f"[{inner.strip()}]({href})"
    if name == "br":
        return "  \n"
    return inner


def text_of(node) -> str:
    return re.sub(r"[ \t]+", " ", inline(node)).strip()


def plain(node) -> str:
    """Visible text only, no markdown decoration (for labels and titles)."""
    return re.sub(r"\s+", " ", node.get_text()).strip()


def table_md(tbl: Tag) -> str:
    rows = []
    for tr in tbl.find_all("tr"):
        cells = []
        for c in tr.find_all(["td", "th"]):
            span = int(c.get("colspan", 1))
            cells.append(text_of(c).replace("|", "\\|"))
            cells.extend([""] * (span - 1))
        rows.append(cells)
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    first = tbl.find("tr").find_all(["td", "th"])
    if all(c.name == "th" for c in first):
        head, body = rows[0], rows[1:]
    else:  # key/value table (row headers only): keep every row as data
        head, body = [""] * width, rows
    out = ["| " + " | ".join(head) + " |", "|" + "---|" * width]
    out += ["| " + " | ".join(r) + " |" for r in body]
    return "\n".join(out)


def is_checkbox_label(node: Tag) -> bool:
    return node.name == "label" and node.find("input", attrs={"type": "checkbox"}) is not None


def block(node, depth: int = 0) -> list[str]:
    """Convert a block-level node to a list of markdown blocks (joined by blank lines)."""
    if isinstance(node, NavigableString):
        t = str(node).strip()
        return [t] if t else []
    if not isinstance(node, Tag):
        return []
    name = node.name
    cls = node.get("class", [])
    if name in ("script", "style", "button", "input") or "bar" in cls or "controls" in cls \
            or "prog" in cls and name == "div" or "bar-outer" in cls or "bar-label" in cls \
            or "barlbl" in cls or "top-in" in cls:
        return []
    if name in ("h1", "h2", "h3", "h4"):
        level = int(name[1])
        return ["#" * level + " " + text_of(node)]
    if name == "p":
        t = text_of(node)
        return [t] if t else []
    if name == "pre":
        code = node.get_text().rstrip("\n")
        return ["```python\n" + code + "\n```"]
    if name == "table":
        return [table_md(node)]
    if name in ("ul", "ol"):
        items = []
        for i, li in enumerate(node.find_all("li", recursive=False), 1):
            if li.find("input", attrs={"type": "checkbox"}):
                items.append("- [ ] " + text_of(li))
            else:
                bullet = f"{i}." if name == "ol" else "-"
                items.append(f"{bullet} " + text_of(li))
        return ["\n".join(items)]
    if is_checkbox_label(node):
        return ["- [ ] " + text_of(node)]
    if name == "div" and "note" in cls:
        inner = []
        for c in node.children:
            inner += block(c) if isinstance(c, Tag) and c.name in ("p", "ul", "ol", "table") else []
        body = "\n\n".join(inner) if inner else text_of(node)
        return ["\n".join("> " + ln if ln else ">" for ln in body.split("\n"))]
    # containers: recurse
    out: list[str] = []
    for c in node.children:
        out += block(c, depth + 1)
    return merge_checklists(out)


def merge_checklists(blocks: list[str]) -> list[str]:
    """Consecutive '- [ ]' blocks become one list."""
    merged: list[str] = []
    for b in blocks:
        if merged and b.startswith("- [ ]") and merged[-1].startswith("- [ ]"):
            merged[-1] += "\n" + b
        else:
            merged.append(b)
    return merged


# ---------------------------------------------------------------- task model

@dataclass
class Task:
    id: str
    title: str
    duration: str
    type: str
    links: list[tuple[str, str]] = field(default_factory=list)  # (label, url)
    body: list[str] = field(default_factory=list)

    def render(self, level: int = 3) -> str:
        meta = [f"id: {self.id}", f"duration: {self.duration}", f"type: {self.type}"]
        if len(self.links) == 1:
            label, url = self.links[0]
            meta.append(f'link: "[{label}]({url})"')
        elif self.links:
            meta.append("link:")
            meta += [f'  - "[{label}]({url})"' for label, url in self.links]
        head = "#" * level + " " + self.title
        parts = [head, "```task\n" + "\n".join(meta) + "\n```"] + self.body
        return "\n\n".join(parts)


def says_more_than_links(p: Tag) -> bool:
    """True when a link paragraph carries text beyond its link labels (scope notes, variants)."""
    rest = plain(p)
    for a in p.find_all("a"):
        rest = rest.replace(plain(a), "")
    rest = re.sub(r"\bProblem:|\band\b|[\s,.;:()\-—–]", "", rest)
    return len(rest) > 3


def links_in(node: Tag) -> list[tuple[str, str]]:
    return [(plain(a), a["href"]) for a in node.find_all("a", href=True)]


def front_matter(**kv) -> str:
    lines = ["---"]
    for k, v in kv.items():
        if isinstance(v, str) and (":" in v or "—" in v or "#" in v):
            v = '"' + v.replace('"', '\\"') + '"'
        lines.append(f"{k}: {v}")
    lines.append("---")
    return "\n".join(lines)


def render_doc(fm: str, blocks: list[str]) -> str:
    text = fm + "\n\n" + "\n\n".join(b for b in blocks if b.strip()) + "\n"
    return re.sub(r"\n{3,}", "\n\n", text)


def toc_block(nav: Tag, soup: BeautifulSoup) -> str:
    """Rewrite in-page anchors to the GitHub slugs of the converted headings."""
    items = []
    for a in nav.find_all("a", href=True):
        target = soup.find(id=a["href"].lstrip("#"))
        heading = target if target and target.name in ("h1", "h2", "h3") else \
            (target.find(["h2", "h3"]) if target else None)
        if heading:
            anchor = slug(text_of(heading))
        elif target is not None and target.name == "footer":
            anchor = "sources"
        else:
            anchor = a["href"].lstrip("#")
        items.append(f"- [{plain(a)}](#{anchor})")
    return "\n".join(items)


# ---------------------------------------------------------------- BCG

BCG_DURATION = {"A": "40m", "B": "25m", "C": "1h30m", "D": "20m", "E": "40m"}
BCG_TYPE = {"A": "coding", "B": "coding", "C": "coding", "D": "concept", "E": "coding"}


def convert_bcg(soup: BeautifulSoup) -> str:
    wrap = soup.find("div", class_="wrap")
    blocks: list[str] = []
    for node in wrap.children:
        if not isinstance(node, Tag):
            continue
        if node.name == "header":
            blocks.append("# " + text_of(node.find("h1")))
            blocks.append(text_of(node.find("p", class_="sub")))
            continue
        if node.name == "nav":
            blocks.append("## Contents\n\n" + toc_block(node, soup))
            continue
        if node.name == "h2" and node.get("id") == "skip":
            skip = node.find_next_sibling("div", class_="card")
            t = Task("SKIP", "Skip test — tick what you already own", "40m", "drill",
                     body=block(skip))
            blocks.append("## " + text_of(node))
            blocks.append(t.render(3))
            continue
        if node.name == "div" and "card" in node.get("class", []) and \
                node.find_previous_sibling("h2") and node.find_previous_sibling("h2").get("id") == "skip":
            continue  # consumed by SKIP task
        if node.name == "div" and "card" in node.get("class", []) and node.find("span", class_="num"):
            num = plain(node.find("span", class_="num"))
            title = plain(node.find("div", class_="tech-h").find("b"))
            tag = node.find("span", class_="tag")
            meta = node.find("p", class_="meta")
            links = links_in(meta) if meta else []
            body = []
            if meta and (not links or says_more_than_links(meta)):
                body.append(text_of(meta))
            if tag:
                body.append(f"*Tag: {text_of(tag)}*")
            for c in node.children:
                if not isinstance(c, Tag) or c is meta or "tech-h" in c.get("class", []):
                    continue
                if is_checkbox_label(c) and plain(c) == "Done":
                    continue  # the per-card "Done" box: status lives in the planner state
                body += block(c)
            block_letter = num[0]
            if num == "C1":
                title = "The template (matplotlib plot, typed 3×)"
            blocks.append(Task(num, f"{num} · {title}", BCG_DURATION[block_letter],
                               BCG_TYPE[block_letter], links, body).render(3))
            continue
        if node.name == "h2" and node.get("id") == "sched":
            blocks.append("## " + text_of(node))
            continue
        if node.name == "footer":
            blocks.append("## Sources\n\n" + text_of(node))
            continue
        blocks += block(node)

    # Work rows from the 24-day schedule that are not technique cards.
    sched = soup.find(id="sched").find_next_sibling("div")
    rows = {text_of(tr.find_all("td")[0]): tr.find_all("td")[1]
            for tr in sched.find("table").find_all("tr")[1:]}
    kaggle = [l for l in links_in(rows["12–13"]) if "kaggle" in l[1]]
    mock2 = links_in(rows["22"])
    practice = [
        Task("D-TITANIC", "Timed Titanic run, end to end", "40m", "mock", kaggle,
             ["Days 12–13 of the original schedule: \"plus one timed Titanic run end to end\". "
              "40m so the ten concept cards (20m each) and this run fill the row's 4 h."]),
        Task("MOCK-1", "Mock 1 — 90 min timed: 2 stats, 6 MCQ, 3 pandas tasks", "2h", "mock",
             [], ["Day 20 of the original schedule."]),
        Task("REPAIR-1", "Repair the weak spots mock 1 exposed", "2h", "drill", [],
             ["Day 21 of the original schedule."]),
        Task("MOCK-2", "Mock 2 on StrataScratch free tier, plus one CodeSignal practice run",
             "2h", "mock", mock2,
             ["Day 22 of the original schedule. The CodeSignal run is for the interface."]),
    ]
    # Insert practice tasks right before the schedule heading.
    idx = next(i for i, b in enumerate(blocks) if b.startswith("## 9."))
    section = "## Practice sessions\n\nWork rows from the original 24-day schedule that are " \
              "not technique cards. Buffer days are slack, not tasks."
    blocks[idx:idx] = [section] + [p.render(3) for p in practice]

    fm = front_matter(schema="planner/task-file@1", track="bcg",
                      title="BCG X AI Engineer — Assessment Prep Plan", kind="prep",
                      priority=1, source_html="bcg_prep_plan.html")
    return render_doc(fm, blocks)


# ---------------------------------------------------------------- Anthropic FDE

def convert_anthropic(soup: BeautifulSoup) -> str:
    content = soup.find(id="content")
    blocks = ["# " + text_of(soup.find("h1"))]
    for node in content.children:
        if not isinstance(node, Tag):
            continue
        if node.name == "nav":
            blocks.append("## Contents\n\n" + toc_block(node, soup))
            continue
        if node.name == "section" and "tech" in node.get("class", []):
            head = node.find("h3")
            full = plain(head.find("span"))            # "T1 · State as records ..."
            tid = full.split("·")[0].strip()
            weight = text_of(head.find("span", class_="wt"))
            lk = node.find("p", class_="lk")
            body = [f"*Weight: {weight}*"]
            for c in node.children:
                if isinstance(c, Tag) and c not in (head, lk):
                    body += block(c)
            blocks.append(Task(tid, full, "2h", "coding", links_in(lk), body).render(3))
            continue
        if node.name == "h2" and node.get("id") == "skip":
            blocks.append("## " + text_of(node))
            nxt = [node.find_next_sibling("p"), node.find_next_sibling("div", class_="tblwrap")]
            after = node.find_next_sibling("div", class_="tblwrap").find_next_sibling("p")
            body = [text_of(nxt[0]), table_md(nxt[1].find("table")), text_of(after)]
            blocks.append(Task("SKIP", "Skip test — cold, timed, no notes", "30m", "drill",
                               body=body).render(3))
            continue
        if node.find_previous_sibling("h2") is not None and \
                node.find_previous_sibling("h2").get("id") == "skip" and node.name != "h2":
            continue  # consumed by SKIP task
        if node.name == "footer":
            blocks.append("## Sources")
            blocks += block(node.find("ol"))
            blocks.append(text_of(node.find_all("p")[-1]))
            continue
        blocks += block(node)

    libre = ("LibreSignal — free local ICF practice sets",
             "https://github.com/EricZheng0404/LibreSignal")
    lockett = ("PaulLockett — ICF practice repo, file-storage example",
               "https://github.com/PaulLockett/CodeSignal_Practice_Industry_Coding_Framework")
    kind_type = {"Level-chaining build": "build", "Timed mock": "mock",
                 "Blind recall": "drill", "Weak-spot drill": "drill", "Taper": "drill"}
    practice, counters = [], {}
    sched = soup.find(id="sched").find_next_sibling("div")
    for tr in sched.find("tbody").find_all("tr"):
        day, kind, item, _n, hours = [text_of(td) for td in tr.find_all("td")]
        if kind in ("Technique drills", "Rest"):
            continue  # technique days = T1..T8 tasks; rest days are not work
        prefix = {"build": "BUILD", "mock": "MOCK", "drill": "DRILL"}[kind_type[kind]]
        if kind == "Level-chaining build":
            n = re.search(r"#(\d)", item).group(1)
        elif kind == "Timed mock":
            n = re.search(r"#(\d)", item).group(1)
        else:
            counters[prefix] = counters.get(prefix, 0) + 1
            n = str(counters[prefix])
        h = float(hours)
        dur = f"{int(h)}h" + ("30m" if h % 1 else "")
        links = []
        if kind == "Level-chaining build" and n in ("1", "2"):
            links = [libre]
        elif kind == "Level-chaining build" and n == "3":
            links = [lockett]
        elif kind == "Timed mock":
            links = [libre]
        title = item if prefix in ("BUILD", "MOCK") or ":" in item else f"{kind}: {item}"
        practice.append(Task(f"{prefix}-{n}", title, dur, kind_type[kind], links,
                             [f"Day {day} of the original 28-day schedule."]))
    idx = next(i for i, b in enumerate(blocks) if b.startswith("## 28-day schedule"))
    section = "## Practice sessions\n\nWork rows from the original 28-day schedule that are " \
              "not technique drills. Rest days are not tasks."
    blocks[idx:idx] = [section] + [p.render(3) for p in practice]

    fm = front_matter(schema="planner/task-file@1", track="anthropic",
                      title="Anthropic Forward Deployed Engineer — Coding Screen Plan",
                      kind="prep", priority=3, source_html="fde-coding-screen-plan.html")
    return render_doc(fm, blocks)


# ---------------------------------------------------------------- Salesforce FDE

def convert_salesforce(soup: BeautifulSoup) -> str:
    main = soup.find("main")
    header = soup.find("header")
    blocks = ["# " + text_of(header.find("h1")), text_of(header.find("p", class_="sub"))]
    in_skip = False
    for node in main.children:
        if not isinstance(node, Tag):
            continue
        if node.name == "nav":
            blocks.append("## Contents\n\n" + toc_block(node, soup))
            continue
        if node.name == "h2":
            in_skip = node.get("id") == "skip"
            blocks.append("## " + text_of(node))
            if in_skip:
                skip_body = []
            continue
        if in_skip:
            skip_body += block(node)
            if node.name == "div" and "note" in node.get("class", []):
                blocks.append(Task("SKIP", "Skip test — 60 seconds per line, blank editor",
                                   "1h", "drill", body=merge_checklists(skip_body)).render(3))
                in_skip = False
            continue
        if node.name == "div" and "card" in node.get("class", []):
            h3 = node.find("h3")
            tag = h3.find("span", class_="tag")
            tag.extract()
            full = plain(h3)                               # "A1 — Hash map keyed ..."
            tid = full.split("—")[0].strip()
            prob = next((p for p in node.find_all("p")
                         if p.find("strong") and plain(p.find("strong")).startswith("Problem")),
                        None)
            links = links_in(prob) if prob else []
            body = [f"*{text_of(tag)}*"]
            if prob and says_more_than_links(prob):
                body.append(text_of(prob))
            hedge = tid.startswith("H")  # no linked problem: you write it against a fake
            if hedge:
                body.append("*Duration: 1h, so plan day 15 (H1, H2, then the A+B recall) fits its 4 h.*")
            for c in node.children:
                if isinstance(c, Tag) and c not in (h3, prob):
                    body += block(c)
            blocks.append(Task(tid, full.replace(" — ", " · ", 1), "1h" if hedge else "2h30m",
                               "build" if hedge else "coding", links, body).render(3))
            continue
        blocks += block(node)

    practice = [
        Task("RECALL-A1", "Block A recall drill", "1h30m", "drill", [], ["Day 3."]),
        Task("MOCK-1", "Mock 1 + review (easy + medium, 75 min)", "3h", "mock", [], ["Day 7."]),
        Task("RECALL-A2", "Block A recall drill, second pass", "1h", "drill", [], ["Day 7."]),
        Task("RECALL-B", "Block B recall drill", "2h", "drill", [], ["Day 11."]),
        Task("REPAIR-1", "Weak-spot repair after Block B", "2h", "drill", [], ["Day 11."]),
        Task("MOCK-2", "Mock 2 + review (easy + medium, 75 min)", "3h", "mock", [], ["Day 14."]),
        Task("RECALL-C", "Block C recall drill", "1h", "drill", [], ["Day 14."]),
        Task("RECALL-AB", "Block A and B recall drill", "2h", "drill", [], ["Day 15."]),
        Task("MOCK-3", "Mock 3 + review (easy + medium, 75 min)", "4h", "mock", [], ["Day 16."]),
        Task("REPAIR-2", "Weak-spot repair: your 3 slowest techniques", "4h", "drill", [], ["Day 17."]),
        Task("MOCK-4", "Mock 4 + review (easy + medium, 75 min)", "4h", "mock", [], ["Day 18."]),
        Task("NEXT-1", "Next round: AI system design (RAG, evals, cost, failure modes)", "4h",
             "reading", [], ["Day 19."]),
        Task("MOCK-5", "Mock 5 + review (easy + medium, 75 min)", "4h", "mock", [], ["Day 20."]),
        Task("RECALL-ALL1", "All 17 snippets from memory, timed", "4h", "drill", [], ["Day 21."]),
        Task("MOCK-6", "Mock 6 + review (easy + medium, 75 min)", "4h", "mock", [], ["Day 22."]),
        Task("NEXT-2", "Next round: decomposition and customer case", "4h", "reading", [], ["Day 23."]),
        Task("MOCK-7", "Mock 7 + review (easy + medium, 75 min)", "4h", "mock", [], ["Day 24."]),
        Task("REPAIR-3", "Weak-spot repair (or buffer)", "4h", "drill", [], ["Day 25."]),
        Task("MOCK-8", "Mock 8 + review (easy + medium, 75 min)", "4h", "mock", [], ["Day 26."]),
        Task("RECALL-ALL2", "All 17 snippets timed, then skim every trap note", "4h", "drill", [],
             ["Day 27."]),
        Task("FINAL", "Light day: one easy and one medium, untimed. Logistics check. Stop by midday.",
             "2h", "drill", [], ["Day 28."]),
    ]
    idx = next(i for i, b in enumerate(blocks) if b.startswith("## 9."))
    section = "## Practice sessions\n\nWork rows from the original day-by-day schedule that are " \
              "not technique cards. See *How to run a recall drill* and *How to run a mock* below."
    blocks[idx:idx] = [section] + [p.render(3) for p in practice]

    footer = soup.find("footer")
    blocks.append("## Sources")
    blocks += block(footer.find("ul"))
    blocks.append(text_of(footer.find_all("p")[-1]))

    fm = front_matter(schema="planner/task-file@1", track="salesforce",
                      title="Salesforce Forward Deployed AI Engineer — Coding Screen Plan",
                      kind="prep", priority=2,
                      source_html="salesforce-fde-coding-screen-plan.html")
    return render_doc(fm, blocks)


JOBS = {
    "bcg_prep_plan.html": ("bcg.md", convert_bcg),
    "fde-coding-screen-plan.html": ("anthropic.md", convert_anthropic),
    "salesforce-fde-coding-screen-plan.html": ("salesforce.md", convert_salesforce),
}

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for src, (dst, fn) in JOBS.items():
        soup = BeautifulSoup((SRC / src).read_text(encoding="utf-8"), "html.parser")
        md = fn(soup)
        (OUT / dst).write_text(md, encoding="utf-8", newline="\n")
        print(f"{src} -> resources/{dst}  ({md.count('```task')} tasks)", file=sys.stderr)
