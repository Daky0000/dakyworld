<?xml version="1.0" encoding="UTF-8"?>
<!--
  Makes dakyx.com's sitemaps readable in a browser. Search engines read the XML
  underneath and never apply this. Written by hand; the sitemaps themselves come
  from scripts/build-seo.mjs.
-->
<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:sitemap="http://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <xsl:output method="html" version="1.0" encoding="UTF-8" indent="yes"/>

  <xsl:template match="/">
    <html lang="en">
      <head>
        <meta charset="UTF-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <meta name="robots" content="noindex, follow"/>
        <title>XML Sitemap | DakyXTech</title>
        <link rel="stylesheet" href="/assets/fonts.css"/>
        <style>
          :root{--navy:#091833;--ink:#0D1526;--blue:#2563EB;--pale:#EAF1FF;--canvas:#ECEEF1;--soft:#F6F7F9;--line:#E3E6EB;--muted:#5B6374}
          *{box-sizing:border-box}
          body{margin:0;background:var(--canvas);color:var(--ink);font:400 15px/1.6 Outfit,system-ui,-apple-system,"Segoe UI",sans-serif}
          a{color:var(--blue);text-decoration:none}
          a:hover{text-decoration:underline}
          header{background:var(--navy);color:#fff;padding:40px 16px 44px}
          .in{max-width:1120px;margin:0 auto}
          header img{height:34px;width:auto;display:block;margin-bottom:28px}
          h1{font-weight:400;font-size:clamp(28px,4vw,40px);line-height:1.1;margin:0 0 12px;letter-spacing:-.01em}
          header p{margin:0;max-width:72ch;color:rgba(255,255,255,.78)}
          header a{color:#8FB2FF}
          main{padding:28px 16px 64px}
          .panel{background:#fff;border-radius:22px;padding:28px;overflow-x:auto}
          .count{margin:0 0 18px;color:var(--muted)}
          .count b{color:var(--ink);font-weight:600}
          table{width:100%;border-collapse:collapse}
          th{text-align:left;font-weight:500;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);padding:12px 14px;border-bottom:1px solid var(--line)}
          td{padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:top;word-break:break-all}
          tr:nth-child(even) td{background:var(--soft)}
          th.n,td.n{white-space:nowrap;word-break:normal;color:var(--muted);width:1%}
          @media (max-width:600px){.panel{padding:18px}th,td{padding:10px 8px}.img{display:none}}
          footer{max-width:1120px;margin:18px auto 0;color:var(--muted);font-size:13px}
        </style>
      </head>
      <body>
        <header>
          <div class="in">
            <a href="/"><img src="/assets/brand/masters/lockup-white.png" alt="DakyXTech" width="168" height="42"/></a>
            <h1>XML Sitemap</h1>
            <p>This is the list of pages on dakyx.com that search engines such as Google and Bing use to find and re-crawl the site. It is written for crawlers; you are seeing a readable version of it. <a href="https://www.sitemaps.org/">About XML sitemaps</a>.</p>
          </div>
        </header>
        <main>
          <div class="in panel">
            <xsl:apply-templates/>
          </div>
          <footer>DakyXTech &#183; <a href="/">dakyx.com</a> &#183; <a href="/robots.txt">robots.txt</a> &#183; <a href="/llms.txt">llms.txt</a></footer>
        </main>
      </body>
    </html>
  </xsl:template>

  <xsl:template match="sitemap:sitemapindex">
    <p class="count">This sitemap index contains <b><xsl:value-of select="count(sitemap:sitemap)"/></b> sitemaps.</p>
    <table>
      <thead><tr><th>Sitemap</th><th class="n">Last modified</th></tr></thead>
      <tbody>
        <xsl:for-each select="sitemap:sitemap">
          <tr>
            <td><a href="{sitemap:loc}"><xsl:value-of select="sitemap:loc"/></a></td>
            <td class="n"><xsl:value-of select="sitemap:lastmod"/></td>
          </tr>
        </xsl:for-each>
      </tbody>
    </table>
  </xsl:template>

  <xsl:template match="sitemap:urlset">
    <p class="count">This sitemap contains <b><xsl:value-of select="count(sitemap:url)"/></b> URLs. <a href="/sitemap_index.xml">Back to the index</a>.</p>
    <table>
      <thead><tr><th>URL</th><th class="n img">Images</th><th class="n">Last modified</th></tr></thead>
      <tbody>
        <xsl:for-each select="sitemap:url">
          <tr>
            <td><a href="{sitemap:loc}"><xsl:value-of select="sitemap:loc"/></a></td>
            <td class="n img"><xsl:value-of select="count(image:image)"/></td>
            <td class="n"><xsl:value-of select="sitemap:lastmod"/></td>
          </tr>
        </xsl:for-each>
      </tbody>
    </table>
  </xsl:template>
</xsl:stylesheet>
