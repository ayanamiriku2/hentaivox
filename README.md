# HentaiVox Mirror Proxy

Full mirror reverse proxy with ad removal and SEO optimization.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `MIRROR_DOMAIN` | `hentaivox.online` | Your mirror domain |
| `ORIGIN_DOMAIN` | `hentaivox.com` | Original site domain |
| `SITE_NAME` | `HentaiVox` | Site name for SEO |
| `SITE_TAGLINE` | `Free Hentai Manga & Doujinshi Online` | Site tagline |

## Deploy to Railway

1. Push repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Set environment variables in Railway dashboard
4. Railway auto-detects `Dockerfile` or `package.json` and deploys
5. Add custom domain in Settings → Networking → Custom Domain

## Deploy to Render

1. Push repo to GitHub
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect GitHub repo
4. Settings:
   - **Runtime**: Docker (or Node)
   - **Build Command** (if Node): `npm install`
   - **Start Command** (if Node): `node server.js`
5. Add environment variables
6. Add custom domain in Settings

## Deploy to VPS

```bash
# Clone
git clone https://github.com/YOUR_USER/hentaivox.git
cd hentaivox

# Option A: Docker
docker build -t hentaivox-mirror .
docker run -d --restart=always -p 3000:3000 \
  -e MIRROR_DOMAIN=hentaivox.online \
  -e ORIGIN_DOMAIN=hentaivox.com \
  --name hentaivox hentaivox-mirror

# Option B: Node.js directly
npm install --production
PORT=3000 MIRROR_DOMAIN=hentaivox.online node server.js

# Option C: PM2 (recommended for VPS)
npm install -g pm2
npm install --production
pm2 start server.js --name hentaivox -- --env production
pm2 save
pm2 startup
```

### Nginx Reverse Proxy (VPS)

```nginx
server {
    listen 80;
    server_name hentaivox.online;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name hentaivox.online;

    ssl_certificate /etc/letsencrypt/live/hentaivox.online/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hentaivox.online/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }
}
```

Get SSL cert: `certbot --nginx -d hentaivox.online`

## SEO Fixes Applied

| Google Search Console Issue | Fix |
|---|---|
| **Duplikat, Google memilih versi kanonis berbeda** | URL normalization (trailing slash, lowercase, strip tracking params) + proper `<link rel="canonical">` + 301 redirects for non-canonical URLs |
| **Tidak ditemukan (404)** | Origin 404 status forwarded correctly instead of masking |
| **Halaman dengan pengalihan** | `redirect: "manual"` intercepts origin redirects, rewrites Location header to mirror domain, returns proper 301/302 |
| **Data terstruktur Breadcrumb** | Last breadcrumb item no longer has `item` property (per Google spec) + built via `JSON.stringify()` for valid JSON |
| **Data terstruktur tidak dapat diurai** | All JSON-LD built as JS objects then `JSON.stringify()` — guarantees valid JSON, no manual string escaping |
| **Sitemap dates manipulation** | Removed random date generation (Google detects this as spam) |