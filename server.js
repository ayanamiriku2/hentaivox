"use strict";

const express = require("express");
const fetch = require("node-fetch");
const compression = require("compression");
const { URL } = require("url");

// ═══════════════════════════════════════════════════════════════
//  CONFIGURATION
// ═══════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
const ORIGIN_DOMAIN = process.env.ORIGIN_DOMAIN || "hentaivox.com";
const SITE_NAME = process.env.SITE_NAME || "HentaiVox";
const SITE_TAGLINE =
  process.env.SITE_TAGLINE || "Free Hentai Manga & Doujinshi Online";

// Known domains that should be rewritten to the mirror host.
// This includes the origin AND any old mirrors that may appear in origin HTML.
const REWRITE_DOMAINS = [
  ORIGIN_DOMAIN,
  "hentaivox.online",  // old mirror — must be rewritten too
  "hentaivox.biz",     // our mirror domain
];

const app = express();
app.set("trust proxy", true);
app.use(compression());

// ═══════════════════════════════════════════════════════════════
//  AUTO-DETECT MIRROR HOST FROM REQUEST
//  Uses the Host header so links always point back to THIS server,
//  whether it's localhost:3000, myapp.railway.app, or a custom domain.
// ═══════════════════════════════════════════════════════════════

function getMirrorHost(req) {
  // Behind proxies (Codespaces, Railway, Render), use X-Forwarded-Host
  return req.headers["x-forwarded-host"]?.split(",")[0]?.trim()
    || req.hostname
    || req.headers.host?.split(":")[0]
    || "localhost";
}

function getMirrorOrigin(req) {
  // Behind proxies, the real origin comes from X-Forwarded headers
  const forwardedHost = req.headers["x-forwarded-host"]?.split(",")[0]?.trim();
  const forwardedProto = req.headers["x-forwarded-proto"]?.split(",")[0]?.trim();
  if (forwardedHost) {
    const proto = forwardedProto || "https";
    return `${proto}://${forwardedHost}`;
  }
  const host = req.headers.host || "localhost:3000";
  const proto = req.protocol || "http";
  return `${proto}://${host}`;
}

// ═══════════════════════════════════════════════════════════════
//  URL NORMALIZATION — Prevents duplicate content
// ═══════════════════════════════════════════════════════════════

const STRIP_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "fbclid", "gclid", "ref", "source",
]);

function normalizeUrl(pathname, search) {
  let p = pathname.replace(/\/index\.(html|php)$/i, "/");
  if (p !== "/" && !p.match(/\.[a-zA-Z0-9]{1,10}$/) && !p.endsWith("/")) {
    p += "/";
  }
  if (search) {
    const params = new URLSearchParams(search);
    for (const key of STRIP_PARAMS) params.delete(key);
    const cleaned = params.toString();
    search = cleaned ? `?${cleaned}` : "";
  }
  return { pathname: p, search: search || "" };
}

// ═══════════════════════════════════════════════════════════════
//  STATIC SEO ROUTES
// ═══════════════════════════════════════════════════════════════

app.get("/robots.txt", (req, res) => {
  const mirrorOrigin = getMirrorOrigin(req);
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.set("Cache-Control", "public, max-age=86400");
  res.send(
    [
      "User-agent: *",
      "Allow: /",
      "",
      `Sitemap: ${mirrorOrigin}/sitemap.xml`,
      `Sitemap: ${mirrorOrigin}/sitemap-index.xml`,
      "",
      "User-agent: *",
      "Crawl-delay: 2",
    ].join("\n")
  );
});

app.get("/ads.txt", (_req, res) => {
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.set("Cache-Control", "public, max-age=86400");
  res.send("# No ads\n");
});

app.get("/.well-known/security.txt", (req, res) => {
  const mirrorHost = getMirrorHost(req);
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.set("Cache-Control", "public, max-age=86400");
  res.send(`Contact: admin@${mirrorHost}\nPreferred-Languages: en, id\n`);
});

app.get("/security.txt", (_req, res) => {
  res.redirect(301, "/.well-known/security.txt");
});

app.get("/humans.txt", (req, res) => {
  const mirrorOrigin = getMirrorOrigin(req);
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.set("Cache-Control", "public, max-age=86400");
  res.send(`/* TEAM */\nSite: ${SITE_NAME}\nURL: ${mirrorOrigin}\n`);
});

app.get("/site.webmanifest", (req, res) => {
  const mirrorOrigin = getMirrorOrigin(req);
  res.set("Content-Type", "application/manifest+json; charset=utf-8");
  res.set("Cache-Control", "public, max-age=86400");
  res.json({
    name: SITE_NAME,
    short_name: SITE_NAME,
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#000000",
    icons: [
      { src: `${mirrorOrigin}/favicon.ico`, sizes: "any", type: "image/x-icon" }
    ]
  });
});

// ═══════════════════════════════════════════════════════════════
//  MAIN REVERSE PROXY HANDLER
// ═══════════════════════════════════════════════════════════════

