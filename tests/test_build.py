import html
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build.py"
EXAMPLE = ROOT / "examples" / "hello"


def build(proj):
    return subprocess.run([sys.executable, str(BUILD), str(proj)], capture_output=True, text=True)


def config_of(page):
    m = re.search(r"window\.OPEN_LOOM = (.*?);</script>", page, re.S)
    return json.loads(m.group(1))


class ExampleBuild(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.proj = Path(cls.tmp.name) / "hello"
        shutil.copytree(EXAMPLE, cls.proj, ignore=shutil.ignore_patterns("dist"))
        cls.result = build(cls.proj)
        cls.page = (cls.proj / "dist" / "prompter.html").read_text(encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_outputs_exist(self):
        self.assertEqual(self.result.returncode, 0, self.result.stderr)
        for name in ("prompter.html", "script.md", "demo.html"):
            self.assertTrue((self.proj / "dist" / name).is_file(), name)

    def test_segment_count_and_slug(self):
        cfg = config_of(self.page)
        self.assertEqual(len(cfg["segments"]), 5)
        self.assertEqual(cfg["slug"], "open-loom-demo")
        self.assertEqual(cfg["demo"], "demo.html")
        self.assertIn("<title>open-loom demo [script]</title>", self.page)

    def test_script_md_has_every_segment(self):
        md = (self.proj / "dist" / "script.md").read_text(encoding="utf-8")
        self.assertEqual(len(re.findall(r"^## \d+\. ", md, re.M)), 5)
        self.assertIn("View: screen", md)

    def test_data_f_computed(self):
        cfg = config_of(self.page)
        say = {s["id"]: s["say"] for s in cfg["segments"]}
        found = 0
        for sec in re.finditer(r'<section[^>]*id="v-([^"]+)"[^>]*>(.*?)</section>', self.page, re.S):
            for tag in re.finditer(r'<[^>]*data-at="([^"]*)"[^>]*>', sec.group(2)):
                phrase = html.unescape(tag.group(1))
                f = float(re.search(r'data-f="([^"]+)"', tag.group(0)).group(1))
                self.assertAlmostEqual(f, say[sec.group(1)].find(phrase) / len(say[sec.group(1)]), places=5)
                found += 1
        self.assertEqual(found, 6)


class Validation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.proj = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def project(self, segments, slides=None, project=None):
        (self.proj / "project.json").write_text(json.dumps(project or {"title": "T"}))
        (self.proj / "segments.json").write_text(json.dumps(segments))
        if slides is not None:
            (self.proj / "slides.html").write_text(slides)

    def expect_error(self, text):
        r = build(self.proj)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn(text, r.stderr)

    def seg(self, **kw):
        return {"id": "a", "title": "A", "view": "camera", "say": "hello there", **kw}

    def test_missing_project_json(self):
        (self.proj / "segments.json").write_text("[]")
        self.expect_error("missing project.json")

    def test_missing_segments_json(self):
        (self.proj / "project.json").write_text('{"title":"T"}')
        self.expect_error("missing segments.json")

    def test_missing_slides_html(self):
        self.project([self.seg(view="slide")])
        self.expect_error("missing slides.html")

    def test_invalid_view(self):
        self.project([self.seg(view="video")])
        self.expect_error("invalid view")

    def test_duplicate_ids(self):
        self.project([self.seg(), self.seg()])
        self.expect_error("duplicate segment id: a")

    def test_missing_slide_section(self):
        self.project([self.seg(view="slide")], slides='<section class="view slide" id="v-other"></section>')
        self.expect_error('section id="v-a" not found')

    def test_data_at_not_in_say(self):
        self.project([self.seg(view="slide")],
                     slides='<section class="view slide" id="v-a"><p class="rv" data-at="nowhere">x</p></section>')
        self.expect_error("data-at phrase not found")

    def test_screen_without_demo_url(self):
        self.project([self.seg(view="screen")])
        self.expect_error("demo_url")

    def test_script_end_tag_is_escaped(self):
        self.project([self.seg(say="evil </script><b>x</b> text")])
        self.assertEqual(build(self.proj).returncode, 0)
        page = (self.proj / "dist" / "prompter.html").read_text(encoding="utf-8")
        self.assertNotIn("</script><b>", page)
        self.assertIn("\\u003c/script>", page)
        self.assertIn("evil </script><b>x</b> text", config_of(page)["segments"][0]["say"])

    def test_reserved_ids(self):
        for rid in ("cam", "scr"):
            self.project([self.seg(id=rid)])
            self.expect_error("reserved")

    def test_single_quoted_data_at(self):
        self.project([self.seg(view="slide")],
                     slides="<section class=\"view slide\" id=\"v-a\"><p class=\"rv\" data-at='hello'>x</p></section>")
        self.expect_error("data-at")

    def test_data_at_without_rv(self):
        self.project([self.seg(view="slide")],
                     slides='<section class="view slide" id="v-a"><p data-at="hello">x</p></section>')
        self.expect_error("class rv")

    def _demo(self, url, files=()):
        for f in files:
            (self.proj / f).parent.mkdir(parents=True, exist_ok=True)
            (self.proj / f).write_text("<html>demo</html>")
        self.project([self.seg(view="screen")], project={"title": "T", "demo_url": url})

    def test_demo_query_is_stripped(self):
        self._demo("demo.html?x=1#top", ["demo.html"])
        r = build(self.proj)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((self.proj / "dist" / "demo.html").is_file())
        self.assertEqual(config_of((self.proj / "dist" / "prompter.html").read_text())["demo"], "demo.html?x=1#top")

    def test_demo_outside_project(self):
        (self.proj.parent / "outside-demo.html").write_text("x")
        self._demo("../outside-demo.html")
        self.expect_error("outside the project")

    def test_demo_reserved_name(self):
        self._demo("prompter.html", ["prompter.html"])
        self.expect_error("reserved")

    def test_demo_keeps_relative_path(self):
        self._demo("pages/x.html", ["pages/x.html"])
        self.assertEqual(build(self.proj).returncode, 0)
        self.assertTrue((self.proj / "dist" / "pages" / "x.html").is_file())

    def test_demo_index_copies_folder(self):
        self._demo("app/index.html", ["app/index.html", "app/main.js"])
        self.assertEqual(build(self.proj).returncode, 0)
        self.assertTrue((self.proj / "dist" / "app" / "main.js").is_file())


if __name__ == "__main__":
    unittest.main()
