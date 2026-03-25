#!/usr/bin/env python3
"""Generate SEO city pages and sitemap from shared template + data source."""

from __future__ import annotations

import json
from pathlib import Path
from string import Template

ROOT = Path(__file__).resolve().parents[1]
DATA_FILE = ROOT / "data" / "cities.json"
TEMPLATE_FILE = ROOT / "templates" / "city_page.html.tmpl"
INDEX_TEMPLATE_FILE = ROOT / "templates" / "city_index.html.tmpl"
SUN_DIR = ROOT / "sun"
SITEMAP_FILE = ROOT / "sitemap.xml"
BASE_URL = "https://iwannasun.com"


def load_cities() -> list[dict]:
    cities = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    if not isinstance(cities, list):
        raise ValueError("cities.json must be a list")
    return cities


def fmt_coord(value: float) -> str:
    # Keep stable coordinate formatting in generated JS.
    return f"{float(value):.4f}"


def render_city_pages(cities: list[dict]) -> None:
    template = Template(TEMPLATE_FILE.read_text(encoding="utf-8"))

    for city in cities:
        slug = str(city["slug"]).strip()
        name = str(city["city"]).strip()
        lat = fmt_coord(city["lat"])
        lon = fmt_coord(city["lon"])

        html = template.substitute(
            slug=slug,
            city=name,
            lat=lat,
            lon=lon,
            meta_description=str(city["meta_description"]),
            og_description=str(city["og_description"]),
            twitter_description=str(city["twitter_description"]),
        )

        out_dir = SUN_DIR / slug
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "index.html").write_text(html, encoding="utf-8")


def render_city_index(cities: list[dict]) -> None:
    template = Template(INDEX_TEMPLATE_FILE.read_text(encoding="utf-8"))
    links = []

    for city in sorted(cities, key=lambda c: str(c["city"]).lower()):
        slug = str(city["slug"]).strip()
        name = str(city["city"]).strip()
        links.append(f'          <li><a href="/sun/{slug}/">{name}</a></li>')

    html = template.substitute(city_links="\n".join(links))
    (SUN_DIR / "index.html").write_text(html, encoding="utf-8")


def render_sitemap(cities: list[dict]) -> None:
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        "  <url>",
        f"    <loc>{BASE_URL}/</loc>",
        "    <changefreq>daily</changefreq>",
        "    <priority>1.0</priority>",
        "  </url>",
        "  <url>",
        f"    <loc>{BASE_URL}/solar/</loc>",
        "    <changefreq>weekly</changefreq>",
        "    <priority>0.7</priority>",
        "  </url>",
        "  <url>",
        f"    <loc>{BASE_URL}/solar/docs/</loc>",
        "    <changefreq>weekly</changefreq>",
        "    <priority>0.6</priority>",
        "  </url>",
        "  <url>",
        f"    <loc>{BASE_URL}/sun/</loc>",
        "    <changefreq>daily</changefreq>",
        "    <priority>0.9</priority>",
        "  </url>",
    ]

    for city in cities:
        slug = str(city["slug"]).strip()
        lines.extend(
            [
                "  <url>",
                f"    <loc>{BASE_URL}/sun/{slug}/</loc>",
                "    <changefreq>daily</changefreq>",
                "    <priority>0.8</priority>",
                "  </url>",
            ]
        )

    lines.append("</urlset>")
    SITEMAP_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    cities = load_cities()
    render_city_pages(cities)
    render_city_index(cities)
    render_sitemap(cities)
    print(f"Generated {len(cities)} city pages, /sun/index.html, and sitemap.xml")


if __name__ == "__main__":
    main()
