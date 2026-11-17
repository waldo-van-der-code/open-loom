#!/usr/bin/env python3
"""Build an open-loom project into dist/prompter.html and dist/script.md.

Usage: python3 build.py <project-dir> [--wpm 150]

Reads <project-dir>/project.json, segments.json, slides.html (and optional slides.css).
Python 3 standard library only.
"""
import argparse
import html
import json
import re
import shutil
import sys
from urllib.parse import unquote
from pathlib import Path

SRC = Path(__file__).resolve().parent / "src"
VIEWS = ("slide", "camera", "screen")
ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
RESERVED_IDS = ("cam", "scr")   # v-cam and v-scr are the runtime's own views
RESERVED_FILES = ("prompter.html", "script.md")


def fail(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def read_json(path, what):
    if not path.is_file():
        fail(f"missing {what}: {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        fail(f"{what} is not valid JSON ({path}): {e}")


def mmss(sec):
    return f"{int(sec // 60)}:{int(sec % 60):02d}"


def load_project(proj):
    if not proj.is_dir():
        fail(f"project directory not found: {proj}")
    cfg = read_json(proj / "project.json", "project.json")
    if not isinstance(cfg, dict) or not str(cfg.get("title", "")).strip():
        fail("project.json needs a non-empty \"title\"")
    segs = read_json(proj / "segments.json", "segments.json")
    if not isinstance(segs, list) or not segs:
        fail("segments.json must be a non-empty list")
    seen = set()
    out = []
    for i, s in enumerate(segs, 1):
        if not isinstance(s, dict):
            fail(f"segment {i} is not an object")
        sid = s.get("id")
        if not isinstance(sid, str) or not ID_RE.match(sid):
            fail(f"segment {i}: \"id\" must be letters, digits, - or _ (got {sid!r})")
        if sid in RESERVED_IDS:
            fail(f"segment {i}: id {sid!r} is reserved (reserved ids: {', '.join(RESERVED_IDS)})")
        if sid in seen:
            fail(f"duplicate segment id: {sid}")
        seen.add(sid)
        if s.get("view") not in VIEWS:
            fail(f"segment {sid}: invalid view {s.get('view')!r} (use one of: {', '.join(VIEWS)})")
        say = s.get("say")
        if not isinstance(say, str) or not say.strip():
            fail(f"segment {sid}: \"say\" must be non-empty text")
        out.append({"id": sid, "title": str(s.get("title") or sid), "view": s["view"],
                    "say": say.strip(), "cue": str(s.get("cue") or "")})
    demo = str(cfg.get("demo_url") or "").strip()
    if any(s["view"] == "screen" for s in out):
        if not demo:
            fail("a screen segment needs \"demo_url\" in project.json")
    return cfg, out, demo


def process_slides(proj, segs):
    """Return {segment id: section html} with data-f computed from each data-at phrase."""
    slide_ids = [s["id"] for s in segs if s["view"] == "slide"]
    if not slide_ids:
        return {}, ""
    path = proj / "slides.html"
    if not path.is_file():
        fail(f"missing slides.html: {path} (needed for slide segments)")
    text = path.read_text(encoding="utf-8")
    sections = {}
    for m in re.finditer(r"<section\b([^>]*)>(.*?)</section>", text, re.S):
        mid = re.search(r'\bid="v-([^"]+)"', m.group(1))
        if not mid:
            continue
        if mid.group(1) in sections:
            fail(f"slides.html: duplicate section id=\"v-{mid.group(1)}\"")
        sections[mid.group(1)] = m
    say = {s["id"]: s["say"] for s in segs}
    result = {}
    for sid in slide_ids:
        m = sections.get(sid)
        if m is None:
            fail(f"slide segment \"{sid}\": section id=\"v-{sid}\" not found in slides.html")
        if not re.search(r'\bclass="[^"]*\bview\b', m.group(1)):
            fail(f"slides.html: section v-{sid} needs class=\"view slide\"")
        body = m.group(2)

        def fix(tag_m, sid=sid):
            tag = tag_m.group(0)
            q = re.search(r'\sdata-at="([^"]*)"', tag)
            if not q:
                fail(f"segment {sid}: data-at must be written with double quotes (data-at=\"...\"): {tag[:80]}")
            if not re.search(r'\bclass="[^"]*\brv\b', tag):
                fail(f"segment {sid}: an element with data-at needs class rv: {tag[:80]}")
            phrase = html.unescape(q.group(1))
            idx = say[sid].find(phrase) if phrase else -1
            if idx < 0:
                fail(f"segment {sid}: data-at phrase not found in say text: {phrase!r}")
            tag = re.sub(r'\sdata-f="[^"]*"', "", tag)
            f = f' data-f="{idx / len(say[sid]):.6f}"'
            return tag[:-2] + f + "/>" if tag.endswith("/>") else tag[:-1] + f + ">"

        body = re.sub(r'<[a-zA-Z][^>]*?\sdata-at(?![\w-])[^>]*>', fix, body)
        result[sid] = f"<section{m.group(1)}>{body}</section>"
    css_path = proj / "slides.css"
    css = css_path.read_text(encoding="utf-8") if css_path.is_file() else ""
    return result, css


def copy_demo(proj, dist, demo):
    """Copy a relative demo page into dist keeping its relative path; returns the URL to use in the iframe."""
    m = re.match(r"^([^?#]*)(.*)$", demo, re.S)
    rel, suffix = unquote(m.group(1)), m.group(2)
    if not rel:
        fail(f"demo_url has no file path: {demo!r}")
    src = (proj / rel).resolve()
    try:
        relp = src.relative_to(proj)
    except ValueError:
        fail(f"demo_url points outside the project folder: {demo!r}")
    if relp.parts and relp.parts[0] == "dist":
        fail(f"demo_url must not point into dist/: {demo!r}")
    if relp.as_posix() in RESERVED_FILES:
        fail(f"demo_url {relp.as_posix()!r} is reserved (the build writes it): rename your demo file")
    if not src.is_file():
        fail(f"demo_url file not found: {src}")
    if src.name == "index.html" and src.parent != proj:
        shutil.copytree(src.parent, dist / src.parent.relative_to(proj), dirs_exist_ok=True)
    else:
        (dist / relp).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dist / relp)
    return relp.as_posix() + suffix


def script_md(title, segs, wpm):
    words = sum(len(s["say"].split()) for s in segs)
    t = 0.0
    lines = []
    for i, s in enumerate(segs, 1):
        n = len(s["say"].split())
        lines += ["", f"## {i}. {s['title']} [~{mmss(t)}]", f"View: {s['view']}"]
        if s["cue"]:
            lines.append(f"Cue: {s['cue']}")
        lines += ["", s["say"], ""]
        t += n / wpm * 60 + 1.0
    head = [f"# {title}: script for recording", "",
            f"About {mmss(t - 1.0)} at {wpm:.0f} wpm. {words} words."]
    return "\n".join(head + lines)


def main():
    ap = argparse.ArgumentParser(description="Build an open-loom project.")
    ap.add_argument("project", help="project directory")
    ap.add_argument("--wpm", type=float, default=150.0, help="speaking pace for time estimates")
    args = ap.parse_args()
    proj = Path(args.project).resolve()
    cfg, segs, demo = load_project(proj)
    slides, slides_css = process_slides(proj, segs)

    dist = proj / "dist"
    dist.mkdir(exist_ok=True)
    demo_src = demo
    if demo and not re.match(r"^([a-z][a-z0-9+.-]*:)?//|^/", demo, re.I):
        demo_src = copy_demo(proj, dist, demo)

    title = str(cfg["title"]).strip()
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-") or "open-loom"
    config = {"title": title, "slug": slug, "demo": demo_src,
              "segments": [{k: s[k] for k in ("id", "title", "view", "say", "cue")} for s in segs]}
    config_js = json.dumps(config, ensure_ascii=False).replace("<", "\\u003c")

    css = (SRC / "prompter.css").read_text(encoding="utf-8")
    body = (
        '<div class="app"><div class="main">\n'
        '<div id="stage"><div id="inner">\n'
        '<video id="camvid" autoplay muted playsinline></video><canvas id="camcv"></canvas>\n'
        + "\n".join(slides[s["id"]] for s in segs if s["view"] == "slide") +
        '\n</div></div>\n'
        '<div class="hint"><span>→ / Space / clicker = next · ← = back · Home = start'
        ' · V = camera full / bubble · B = blur · M = mirror</span>'
        '<span class="right"><button id="stageb">Open stage window</button>'
        '<button id="camb">Turn camera on</button><button id="blurb">Blur: on</button>'
        '<span id="pos"></span></span></div>\n'
        '</div>\n'
        '<aside class="side"><div class="sl"><div class="hd"><b id="ttl"></b><i id="vw"></i></div>'
        '<div id="say"></div></div>'
        '<div class="sr"><div id="cue"></div><div class="btns">'
        '<button id="bk">◀ Back</button><button id="nx">Next ▶</button></div>'
        '<div id="nexts"></div></div></aside>\n</div>\n'
    )
    page = (
        '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
        f"<title>{html.escape(title)} [script]</title>\n<style>{css}</style>\n"
        + (f"<style>{slides_css}</style>\n" if slides_css else "")
        + "</head><body>\n" + body
        + f"<script>window.OPEN_LOOM = {config_js};</script>\n"
        + "<script>" + (SRC / "prompter.js").read_text(encoding="utf-8") + "</script>\n"
        + '<script type="module">' + (SRC / "camfx.js").read_text(encoding="utf-8") + "</script>\n"
        + "<script>" + (SRC / "mirror.js").read_text(encoding="utf-8") + "</script>\n"
        + "</body></html>\n"
    )
    (dist / "prompter.html").write_text(page, encoding="utf-8")
    (dist / "script.md").write_text(script_md(title, segs, args.wpm), encoding="utf-8")
    words = sum(len(s["say"].split()) for s in segs)
    print(f"segments={len(segs)} words={words} -> {dist / 'prompter.html'}")


if __name__ == "__main__":
    main()
