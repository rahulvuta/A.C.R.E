"""Page verification: PDF text, hyphenated line breaks, one retry, a generic browser User-Agent.
The PDFs are built in the test (a few hundred bytes); no network."""

from __future__ import annotations

import httpx

from acre.croplib import research as crop_research
from acre.research import verify

QUOTE = "price received was 12.40 dollars per bushel in 2024"


def make_pdf(pages: list[list[str]]) -> bytes:
    """A minimal valid PDF: one Helvetica text line per entry (no parentheses in the text)."""
    n = len(pages)
    ids = [4 + 2 * i for i in range(n)]
    objs = {1: b"<< /Type /Catalog /Pages 2 0 R >>",
            2: f"<< /Type /Pages /Kids [{' '.join(f'{i} 0 R' for i in ids)}] /Count {n} >>".encode(),
            3: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"}  # fmt: skip
    for pid, lines in zip(ids, pages, strict=True):
        stream = "BT /F1 12 Tf 14 TL 50 750 Td " + " ".join(f"({x}) Tj T*" for x in lines) + " ET"
        objs[pid] = (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {pid + 1} 0 R "
                     "/Resources << /Font << /F1 3 0 R >> >> >>").encode()
        objs[pid + 1] = f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream".encode()
    out = bytearray(b"%PDF-1.4\n")
    offs = {}
    for k in sorted(objs):
        offs[k] = len(out)
        out += f"{k} 0 obj\n".encode() + objs[k] + b"\nendobj\n"
    size = max(objs) + 1
    xref = len(out)
    out += f"xref\n0 {size}\n".encode() + b"0000000000 65535 f \n"
    for k in range(1, size):
        out += f"{offs[k]:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def fetch(body: bytes, ctype="application/pdf", url="https://www.example.gov/report.pdf", **kw):
    def handler(request):
        return httpx.Response(200, content=body, headers={"content-type": ctype})

    with httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True) as c:
        return verify.fetch_page(url, c, **kw) if kw else verify.fetch_page(url, c)


def test_a_quote_on_a_pdf_is_checked_and_makes_the_item_source_checked():
    pdf = make_pdf([["Table 1. Farm prices."], ["Sorghum " + QUOTE + ".", "Other text."]])
    page = fetch(pdf)
    assert page.ok and page.reason == "pdf" and QUOTE in page.text
    item = {"source_url": "https://www.example.gov/report.pdf", "evidence_quote": QUOTE}
    assert crop_research._origin(item, page) == "source_checked"
    item["evidence_quote"] = "price received was 99.99 dollars per bushel"
    assert crop_research._origin(item, page) == "ai_suggested"  # reachable, quote not on it


def test_hyphenated_line_breaks_in_a_pdf_still_match():
    pdf = make_pdf([["The price received was 12.40 dol-", "lars per bushel in 2024 in the state"]])
    page = fetch(pdf)
    assert "dol- lars" in page.text  # as extracted: the word is split over two lines
    assert verify.quote_in("the price received was 12.40 dollars per bushel", page.text)
    assert not verify.quote_in("the price received was 12.41 dollars per bushel", page.text)


def test_a_broken_or_encrypted_pdf_falls_back_without_raising():
    for body in (b"%PDF-1.4 this is not a pdf at all", b"", make_pdf([["x"]])[:200]):
        page = fetch(body)
        assert page.ok and page.text == "" and page.reason == "pdf_not_checked"
    assert verify.pdf_text(b"\x00" * 10) is None


def test_only_the_first_pages_are_read():
    pages = [[f"Page {i} filler."] for i in range(verify.MAX_PDF_PAGES + 5)]
    pages[2] = ["Early page says the yield was 52 bushels per acre."]
    pages[verify.MAX_PDF_PAGES + 2] = ["Late page says the yield was 77 bushels per acre."]
    text = verify.pdf_text(make_pdf(pages))
    assert "yield was 52 bushels" in text and "yield was 77 bushels" not in text


def test_a_pdf_over_the_byte_cap_is_not_parsed(monkeypatch):
    monkeypatch.setattr(verify, "MAX_PDF_BYTES", 100)
    assert verify.pdf_text(make_pdf([["small"]])) is None


