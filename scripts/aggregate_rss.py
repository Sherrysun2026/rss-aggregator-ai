import feedparser
import requests
from datetime import datetime, timezone, timedelta
from xml.etree.ElementTree import Element, SubElement, tostring
from xml.dom import minidom
import os
import re

# ============================================
# 11个新闻源配置
# ============================================
RSS_FEEDS = [
    {"name": "TechCrunch AI",  "url": "https://techcrunch.com/category/artificial-intelligence/feed/"},
    {"name": "The Verge AI",   "url": "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml"},
    {"name": "WIRED AI",       "url": "https://www.wired.com/feed/tag/ai/latest/rss"},
    {"name": "36氪",           "url": "https://36kr.com/feed"},
    {"name": "钛媒体",         "url": "https://www.tmtpost.com/rss.xml"},
    {"name": "Business Times", "url": "https://www.businesstimes.com.sg/rss/startups-tech"},
    {"name": "Tech in Asia",   "url": "https://www.techinasia.com/feed"},
    {"name": "MarTech",        "url": "https://martech.org/topic/marketing-artificial-intelligence-ai/feed/"},
    {"name": "BBC Technology", "url": "https://feeds.bbci.co.uk/news/technology/rss.xml"},
    {"name": "CNA Tech",       "url": "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6936"},
    {"name": "Straits Times",  "url": "https://www.straitstimes.com/news/business/rss.xml"},
]

PER_SOURCE_LIMIT = 6
DAYS_BACK = 7

FILTER_REQUIRED = ["BBC Technology", "CNA Tech", "Straits Times", "36氪", "钛媒体"]

AI_KEYWORDS = [
    "ai", "artificial intelligence", "machine learning", "llm", "chatgpt",
    "openai", "anthropic", "gemini", "deepseek", "nvidia", "tech", "technology",
    "martech", "ecommerce", "e-commerce", "digital", "robot", "automation",
    "startup", "software", "app", "platform", "data", "cloud", "chip",
    "semiconductor", "generative", "model", "algorithm",
    "人工智能", "科技", "大模型", "算法", "数字化", "电商", "创业", "芯片"
]

def is_ai_or_tech(title, summary):
    text = (title + " " + summary).lower()
    return any(keyword in text for keyword in AI_KEYWORDS)

def clean_html(text):
    return re.sub(r'<[^>]+>', '', text).strip()[:300]

def fetch_feed(source):
    articles = []
    try:
        headers = {"User-Agent": "Mozilla/5.0 (compatible; RSSBot/1.0)"}
        response = requests.get(source["url"], headers=headers, timeout=15)

        if response.status_code != 200:
            print(f"❌ 抓取失败 {source['name']}: HTTP {response.status_code}")
            return articles

        feed = feedparser.parse(response.content)

        if not feed.entries:
            print(f"⚠️  无内容 {source['name']}")
            return articles

        cutoff = datetime.now(timezone.utc) - timedelta(days=DAYS_BACK)
        count = 0

        for entry in feed.entries:
            if count >= PER_SOURCE_LIMIT:
                break

            title   = entry.get("title", "").strip()
            url     = entry.get("link", "").strip()
            summary = clean_html(entry.get("summary", entry.get("description", "")))

            if not title or not url:
                continue

            pub_date = None
            for date_field in ["published_parsed", "updated_parsed"]:
                parsed = getattr(entry, date_field, None)
                if parsed:
                    try:
                        pub_date = datetime(*parsed[:6], tzinfo=timezone.utc)
                        break
                    except Exception:
                        continue

            if pub_date and pub_date < cutoff:
                continue

            if source["name"] in FILTER_REQUIRED:
                if not is_ai_or_tech(title, summary):
                    continue

            articles.append({
                "source":   source["name"],
                "title":    title,
                "url":      url,
                "summary":  summary,
                "pub_date": pub_date.strftime("%a, %d %b %Y %H:%M:%S +0000") if pub_date else "",
            })
            count += 1

        print(f"✅ {source['name']}: {len(articles)} 条")

    except Exception as e:
        print(f"❌ 错误 {source['name']}: {str(e)}")

    return articles

def generate_rss_xml(all_articles):
    rss = Element("rss", version="2.0")
    channel = SubElement(rss, "channel")

    SubElement(channel, "title").text = "AI & Tech News Aggregator"
    SubElement(channel, "link").text = "https://github.com/Sherrysun2026/rss-aggregator-ai"
    SubElement(channel, "description").text = "Aggregated AI and Tech news from 11 sources"
    SubElement(channel, "lastBuildDate").text = datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S +0000")

    for article in all_articles:
        item = SubElement(channel, "item")
        SubElement(item, "title").text       = article["title"]
        SubElement(item, "link").text        = article["url"]
        SubElement(item, "description").text = f"[{article['source']}] {article['summary']}"
        SubElement(item, "pubDate").text     = article["pub_date"]
        SubElement(item, "source").text      = article["source"]

    xml_str = minidom.parseString(tostring(rss, encoding="unicode")).toprettyxml(indent="  ")
    return "\n".join(xml_str.split("\n")[1:])

def main():
    print(f"🚀 开始抓取 - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    all_articles = []
    for source in RSS_FEEDS:
        articles = fetch_feed(source)
        all_articles.extend(articles)

    print(f"\n📊 总计抓取: {len(all_articles)} 条文章")

    if len(all_articles) == 0:
        print("⚠️  没有文章，跳过生成")
        return

    all_articles.sort(key=lambda x: x["pub_date"], reverse=True)

    xml_content = generate_rss_xml(all_articles)

    os.makedirs("feeds", exist_ok=True)
    with open("feeds/merged.xml", "w", encoding="utf-8") as f:
        f.write(xml_content)

    print(f"✅ 已生成 feeds/merged.xml，共 {len(all_articles)} 条文章")

if __name__ == "__main__":
    main()