app.all("*", async (req, res) => {
  try {
    const mirrorHost = getMirrorHost(req);
    const mirrorOrigin = getMirrorOrigin(req);

    const originalPath = req.path;
    const originalSearch = req.url.includes("?")
      ? "?" + req.url.split("?").slice(1).join("?")
      : "";

    // ──── URL NORMALIZATION (301 redirect if needed) ────
    const normalized = normalizeUrl(originalPath, originalSearch);
    if (normalized.pathname !== originalPath || normalized.search !== originalSearch) {
      // Use relative redirect — works behind any proxy
      return res.redirect(301, `${normalized.pathname}${normalized.search}`);
    }

    const pathname = normalized.pathname;
    const search = normalized.search;
    const fullMirrorUrl = `${mirrorOrigin}${pathname}${search}`;

    // ──── Build origin request ────
    const originUrl = `https://${ORIGIN_DOMAIN}${pathname}${search}`;

    const fetchHeaders = {};
    const forwardHeaders = [
      "accept", "accept-language", "cookie", "user-agent",
      "referer", "if-modified-since", "if-none-match", "range",
    ];
    for (const h of forwardHeaders) {
      if (req.headers[h]) fetchHeaders[h] = req.headers[h];
    }
    fetchHeaders["host"] = ORIGIN_DOMAIN;
    fetchHeaders["x-forwarded-host"] = mirrorHost;
    fetchHeaders["x-forwarded-for"] = req.ip || req.headers["x-forwarded-for"] || "";
    fetchHeaders["x-real-ip"] = req.ip || "";

    const fetchOpts = {
      method: req.method,
      headers: fetchHeaders,
      redirect: "manual",
      compress: false,
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      fetchOpts.body = req;
    }

    const response = await fetch(originUrl, fetchOpts);

    // ──── HANDLE REDIRECTS — rewrite Location to mirror ────
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      let location = response.headers.get("location") || "";

      // Rewrite origin domains to relative paths in Location header
      for (const domain of REWRITE_DOMAINS) {
        location = location.replace(
          new RegExp(`https?://${escapeRegex(domain)}`, "gi"), ""
        );
      }

      // Normalize the redirect target path
      if (location.startsWith("/")) {
        try {
          const locUrl = new URL(location, "http://placeholder");
          const normLoc = normalizeUrl(locUrl.pathname, locUrl.search);
          location = `${normLoc.pathname}${normLoc.search}`;
        } catch (_) {}
      }

      // If it's still an absolute URL to the same site, make it relative
      if (!location.startsWith("/") && !location.startsWith("http")) {
        location = "/" + location;
      }

      res.set("Location", location);
      res.set("Cache-Control", "public, max-age=3600");
      return res.status(response.status).end();
    }

    // ──── Build response headers ────
    const contentType = response.headers.get("content-type") || "";

    const safeHeaders = [
      "content-type", "last-modified", "etag", "accept-ranges",
      "content-range", "content-disposition", "age",
    ];
    for (const h of safeHeaders) {
      const val = response.headers.get(h);
      if (val) res.set(h, val);
    }

    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "origin-when-cross-origin");
    res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.set("X-Robots-Tag", "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1");

    if (contentType.includes("text/html")) {
      res.set("Cache-Control", "public, max-age=3600, s-maxage=7200, stale-while-revalidate=86400");
      res.set("Vary", "Accept-Encoding");
    } else if (isStaticAsset(contentType)) {
      res.set("Cache-Control", "public, max-age=604800, immutable");
    }

    res.set("Link", `<${fullMirrorUrl}>; rel="canonical"`);
    // No CSP — it breaks behind proxies (Codespaces, Railway, Render)
    // and isn't needed for a mirror site

    // ──── REWRITABLE CONTENT ────
    if (isRewritableContent(contentType)) {
      let body = await response.text();

      // 1. Remove all ads
      body = removeAllAds(body);

      // 2. Rewrite ALL known domains → relative URLs
      //    https://hentaivox.com/path → /path
      //    Keeps subdomain URLs (a1.hentaivox.com, t.hentaivox.com) pointing to origin CDN
      for (const domain of REWRITE_DOMAINS) {
        body = replaceAllDomainReferences(body, domain);
      }

      if (contentType.includes("text/html")) {
        // 3. Full SEO overhaul
        body = fullSEOOverhaul(
          body, mirrorHost, mirrorOrigin, ORIGIN_DOMAIN,
          SITE_NAME, SITE_TAGLINE, pathname, search, response.status
        );

        // 4. Inject ad blocker runtime (with dynamic host)
        body = injectAdBlockRuntime(body, mirrorHost);
      }

      if (contentType.includes("xml")) {
        for (const domain of REWRITE_DOMAINS) {
          body = rewriteSitemap(body, domain, mirrorOrigin);
        }
      }

      // Also remove any leftover CSP meta tags from origin HTML
      if (contentType.includes("text/html")) {
        body = body.replace(/<meta\s+[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi, "");

        // Fix viewport maximum-scale out of bounds (browsers clamp >10)
        body = body.replace(
          /(<meta[^>]*name\s*=\s*["']viewport["'][^>]*content\s*=\s*["'])([^"']*)["']/gi,
          function(match, prefix, content) {
            const fixed = content.replace(
              /maximum-scale\s*=\s*([\d.]+)/i,
              function(_, val) {
                const n = parseFloat(val);
                return 'maximum-scale=' + Math.min(Math.max(n, 0.1), 10);
              }
            );
            return prefix + fixed + '"';
          }
        );

        // Rewrite manifest link to local route
        body = body.replace(
          /<link[^>]*rel\s*=\s*["']manifest["'][^>]*>/gi,
          '<link rel="manifest" href="/site.webmanifest">'
        );
      }

      return res.status(response.status).send(body);
    }

    // ──── BINARY / STREAM CONTENT ────
    res.status(response.status);
    const cl = response.headers.get("content-length");
    if (cl) res.set("content-length", cl);

    if (response.body) {
      response.body.pipe(res);
    } else {
      const buf = await response.buffer();
      res.send(buf);
    }
  } catch (err) {
    console.error("Proxy error:", err.message);
    if (!res.headersSent) {
      res.status(502).send("<!-- Mirror proxy error -->");
    }
  }
});

// ═══════════════════════════════════════════════════════════════
//  UTILITY: escapeRegex
// ═══════════════════════════════════════════════════════════════

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ═══════════════════════════════════════════════════════════════
//  AD DOMAIN LIST
// ═══════════════════════════════════════════════════════════════

const AD_DOMAINS = [
  "diagramjawlineunhappy.com", "bullionglidingscuttle.com",
  "unusual-spot.com", "www.unusual-spot.com", "psotiwhotho.com",
  "juicyads.com", "juicyads.me", "adserver.juicyads.com",
  "ads.juicyads.com", "ads.juicyads.me", "ck.juicyads.com",
  "exoclick.com", "exosrv.com", "exdynsrv.com", "realsrv.com",
  "tsyndicate.com", "a-ads.com", "ad-maven.com", "admaven.com",
  "adsterra.com", "adsterratools.com", "hpyrdr.com",
  "trafficjunky.com", "trafficjunky.net", "popads.net",
  "popcash.net", "propellerads.com", "propellerclick.com",
  "clickadu.com", "hilltopads.net", "hilltopads.com",
  "richpush.com", "pushground.com", "evadav.com", "galaksion.com",
  "monetag.com", "onclicka.com", "onclickads.net", "clickaine.com",
  "plugrush.com", "acint.net", "adskeeper.com", "adnium.com",
  "eroadvertising.com", "trafficstars.com", "trafficfactory.biz",
  "lfrfrequency.com", "frtya.com", "trkyclk.com", "dolohen.com",
  "notifpush.com", "pushwhy.com", "pushengage.com",
  "mafrfrequency.com", "bidgear.com", "awempire.com",
  "cpmstar.com", "ad.plus", "syndication.exoclick.com",
  "go.onclasrv.com", "onclkds.com", "clickfuse.com",
  "ratexchange.net", "cetrk.com", "clksite.com",
  "voluum.com", "trackvoluum.com",
  "betweendigital.com", "lbs-eu1.ads.betweendigital.com",
  "uuidksinc.net", "s.uuidksinc.net",
  "cpx.to", "rfrfrequency.com", "adsco.re",
  "adserverplus.com", "365smarfind.com", "adxpansion.com",
  "ero-advertising.com", "adxprtz.com", "srfrtracker.com",
  "clickagy.com", "adspyglass.com", "clkmon.com",
  "datamined.io", "contextualadv.com", "adtng.com",
  "tubecorporate.com", "livejasmin.com", "awinmid.com",
  "fleshlight.com", "cam4.com", "stripchat.com",
  "chaturbate.com", "bongacams.com", "imlive.com",
  "jads.co", "poweredby.jads.co",
  "wpadmngr.com", "js.wpadmngr.com",
];

// ═══════════════════════════════════════════════════════════════
//  AD REMOVAL
// ═══════════════════════════════════════════════════════════════

function removeAllAds(body) {
  // A. Remove script tags by SRC domain
  for (const domain of AD_DOMAINS) {
    const esc = domain.replace(/\./g, "\\.");
    body = body.replace(
      new RegExp(`<script[^>]*src\\s*=\\s*["'][^"']*${esc}[^"']*["'][^>]*>[\\s\\S]*?<\\/script>`, "gi"),
      "<!-- ad removed -->"
    );
    body = body.replace(
      new RegExp(`<script[^>]*src\\s*=\\s*["'][^"']*${esc}[^"']*["'][^>]*\\/?>`, "gi"),
      "<!-- ad removed -->"
    );
  }

  // B. Remove scripts by obfuscated/random URL patterns
  body = body.replace(
    /<script[^>]*src\s*=\s*["'](?:https?:)?\/\/[a-z]{6,20}\.com\/[a-zA-Z0-9_\-\.\/]{20,}["'][^>]*>[\s\S]*?<\/script>/gi,
    function (match) {
      if (isTrustedScript(match)) return match;
      return "<!-- suspicious ad script removed -->";
    }
  );
  body = body.replace(
    /<script[^>]*src\s*=\s*["']\/\/[a-z]{6,20}\.com\/[a-zA-Z0-9_\-\.\/]{10,}["'][^>]*>[\s\S]*?<\/script>/gi,
    function (match) {
      if (isTrustedScript(match)) return match;
      return "<!-- suspicious ad script removed -->";
    }
  );
  body = body.replace(
    /<script[^>]*src\s*=\s*["']\/\/[a-z]{6,20}\.com\/[a-zA-Z0-9_\-\.\/]{10,}["'][^>]*\/?>/gi,
    function (match) {
      if (isTrustedScript(match)) return match;
      return "<!-- suspicious ad script removed -->";
    }
  );

  // C. Remove inline scripts with ad code
  body = body.replace(
    /<script(?:\s[^>]*)?>[\s\S]*?<\/script>/gi,
    function (match) {
      const content = match.toLowerCase();
      for (const domain of AD_DOMAINS) {
        if (content.includes(domain.toLowerCase())) return "<!-- inline ad removed -->";
      }
      const adSignatures = [
        "adsbyjuicy", "juicy_code", "adshow.php", "adserver.juicyads",
        "adzone", "jac.js", "profile.min.js",
        "unusual-spot.com", "psotiwhotho.com",
        "diagramjawlineunhappy", "bullionglidingscuttle",
        "blockadblock", "fuckadblock", "sniffadblock",
        "popunder", "pop_under", "clickunder",
        "window.open(", "adblock_detected", "adblock-detected",
        "disable your ad", "disable adblock",
      ];
      for (const sig of adSignatures) {
        if (content.includes(sig.toLowerCase())) return "<!-- inline ad removed -->";
      }
      return match;
    }
  );

  // D. Remove <a>, <img>, <iframe>, <div>, <link>, <noscript> ads
  for (const domain of AD_DOMAINS) {
    const esc = domain.replace(/\./g, "\\.");
    body = body.replace(new RegExp(`<a[^>]*href\\s*=\\s*["'][^"']*${esc}[^"']*["'][^>]*>[\\s\\S]*?<\\/a>`, "gi"), "<!-- ad removed -->");
    body = body.replace(new RegExp(`<img[^>]*src\\s*=\\s*["'][^"']*${esc}[^"']*["'][^>]*\\/?>`, "gi"), "<!-- ad removed -->");
    body = body.replace(new RegExp(`<iframe[^>]*src\\s*=\\s*["'][^"']*${esc}[^"']*["'][^>]*>[\\s\\S]*?<\\/iframe>`, "gi"), "<!-- ad removed -->");
    body = body.replace(new RegExp(`<div[^>]*>\\s*<a[^>]*href\\s*=\\s*["'][^"']*${esc}[^"']*["'][^>]*>[\\s\\S]*?<\\/a>\\s*<\\/div>`, "gi"), "<!-- ad removed -->");
    body = body.replace(new RegExp(`<link[^>]*href\\s*=\\s*["'][^"']*${esc}[^"']*["'][^>]*\\/?>`, "gi"), "<!-- ad removed -->");
    body = body.replace(new RegExp(`<noscript[^>]*>[\\s\\S]*?${esc}[\\s\\S]*?<\\/noscript>`, "gi"), "<!-- ad removed -->");
  }

  // E. Remove onclick redirect handlers
  body = body.replace(
    /\s+onclick\s*=\s*["'][^"']*(?:window\.open|window\.location|location\.href)[^"']*["']/gi,
    ""
  );

  // F. Remove adzone elements
  body = body.replace(
    /<(?:div|span|ins)[^>]*(?:id|class)\s*=\s*["'][^"']*adzone[^"']*["'][^>]*>[\s\S]*?<\/(?:div|span|ins)>/gi,
    "<!-- adzone removed -->"
  );

  // G. Remove 1x1 tracking iframes (betweendigital, uuidksinc, cookie sync, etc.)
  body = body.replace(
    /<iframe[^>]*(?:width\s*=\s*["']?1(?:px)?["']?|height\s*=\s*["']?1(?:px)?["']?|width:1px|height:1px)[^>]*>[\s\S]*?<\/iframe>/gi,
    "<!-- tracking iframe removed -->"
  );
  // Self-closing 1x1 iframes
  body = body.replace(
    /<iframe[^>]*(?:width\s*=\s*["']?1(?:px)?["']?|height\s*=\s*["']?1(?:px)?["']?|width:1px|height:1px)[^>]*\/?>/gi,
    "<!-- tracking iframe removed -->"
  );

  // H. Remove invisible overlay divs that hijack clicks
  body = body.replace(
    /<div[^>]*style\s*=\s*["'][^"']*(?:position:\s*(?:fixed|absolute)[^"']*z-index:\s*\d{4,}|z-index:\s*\d{4,}[^"']*position:\s*(?:fixed|absolute))[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
    function(match) {
      // Keep if it contains meaningful content (images, text nodes > 10 chars)
      if (/<img[^>]*>/i.test(match) && match.length > 500) return match;
      return "<!-- overlay removed -->";
    }
  );

  // I. Remove ad container divs (header-ban-agsy, middle-ban-agsy, footer-ban-agsy)
  body = body.replace(
    /<div[^>]*id\s*=\s*["'][^"']*ban-agsy[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
    "<!-- ad container removed -->"
  );

  return body;
}

// ═══════════════════════════════════════════════════════════════
//  TRUSTED SCRIPT WHITELIST
// ═══════════════════════════════════════════════════════════════

function isTrustedScript(scriptTag) {
  const trusted = [
    "jquery", "googleapis.com", "gstatic.com", "google.com",
    "google-analytics.com", "googletagmanager.com", "cloudflare.com",
    "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com",
    "bootstrapcdn.com", "fontawesome.com",
    ORIGIN_DOMAIN,
    "wp.com", "wordpress.com", "wp-content", "wp-includes",
  ];
  const lower = scriptTag.toLowerCase();
  return trusted.some((t) => lower.includes(t));
}

// ═══════════════════════════════════════════════════════════════
//  RUNTIME AD BLOCKER INJECTION
//  mirrorHost is injected dynamically into the TRUSTED list
// ═══════════════════════════════════════════════════════════════

function injectAdBlockRuntime(body, mirrorHost) {
  const runtime = `
<style id="mirror-adblock-css">
  [id*="juicy"],[class*="juicy"],[id*="exo_"],[class*="exo_"],
  [id*="ad-container"],[class*="ad-container"],
  [id*="ad_container"],[class*="ad_container"],
  [id*="adzone"],[class*="adzone"],[id*="banner-ad"],[class*="banner-ad"],
  [id*="popunder"],[class*="popunder"],[id*="overlay-ad"],[class*="overlay-ad"],
  [id*="interstitial"],[class*="interstitial"],
  div[data-ad],div[data-adzone],
  iframe[src*="juicyads"],iframe[src*="exoclick"],
  iframe[src*="adshow.php"],iframe[src*="adserver.juicyads"],
  a[href*="juicyads.com"],a[href*="ck.juicyads.com"],
  a[href*="getjuicy.php"],a[href*="exoclick.com"],
  a[href*="trafficjunky.com"],a[href*="trafficstars.com"],
  a[href*="betweendigital.com"],a[href*="uuidksinc.net"],
  iframe[src*="betweendigital"],iframe[src*="uuidksinc"],
  iframe[src*="match?bidder"],
  img[src*="juicyads"],img[src*="ads.juicyads.me"],
  iframe[style*="width:1px"],iframe[style*="width: 1px"],
  iframe[style*="height:1px"],iframe[style*="height: 1px"],
  iframe[width="1"],iframe[width="1px"],
  iframe[height="1"],iframe[height="1px"],
  iframe[width="0"],iframe[height="0"],
  div#header-ban-agsy,div#middle-ban-agsy,div#footer-ban-agsy,
  [id*="ban-agsy"],[class*="ban-agsy"] {
    display:none!important;visibility:hidden!important;
    height:0!important;width:0!important;
    pointer-events:none!important;position:absolute!important;
    left:-99999px!important;
  }
</style>

<script id="mirror-adblock-runtime">
(function() {
  'use strict';

  var AD = [
    'diagramjawlineunhappy.com','bullionglidingscuttle.com',
    'unusual-spot.com','www.unusual-spot.com','psotiwhotho.com',
    'juicyads.com','juicyads.me','adserver.juicyads.com',
    'ads.juicyads.com','ads.juicyads.me','ck.juicyads.com',
    'exoclick.com','exosrv.com','exdynsrv.com','realsrv.com',
    'tsyndicate.com','adsterra.com','adsterratools.com',
    'trafficjunky.com','trafficjunky.net','popads.net',
    'popcash.net','propellerads.com','propellerclick.com',
    'clickadu.com','hilltopads.net','hilltopads.com',
    'monetag.com','onclicka.com','onclickads.net',
    'trafficstars.com','trafficfactory.biz','ad-maven.com',
    'admaven.com','hpyrdr.com','galaksion.com','cpmstar.com',
    'a-ads.com','plugrush.com','richpush.com','evadav.com',
    'pushground.com','frtya.com','trkyclk.com','dolohen.com',
    'notifpush.com','pushwhy.com','pushengage.com',
    'mafrfrequency.com','bidgear.com','awempire.com','ad.plus',
    'syndication.exoclick.com','go.onclasrv.com','onclkds.com',
    'clickfuse.com','voluum.com','trackvoluum.com',
    'betweendigital.com','lbs-eu1.ads.betweendigital.com',
    'uuidksinc.net','s.uuidksinc.net',
    'cpx.to','rfrfrequency.com','adsco.re',
    'adserverplus.com','365smarfind.com','adxpansion.com',
    'ero-advertising.com','adxprtz.com','srfrtracker.com',
    'clickagy.com','adspyglass.com','clkmon.com',
    'datamined.io','contextualadv.com','adtng.com',
    'tubecorporate.com','livejasmin.com','awinmid.com',
    'fleshlight.com','cam4.com','stripchat.com',
    'chaturbate.com','bongacams.com','imlive.com',
    'jads.co','poweredby.jads.co',
    'wpadmngr.com','js.wpadmngr.com'
  ];

  var TRUSTED = [
    location.hostname,
    '${escapeJs(mirrorHost)}',
    '${escapeJs(ORIGIN_DOMAIN)}',
    'googleapis.com','gstatic.com','google.com',
    'cloudflare.com','jsdelivr.net','jquery.com',
    'bootstrapcdn.com','unpkg.com','fontawesome.com',
    'wp.com','wordpress.com','google-analytics.com',
    'googletagmanager.com','mc.yandex.ru'
  ];

  function isAd(u) {
    try {
      var h = new URL(u, location.href).hostname;
      return AD.some(function(d) { return h === d || h.endsWith('.' + d); });
    } catch(e) { return false; }
  }

  function isTrusted(u) {
    try {
      var h = new URL(u, location.href).hostname;
      return TRUSTED.some(function(d) { return h === d || h.endsWith('.' + d); });
    } catch(e) { return false; }
  }

  function isSameSite(u) {
    try {
      return new URL(u, location.href).hostname === location.hostname;
    } catch(e) { return false; }
  }

  function isObf(url) {
    try {
      var p = new URL(url, location.href).pathname;
      if (/\\/[a-zA-Z0-9_\\-]{20,}/.test(p)) return true;
      if (/\\/[a-f0-9]{8,}\\.js$/.test(p)) return true;
      if ((p.match(/\\//g) || []).length >= 2 && /[A-Z].*[a-z].*[A-Z]/.test(p)) return true;
    } catch(e) {}
    return false;
  }

  // Freeze ad globals
  var freezeGlobals = [
    'adsbyjuicy','juicy_code',
    'Fe','GA','MA','Ae','Ac','rPE','cp','cV','GS','HZ','ShSh','Rn','Be','Ge',
    'popunder','PopUnder','Popunder',
    '__pop','_pop','pop_config',
    'clickunder','ClickUnder'
  ];
  freezeGlobals.forEach(function(name) {
    try {
      Object.defineProperty(window, name, {
        get: function() { return (name === 'adsbyjuicy') ? { loaded: true, onload: function(){}, push: function(){}, pop: function(){}, length: 0 } : function(){}; },
        set: function() {},
        configurable: false
      });
    } catch(e) {}
  });

  // Anti-click hijacking
  var _AEL = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, fn, opts) {
    var hijackEvents = ['click','mousedown','mouseup','pointerdown','pointerup','touchstart','touchend'];
    if (hijackEvents.indexOf(type) !== -1) {
      if (this === window || this === document || this === document.body || this === document.documentElement) {
        var fnStr = '';
        try { fnStr = fn.toString(); } catch(e) {}
        var adPatterns = [
          'window.open','window.location','location.href','location.assign',
          'location.replace','about:blank','_blank','popunder','clickunder',
          'zoneid','adzone','juicy','exo','redir','redirect','appendChild'
        ];
        var isAdListener = adPatterns.some(function(p) {
          return fnStr.toLowerCase().indexOf(p.toLowerCase()) !== -1;
        });
        if (isAdListener) return;
      }
    }
    if (type === 'message') {
      var wrappedFn = function(e) {
        if (e.origin && isAd(e.origin)) return;
        if (typeof e.data === 'string' && /^\\d+_\\d+px_\\d+px$/.test(e.data)) return;
        return fn.apply(this, arguments);
      };
      return _AEL.call(this, type, wrappedFn, opts);
    }
    return _AEL.call(this, type, fn, opts);
  };

  // ── AGGRESSIVE TAB-UNDER / POPUNDER PROTECTION ──
  // Track click state: any window.open or location change during a click
  // that doesn't go to same-site is blocked.
  var __clickTime = 0;
  var __clickIsLegit = false;
  var CLICK_WINDOW_MS = 1500;

  function inClickWindow() {
    return (Date.now() - __clickTime) < CLICK_WINDOW_MS;
  }

  // Capture click — mark click window
  document.addEventListener('click', function(e) {
    var el = e.target;
    __clickTime = Date.now();
    __clickIsLegit = false;

    while (el && el !== document.body) {
      if (el.tagName === 'A' && el.href) {
        if (isSameSite(el.href) || isTrusted(el.href)) {
          __clickIsLegit = true;
        } else if (isAd(el.href)) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          return false;
        }
        break;
      }
      el = el.parentElement;
    }

    // If clicking on empty area (not a link/button), block ALL redirects
    if (!__clickIsLegit && !e.target.closest('a, button, input, select, textarea, video, audio, [role="button"], [onclick]')) {
      window.__mirrorBlockRedirect = true;
      setTimeout(function() { window.__mirrorBlockRedirect = false; }, CLICK_WINDOW_MS);
    }
  }, true);

  // Capture mousedown
  document.addEventListener('mousedown', function(e) {
    var el = e.target;
    while (el && el !== document.body) {
      if (el.tagName === 'A' && el.href && isAd(el.href)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return false;
      }
      el = el.parentElement;
    }
  }, true);

  // Block window.open — ONLY allow same-site opens OR legit link clicks
  var _origOpen = window.open;
  try {
    Object.defineProperty(window, 'open', {
      get: function() {
        return function(url, name, specs) {
          if (!url || url === 'about:blank' || url === '') return null;
          if (typeof url === 'string') {
            if (isAd(url)) return null;
            // During a click event, only allow same-site window.open
            if (inClickWindow() && !isSameSite(url) && !isTrusted(url)) {
              return null;
            }
            if (window.__mirrorBlockRedirect) return null;
            // Outside click: still block non-same-site opens (timer-based popunders)
            if (!isSameSite(url) && !isTrusted(url)) return null;
          }
          return _origOpen.call(window, url, name, specs);
        };
      },
      set: function() {},
      configurable: false
    });
  } catch(e) {}

  // Block location redirect — prevent tab-under
  try {
    var _assign = location.assign.bind(location);
    var _replace = location.replace.bind(location);
    location.assign = function(url) {
      if (typeof url === 'string' && (isAd(url) || window.__mirrorBlockRedirect)) return;
      // During click window, if something tries to navigate away to non-same-site, block it
      if (inClickWindow() && typeof url === 'string' && !isSameSite(url) && !isTrusted(url)) return;
      return _assign(url);
    };
    location.replace = function(url) {
      if (typeof url === 'string' && (isAd(url) || window.__mirrorBlockRedirect)) return;
      if (inClickWindow() && typeof url === 'string' && !isSameSite(url) && !isTrusted(url)) return;
      return _replace(url);
    };
  } catch(e) {}

  // Block location.href setter — catches: location.href = 'ad-url'
  try {
    var locDesc = Object.getOwnPropertyDescriptor(window, 'location');
    if (!locDesc || locDesc.configurable) {
      // Can't override location in most browsers, use History API instead
    }
  } catch(e) {}

  // Intercept History pushState/replaceState to block ad redirects
  try {
    var _pushState = history.pushState.bind(history);
    var _replaceState = history.replaceState.bind(history);
    history.pushState = function(state, title, url) {
      if (typeof url === 'string' && !isSameSite(url) && isAd(url)) return;
      return _pushState(state, title, url);
    };
    history.replaceState = function(state, title, url) {
      if (typeof url === 'string' && !isSameSite(url) && isAd(url)) return;
      return _replaceState(state, title, url);
    };
  } catch(e) {}

  // Block beforeunload-based redirects during click
  window.addEventListener('beforeunload', function(e) {
    if (inClickWindow() && !__clickIsLegit) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  });

  // Prevent setTimeout/setInterval based redirects
  var _setTimeout = window.setTimeout;
  var _setInterval = window.setInterval;
  window.setTimeout = function(fn, ms) {
    if (typeof fn === 'string') {
      var lc = fn.toLowerCase();
      if (/window\.open|location\.href|location\.assign|location\.replace|document\.write/i.test(lc)) return 0;
    }
    return _setTimeout.apply(window, arguments);
  };
  window.setInterval = function(fn, ms) {
    if (typeof fn === 'string') {
      var lc = fn.toLowerCase();
      if (/window\.open|location\.href|location\.assign|location\.replace|document\.write/i.test(lc)) return 0;
    }
    return _setInterval.apply(window, arguments);
  };

  // Block document.write of ad content
  var _docWrite = document.write.bind(document);
  var _docWriteln = document.writeln.bind(document);
  document.write = function(markup) {
    if (typeof markup === 'string') {
      var lc = markup.toLowerCase();
      if (AD.some(function(d) { return lc.indexOf(d) !== -1; })) return;
      if (/adsbyjuicy|juicy_code|adshow\.php|popunder|clickunder/i.test(lc)) return;
    }
    return _docWrite(markup);
  };
  document.writeln = function(markup) {
    if (typeof markup === 'string') {
      var lc = markup.toLowerCase();
      if (AD.some(function(d) { return lc.indexOf(d) !== -1; })) return;
    }
    return _docWriteln(markup);
  };

  // Block createElement for ad scripts
  var _ce = document.createElement.bind(document);
  document.createElement = function(tag) {
    var el = _ce(tag);
    var tagL = tag.toLowerCase();
    if (tagL === 'script' || tagL === 'iframe') {
      var _sa = el.setAttribute.bind(el);
      el.setAttribute = function(n, v) {
        if (n === 'src' && typeof v === 'string') {
          if (isAd(v) || /jac\\.js|adshow\\.php|profile\\.min\\.js|jads\\.co/i.test(v)) return;
          if (!isTrusted(v) && !isSameSite(v) && isObf(v)) return;
        }
        return _sa(n, v);
      };
      try {
        Object.defineProperty(el, 'src', {
          get: function() { return el.getAttribute('src') || ''; },
          set: function(v) {
            if (typeof v === 'string') {
              if (isAd(v) || /jac\\.js|adshow\\.php|profile\\.min\\.js|jads\\.co/i.test(v)) return;
              if (!isTrusted(v) && !isSameSite(v) && isObf(v)) return;
            }
            _sa('src', v);
          }
        });
      } catch(e) {}
    }
    if (tagL === 'a') {
      var _saA = el.setAttribute.bind(el);
      el.setAttribute = function(n, v) {
        if (n === 'href' && typeof v === 'string' && isAd(v)) return;
        return _saA(n, v);
      };
      try {
        Object.defineProperty(el, 'href', {
          get: function() { return el.getAttribute('href') || ''; },
          set: function(v) {
            if (typeof v === 'string' && isAd(v)) return;
            _saA('href', v);
          }
        });
      } catch(e) {}
    }
    return el;
  };

  // Block fetch & XHR
  var _fetch = window.fetch;
  window.fetch = function(input) {
    var u = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    if (isAd(u)) return Promise.resolve(new Response('', { status: 200 }));
    return _fetch.apply(this, arguments);
  };
  var _xo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(m, u) {
    if (typeof u === 'string' && isAd(u)) { this._blocked = true; return; }
    return _xo.apply(this, arguments);
  };
  var _xs = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function() {
    if (this._blocked) return;
    return _xs.apply(this, arguments);
  };

  // MutationObserver
  var obs = new MutationObserver(function(muts) {
    muts.forEach(function(m) {
      m.addedNodes.forEach(function(n) {
        if (n.nodeType !== 1) return;
        var tag = n.tagName;
        if (tag === 'SCRIPT') {
          var src = n.src || n.getAttribute('src') || '';
          var text = n.textContent || '';
          if (
            isAd(src) ||
            (!isTrusted(src) && !isSameSite(src) && src && isObf(src)) ||
            /jac\\.js|adshow\\.php|profile\\.min\\.js|jads\\.co/i.test(src) ||
            /adsbyjuicy|juicy_code|adserver\\.juicyads|adshow\\.php|unusual-spot|psotiwhotho|diagramjawlineunhappy|bullionglidingscuttle/i.test(text)
          ) { n.remove(); return; }
        }
        if (tag === 'IFRAME') {
          var isrc = n.src || '';
          if (isAd(isrc) || /adshow\\.php|match\\?bidder|remote_uid/i.test(isrc)) { n.remove(); return; }
          var iw = n.width || n.style.width || '';
          var ih = n.height || n.style.height || '';
          if (/^[01](?:px)?$/.test(String(iw)) || /^[01](?:px)?$/.test(String(ih))) {
            if (!isTrusted(isrc) && !isSameSite(isrc)) { n.remove(); return; }
          }
          if (n.style && n.style.position === 'absolute' && (parseInt(n.style.width) <= 1 || parseInt(n.style.height) <= 1)) {
            n.remove(); return;
          }
        }
        if (tag === 'A' && n.href && isAd(n.href)) { n.remove(); return; }
        if (tag === 'IMG' && n.src && isAd(n.src)) { n.remove(); return; }
        if (n.querySelectorAll) {
          n.querySelectorAll('script[src], iframe[src], a[href], img[src]').forEach(function(el) {
            var s = el.src || el.href || '';
            if (isAd(s) || /jac\\.js|adshow\\.php|profile\\.min\\.js|jads\\.co/i.test(s)) el.remove();
          });
          n.querySelectorAll('iframe[src*="adshow.php"]').forEach(function(el) { el.remove(); });
        }
      });
    });
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });

  // Cleanup
  function cleanup() {
    document.querySelectorAll('iframe').forEach(function(f) {
      var src = f.src || '';
      if (isAd(src) || /adshow\\.php|match\\?bidder|remote_uid/i.test(src)) { f.remove(); return; }
      var fw = f.width || f.style.width || f.getAttribute('width') || '';
      var fh = f.height || f.style.height || f.getAttribute('height') || '';
      if (/^[01](?:px)?$/.test(String(fw)) || /^[01](?:px)?$/.test(String(fh))) {
        if (!isTrusted(src) && !isSameSite(src)) { f.remove(); return; }
      }
      if (f.style.position === 'absolute' && (parseInt(f.style.width) <= 1 || parseInt(f.style.height) <= 1)) {
        f.remove(); return;
      }
    });
    document.querySelectorAll('[id*="adzone"], [class*="adzone"]').forEach(function(el) { el.remove(); });
    document.querySelectorAll('[id*="ban-agsy"]').forEach(function(el) { el.innerHTML = ''; el.style.display = 'none'; });
    document.querySelectorAll('ins[data-width], ins[data-height]').forEach(function(el) { el.remove(); });
    document.querySelectorAll('img[width="1"][height="1"]').forEach(function(el) {
      if (el.src && isAd(el.src)) el.remove();
    });
    document.querySelectorAll('div[style]').forEach(function(el) {
      var s = el.style;
      if (
        (s.position === 'fixed' || s.position === 'absolute') &&
        parseInt(s.zIndex) > 9000 &&
        (s.opacity === '0' || s.background === 'transparent' || !s.background) &&
        el.children.length === 0
      ) { el.remove(); }
    });
    document.querySelectorAll('a[target="_blank"]').forEach(function(el) {
      if (isAd(el.href)) el.remove();
    });
    // Remove any dynamically loaded ad scripts
    document.querySelectorAll('script[src*="jads.co"], script[src*="juicyads"], script[src*="exoclick"], script[src*="exosrv"]').forEach(function(el) { el.remove(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', cleanup);
  } else {
    cleanup();
  }
  setTimeout(cleanup, 500);
  setTimeout(cleanup, 1500);
  setTimeout(cleanup, 3000);
  setTimeout(cleanup, 5000);
  setTimeout(cleanup, 10000);
})();
</script>`;

  body = body.replace(/<head([^>]*)>/i, `<head$1>\n${runtime}`);
  return body;
}

// ═══════════════════════════════════════════════════════════════
//  FULL SEO OVERHAUL
// ═══════════════════════════════════════════════════════════════

function fullSEOOverhaul(
  body, mirrorHost, mirrorOrigin, originDomain,
  siteName, tagline, pathname, search, statusCode
) {
  const fullUrl = `${mirrorOrigin}${pathname}${search}`;

  // 1. Remove old meta tags
  body = body.replace(/<link\s+[^>]*rel\s*=\s*["']canonical["'][^>]*\/?>/gi, "");
  body = body.replace(/<link\s+[^>]*rel\s*=\s*["']alternate["'][^>]*\/?>/gi, "");
  body = body.replace(/<meta\s+[^>]*property\s*=\s*["']og:[^"']*["'][^>]*\/?>/gi, "");
  body = body.replace(/<meta\s+[^>]*name\s*=\s*["']twitter:[^"']*["'][^>]*\/?>/gi, "");
  body = body.replace(/<meta\s+[^>]*name\s*=\s*["']robots["'][^>]*\/?>/gi, "");
  body = body.replace(/<meta\s+[^>]*name\s*=\s*["']googlebot["'][^>]*\/?>/gi, "");
  body = body.replace(/<meta\s+[^>]*name\s*=\s*["']generator["'][^>]*\/?>/gi, "");
  body = body.replace(/<script\s+[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, "");
  body = body.replace(/<link\s+[^>]*rel\s*=\s*["'](?:shortlink|prev|next)["'][^>]*\/?>/gi, "");

  // 2. Extract page info
  let pageTitle = "";
  const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    pageTitle = titleMatch[1].trim().replace(/\s+/g, " ");
    // Remove any old domain from title
    for (const d of REWRITE_DOMAINS) {
      pageTitle = pageTitle.replace(new RegExp(escapeRegex(d), "gi"), mirrorHost);
    }
  }

  let pageDesc = "";
  const descMatch =
    body.match(/<meta\s+[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/i) ||
    body.match(/<meta\s+[^>]*content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["']/i);
  if (descMatch) {
    pageDesc = descMatch[1].trim();
    for (const d of REWRITE_DOMAINS) {
      pageDesc = pageDesc.replace(new RegExp(escapeRegex(d), "gi"), mirrorHost);
    }
    body = body.replace(/<meta\s+[^>]*name\s*=\s*["']description["'][^>]*\/?>/gi, "");
  }
  if (!pageDesc) {
    pageDesc = `${pageTitle || siteName} - Read free on ${siteName}`;
  }

  let ogImage = `${mirrorOrigin}/favicon.ico`;
  const imgMatch = body.match(
    /<img[^>]*src\s*=\s*["']([^"']+)["'][^>]*class\s*=\s*["'][^"']*(?:thumbnail|cover|featured|entry)[^"']*["']/i
  ) || body.match(/<img[^>]*src\s*=\s*["']([^"']+)["']/i);
  if (imgMatch) {
    let imgSrc = imgMatch[1];
    if (imgSrc.startsWith("/")) {
      imgSrc = `${mirrorOrigin}${imgSrc}`;
    }
    for (const d of REWRITE_DOMAINS) {
      imgSrc = imgSrc.replace(new RegExp(escapeRegex(d), "gi"), mirrorHost);
    }
    ogImage = imgSrc;
  }

  // 3. Rewrite <title>
  if (pageTitle) {
    let newTitle = pageTitle;
    if (!newTitle.toLowerCase().includes(mirrorHost.toLowerCase()) &&
        !newTitle.toLowerCase().includes(siteName.toLowerCase())) {
      newTitle = `${pageTitle} | ${siteName}`;
    }
    body = body.replace(/<title[^>]*>[\s\S]*?<\/title>/i, `<title>${escapeHtml(newTitle)}</title>`);
  }

  // 4. Build & inject SEO meta block
  const websiteSchema = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: siteName,
    alternateName: tagline,
    url: `${mirrorOrigin}/`,
    description: tagline,
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: `${mirrorOrigin}/?s={search_term_string}` },
      "query-input": "required name=search_term_string",
    },
    publisher: {
      "@type": "Organization",
      name: siteName,
      url: `${mirrorOrigin}/`,
      logo: { "@type": "ImageObject", url: `${mirrorOrigin}/favicon.ico` },
    },
  };

  let pageSchemaBlock = "";
  if (pathname !== "/") {
    pageSchemaBlock = `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: pageTitle || siteName,
      description: pageDesc,
      url: fullUrl,
      image: ogImage,
      isPartOf: { "@type": "WebSite", name: siteName, url: `${mirrorOrigin}/` },
      publisher: { "@type": "Organization", name: siteName, url: `${mirrorOrigin}/` },
    })}</script>`;
  }

  let breadcrumbBlock = "";
  if (pathname !== "/") {
    breadcrumbBlock = `<script type="application/ld+json">${JSON.stringify(
      buildBreadcrumbSchema(mirrorOrigin, siteName, pathname)
    )}</script>`;
  }

  const seoBlock = `
<!-- Mirror SEO Block -->
<link rel="canonical" href="${escapeAttr(fullUrl)}" />
<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" />
<meta name="googlebot" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" />
<meta name="bingbot" content="index, follow" />
<meta name="description" content="${escapeAttr(pageDesc)}" />
<meta property="og:type" content="website" />
<meta property="og:url" content="${escapeAttr(fullUrl)}" />
<meta property="og:title" content="${escapeAttr(pageTitle || siteName)}" />
<meta property="og:description" content="${escapeAttr(pageDesc)}" />
<meta property="og:image" content="${escapeAttr(ogImage)}" />
<meta property="og:site_name" content="${escapeAttr(siteName)}" />
<meta property="og:locale" content="en_US" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:url" content="${escapeAttr(fullUrl)}" />
<meta name="twitter:title" content="${escapeAttr(pageTitle || siteName)}" />
<meta name="twitter:description" content="${escapeAttr(pageDesc)}" />
<meta name="twitter:image" content="${escapeAttr(ogImage)}" />
<meta name="author" content="${escapeAttr(siteName)}" />
<meta name="rating" content="adult" />
<link rel="alternate" type="application/rss+xml" title="${escapeAttr(siteName)} RSS" href="${mirrorOrigin}/feed/" />
<!-- Google/Bing/Yandex verification — uncomment and fill: -->
<!-- <meta name="google-site-verification" content="YOUR_CODE" /> -->
<!-- <meta name="yandex-verification" content="YOUR_CODE" /> -->
<!-- <meta name="msvalidate.01" content="YOUR_CODE" /> -->
<script type="application/ld+json">${JSON.stringify(websiteSchema)}</script>
${pageSchemaBlock}
${breadcrumbBlock}
<!-- End Mirror SEO Block -->
`;

  body = body.replace(/<head([^>]*)>/i, `<head$1>\n${seoBlock}`);

  // 5. Rewrite visible text — show site name instead of origin domain
  for (const d of REWRITE_DOMAINS) {
    body = body.replace(
      new RegExp(`(>\\s*)${escapeRegex(d)}(\\s*<)`, "gi"),
      `$1${siteName}$2`
    );
  }

  // 6. Inject unique footer
  const year = new Date().getFullYear();
  const uniqueFooter = `
<div id="mirror-site-identity" style="text-align:center;padding:15px 0;font-size:12px;color:#666;border-top:1px solid #eee;margin-top:20px;">
  <p>&copy; ${year} <a href="/" style="color:#888;text-decoration:none;">${escapeHtml(siteName)}</a> &mdash; ${escapeHtml(tagline)}</p>
  <p style="font-size:11px;color:#999;">All content provided for educational and entertainment purposes.</p>
</div>`;

  body = body.replace(/<\/body>/i, `${uniqueFooter}\n</body>`);

  return body;
}

// ═══════════════════════════════════════════════════════════════
//  BREADCRUMB SCHEMA — Last item has NO "item" (Google spec)
// ═══════════════════════════════════════════════════════════════

function buildBreadcrumbSchema(mirrorOrigin, siteName, pathname) {
  const parts = pathname.split("/").filter(Boolean);
  const items = [{
    "@type": "ListItem",
    position: 1,
    name: siteName,
    item: `${mirrorOrigin}/`,
  }];

  let currentPath = "";
  parts.forEach((part, index) => {
    currentPath += `/${part}`;
    const isLast = index === parts.length - 1;
    const name = decodeURIComponent(part)
      .replace(/-/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase());
    const listItem = { "@type": "ListItem", position: index + 2, name };
    if (!isLast) {
      listItem.item = `${mirrorOrigin}${currentPath}/`;
    }
    items.push(listItem);
  });

  return { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: items };
}

// ═══════════════════════════════════════════════════════════════
//  SITEMAP REWRITE
// ═══════════════════════════════════════════════════════════════

function rewriteSitemap(body, fromDomain, mirrorOrigin) {
  const mirrorUrl = new URL(mirrorOrigin);
  const mirrorHostWithPort = mirrorUrl.host;
  const mirrorProto = mirrorUrl.protocol.replace(":", "");
  body = body.split(`https://${fromDomain}`).join(`${mirrorProto}://${mirrorHostWithPort}`);
  body = body.split(`http://${fromDomain}`).join(`${mirrorProto}://${mirrorHostWithPort}`);
  return body;
}

// ═══════════════════════════════════════════════════════════════
//  DOMAIN REWRITE — replaces one source domain with mirror host
// ═══════════════════════════════════════════════════════════════

function replaceAllDomainReferences(body, fromDomain) {
  // Replace absolute URLs to relative paths:
  // https://hentaivox.com/view/123 → /view/123
  // This works behind ANY proxy (Codespaces, Railway, Render, VPS)
  // because the browser resolves relative URLs to the current domain.
  //
  // IMPORTANT: Only rewrites exact domain, NOT subdomains.
  // a1.hentaivox.com stays as-is (CDN for images)
  // t.hentaivox.com stays as-is (tracking/API)

  const replacements = [
    // Standard URLs → relative
    [`https://${fromDomain}/`, `/`],
    [`http://${fromDomain}/`, `/`],
    [`//${fromDomain}/`, `/`],
    // URLs without trailing slash (e.g., href="https://hentaivox.com")
    [`https://${fromDomain}"`, `/"`, ],
    [`http://${fromDomain}"`, `/"`, ],
    [`https://${fromDomain}'`, `/'`, ],
    [`http://${fromDomain}'`, `/'`, ],
    // Escaped URLs in JS
    [`https:\\/\\/${fromDomain}\\/`, `\\/`],
    [`http:\\/\\/${fromDomain}\\/`, `\\/`],
    [`https:\\/\\/${fromDomain}"`, `\\/"`, ],
    [`http:\\/\\/${fromDomain}"`, `\\/"`, ],
    // Encoded URLs
    [`https%3A%2F%2F${fromDomain}%2F`, `%2F`],
    [`http%3A%2F%2F${fromDomain}%2F`, `%2F`],
  ];
  for (const [from, to] of replacements) {
    body = body.split(from).join(to);
  }
  return body;
}

// ═══════════════════════════════════════════════════════════════
//  UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttr(str) {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeJs(str) {
  return str.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function isRewritableContent(contentType) {
  return [
    "text/html", "text/css", "text/javascript",
    "application/javascript", "application/json",
    "application/xml", "text/xml",
    "application/rss+xml", "application/atom+xml", "text/plain",
  ].some((t) => contentType.includes(t));
}

function isStaticAsset(contentType) {
  return [
    "image/", "font/", "application/font",
    "video/", "audio/", "application/octet-stream", "application/wasm",
  ].some((t) => contentType.includes(t));
}

// ═══════════════════════════════════════════════════════════════
//  START SERVER
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Mirror proxy running on port ${PORT}`);
  console.log(`Origin: ${ORIGIN_DOMAIN}`);
  console.log(`Rewriting domains: ${REWRITE_DOMAINS.join(", ")} → [auto-detected from Host header]`);
});