def test_html_is_unchanged_and_a_pdf_is_recognised_by_its_url_too():
    page = fetch(b"<html><body><p>Sorghum " + QUOTE.encode() + b"</p></body></html>", "text/html",
                 "https://www.example.gov/page")
    assert page.ok and QUOTE in page.text
    by_url = fetch(make_pdf([["Sorghum " + QUOTE]]), "application/octet-stream")
    assert QUOTE in by_url.text


def test_one_retry_on_a_network_error_or_a_server_error_then_give_up():
    calls = []

    def flaky(request):
        calls.append(request.headers["user-agent"])
        if len(calls) == 1:
            raise httpx.ConnectError("boom")
        if len(calls) == 2:
            return httpx.Response(503)
        return httpx.Response(404)  # the archive has no copy either

    with httpx.Client(transport=httpx.MockTransport(flaky)) as c:
        assert verify.fetch_page("https://x.example.edu/a", c).reason == "http_503"
    assert len(calls) == 3  # one retry of the live page, then one look in the archive
    calls.clear()

    def once(request):
        calls.append(1)
        return httpx.Response(500) if len(calls) == 1 else httpx.Response(200, text="<p>fine</p>")

    with httpx.Client(transport=httpx.MockTransport(once)) as c:
        assert verify.fetch_page("https://x.example.edu/a", c).text == "fine"

    def dead(request):
        raise httpx.ConnectError("down")

    with httpx.Client(transport=httpx.MockTransport(dead)) as c:
        assert verify.fetch_page("https://x.example.edu/a", c).reason == "unreachable"

    def notfound(request):
        calls.append(2)
        return httpx.Response(404)

    calls.clear()
    with httpx.Client(transport=httpx.MockTransport(notfound)) as c:
        assert verify.fetch_page("https://x.example.edu/a", c).reason == "http_404"
    assert calls == [2, 2]  # a 4xx is not retried; the archive is asked once


def test_the_user_agent_is_a_generic_browser_string():
    ua = verify.USER_AGENT
    assert ua.startswith("Mozilla/5.0") and "ACRE" not in ua and "@" not in ua
    assert "http" not in ua.lower()
    seen = []

    def handler(request):
        seen.append(request.headers.get("user-agent"))
        return httpx.Response(200, text="<p>x</p>")

    real = httpx.Client
    # the default client (no client passed) sends the configured header
    import acre.research.verify as v

    class Patched(real):
        def __init__(self, *a, **k):
            super().__init__(*a, transport=httpx.MockTransport(handler), **k)

    v.httpx.Client = Patched  # type: ignore[misc]
    try:
        assert v.fetch_page("https://x.example.edu/a").ok
    finally:
        v.httpx.Client = real  # type: ignore[misc]
    assert seen == [ua]


def test_the_allowlist_additions_are_official_sources_only():
    from acre.research.guardrails import domain_allowed

    for url in ("https://www.statcan.gc.ca/t", "https://ec.europa.eu/eurostat/x",
                "https://www.abares.gov.au/x", "https://www.canada.ca/x",
                "https://quickstats.nass.usda.gov/", "https://www.fao.org/faostat/",
                "https://stats.govt.nz/x"):  # fmt: skip
        assert domain_allowed(url), url
    for url in ("https://www.ambrook.com/x", "https://gc.ca.evil.example.com/",
                "https://notgc.ca.example.com/", "https://europa.eu.example.org/"):  # fmt: skip
        assert not domain_allowed(url), url


def test_a_dead_or_blocked_page_is_read_from_the_archive():
    seen = []

    def handler(request):
        seen.append(str(request.url))
        if str(request.url).startswith(verify.ARCHIVE_PREFIX):
            return httpx.Response(200, text="<p>Sorghum " + QUOTE + "</p>")
        return httpx.Response(404 if "moved" in str(request.url) else 403)

    with httpx.Client(transport=httpx.MockTransport(handler)) as c:
        moved = verify.fetch_page("https://www.example.gov/moved.html", c)
        blocked = verify.fetch_page("https://www.example.edu/blocked.html", c)
    assert moved.ok and moved.reason == "archived" and QUOTE in moved.text
    assert blocked.ok and blocked.reason == "archived"
    assert seen[1] == verify.ARCHIVE_PREFIX + "https://www.example.gov/moved.html"
